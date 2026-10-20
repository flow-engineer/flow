// `flow deploy`: puts the agent in this folder on Flow's hosting, through the cloud (observe's
// /v1/hosting routes) with the agent's CI key. Node's own modules only.
//
//   flow deploy [--env staging|production] [--dir .] [--version <v>] [--json]   pack, upload, build, go live
//   flow deploy promote [--json]                                                 staging's live version to production
//   flow deploy status [--env staging|production] [--json]                       what is live, its version, when, its URL
//   flow logs [--env staging|production] [--since 1h] [--follow] [--json]        the hosted agent's log lines
//   flow deploy secret <NAME> [--env staging|production] [--json]                a secret, its value read from stdin
//   flow deploy secrets --from-env [<file>] [--env staging|production] [--json]  every value in the agent's .env
//
// The folder is packed without node_modules, .git, .env files and the framework's local results
// (.flow); its package-lock.json is installed with `npm ci` in the build, and the build runs
// hosting's lint (its findings are printed here). Nothing here prints a key or a secret's value.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { RUN } from "../../src/names.ts";
const DEFAULT_CLOUD = "https://flow.engineer/observe";

export const DEPLOY_LINE = `  flow deploy [--env staging|production] [--dir <folder>] [--version <v>] [--json]
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
  flow deploy [--env staging|production] [--dir <folder>] [--version <v>] [--json]
  flow deploy promote [--json]                             staging's live version to production
  flow deploy status [--env staging|production] [--json]   what is live, its version, when, and its URL
  flow deploy secret <NAME> [--env staging|production]     the value on stdin
  flow deploy secrets --from-env [<file>] [--env staging|production]
                                                           every value in <file> (default: the agent's .env)

  --env        Where (default: staging). Production takes only an agent whose buildAgent passes
               options.host on to createAgent, with no database of its own.
  --dir        The agent's folder (default: .): package.json, package-lock.json, src/agent.ts.
  --version    A label for this version (default: the folder's git commit, if any).
  --cloud      The cloud's address (default: FLOW_FRAMEWORK_CLOUD, else ${DEFAULT_CLOUD}).
  --from-env   With secrets: send each non-empty value in the file as a secret (never the CI key,
               the cloud's address, or a name Flow sets itself, such as the
               FLOW_FRAMEWORK_TRACES_* that flow link writes). Prints names only.
  --json       Print one JSON answer on stdout (progress goes to stderr).

status shows both environments unless --env names one. The last deploy this folder made is kept
in .flow/deploys.json (never packed).

Environment (or the agent folder's .env):
  FLOW_FRAMEWORK_CLOUD_KEY   The agent's CI key (oci_...): flow setup writes it, or make one on
                             your agent's Developers page. CHINWAG_CLOUD_KEY, its older name, works too.`;

