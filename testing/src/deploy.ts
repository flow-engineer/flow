// `flow deploy`: puts the agent in this folder on Flow's hosting, through the cloud (observe's
// /v1/hosting routes) with the agent's CI key. Node's own modules only.
//
//   flow deploy [--env staging|production] [--dir .] [--version <v>] [--no-secrets] [--no-cli] [--json]
//                                                                                pack, send .env's new or changed values as secrets, upload, build, go live
//   flow deploy promote [--no-secrets] [--no-cli] [--json]                       staging's live version to production
//   flow deploy status [--env staging|production] [--json]                       what is live, its version, when, its URL
//   flow logs [--env staging|production] [--since 1h] [--follow] [--json]        the hosted agent's log lines
//   flow deploy secret <NAME> [--env staging|production] [--json]                a secret, its value read from stdin
//   flow deploy secrets --from-env [<file>] [--env staging|production] [--json]  every value in the agent's .env
//
// The folder is packed without node_modules, .git, .env files and the framework's local results
// (.flow); its package-lock.json is installed with `npm ci` in the build, and the build runs
// hosting's lint (its findings are printed here). Before anything is sent, flow deploy asks the
// cloud which Flow Framework hosting runs (GET /v1/hosting/framework → { framework: { version } })
// and refuses an agent locked to a newer release line (major.minor), as hosting's lint would after
// the upload; a cloud without that route, or any failure to ask, leaves the build to decide.
// With a CLI file (src/cli.ts), the CLI is packed for the environment's address before anything is
// sent and published once live (flow cli publish); promote publishes a production build of it.
// `flow cli pack|publish|rollback|status` are here too, on the /v1/hosting/cli routes.
// Nothing here prints a key or a secret's value.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { RUN } from "../../src/names.ts";
import { fixedServer, packCli, PackError, type PackedCli } from "./cli-pack.ts";
import { agentVersion } from "../../src/traces.ts";
const DEFAULT_CLOUD = "https://flow.engineer/observe";

export const DEPLOY_LINE = `  flow deploy [--env staging|production] [--dir <folder>] [--version <v>] [--no-secrets] [--no-cli] [--json]
                            Put this agent on Flow's hosting, so it answers while this machine
                            sleeps (flow deploy --help: status, promote, secret, secrets)
  flow logs [--env staging|production] [--since 1h] [--follow] [--json]
                            The hosted agent's recent log lines`;

export const LOGS_USAGE = `Usage:
  flow logs [--env staging|production] [--since 1h] [--follow] [--json]

  --env        Which (default: staging).
  --since      How far back: 30s, 15m, 1h (the default) or 2d, at most 30d.
  --follow     Keep printing new lines until Ctrl-C.
  --json       One JSON object per line on stdout: { time, severity, text }.
  --dir, --cloud, FLOW_FRAMEWORK_CLOUD_KEY: as for flow deploy (flow deploy --help).`;

export const DEPLOY_USAGE = `Usage:
  flow deploy [--env staging|production] [--dir <folder>] [--version <v>] [--no-secrets] [--no-cli] [--json]
                                                           one command, first deploy included: sends the
                                                           .env's new or changed values as secrets, then
                                                           packs, builds and follows it to live
  flow deploy promote [--no-secrets] [--no-cli] [--json]   staging's live version to production (the
                                                           .env's new or changed values sent there first)
  flow deploy status [--env staging|production] [--json]   what is live, its version, when, and its URL
  flow deploy secret <NAME> [--env staging|production]     one secret, the value on stdin
  flow deploy secrets --from-env [<file>] [--env staging|production]
                                                           every value in <file> now (default: the agent's .env);
                                                           flow deploy does this itself

  --env        Where (default: staging). Production takes only an agent whose buildAgent passes
               options.host on to createAgent, with no database of its own.
  --dir        The agent's folder (default: .): package.json, package-lock.json, src/agent.ts.
  --version    A label for this version (default: the agent's version, as its traces and flow test
               send it: FLOW_AGENT_VERSION, else the CI's commit, else the folder's git commit with
               +dirty when it has uncommitted changes, else package.json's version).
  --no-secrets Deploy without sending the .env's values as secrets.
  --no-cli     Deploy without packing and publishing the CLI (src/cli.ts).
  --cloud      The cloud's address (default: FLOW_FRAMEWORK_CLOUD, else ${DEFAULT_CLOUD}).
  --from-env   With secrets: send each non-empty value in the file as a secret (never the CI key,
               the cloud's address, or a name Flow sets itself, such as the
               FLOW_FRAMEWORK_TRACES_* that flow link writes). Prints names only.
  --json       Print one JSON answer on stdout (progress goes to stderr).

flow deploy (and deploy promote, for production) sends each non-empty .env value as a secret (the
same names as secrets --from-env sends) before the service starts, and later only the new or changed ones: .flow/secrets.json keeps a
hash per name, never a value. It prints names only.

flow deploy first checks that hosting runs the agent's Flow Framework release line (the major.minor
in package-lock.json, 0.4 for 0.4.11): a newer one is refused before anything is sent. A Flow whose
cloud does not say which it runs deploys as before, and the build refuses it.

With a CLI file (src/cli.ts), flow deploy packs the CLI for the environment's address before
anything is sent (one that does not pack stops the deploy), and publishes it once the deploy is
live, as flow cli publish does: curl -fsSL <the agent's URL> | sh installs it. Before an
environment's first deploy it is packed once live. promote publishes a production build of it from
this folder. Without esbuild, or on a Flow whose hosting serves no CLIs, the deploy goes on without
it and says so; --json's answer has cli: what publishing it came to (null without one).

status shows both environments unless --env names one. The last deploy this folder made is kept
in .flow/deploys.json (never packed).

Environment (or the agent folder's .env):
  FLOW_FRAMEWORK_CLOUD_KEY   The agent's CI key (oci_...): flow setup writes it, or make one on
                             your agent's Developers page. CHINWAG_CLOUD_KEY, its older name, works too.`;

/** The CLI's own settings in a .env: never sent as secrets. */
const CLI_NAMES = new Set(["FLOW_FRAMEWORK_CLOUD_KEY", "CHINWAG_CLOUD_KEY", "FLOW_FRAMEWORK_CLOUD", "CHINWAG_CLOUD"]);
/** Names the host sets on the agent's service itself, which it refuses as secrets. */
export const HOST_NAMES = /^(FLOW_AGENT_ID|FLOW_AGENT_NAME|FLOW_ENVIRONMENT|FLOW_STORE_URL|FLOW_STORE_TOKEN|FLOW_STORE_FRAMEWORK|FLOW_STORE_CHINWAG|FLOW_API_TOKEN|FLOW_PLAYGROUND_TOKEN|FLOW_CLI_BUCKET|FLOW_WEB_CHAT_SESSION_KEY|FLOW_TRUST_PROXY|AGENT_VERSION|AGENT_DIR|PORT)$|^(FLOW_STORE_|CHINWAG_TRACES_|FLOW_FRAMEWORK_TRACES_|K_)/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** A name `secrets --from-env` sends: two characters at least, as the host takes them. */
const ENV_SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * Left out of the packed folder: dependencies (the build runs npm ci), git, every .env, and the
 * framework's local results (.flow, .chinwag before the rename), which the hosted agent never reads.
 */
export const PACK_EXCLUDES = ["node_modules", ".git", ".env", ".env.*", ".DS_Store", ".flow", ".chinwag"];
export const MAX_BUNDLE = 50 * 1024 * 1024;
const GIVE_UP_MS = 20 * 60 * 1000;

/**
 * A .env file's names and values: NAME=value lines, `export ` allowed, values in single or double
 * quotes taken as written (double quotes understand \n), an unquoted value up to a ` #` comment.
 */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2]!;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
      if (quote === '"') value = value.replace(/\\n/g, "\n");
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out.set(m[1]!, value);
  }
  return out;
}

function readEnvFile(file: string): Map<string, string> {
  try {
    return parseEnv(readFileSync(file, "utf8"));
  } catch {
    return new Map();
  }
}

/** The agent's folder as a .tgz at `bundle`, without PACK_EXCLUDES. */
export function pack(dir: string, bundle: string): void {
  execFileSync("tar", ["-czf", bundle, ...PACK_EXCLUDES.map((p) => `--exclude=${p}`), "-C", dir, "."], { stdio: ["ignore", "ignore", "inherit"] });
}

interface Finding {
  level: "error" | "warning";
  code: string;
  message: string;
}
interface Deploy {
  id: string;
  environment: string;
  status: string;
  version: string | null;
  findings: Finding[];
  error: string | null;
  url?: string | null;
}

class Refused extends Error {
  readonly code: string;
  /** The cloud has no such route (an older Flow): a plain 404 or 405, not one of its JSON errors. */
  readonly missing: boolean;
  constructor(message: string, code: string, missing = false) {
    super(message);
    this.code = code;
    this.missing = missing;
  }
}
class Usage extends Error {}
/** The agent's Flow Framework is newer than hosting's (hosting's own code for it, chinwag_too_new). */
class TooNew extends Error {
  readonly next: string;
  constructor(message: string, next: string) {
    super(message);
    this.next = next;
  }
}
/** What this Flow's cloud cannot do yet; the CLI side is ready for when it can. */
class NotAvailable extends Error {}

type Api = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export interface DeployOptions {
  /** Where the value of `flow deploy secret` comes from (default: stdin). */
  readStdin?: () => string;
  /** Milliseconds between looks at a building deploy, or new log lines with --follow (default 3000). */
  pollMs?: number;
  /** With `flow logs --follow`: stop after this many looks (tests); default never. */
  maxPolls?: number;
  /** The clock, for --since (tests). */
  now?: () => number;
}

/** `flow deploy ...`. */
export function deployCli(argv: string[], env: NodeJS.ProcessEnv = process.env, options: DeployOptions = {}): Promise<number> {
  return cloudCli("deploy", argv, env, options);
}

/** `flow logs ...`. */
export function logsCli(argv: string[], env: NodeJS.ProcessEnv = process.env, options: DeployOptions = {}): Promise<number> {
  return cloudCli("logs", argv, env, options);
}

async function cloudCli(top: "deploy" | "logs", argv: string[], env: NodeJS.ProcessEnv, options: DeployOptions): Promise<number> {
  const usage = top === "logs" ? LOGS_USAGE : DEPLOY_USAGE;
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        env: { type: "string" },
        dir: { type: "string", default: "." },
        version: { type: "string" },
        cloud: { type: "string" },
        "from-env": { type: "boolean" },
        "no-secrets": { type: "boolean" },
        "no-cli": { type: "boolean" },
        since: { type: "string" },
        follow: { type: "boolean", short: "f" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${usage}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(usage);
    return 0;
  }
  const json = Boolean(values.json);
  const say = json ? (line: string) => console.error(line) : (line: string) => console.log(line);
  const fail = failer(json);

  const command = top === "logs" ? "logs" : positionals[0];
  const args = top === "logs" ? positionals : positionals.slice(1);
  const given = values.env;
  if (given !== undefined && given !== "staging" && given !== "production") return fail("usage", `--env is staging or production\n\n${usage}`, 2);
  if (command !== "logs" && (values.since !== undefined || values.follow)) return fail("usage", `--since and --follow go with flow logs\n\n${usage}`, 2);
  const environment: "staging" | "production" = given ?? "staging";
  const dir = resolve(values.dir!);
  const { key, cloud, api, dotEnv } = cloudOf(dir, env, values.cloud);
  if (!key) return fail("no_ci_key", NO_KEY, 2, `${RUN} setup`);

  const ctx: Ctx = { api, say, json, dir, pollMs: options.pollMs ?? 3000, maxPolls: options.maxPolls, now: options.now ?? Date.now, keyId: createHash("sha256").update(key).digest("hex").slice(0, 16), env: { ...Object.fromEntries(dotEnv), ...env } };
  try {
    const [name, extra] = args;
    for (const flag of ["no-secrets", "no-cli"] as const) if (values[flag] && command !== undefined && command !== "promote") throw new Usage(`--${flag} goes with flow deploy and deploy promote\n\n${usage}`);
    if (command === "logs") {
      if (name !== undefined) throw new Usage(`flow logs takes no arguments.\n\n${usage}`);
      return await logs(ctx, environment, values.since ?? "1h", Boolean(values.follow));
    }
    if (extra !== undefined || (name !== undefined && command !== "secret" && command !== "secrets")) throw new Usage(`Too many arguments.\n\n${usage}`);
    if (command === "promote") return await promote(ctx, !values["no-secrets"], !values["no-cli"]);
    if (command === "status") return await status(ctx, given ? [given] : ["staging", "production"]);
    if (command === "secret") return await secret(ctx, name, environment, options.readStdin ?? (() => readFileSync(0, "utf8")));
    if (command === "secrets") {
      if (!values["from-env"]) throw new Usage(`secrets takes --from-env [<file>]\n\n${usage}`);
      return await secretsFromEnv(ctx, resolve(name ? name : join(dir, ".env")), environment);
    }
    if (command !== undefined) throw new Usage(`Unknown command: deploy ${command}\n\n${usage}`);
    return await deploy(ctx, dir, environment, values.version, !values["no-secrets"], !values["no-cli"]);
  } catch (error) {
    if (error instanceof Usage) return fail("usage", error.message, 2);
    if (error instanceof TooNew) return fail("chinwag_too_new", `Refused: ${error.message}`, 1, error.next);
    if (error instanceof NotAvailable) return fail("not_available", error.message, 1);
    if (error instanceof PackError) return fail(error.code, `The CLI did not pack, so nothing was sent: ${error.message}`, error.exit, "fix it, or add --no-cli");
    if (error instanceof Refused) return fail(error.code, `Refused: ${error.message}`, 1);
    return fail("network", `Could not reach ${cloud}: ${(error as Error).message}`, 1);
  }
}

/** Prints a failure, also as JSON with --json; returns the exit code. */
function failer(json: boolean): (code: string, message: string, exit: number, next?: string) => number {
  return (code, message, exit, next) => {
    if (json) console.log(JSON.stringify({ ok: false, error: { code, message }, next: next ?? null }));
    console.error(next ? `${message}\nNext: ${next}` : message);
    return exit;
  };
}

const NO_KEY = "Set FLOW_FRAMEWORK_CLOUD_KEY to your agent's CI key (oci_...), in the environment or the agent's .env.";