/** The CLI's own settings in a .env: never sent as secrets. */
const CLI_NAMES = new Set(["FLOW_FRAMEWORK_CLOUD_KEY", "CHINWAG_CLOUD_KEY", "FLOW_FRAMEWORK_CLOUD", "CHINWAG_CLOUD"]);
/** Names the host sets on the agent's service itself, which it refuses as secrets. */
export const HOST_NAMES = /^(FLOW_AGENT_ID|FLOW_AGENT_NAME|FLOW_ENVIRONMENT|FLOW_STORE_URL|FLOW_STORE_TOKEN|FLOW_STORE_FRAMEWORK|FLOW_STORE_CHINWAG|FLOW_API_TOKEN|FLOW_PLAYGROUND_TOKEN|AGENT_VERSION|AGENT_DIR|PORT)$|^(FLOW_STORE_|CHINWAG_TRACES_|FLOW_FRAMEWORK_TRACES_|K_)/;
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
  const fail = (code: string, message: string, exit: number, next?: string): number => {
    if (json) console.log(JSON.stringify({ ok: false, error: { code, message }, next: next ?? null }));
    console.error(next ? `${message}\nNext: ${next}` : message);
    return exit;
  };

  const command = top === "logs" ? "logs" : positionals[0];
  const args = top === "logs" ? positionals : positionals.slice(1);
  const given = values.env;
  if (given !== undefined && given !== "staging" && given !== "production") return fail("usage", `--env is staging or production\n\n${usage}`, 2);
  if (command !== "logs" && (values.since !== undefined || values.follow)) return fail("usage", `--since and --follow go with flow logs\n\n${usage}`, 2);
  const environment: "staging" | "production" = given ?? "staging";
  const dir = resolve(values.dir!);
  const dotEnv = readEnvFile(join(dir, ".env"));
  const setting = (...names: string[]) => {
    for (const name of names) if (env[name]) return env[name];
    for (const name of names) if (dotEnv.get(name)) return dotEnv.get(name);
    return undefined;
  };
  const key = setting("FLOW_FRAMEWORK_CLOUD_KEY", "CHINWAG_CLOUD_KEY");
  if (!key) return fail("no_ci_key", "Set FLOW_FRAMEWORK_CLOUD_KEY to your agent's CI key (oci_...), in the environment or the agent's .env.", 2, `${RUN} setup`);
  const cloud = (values.cloud || setting("FLOW_FRAMEWORK_CLOUD", "CHINWAG_CLOUD") || DEFAULT_CLOUD).replace(/\/$/, "");

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

  const ctx: Ctx = { api, say, json, dir, pollMs: options.pollMs ?? 3000, maxPolls: options.maxPolls, now: options.now ?? Date.now };
  try {
    const [name, extra] = args;
    if (command === "logs") {
      if (name !== undefined) throw new Usage(`flow logs takes no arguments.\n\n${usage}`);
      return await logs(ctx, environment, values.since ?? "1h", Boolean(values.follow));
    }
    if (extra !== undefined || (name !== undefined && command !== "secret" && command !== "secrets")) throw new Usage(`Too many arguments.\n\n${usage}`);
    if (command === "promote") return await promote(ctx);
    if (command === "status") return await status(ctx, given ? [given] : ["staging", "production"]);
    if (command === "secret") return await secret(ctx, name, environment, options.readStdin ?? (() => readFileSync(0, "utf8")));
    if (command === "secrets") {
      if (!values["from-env"]) throw new Usage(`secrets takes --from-env [<file>]\n\n${usage}`);
      return await secretsFromEnv(ctx, resolve(name ? name : join(dir, ".env")), environment);
    }
    if (command !== undefined) throw new Usage(`Unknown command: deploy ${command}\n\n${usage}`);
    return await deploy(ctx, dir, environment, values.version);
  } catch (error) {
    if (error instanceof Usage) return fail("usage", error.message, 2);
    if (error instanceof NotAvailable) return fail("not_available", error.message, 1);
    if (error instanceof Refused) return fail(error.code, `Refused: ${error.message}`, 1);
    return fail("network", `Could not reach ${cloud}: ${(error as Error).message}`, 1);
  }
}

interface Ctx {
  api: Api;
  say: (line: string) => void;
  json: boolean;
  dir: string;
  pollMs: number;
  maxPolls: number | undefined;
  now: () => number;
}

async function deploy(ctx: Ctx, dir: string, env: string, version: string | undefined): Promise<number> {
  for (const file of ["package.json", "package-lock.json", "src/agent.ts"]) {
    if (!existsSync(join(dir, file))) throw new Usage(`${join(dir, file)} is missing: deploy the agent's folder (npm install makes package-lock.json).`);
  }
  version ??= gitVersion(dir);
  const tmp = mkdtempSync(join(tmpdir(), "flow-deploy-"));
  try {
    const bundle = join(tmp, "agent.tgz");
    pack(dir, bundle);
    const size = statSync(bundle).size;
    if (size > MAX_BUNDLE) throw new Usage(`The packed folder is ${mb(size)}, over ${mb(MAX_BUNDLE)}. Leave large files out of it.`);
    ctx.say(`Packed ${dir} (${mb(size)})${version ? `, version ${version}` : ""}.`);
    const made = await ctx.api<{ deploy: Deploy; upload_url: string }>("POST", "/v1/hosting/deploys", { environment: env, ...(version ? { version } : {}) });
    const put = await fetch(made.upload_url, { method: "PUT", headers: { "content-type": "application/gzip" }, body: readFileSync(bundle) });
    if (!put.ok) throw new Refused(`the upload failed (${put.status})`, "upload_failed");
    await ctx.api("POST", `/v1/hosting/deploys/${made.deploy.id}/start`);
    remember(ctx.dir, env, made.deploy.id);
    ctx.say(`Deploy ${made.deploy.id} to ${env}: building.`);
    return await follow(ctx, made.deploy.id);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function promote(ctx: Ctx): Promise<number> {
  const { deploy } = await ctx.api<{ deploy: Deploy }>("POST", "/v1/hosting/promote");
  remember(ctx.dir, "production", deploy.id);
  ctx.say(`Promoting staging's ${deploy.version ?? "live version"} to production (${deploy.id}).`);
  return await follow(ctx, deploy.id);
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

/** Every non-empty value in a .env file as a secret, one each; the names only are printed. */
async function secretsFromEnv(ctx: Ctx, file: string, env: string): Promise<number> {
  if (!existsSync(file)) throw new Usage(`${file} is missing.`);
  const entries = [...parseEnv(readFileSync(file, "utf8"))].filter(([, value]) => value !== "");
  const saved: string[] = [];
  const skipped: Array<{ name: string; why: string }> = [];
  const refused: Array<{ name: string; message: string }> = [];
  for (const [name, value] of entries) {
    if (CLI_NAMES.has(name)) continue;
    if (HOST_NAMES.test(name)) {
      skipped.push({ name, why: "set by Flow" });
      ctx.say(`  ${name} skipped (set by Flow)`);
      continue;
    }
    if (!ENV_SECRET_NAME.test(name)) {
      skipped.push({ name, why: "not upper case letters, digits and _" });
      ctx.say(`  ${name} skipped: a secret's name is upper case letters, digits and _`);
      continue;
    }
    try {
      await ctx.api("PUT", `/v1/hosting/secrets/${name}`, { environment: env, value });
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      refused.push({ name, message: error.message });
      ctx.say(`  ${name} refused: ${error.message}`);
      continue;
    }
    saved.push(name);
    ctx.say(`  ${name} set`);
  }
  const next = `${RUN} deploy${env === "production" ? " --env production" : ""}`;
  if (ctx.json) console.log(JSON.stringify({ ok: refused.length === 0, environment: env, saved, skipped, refused, next }));
  ctx.say(saved.length ? `Saved ${saved.length} secret${saved.length === 1 ? "" : "s"} for ${env}. They take effect on the next deploy.` : `No secrets saved from ${file}.`);
  if (saved.length) ctx.say(`Next: ${next}`);
  return refused.length ? 1 : 0;
}

/** Follows a deploy until it is live, refused or failed, printing each change. */
async function follow(ctx: Ctx, id: string): Promise<number> {
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
      if (ctx.json) {
        const { id: deployId, environment, status, version, findings, error } = deploy;
        console.log(JSON.stringify({ ok: live, deploy: { id: deployId, environment, status, version, findings: findings ?? [], error }, url, next }));
      }
      if (live) {
        ctx.say(`Live in ${deploy.environment}.`);
        ctx.say(`URL: ${url ?? NO_URL}`);
        ctx.say(`Next: ${next}`);
        return 0;
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
async function address(ctx: Ctx, environment: string): Promise<string | null> {
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

interface EnvironmentStatus {
  environment: string;
  /** The deploy serving it: the newest live one; else the newest. */
  deploy: (Deploy & { created_at?: string; updated_at?: string; source?: string }) | null;
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

function gitVersion(dir: string): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