/** The cloud's address and the agent's CI key (the environment's, else the agent's .env's), and a caller of the cloud's routes. */
function cloudOf(dir: string, env: NodeJS.ProcessEnv, given: string | undefined): { key: string | undefined; cloud: string; api: Api; dotEnv: Map<string, string> } {
  const dotEnv = readEnvFile(join(dir, ".env"));
  const setting = (...names: string[]) => {
    for (const name of names) if (env[name]) return env[name];
    for (const name of names) if (dotEnv.get(name)) return dotEnv.get(name);
    return undefined;
  };
  const key = setting("FLOW_FRAMEWORK_CLOUD_KEY", "CHINWAG_CLOUD_KEY");
  const cloud = (given || setting("FLOW_FRAMEWORK_CLOUD", "CHINWAG_CLOUD") || DEFAULT_CLOUD).replace(/\/$/, "");
  const api: Api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(cloud + path, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let answer: { error?: { code?: string; message?: string; hint?: string } } & Record<string, unknown> = {};
    try {
      answer = JSON.parse(text);
    } catch {
      // not JSON: the status says it
    }
    if (!res.ok) {
      const why = answer.error?.message ?? `${res.status} ${res.statusText}`;
      const missing = (res.status === 404 || res.status === 405) && typeof answer.error?.code !== "string";
      throw new Refused(answer.error?.hint ? `${why} (${answer.error.hint})` : why, answer.error?.code ?? "refused", missing);
    }
    return answer as T;
  };
  return { key, cloud, api, dotEnv };
}

interface Ctx {
  api: Api;
  say: (line: string) => void;
  json: boolean;
  dir: string;
  pollMs: number;
  maxPolls: number | undefined;
  now: () => number;
  /** Which agent (a hash of its CI key), for .flow/secrets.json. */
  keyId: string;
  /** The environment, over the agent's .env: where the version's settings (FLOW_AGENT_VERSION, a CI's commit) are read. */
  env: NodeJS.ProcessEnv;
}

async function deploy(ctx: Ctx, dir: string, env: "staging" | "production", version: string | undefined, withSecrets: boolean, withCli: boolean): Promise<number> {
  for (const file of ["package.json", "package-lock.json", "src/agent.ts"]) {
    if (!existsSync(join(dir, file))) throw new Usage(`${join(dir, file)} is missing: deploy the agent's folder (npm install makes package-lock.json).`);
  }
  await frameworkFits(ctx, dir, env);
  if (version === undefined) {
    version = agentVersion({ dir, env: ctx.env })?.version;
    if (version?.endsWith("+dirty")) console.error("Warning: deploying uncommitted changes; commit first so the version names what runs.");
  }
  const tmp = mkdtempSync(join(tmpdir(), "flow-deploy-"));
  try {
    const cli = withCli ? await cliStep(ctx, env, tmp) : undefined;
    const bundle = join(tmp, "agent.tgz");
    pack(dir, bundle);
    const size = statSync(bundle).size;
    if (size > MAX_BUNDLE) throw new Usage(`The packed folder is ${mb(size)}, over ${mb(MAX_BUNDLE)}. Leave large files out of it.`);
    ctx.say(`Packed ${dir} (${mb(size)})${version ? `, version ${version}` : ""}.`);
    const made = await ctx.api<{ deploy: Deploy; upload_url: string }>("POST", "/v1/hosting/deploys", { environment: env, ...(version ? { version } : {}) });
    // The agent exists on the host once its first deploy is made, so its secrets go now, before
    // the build starts: the service's first version starts with them.
    if (withSecrets) await secretsFirst(ctx, env, "deploy");
    const put = await fetch(made.upload_url, { method: "PUT", headers: { "content-type": "application/gzip" }, body: readFileSync(bundle) });
    if (!put.ok) throw new Refused(`the upload failed (${put.status})`, "upload_failed");
    await ctx.api("POST", `/v1/hosting/deploys/${made.deploy.id}/start`);
    remember(ctx.dir, env, made.deploy.id);
    ctx.say(`Deploy ${made.deploy.id} to ${env}: building.`);
    return await follow(ctx, made.deploy.id, cli);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The framework packages hosting loads, in its order (hosting's runtime/load.ts). */
const FRAMEWORKS = ["@flow-engineer/flow", "chinwag"] as const;

/**
 * The Flow Framework the build will install: the package the agent's package.json depends on (else
 * the first in its lock), at the version its package-lock.json pins. Undefined when the lock does
 * not say.
 */
export function lockedFramework(dir: string): { package: string; version: string } | undefined {
  const read = (file: string): Record<string, unknown> => {
    try {
      const value = JSON.parse(readFileSync(join(dir, file), "utf8"));
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  };
  const declared = (read("package.json").dependencies ?? {}) as Record<string, unknown>;
  const lock = read("package-lock.json") as { packages?: Record<string, { version?: unknown }>; dependencies?: Record<string, { version?: unknown }> };
  const locked = (name: string) => {
    const v = lock.packages?.[`node_modules/${name}`]?.version ?? lock.dependencies?.[name]?.version;
    return typeof v === "string" && /^\d+\.\d+/.test(v) ? v : undefined;
  };
  const order = [...FRAMEWORKS.filter((n) => n in declared), ...FRAMEWORKS.filter((n) => !(n in declared))];
  for (const name of order) {
    const version = locked(name);
    if (version) return { package: name, version };
    if (name in declared) return undefined;
  }
  return undefined;
}

/** A version's release line as numbers: "0.4.11" → [0, 4]. */
const releaseLine = (v: string) => v.split(/[.-]/).slice(0, 2).map((n) => Number.parseInt(n, 10) || 0);

/** Whether `a` is on a newer release line (major.minor) than `than`, as hosting's lint decides (0.5.0 against 0.4.11, not 0.4.12). */
export function newerLine(a: string, than: string): boolean {
  const [a0, a1] = releaseLine(a);
  const [b0, b1] = releaseLine(than);
  return a0! !== b0! ? a0! > b0! : a1! > b1!;
}

/**
 * Refuses, before anything is packed or sent, an agent whose locked Flow Framework is on a newer
 * release line than the one hosting runs. Only when both versions are known: a cloud without
 * GET /v1/hosting/framework, an answer without a version, or any failure to ask, deploys as before
 * (the build's lint still refuses it).
 */
async function frameworkFits(ctx: Ctx, dir: string, env: string): Promise<void> {
  const agent = lockedFramework(dir);
  if (!agent) return;
  let hosted: unknown;
  try {
    hosted = (await ctx.api<{ framework?: { version?: unknown } }>("GET", "/v1/hosting/framework")).framework?.version;
  } catch {
    return;
  }
  if (typeof hosted !== "string" || !/^\d+\.\d+/.test(hosted)) return;
  if (!newerLine(agent.version, hosted)) return;
  const line = releaseLine(hosted).join(".");
  throw new TooNew(
    `The agent's package-lock.json pins ${agent.package} ${agent.version}; Flow hosts Flow Framework ${line}.x (${hosted}) today, so ${env} would refuse it after the upload. Nothing was sent.`,
    `npm install @flow-engineer/flow@${hosted}, then ${RUN} deploy${env === "production" ? " --env production" : ""} (or deploy again once Flow updates)`,
  );
}

/**
 * The .env's new or changed values as secrets for `env`, before what would start without them;
 * a refused one stops it there. The names sent are printed.
 */
async function secretsFirst(ctx: Ctx, env: string, what: "deploy" | "promote"): Promise<void> {
  const file = join(ctx.dir, ".env");
  if (!existsSync(file)) return;
  const sent = await sendSecrets(ctx, file, env, true);
  if (sent.refused.length) {
    const one = sent.refused.length === 1;
    throw new Refused(
      `${sent.refused.map((r) => r.name).join(", ")} could not be saved as ${one ? "a secret" : "secrets"} for ${env} (${sent.refused.map((r) => `${r.name}: ${r.message}`).join("; ")}), so this ${what} did not start. Fix or remove ${one ? "it" : "them"} in .env, then ${RUN} deploy${what === "promote" ? " promote" : ""} again (or add --no-secrets)`,
      "secret_refused",
    );
  }
  if (sent.saved.length) ctx.say(`Sent ${sent.saved.length} secret${sent.saved.length === 1 ? "" : "s"} from .env to ${env}: ${sent.saved.join(", ")}.`);
}

async function promote(ctx: Ctx, withSecrets: boolean, withCli: boolean): Promise<number> {
  const tmp = mkdtempSync(join(tmpdir(), "flow-promote-"));
  try {
    // A production build of the CLI, from this folder.
    const cli = withCli ? await cliStep(ctx, "production", tmp) : undefined;
    // Production keeps secrets of its own: the .env's go there first, so the promoted version has them.
    if (withSecrets) await secretsFirst(ctx, "production", "promote");
    const { deploy } = await ctx.api<{ deploy: Deploy }>("POST", "/v1/hosting/promote");
    remember(ctx.dir, "production", deploy.id);
    ctx.say(`Promoting staging's ${deploy.version ?? "live version"} to production (${deploy.id}).`);
    return await follow(ctx, deploy.id, cli);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** What publishing the CLI after a deploy came to, for the deploy's answer; failed makes the deploy exit 1. */
interface CliOutcome {
  cli: ({ published: true } & Published) | { published: false; code: string; message: string };
  failed: boolean;
}

/**
 * The CLI's part of a deploy, when the folder has src/cli.ts: packed into `out` before anything is
 * sent, for the address it will be served from, so a CLI that does not pack stops the deploy there;
 * published once the deploy is live (the step returned). Before an environment's first deploy it
 * has no address yet, so it is packed once live. Without esbuild, or on a Flow whose hosting serves
 * no CLIs, the deploy goes on without it and says so.
 */
async function cliStep(ctx: Ctx, environment: "staging" | "production", out: string): Promise<(() => Promise<CliOutcome>) | undefined> {
  if (!existsSync(join(ctx.dir, "src", "cli.ts"))) return undefined;
  const skipped = (code: string, message: string): CliOutcome => {
    ctx.say(message);
    return { cli: { published: false, code, message }, failed: false };
  };
  const noEsbuild = (error: unknown) => error instanceof PackError && error.code === "no_esbuild";
  const leftOut = (error: PackError) => skipped("no_esbuild", `The CLI (src/cli.ts) is left out: ${error.message} (or add --no-cli).`);
  let packed: PackedCli | undefined;
  try {
    const url = (await fixedServer(ctx.dir, environment)) ? undefined : await hostedAddress(ctx, environment).catch(() => null);
    if (url) packed = await packFor(ctx, environment, url, out);
    else if (url === undefined) packed = await packHosted(ctx, environment, undefined, out);
  } catch (error) {
    if (!noEsbuild(error)) throw error;
    return async () => leftOut(error as PackError);
  }
  return async () => {
    try {
      packed ??= await packHosted(ctx, environment, undefined, out);
      return { cli: { published: true, ...(await publish(ctx, environment, packed, out)) }, failed: false };
    } catch (error) {
      if (noEsbuild(error)) return leftOut(error as PackError);
      if (error instanceof Refused && error.code === "cli_off") return skipped("cli_off", "This Flow's hosting serves no CLIs yet: the CLI was not published.");
      if (error instanceof Refused && error.code === "server_changed") return skipped("server_changed", `Warning: the CLI was not published. ${error.message}.`);
      const code = error instanceof Refused || error instanceof PackError ? error.code : "network";
      const message = (error as Error).message;
      console.error(`The CLI was not published: ${message}\nNext: ${RUN} cli publish --env ${environment}`);
      return { cli: { published: false, code, message }, failed: true };
    }
  };
}

async function secret(ctx: Ctx, name: string | undefined, env: string, readStdin: () => string): Promise<number> {
  if (!name || !SECRET_NAME.test(name)) throw new Usage(`A secret's name is upper case letters, digits and _ (like ANTHROPIC_API_KEY).\n\n${DEPLOY_USAGE}`);
  if (process.stdin.isTTY) console.error(`Paste ${name}'s value for ${env}, then press Enter and Ctrl-D:`);
  const value = readStdin().replace(/\r?\n$/, "");
  if (!value) throw new Usage("No value on stdin.");
  const saved = await ctx.api<{ name: string; last4: string }>("PUT", `/v1/hosting/secrets/${name}`, { environment: env, value });
  const next = `${RUN} deploy${env === "production" ? " --env production" : ""}`;
  if (ctx.json) console.log(JSON.stringify({ ok: true, secret: { name: saved.name, last4: saved.last4, environment: env }, next }));
  ctx.say(`Saved ${saved.name} (••••${saved.last4}) for ${env}. It takes effect on the next deploy.`);
  ctx.say(`Next: ${next}`);
  return 0;
}

interface Sent {
  saved: string[];
  skipped: Array<{ name: string; why: string }>;
  refused: Array<{ name: string; message: string }>;
  unchanged: string[];
}

/** Where flow deploy keeps a hash per secret it sent (never a value), to send only new or changed ones. */
const SENT = join(".flow", "secrets.json");

const secretHash = (ctx: Ctx, env: string, name: string, value: string) => createHash("sha256").update(`${ctx.keyId}\0${env}\0${name}\0${value}`).digest("hex");

function sentHashes(dir: string): Record<string, Record<string, string>> {
  try {
    const known = JSON.parse(readFileSync(join(dir, SENT), "utf8"));
    return known && typeof known === "object" ? known : {};
  } catch {
    return {};
  }
}

/**
 * Every non-empty value in a .env file as a secret, one each, the names only printed; with
 * `onlyChanged`, the ones .flow/secrets.json shows were already sent are left alone. Each one saved
 * is recorded there as a hash.
 */
async function sendSecrets(ctx: Ctx, file: string, env: string, onlyChanged: boolean): Promise<Sent> {
  const entries = [...parseEnv(readFileSync(file, "utf8"))].filter(([, value]) => value !== "");
  const out: Sent = { saved: [], skipped: [], refused: [], unchanged: [] };
  const all = sentHashes(ctx.dir);
  const scope = `${ctx.keyId}:${env}`;
  const known = { ...(all[scope] ?? {}) };
  for (const [name, value] of entries) {
    if (CLI_NAMES.has(name)) continue;
    if (HOST_NAMES.test(name)) {
      out.skipped.push({ name, why: "set by Flow" });
      if (!onlyChanged) ctx.say(`  ${name} skipped (set by Flow)`);
      continue;
    }
    if (!ENV_SECRET_NAME.test(name)) {
      out.skipped.push({ name, why: "not upper case letters, digits and _" });
      ctx.say(`  ${name} skipped: a secret's name is upper case letters, digits and _`);
      continue;
    }
    const hash = secretHash(ctx, env, name, value);
    if (onlyChanged && known[name] === hash) {
      out.unchanged.push(name);
      continue;
    }
    try {
      await ctx.api("PUT", `/v1/hosting/secrets/${name}`, { environment: env, value });
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      out.refused.push({ name, message: error.message });
      console.error(`  ${name} refused: ${error.message}`);
      continue;
    }
    out.saved.push(name);
    known[name] = hash;
    if (!onlyChanged) ctx.say(`  ${name} set`);
  }
  if (out.saved.length) {
    try {
      mkdirSync(join(ctx.dir, ".flow"), { recursive: true });
      writeFileSync(join(ctx.dir, SENT), `${JSON.stringify({ ...all, [scope]: known }, null, 2)}\n`);
    } catch {
      // only saves sending them again next time
    }
  }
  return out;
}

/** `flow deploy secrets --from-env`: every non-empty value in a .env file as a secret now. */
async function secretsFromEnv(ctx: Ctx, file: string, env: string): Promise<number> {
  if (!existsSync(file)) throw new Usage(`${file} is missing.`);
  const { saved, skipped, refused } = await sendSecrets(ctx, file, env, false);
  const deployCmd = `${RUN} deploy${env === "production" ? " --env production" : ""}`;
  const neverDeployed = refused.length > 0 && refused.every((r) => /never been deployed/.test(r.message));
  const next = neverDeployed ? `${deployCmd} (it sends the .env's values itself)` : deployCmd;
  if (ctx.json) console.log(JSON.stringify({ ok: refused.length === 0, environment: env, saved, skipped, refused, next }));
  if (saved.length) ctx.say(`Saved ${saved.length} secret${saved.length === 1 ? "" : "s"} for ${env}. They take effect on the next deploy.`);
  if (refused.length) {
    console.error(
      neverDeployed
        ? `Refused: this agent has not been deployed yet, so ${env} took no secrets. ${deployCmd} deploys it and sends the .env's values as secrets before it starts.`
        : `Refused: ${refused.length} secret${refused.length === 1 ? "" : "s"} not saved (${refused.map((r) => r.name).join(", ")}).`,
    );
    console.error(`Next: ${next}`);
    return 1;
  }
  if (!saved.length) ctx.say(`No secrets saved from ${file}.`);
  else ctx.say(`Next: ${next}`);
  return 0;
}

/** Follows a deploy until it is live, refused or failed, printing each change. */
async function follow(ctx: Ctx, id: string, cli?: () => Promise<CliOutcome>): Promise<number> {
  const until = Date.now() + GIVE_UP_MS;
  let last = "";
  for (;;) {
    const { deploy } = await ctx.api<{ deploy: Deploy }>("GET", `/v1/hosting/deploys/${id}`);
    if (deploy.status !== last) {
      last = deploy.status;
      if (!["live", "refused", "failed", "replaced"].includes(deploy.status)) ctx.say(`  ${deploy.status}…`);
    }
    if (["live", "refused", "failed", "replaced"].includes(deploy.status)) {
      for (const f of deploy.findings ?? []) ctx.say(`  ${f.level === "error" ? "✗" : "!"} ${f.code}: ${f.message}`);
      const live = deploy.status === "live" || deploy.status === "replaced";
      const url = live ? (deploy.url ?? (await address(ctx, deploy.environment))) : null;
      const next = !live
        ? deploy.status === "refused"
          ? `fix the errors above, then ${RUN} deploy${deploy.environment === "production" ? " --env production" : ""}`
          : `see the deploy's page in the dashboard, then ${RUN} deploy again`
        : deploy.environment === "staging"
          ? `try it in your agent's Playground (Staging) in the dashboard, then ${RUN} deploy promote`
          : "open your agent's Playground (Production) in the dashboard";
      if (live) {
        ctx.say(`Live in ${deploy.environment}.`);
        ctx.say(`URL: ${url ?? NO_URL}`);
      }
      // Once live, the CLI is published for it.
      const after = live && cli ? await cli() : undefined;
      if (ctx.json) {
        const { id: deployId, environment, status, version, findings, error } = deploy;
        console.log(JSON.stringify({ ok: live && !after?.failed, deploy: { id: deployId, environment, status, version, findings: findings ?? [], error }, url, cli: after?.cli ?? null, next }));
      }
      if (live) {
        ctx.say(`Next: ${next}`);
        return after?.failed ? 1 : 0;
      }
      if (!ctx.json) console.error(deploy.status === "refused" ? "Refused: fix the errors above and deploy again." : `Failed: ${deploy.error ?? "the build or the service did not start"}.`);
      else ctx.say(deploy.status === "refused" ? "Refused." : `Failed: ${deploy.error ?? "the build or the service did not start"}.`);
      return 1;
    }
    if (Date.now() > until) {
      ctx.say(`Still ${deploy.status} after 20 minutes. Its page in the dashboard shows where it is.`);
      return 1;
    }
    await new Promise((r) => setTimeout(r, ctx.pollMs));
  }
}

const NO_URL = "not available on this Flow yet (the dashboard's Playground opens it)";

/** The service's address, when the cloud tells it (GET /v1/hosting/address); null when it does not. */
async function address(ctx: Pick<Ctx, "api">, environment: string): Promise<string | null> {
  try {
    const { url } = await ctx.api<{ url?: string | null }>("GET", `/v1/hosting/address?environment=${encodeURIComponent(environment)}`);
    return typeof url === "string" && url ? url : null;
  } catch {
    return null;
  }
}

/** Where `flow deploy` keeps the last deploy it made per environment, for `deploy status`: in .flow, never packed. */
const STATE = join(".flow", "deploys.json");

function remember(dir: string, environment: string, id: string): void {
  try {
    const file = join(dir, STATE);
    const known = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
    mkdirSync(join(dir, ".flow"), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ ...known, [environment]: { id } }, null, 2)}\n`);
  } catch {
    // only a convenience for status
  }
}

function remembered(dir: string, environment: string): string | undefined {
  try {
    const id = (JSON.parse(readFileSync(join(dir, STATE), "utf8")) as Record<string, { id?: unknown }>)[environment]?.id;
    return typeof id === "string" && /^hdp_[0-9A-Za-z]+$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a deploy's revision sends message text in its traces, and whether that is Flow's default or the owner's secret (absent on an older Flow). */
interface TraceText {
  on: boolean;
  source: "flow" | "owner";
}

interface EnvironmentStatus {
  environment: string;
  /** The deploy serving it: the newest live one; else the newest. */
  deploy: (Deploy & { created_at?: string; updated_at?: string; source?: string; trace_text?: TraceText | null }) | null;
  /** A newer deploy still on its way (building, deploying), when there is one. */
  pending: { id: string; status: string; version: string | null } | null;
  url: string | null;
  /** list: the cloud's own list; this_folder: the last deploy this folder made. */
  from: "list" | "this_folder" | null;
}

/** `flow deploy status`: per environment, what is live, its version, when, and its URL. */
async function status(ctx: Ctx, environments: string[]): Promise<number> {
  const found: EnvironmentStatus[] = [];
  for (const environment of environments) {
    let deploys: EnvironmentStatus["deploy"][] = [];
    let from: EnvironmentStatus["from"] = null;
    try {
      deploys = (await ctx.api<{ deploys: NonNullable<EnvironmentStatus["deploy"]>[] }>("GET", `/v1/hosting/deploys?environment=${environment}`)).deploys ?? [];
      from = "list";
    } catch (error) {
      if (!(error instanceof Refused) || !error.missing) throw error;
      // This Flow lists deploys by CI key only to a dashboard member: the last one this folder made.
      const id = remembered(ctx.dir, environment);
      if (id) {
        deploys = [(await ctx.api<{ deploy: NonNullable<EnvironmentStatus["deploy"]> }>("GET", `/v1/hosting/deploys/${id}`)).deploy];
        from = "this_folder";
      }
    }
    const newestFirst = [...deploys].sort((a, b) => String(b!.created_at ?? "").localeCompare(String(a!.created_at ?? "")));
    const live = newestFirst.find((d) => d!.status === "live") ?? null;
    const top = newestFirst[0] ?? null;
    const serving = live ?? top;
    const pending = top && top !== serving && !["live", "refused", "failed", "replaced"].includes(top.status) ? { id: top.id, status: top.status, version: top.version } : null;
    const url = live ? (live.url ?? (await address(ctx, environment))) : null;
    found.push({ environment, deploy: serving, pending, url, from });
  }
  const anyLive = found.some((f) => f.deploy?.status === "live");
  const next = anyLive
    ? `${RUN} logs${found.length === 1 && found[0]!.environment === "production" ? " --env production" : ""}`
    : `${RUN} deploy`;
  if (ctx.json) {
    console.log(JSON.stringify({ ok: true, environments: Object.fromEntries(found.map((f) => [f.environment, f.deploy ? { deploy: pick(f.deploy), pending: f.pending, url: f.url, from: f.from } : null])), next }));
    return 0;
  }
  for (const f of found) {
    if (!f.deploy) {
      ctx.say(`${f.environment}: no deploy known${f.from === null ? " (this Flow lists deploys to a dashboard member only, and this folder has made none: the dashboard shows them)" : ""}.`);
      continue;
    }
    const d = f.deploy;
    const when = d.updated_at ?? d.created_at;
    ctx.say(`${f.environment}: ${d.status}${d.version ? `, version ${d.version}` : ""}, deploy ${d.id}${when ? `, ${d.status === "live" ? "deployed" : "updated"} ${when}` : ""}${f.from === "this_folder" ? " (the last deploy from this folder)" : ""}`);
    if (d.status === "live") ctx.say(`  URL: ${f.url ?? NO_URL}`);
    if (d.trace_text) ctx.say(`  trace text: ${d.trace_text.on ? "on" : "off"} (${d.trace_text.source === "owner" ? "set by you" : "Flow's default"})`);
    if (f.pending) ctx.say(`  then ${f.pending.id}${f.pending.version ? ` (${f.pending.version})` : ""}: ${f.pending.status}…`);
  }
  ctx.say(`Next: ${next}`);
  return 0;
}

const pick = (d: NonNullable<EnvironmentStatus["deploy"]>) => ({
  id: d.id,
  environment: d.environment,
  status: d.status,
  version: d.version,
  source: d.source ?? null,
  created_at: d.created_at ?? null,
  updated_at: d.updated_at ?? null,
  trace_text: d.trace_text ?? null,
});

interface LogLine {
  time: string;
  severity?: string;
  text: string;
}

/** --since as seconds: 30s, 15m, 1h, 2d. */
export function sinceSeconds(since: string): number | undefined {
  const m = since.match(/^(\d+)(s|m|h|d)$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"];
}

/**
 * `flow logs`: the hosted agent's log lines, from GET /v1/hosting/logs?environment=&since=&after=
 * → { lines: [{ time, severity, text }], next } (next: the cursor for the lines after these).
 * A Flow without that route says so and exits 1.
 */
async function logs(ctx: Ctx, environment: string, since: string, followLines: boolean): Promise<number> {
  const seconds = sinceSeconds(since);
  if (seconds === undefined || seconds <= 0 || seconds > 30 * 86400) throw new Usage(`--since is a duration such as 30s, 15m, 1h or 2d (at most 30d).\n\n${LOGS_USAGE}`);
  const from = new Date(ctx.now() - seconds * 1000).toISOString();
  let after: string | undefined;
  let polls = 0;
  for (;;) {
    const query = new URLSearchParams({ environment, ...(after ? { after } : { since: from }) });
    let page: { lines?: LogLine[]; next?: string | null };
    try {
      page = await ctx.api("GET", `/v1/hosting/logs?${query}`);
    } catch (error) {
      if (error instanceof Refused && error.missing) {
        throw new NotAvailable(`Logs are not available on this Flow yet: its cloud has no logs route for a CI key. The dashboard shows the agent's deploys; ${RUN} deploy status shows what is live.`);
      }
      throw error;
    }
    for (const line of page.lines ?? []) {
      if (ctx.json) console.log(JSON.stringify({ time: line.time, severity: line.severity ?? null, text: line.text }));
      else console.log(`${line.time} ${(line.severity ?? "").padEnd(7)} ${line.text}`);
    }
    if (page.next) after = page.next;
    polls++;
    if (!followLines || (ctx.maxPolls !== undefined && polls >= ctx.maxPolls)) return 0;
    await new Promise((r) => setTimeout(r, ctx.pollMs));
  }
}

export const CLI_RELEASE_LINE = `  flow cli pack --server <staging|production|url> [--base-url <url>] [--out <folder>] [--json]
                            The agent's CLI (src/cli.ts) as one package anyone with Node.js
                            installs, with its installer (flow cli pack --help)
  flow cli publish|rollback|status --env staging|production
                            Its releases on Flow's hosting: curl -fsSL <agent's address> | sh`;

export const CLI_RELEASE_USAGE = `Usage:
  flow cli pack --server <staging|production|url> [--base-url <url>] [--out <folder>] [--dir <folder>] [--json]
      Bundles the agent's CLI (src/cli.ts) with everything it needs, so Node.js 20.19 or newer is
      all a computer needs to run it, and writes into <out>:
        <name>.tgz     the package: npm install --global <name>.tgz installs it
        install.sh     its installer: curl -fsSL <base-url> | sh
        release.json   { name, display_name, version, sha256, size, server }
  flow cli publish --env staging|production [--server <url>] [--change-server] [--dir <folder>] [--json]
      Packs it for that environment's hosted agent and makes it the version the agent serves:
      curl -fsSL <the agent's address> | sh installs it, and the CLIs out there are offered it.
      flow deploy does this itself after a deploy (--no-cli leaves the CLI out). It refuses a
      build whose server differs from the one served (everyone would sign in again), unless
      --change-server.
  flow cli rollback --env staging|production <version> [--json]
      Serves an earlier published version again; people on the one it replaces are offered it.
  flow cli status [--env staging|production] [--json]
      The version served and the last releases, per environment.

  --server     The MCP server the packed CLI uses: staging or production (the CLI file's
               servers.<env> when set, else the hosted agent's address, asked of the cloud with the
               CI key, plus /mcp), or an https URL. It takes the place of the default server
               written in src/cli.ts, which must be there once.
               The CLI keeps sign-ins by server: never change it for a CLI people already use.
               publish takes an https URL to pack for a domain of the agent other than its address.
  --base-url   Where you serve install.sh and <name>-<version>.tgz yourself: install.sh downloads
               <base-url>/cli/<name>-<version>.tgz. Without it install.sh is for Flow's hosting,
               which fills in the address it serves it from.
  --out        Where pack writes (default: release/ in the agent's folder).
  --dir        The agent's folder (default: .).
  --json       Print one JSON answer on stdout (progress goes to stderr).
  --cloud, FLOW_FRAMEWORK_CLOUD_KEY: as for flow deploy (flow deploy --help).

The version is package.json's, the server's name and the git commit: 0.1.3-production.ab12cd3
(custom for an https server; .dirty at the end with uncommitted changes). Unless src/cli.ts sets
update itself, the packed CLI asks <base>/cli/version for a newer version and <name> update runs
curl -fsSL <base> | sh, where <base> is --base-url, else the hosted agent's address, else the
server's origin. The files in defineCli({ files }) go beside the bundle (cliFile(path) finds them).
The packed CLI's --help must run from a fresh folder before it is packed. esbuild bundles it, an
optional peer of Flow Framework: npm i -D esbuild.`;

/** `flow cli pack|publish|rollback|status ...`, the words after `cli`. */
export async function cliReleaseCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        env: { type: "string" },
        server: { type: "string" },
        "base-url": { type: "string" },
        out: { type: "string" },
        dir: { type: "string", default: "." },
        cloud: { type: "string" },
        "change-server": { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${CLI_RELEASE_USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(CLI_RELEASE_USAGE);
    return 0;
  }
  const json = Boolean(values.json);
  const say = json ? (line: string) => console.error(line) : (line: string) => console.log(line);
  const fail = failer(json);
  const usage = (message: string) => fail("usage", `${message}\n\n${CLI_RELEASE_USAGE}`, 2);
  const [command, ...args] = positionals;
  const https = (url: string | undefined) => url !== undefined && /^https:\/\/[^/\s]/.test(url) && URL.canParse(url);
  const environment = values.env;
  if (!["pack", "publish", "rollback", "status"].includes(command ?? "")) return usage(`Unknown command: cli ${positionals.join(" ")}`);
  if (environment !== undefined && environment !== "staging" && environment !== "production") return usage("--env is staging or production");
  if (command !== "pack" && command !== "status" && !environment) return usage(`cli ${command} needs --env staging or --env production`);
  if (command === "pack" ? environment !== undefined : values["base-url"] !== undefined || values.out !== undefined) return usage(`--env goes with publish, rollback and status; --base-url and --out with pack`);
  if (command === "pack" && values.server !== "staging" && values.server !== "production" && !https(values.server)) return usage("--server is staging, production or an https URL");
  if (command === "publish" && values.server !== undefined && !https(values.server)) return usage("publish's --server is an https URL (else the environment's address)");
  if (command !== "pack" && command !== "publish" && values.server !== undefined) return usage("--server goes with pack and publish");
  if (values["base-url"] !== undefined && !https(values["base-url"])) return usage("--base-url is an https URL");
  if (values["change-server"] && command !== "publish") return usage("--change-server goes with publish");
  if (args.length !== (command === "rollback" ? 1 : 0)) return usage(command === "rollback" ? "cli rollback takes the version to serve again" : `cli ${command} takes no arguments`);

  const dir = resolve(values.dir!);
  const { key, cloud, api } = cloudOf(dir, env, values.cloud);
  // A pack may need no cloud (an https server, or the CLI file's servers): it says when it does.
  if (!key && command !== "pack") return fail("no_ci_key", NO_KEY, 2, `${RUN} setup`);
  const ctx: CliCtx = { api, say, json, dir, noKey: !key };
  try {
    if (command === "pack") {
      const hosted = https(values.server) ? undefined : (values.server as "staging" | "production");
      const out = values.out ? resolve(values.out) : join(dir, "release");
      const release = hosted ? await packHosted(ctx, hosted, undefined, out, values["base-url"]) : await packCli({ dir, server: values.server!, label: "custom", base: (values["base-url"] ?? new URL(values.server!).origin).replace(/\/+$/, ""), baseUrl: values["base-url"], out, say });
      const files = { tgz: join(out, `${release.name}.tgz`), installer: join(out, "install.sh"), release: join(out, "release.json") };
      const next = hosted ? `${RUN} cli publish --env ${hosted} (or npm install --global ${files.tgz} to try it here)` : `npm install --global ${files.tgz} (tries it on this computer)`;
      if (json) console.log(JSON.stringify({ ok: true, release, files, next }));
      say(`Next: ${next}`);
      return 0;
    }
    if (command === "publish") {
      const published = await packAndPublish(ctx, environment!, values.server, Boolean(values["change-server"]));
      const next = `${published.install}  (installs it; ${RUN} cli status --env ${environment} shows the releases)`;
      if (json) console.log(JSON.stringify({ ok: true, ...published, next }));
      say(`Next: ${next}`);
      return 0;
    }
    if (command === "rollback") return await rollback(ctx, environment!, args[0]!);
    return await cliStatus(ctx, environment ? [environment] : ["staging", "production"]);
  } catch (error) {
    if (error instanceof PackError) return fail(error.code, error.message, error.exit);
    if (error instanceof Refused && error.code === "cli_off") return fail("cli_off", CLI_OFF, 1);
    if (error instanceof Refused && error.code === "no_ci_key") return fail("no_ci_key", NO_KEY, 2, `${RUN} setup`);
    if (error instanceof Refused && error.code === "server_changed") return fail("server_changed", `Refused: ${error.message}`, 1);
    if (error instanceof Refused) return fail(error.code, `Refused: ${error.message}`, 1, NEXT_AFTER[error.code]?.(environment ?? "staging"));
    return fail("network", `Could not reach ${cloud}: ${(error as Error).message}`, 1);
  }
}

const CLI_OFF = `This Flow's hosting serves no CLIs (cli_off). ${RUN} cli pack --server <url> --base-url <url> packs one to serve yourself.`;

/** What to do next after a refusal the CLI routes give. */
const NEXT_AFTER: Record<string, (env: string) => string> = {
  version_exists: () => "commit the changes and publish again: a new commit is a new version",
  already_published: (env) => `${RUN} cli rollback --env ${env} <version> serves an earlier version again`,
  not_published: (env) => `${RUN} cli status --env ${env} lists the published versions`,
  already_current: (env) => `${RUN} cli status --env ${env}`,
};

interface CliCtx {
  api: Api;
  say: (line: string) => void;
  json: boolean;
  dir: string;
  /** No CI key: only a pack that asks the cloud nothing can go on. */
  noKey?: boolean;
}

/** A CLI release, as the host keeps it. */
interface CliRelease {
  version: string;
  name: string;
  display_name: string;
  environment: string;
  sha256: string;
  size: number;
  status: "uploading" | "published";
  created_at: string;
  published_at: string | null;
  published_by: string | null;
}

/** The version an environment serves (the host's current.json). */
interface CliCurrent {
  name: string;
  display_name: string;
  version: string;
  sha256: string;
  size: number;
  tgz: string;
  installer: string;
  published_at: string;
  published_by: string;
  rolled_back_from: string | null;
  /** The server packed into it; older clouds do not say. */
  server?: string;
}

/** The hosted agent's address in an environment; null before its first deploy. */
async function hostedAddress(ctx: Pick<CliCtx, "api">, environment: string): Promise<string | null> {
  const { url } = await ctx.api<{ url?: string | null }>("GET", `/v1/hosting/address?environment=${environment}`);
  return typeof url === "string" && url ? url.replace(/\/+$/, "") : null;
}

/** Packs the CLI for an environment: its hosted address plus /mcp, or the https server given (a domain of the agent's own). */
async function packHosted(ctx: CliCtx, environment: "staging" | "production", server: string | undefined, out: string, baseUrl?: string): Promise<PackedCli> {
  if (server) return packCli({ dir: ctx.dir, server, label: "custom", base: new URL(server).origin, out, say: ctx.say });
  // The CLI file's own server for the environment (defineCli({ servers })), else the hosted address.
  const fixed = await fixedServer(ctx.dir, environment);
  if (fixed) return packCli({ dir: ctx.dir, server: fixed, label: environment, base: (baseUrl ?? new URL(fixed).origin).replace(/\/+$/, ""), baseUrl, out, say: ctx.say });
  if (ctx.noKey) throw new Refused(NO_KEY, "no_ci_key");
  const url = await hostedAddress(ctx, environment);
  if (!url) throw new Refused(`${environment} has no address yet: deploy the agent there first (${RUN} deploy${environment === "production" ? " promote" : ""})`, "no_address");
  return packFor(ctx, environment, url, out, baseUrl);
}

/** Packs the CLI for a hosted address: its /mcp the server, the address where it is served from. */
function packFor(ctx: CliCtx, environment: "staging" | "production", url: string, out: string, baseUrl?: string): Promise<PackedCli> {
  return packCli({ dir: ctx.dir, server: `${url}/mcp`, label: environment, base: (baseUrl ?? url).replace(/\/+$/, ""), baseUrl, out, say: ctx.say });
}

interface Published {
  release: CliRelease;
  current: CliCurrent;
  /** How people install it: curl -fsSL <base> | sh. */
  install: string;
}

/** Packs the CLI for an environment into a folder of its own, then publishes it. */
async function packAndPublish(ctx: CliCtx, environment: "staging" | "production", server: string | undefined, changeServer: boolean): Promise<Published> {
  const out = mkdtempSync(join(tmpdir(), "flow-cli-release-"));
  try {
    const packed = await packHosted(ctx, environment, server, out);
    return await publish(ctx, environment, packed, out, changeServer);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/**
 * Publishes a packed release: the host makes it (or finds it, the same sha256) and signs an upload
 * URL for the package and one for the installer, both PUT with no key; then makes it current.
 */
async function publish(ctx: CliCtx, environment: string, packed: PackedCli, out: string, changeServer = false): Promise<Published> {
  const { name, display_name, version, sha256, size, server } = packed;
  // People's sign-ins are kept by server: a release with another one would sign everyone out.
  const { current } = await ctx.api<{ current: CliCurrent | null }>("GET", `/v1/hosting/cli/releases?environment=${environment}`);
  if (current?.server && current.server !== server && !changeServer) {
    throw new Refused(
      `${environment}'s CLI uses ${current.server}, and this build ${server}: everyone who installed it would have to sign in again. To keep ${current.server}, set defineCli({ servers: { ${environment}: "${current.server}" } }) in src/cli.ts; to change it on purpose, ${RUN} cli publish --env ${environment} --change-server`,
      "server_changed",
    );
  }
  const made = await ctx.api<{ release: CliRelease; uploads?: { tgz: string; installer: string } }>("POST", "/v1/hosting/cli/releases", { environment, name, display_name, version, sha256, size, server });
  // A version already published needs no upload: publishing the current one again changes nothing.
  if (made.release.status !== "published" && made.uploads) {
    for (const [url, file, type] of [[made.uploads.tgz, `${name}.tgz`, "application/gzip"], [made.uploads.installer, "install.sh", "text/x-shellscript; charset=utf-8"]] as const) {
      const put = await fetch(url, { method: "PUT", headers: { "content-type": type }, body: readFileSync(join(out, file)) });
      if (!put.ok) throw new Refused(`the upload of ${file} failed (${put.status})`, "upload_failed");
    }
  }
  const done = await ctx.api<{ release: CliRelease; current: CliCurrent }>("POST", `/v1/hosting/cli/releases/${encodeURIComponent(version)}/publish`, { environment });
  const install = `curl -fsSL ${new URL(packed.server).origin} | sh`;
  ctx.say(`Published ${name} ${version} to ${environment} (${(size / 1024).toFixed(0)} KB). ${install}`);
  return { release: done.release, current: done.current, install };
}

/** `flow cli rollback`: serves an earlier published version again. */
async function rollback(ctx: CliCtx, environment: string, version: string): Promise<number> {
  const { current } = await ctx.api<{ current: CliCurrent }>("POST", "/v1/hosting/cli/rollback", { environment, version });
  const next = `${RUN} cli status --env ${environment}`;
  if (ctx.json) console.log(JSON.stringify({ ok: true, current, next }));
  ctx.say(`${environment} serves ${current.name} ${current.version} again${current.rolled_back_from ? `, in place of ${current.rolled_back_from}: people on ${current.rolled_back_from} are offered ${current.version} by ${current.name} update` : ""}.`);
  ctx.say(`Next: ${next}`);
  return 0;
}

/** `flow cli status`: per environment, the version served and the releases, newest first. */
async function cliStatus(ctx: CliCtx, environments: string[]): Promise<number> {
  const found: Array<{ environment: string; current: CliCurrent | null; releases: CliRelease[] }> = [];
  for (const environment of environments) {
    const { current, releases } = await ctx.api<{ current: CliCurrent | null; releases: CliRelease[] }>("GET", `/v1/hosting/cli/releases?environment=${environment}`);
    found.push({ environment, current: current ?? null, releases: releases ?? [] });
  }
  const next = `${RUN} cli publish --env ${environments.length === 1 ? environments[0] : "staging"}`;
  if (ctx.json) {
    console.log(JSON.stringify({ ok: true, environments: Object.fromEntries(found.map(({ environment, ...rest }) => [environment, rest])), next }));
    return 0;
  }
  for (const { environment, current, releases } of found) {
    if (!current) ctx.say(`${environment}: no CLI published.`);
    else ctx.say(`${environment}: ${current.name} ${current.version}, published ${current.published_at} by ${current.published_by}${current.rolled_back_from ? ` (rolled back from ${current.rolled_back_from})` : ""}`);
    for (const r of releases.slice(0, 10)) ctx.say(`  ${r.version}  ${(r.size / 1024).toFixed(0)} KB  ${r.published_at ? `published ${r.published_at}` : r.status}${r.version === current?.version ? "  (current)" : ""}`);
  }
  ctx.say(`Next: ${next}`);
  return 0;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
