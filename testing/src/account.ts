// `flow login | logout | whoami | setup | link`: sign in to flow.engineer once, then get the
// agent's keys into .env and a link to chat with it from a phone, with no key made by hand. `link`
// alone does it all: it signs in and runs setup first when this folder has not been set up.
// The calls to flow.engineer are in testing/src/flow-login.ts. Every command takes --json: one JSON
// object per line on stdout (login prints a "pending" line first, so a coding agent can show the
// link while it waits), every human line on stderr. Errors are {"error":{code,message,next}}, the
// next step the server's when it gave one. Every next step names the package (npx @flow-engineer/flow).
// Nothing reads stdin or needs a terminal, so a coding agent can run every command. login opens the
// browser itself and waits at most --timeout seconds; a code not approved by then stays in
// ~/.config/flow-framework/pending.json for `login --wait`, which polls the same code again.
// Exit status: 0 done, 1 usage or not signed in, 2 network, 3 the server refused (or the code was
// denied or expired), 4 the code is still waiting for approval.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  currentToken, deleteCredentials, deletePending, LoginRefused, loginUrl, pollToken, readCredentials, readPending, revoke, saveCredentials, savePending,
  SETUP_ENV, setup, startDevice, tryLink, whoami, type Account, type PendingLogin, type SetupAnswer,
} from "./flow-login.ts";
import { packageRoot } from "./new.ts";
import { RUN } from "../../src/names.ts";

export const ACCOUNT_COMMANDS = new Set(["login", "logout", "whoami", "setup", "link"]);

export const ACCOUNT_LINES = `  flow login [--wait | --no-wait] [--timeout <s>] [--force] [--no-browser] [--json]
                            Sign in to flow.engineer: opens the browser, prints the link and code,
                            and waits up to --timeout (default 120) for approval; --wait goes on
                            waiting for the same code, --no-wait returns at once
  flow logout [--json]      End this machine's sign-in and delete its token
  flow whoami [--json]      Show the account you are signed in as
  flow setup [--replace] [--ci] [--json]
                            Write this agent's keys (test cloud, traces, Flow Messaging) into ./.env
  flow link [--channel telegram|whatsapp|imessage] [--timeout <s>] [--no-browser] [--json]
                            Print the link that opens a chat with this agent from a phone; signs in
                            and runs setup first when this folder is not set up yet`;

const USAGE = `Usage:\n${ACCOUNT_LINES}

The token is kept in ~/.config/flow-framework/credentials.json (mode 0600); FLOW_FRAMEWORK_TOKEN, when
set, is used instead. setup never prints a key, only its last 4 characters, and keeps any value
already in .env unless --replace. CI never signs in: setup --ci says how to give it the agent's key.
Nothing asks for input. A code not approved in time is kept in ~/.config/flow-framework/pending.json
(mode 0600) until it expires, for ${RUN} login --wait. Signed in already, login says so; --force signs in again.

Exit status: 0 done, 1 usage or not signed in, 2 network, 3 refused, denied or expired,
4 still waiting for approval (run ${RUN} login --wait).`;

const NEXT = { login: `${RUN} login`, wait: `${RUN} login --wait`, setup: `${RUN} setup`, link: `${RUN} link` };
const CHANNELS = ["telegram", "whatsapp", "imessage"];
const EXIT = { ok: 0, usage: 1, network: 2, refused: 3, pending: 4 } as const;

class Stop extends Error {
  readonly code: string;
  readonly next: string | undefined;
  readonly exit: number;
  constructor(code: string, message: string, next: string | undefined, exit: number) {
    super(message);
    this.code = code;
    this.next = next;
    this.exit = exit;
  }
}

/** Runs one account command; resolves to the exit status. */
export async function accountCli(command: string, args: string[]): Promise<number> {
  let values: Record<string, boolean | string | undefined>;
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      options: {
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        ...(command === "login" || command === "link" ? { "no-browser": { type: "boolean", default: false }, timeout: { type: "string", default: "120" } } : {}),
        ...(command === "login"
          ? {
              wait: { type: "boolean", default: false },
              "no-wait": { type: "boolean", default: false },
              force: { type: "boolean", default: false },
            }
          : {}),
        ...(command === "setup" ? { replace: { type: "boolean", default: false }, ci: { type: "boolean", default: false } } : {}),
        ...(command === "link" ? { channel: { type: "string", default: "telegram" } } : {}),
      },
    }));
  } catch (error) {
    console.error(`flow ${command}: ${(error as Error).message.split(". ")[0]}\n\n${USAGE}`);
    return EXIT.usage;
  }
  if (values.help) {
    console.log(USAGE);
    return EXIT.ok;
  }
  const timeoutSeconds = Number(values.timeout);
  if ((command === "login" || command === "link") && (values.wait && values["no-wait"] || !(values.timeout !== "" && timeoutSeconds >= 0))) {
    console.error(`flow ${command}: ${values.wait && values["no-wait"] ? "--wait and --no-wait cannot go together" : "--timeout is a number of seconds, 0 or more"}.\n\n${USAGE}`);
    return EXIT.usage;
  }
  const channel = String(values.channel);
  if (command === "link" && !CHANNELS.includes(channel)) {
    console.error(`flow link: --channel takes ${CHANNELS.join(", ")}.\n\n${USAGE}`);
    return EXIT.usage;
  }
  const json = values.json === true;
  // Straight to the file descriptors, never buffered: a coding agent's cut-off command keeps every line.
  const out = (report: unknown) => writeAll(1, `${JSON.stringify(report)}\n`);
  const say = (line: string) => writeAll(json ? 2 : 1, `${line}\n`);
  try {
    if (command === "login") {
      await login({ noBrowser: values["no-browser"] === true, wait: values.wait === true, noWait: values["no-wait"] === true, force: values.force === true, timeoutSeconds }, json, out, say);
    }
    else if (command === "logout") await logout(json, out, say);
    else if (command === "whoami") await showAccount(json, out, say);
    else if (command === "setup") await setupEnv(values.replace === true, values.ci === true, json, out, say);
    else await link({ channel, noBrowser: values["no-browser"] === true, timeoutSeconds }, json, out, say);
    return EXIT.ok;
  } catch (error) {
    const stop = asStop(error);
    writeAll(2, `${stop.next ? `${stop.message} Next: ${stop.next}` : stop.message}\n`);
    if (json) out(stop instanceof Pending ? stop.report : { error: { code: stop.code, message: stop.message, next: stop.next ?? null } });
    return stop.exit;
  }
}

/** Writes all of the text to the descriptor before going on. */
function writeAll(fd: number, text: string): void {
  let bytes = Buffer.from(text);
  while (bytes.length) bytes = bytes.subarray(writeSync(fd, bytes));
}

type Out = (report: unknown) => void;
type Say = (line: string) => void;

function asStop(error: unknown): Stop {
  if (error instanceof Stop) return error;
  if (error instanceof LoginRefused) {
    if (error.status === 401) return new Stop("not_signed_in", "Your sign-in has ended or was revoked.", error.next ?? NEXT.login, EXIT.refused);
    return new Stop(error.code, error.message, error.next, EXIT.refused);
  }
  const cause = (error as { cause?: { code?: string } }).cause?.code;
  return new Stop("network", `Could not reach ${loginUrl()}: ${cause ?? (error as Error).message}.`, undefined, EXIT.network);
}

function signedIn(): string {
  const current = currentToken();
  if (!current) throw new Stop("not_signed_in", "Not signed in to flow.engineer.", NEXT.login, EXIT.usage);
  return current.token;
}

interface LoginOptions {
  noBrowser: boolean;
  wait: boolean;
  noWait: boolean;
  force: boolean;
  /** How long this run polls before it stops with the code still pending (exit 4). */
  timeoutSeconds: number;
  /** For `link`: polls a pending code if there is one, else starts one, and names `then` as the next step. */
  resume?: { then: string };
}

const WAIT_NEXT = `approve in the browser, then run: ${NEXT.wait}`;

async function login(options: LoginOptions, json: boolean, out: Out, say: Say): Promise<void> {
  const url = loginUrl();
  if (!options.force && !options.wait) {
    const already = await signedInAccount(url);
    if (already) {
      if (json) out({ status: "signed_in", already: true, account: already });
      say(`Already signed in as ${already.email}. ${RUN} login --force signs in again.`);
      return;
    }
  }
  let pending = options.wait || options.resume ? readPending() : undefined;
  if (pending && (pending.url !== url || pending.expires_at <= Date.now())) {
    say("The pending sign-in code has expired; starting a new sign-in.");
    deletePending();
    pending = undefined;
  } else if (options.wait && !pending) say("No sign-in is waiting; starting a new one.");
  const waitNext = options.resume ? `approve in the browser, then run: ${options.resume.then}` : WAIT_NEXT;
  const resumed = pending !== undefined;
  let opened = false;
  if (!pending) {
    const start = await startDevice(url, `flow ${JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")).version}`, hostname());
    pending = { ...start, expires_at: Date.now() + start.expires_in * 1000, url };
    savePending(pending);
    opened = !options.noBrowser && (await openBrowser(pending.verification_uri_complete || pending.verification_uri));
  }
  const page = pending.verification_uri_complete || pending.verification_uri;
  const expiresIn = Math.max(0, Math.round((pending.expires_at - Date.now()) / 1000));
  // Written straight to the file descriptors, so a coding agent whose command is cut off still has them.
  if (json) out({ status: "pending", verification_uri: pending.verification_uri, verification_uri_complete: page, user_code: pending.user_code, expires_in: expiresIn, opened_browser: opened, resumed, next: waitNext });
  if (resumed) say(`Still waiting for ${page} (code ${pending.user_code}).`);
  else if (opened) say(`Opened your browser at ${page}`);
  else say(`${options.noBrowser ? "Open" : "Could not open a browser here; open"} ${page}`);
  if (!resumed) say(`and check it shows the code ${pending.user_code}, then approve.`);
  if (options.noWait) throw new Pending(pending, null, waitNext, options.resume?.then);

  let interval = pending.interval;
  const stopAt = Date.now() + options.timeoutSeconds * 1000;
  for (;;) {
    await delay(Math.max(0, Math.min(interval * 1000, stopAt - Date.now())));
    if (Date.now() > pending.expires_at) throw expired();
    const answer = await pollToken(url, pending.device_code);
    if (answer.status === "slow_down") interval += 5; // RFC 8628: each slow_down adds 5 seconds for good
    if (answer.status === "authorization_pending" || answer.status === "slow_down") {
      if (Date.now() >= stopAt) throw new Pending(pending, options.timeoutSeconds, waitNext, options.resume?.then);
      continue;
    }
    deletePending();
    if (answer.status === "expired_token") throw expired();
    if (answer.status !== "signed_in") throw new Stop("access_denied", "The sign-in was denied in the browser.", NEXT.login, EXIT.refused);
    const path = saveCredentials({ token: answer.token, ...(answer.expires_at ? { expires_at: answer.expires_at } : {}), url });
    const account = answer.account ?? (await whoami(url, answer.token));
    if (json) out({ status: "signed_in", account, token_path: path });
    say(`Signed in as ${account.email}. The token is in ${path}.`);
    if (!options.resume) say(`Next, from your agent's folder: ${NEXT.setup}`);
    return;
  }
}

/** The account of the token in use, or undefined when there is none or the server no longer takes it. */
async function signedInAccount(url: string): Promise<Account | undefined> {
  const current = currentToken();
  if (!current) return undefined;
  try {
    return await whoami(url, current.token);
  } catch (error) {
    if (error instanceof LoginRefused && error.status === 401) return undefined;
    throw error;
  }
}

/** Not approved yet: the code stays in pending.json for `flow login --wait` (or `flow link` again), and the exit is 4. */
class Pending extends Stop {
  readonly report: Record<string, unknown>;
  /** `waited` is the seconds this run polled, null when it did not (--no-wait). */
  constructor(pending: PendingLogin, waited: number | null, next = WAIT_NEXT, command = NEXT.wait) {
    const page = pending.verification_uri_complete || pending.verification_uri;
    super("pending", waited !== null ? `Not approved yet after ${waited} s; the code ${pending.user_code} still works at ${page}.` : `Approve the code ${pending.user_code} at ${page}.`, command, EXIT.pending);
    this.report = { status: "pending", user_code: pending.user_code, verification_uri: pending.verification_uri, waited_s: waited ?? 0, next };
  }
}

const expired = () => {
  deletePending();
  return new Stop("expired_token", "The code expired before it was approved.", NEXT.login, EXIT.refused);
};

/** The commands that open a page in the default browser here, in the order to try them. */
function browserCommands(page: string): string[][] {
  if (process.platform === "darwin") return [["open", page]];
  if (process.platform === "win32") return [["cmd", "/c", "start", "", page]];
  const wsl = Boolean(process.env.WSL_DISTRO_NAME) || (existsSync("/proc/version") && /microsoft/i.test(readFileSync("/proc/version", "utf8")));
  if (wsl) return [["wslview", page], ["cmd.exe", "/c", "start", "", page]];
  // xdg-open needs a display; without one (a server, a sandbox) there is no browser to open.
  return process.env.DISPLAY || process.env.WAYLAND_DISPLAY ? [["xdg-open", page]] : [];
}

/** Opens the page in the default browser, never waiting for it; false when nothing here could (it is printed anyway). */
async function openBrowser(page: string): Promise<boolean> {
  for (const [command, ...args] of browserCommands(page)) {
    const started = await new Promise<boolean>((done) => {
      try {
        const child = spawn(command!, args, { detached: true, stdio: "ignore" });
        child.once("spawn", () => done(true));
        child.once("error", () => done(false));
        child.unref();
      } catch {
        done(false);
      }
    });
    if (started) return true;
  }
  return false;
}

async function logout(json: boolean, out: Out, say: Say): Promise<void> {
  const current = currentToken();
  if (!current) {
    if (json) out({ status: "signed_out" });
    say("Not signed in; nothing to do.");
    return;
  }
  await revoke(readCredentials()?.url ?? loginUrl(), current.token);
  const deleted = deleteCredentials();
  if (json) out({ status: "signed_out", revoked: true, deleted_file: deleted });
  say("Signed out: the token is revoked on flow.engineer and deleted from this machine.");
  if (current.from === "env") say("FLOW_FRAMEWORK_TOKEN is still set in this shell: unset it.");
}

async function showAccount(json: boolean, out: Out, say: Say): Promise<void> {
  const account: Account = await whoami(loginUrl(), signedIn());
  if (json) out(account);
  say(`Signed in to flow.engineer as ${account.email} (account ${account.account}).`);
}

const SECRET = new Set<string>([SETUP_ENV.cloud_key, SETUP_ENV.traces_key, SETUP_ENV.messaging_key]);
const masked = (name: string, value: string) => (SECRET.has(name) ? `${/^[a-z]+_(?:test_|live_)?/.exec(value)?.[0] ?? ""}…${value.slice(-4)}` : value);
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** The names set in a .env's lines, with their values unquoted. */
function envValues(lines: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of lines) {
    const match = ENV_LINE.exec(line);
    if (match) values.set(match[1]!, match[2]!.trim().replace(/^(["'])(.*)\1$/, "$2"));
  }
  return values;
}

async function setupEnv(replace: boolean, ci: boolean, json: boolean, out: Out, say: Say, forLink?: { channel: string }): Promise<void> {
  if (ci) {
    const steps = [
      `CI never signs in. It runs the tests with the agent's test cloud key, ${SETUP_ENV.cloud_key}, as a secret.`,
      `Run ${NEXT.setup} on your machine first, then copy the key from .env into your CI without printing it, for GitHub:`,
      `  grep '^${SETUP_ENV.cloud_key}=' .env | cut -d= -f2- | gh secret set ${SETUP_ENV.cloud_key}`,
      `and in the workflow: ${RUN} test --synthetic --json`,
    ];
    if (json) out({ ci: { secret: SETUP_ENV.cloud_key, steps } });
    for (const line of steps) say(line);
    return;
  }
  const token = signedIn();
  const dir = process.cwd();
  const file = join(dir, ".env");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = text ? text.split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  const before = envValues(lines);
  const packageJson = join(dir, "package.json");
  const named = (existsSync(packageJson) ? (JSON.parse(readFileSync(packageJson, "utf8")) as { name?: string }).name : undefined) ?? basename(dir);
  // The server takes 1 to 64 letters, digits, spaces, -, _ and .: a package's scope and other characters go.
  const name = named.replace(/^@[^/]*\//, "").replace(/[^A-Za-z0-9 ._-]/g, "-").slice(0, 64) || "my-agent";
  const have = Object.values(SETUP_ENV).filter((n) => n !== SETUP_ENV.try_url && before.get(n));
  let answer: SetupAnswer;
  try {
    answer = await setup(loginUrl(), token, { name, hostname: hostname(), channels: [forLink?.channel ?? "telegram"], have });
  } catch (error) {
    // A product failed: the keys that were minted anyway are not shown again, so they go into .env first.
    if (error instanceof LoginRefused && error.status === 502) {
      const written = writeEnv(file, lines, before, error.fields, replace);
      if (written.length) say(`Kept in .env before the error: ${written.map((w) => `${w.name} ${w.action}`).join(", ")}.`);
    }
    throw error;
  }
  const written = writeEnv(file, lines, before, answer as unknown as Record<string, unknown>, replace);

  const next = [`${RUN} test --synthetic`, "npm start", ...(answer.next?.length ? answer.next : [NEXT.link])];
  if (json) {
    out({
      agent: answer.agent_id, join_code: answer.join_code, env_written: { ".env": written }, minted: answer.minted ?? [],
      dashboard_url: answer.dashboard_url ?? null, try_url: answer.try_url ?? null, telegram_link: answer.telegram_link ?? null, next,
    });
  }
  say(`Agent ${answer.agent_id}. In .env:`);
  for (const w of written) say(`  ${w.name}=${w.value}  ${w.action}${w.action === "kept" ? " (yours differs; --replace takes the new one)" : ""}`);
  if (answer.dashboard_url) say(`Its dashboard: ${answer.dashboard_url}`);
  if (!forLink) say(`Next: ${next.join(", then ")}`);
}

type Written = { name: string; action: "added" | "unchanged" | "kept" | "replaced"; value: string };

/** Merges setup's fields into .env's lines and writes the file when anything changed. */
function writeEnv(file: string, lines: string[], before: Map<string, string>, fields: Record<string, unknown>, replace: boolean): Written[] {
  const written: Written[] = [];
  for (const [field, envName] of Object.entries(SETUP_ENV)) {
    const value = fields[field];
    if (typeof value !== "string" || !value) continue;
    const old = before.get(envName);
    let action: Written["action"];
    if (old === undefined) {
      lines.push(`${envName}=${value}`);
      action = "added";
    } else if (old === value) action = "unchanged";
    else if (!replace) action = "kept";
    else {
      const at = lines.findIndex((line) => ENV_LINE.exec(line)?.[1] === envName);
      lines[at] = `${envName}=${value}`;
      action = "replaced";
    }
    written.push({ name: envName, action, value: masked(envName, action === "kept" ? old! : value) });
  }
  if (written.some((w) => w.action === "added" || w.action === "replaced")) writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  return written;
}

interface LinkOptions {
  channel: string;
  noBrowser: boolean;
  timeoutSeconds: number;
}

/** The names set in ./.env, with what the environment sets winning. */
function dotenvValue(): (name: string) => string | undefined {
  const file = join(process.cwd(), ".env");
  const saved = existsSync(file) ? envValues(readFileSync(file, "utf8").split("\n")) : new Map<string, string>();
  return (name) => process.env[name] || saved.get(name);
}

/**
 * The phone link for this folder's join code. Not set up yet (no join code or no Flow Messaging key
 * in .env): it signs in first when it has to (the same login, resuming a code already waiting) and
 * runs setup, then asks flow.engineer for the channel's page, so a channel that is not open yet
 * answers with the server's next step instead of a link that does not work.
 */
async function link(options: LinkOptions, json: boolean, out: Out, say: Say): Promise<void> {
  const again = `${NEXT.link}${options.channel === "telegram" ? "" : ` --channel ${options.channel}`}`;
  let value = dotenvValue();
  if (!value(SETUP_ENV.join_code) || !value(SETUP_ENV.messaging_key)) {
    if (!(await signedInAccount(loginUrl()))) {
      say("Not signed in to flow.engineer yet: signing in first.");
      await login({ noBrowser: options.noBrowser, wait: false, noWait: false, force: true, timeoutSeconds: options.timeoutSeconds, resume: { then: again } }, json, out, say);
    }
    say("Setting up this agent's keys in .env.");
    await setupEnv(false, false, json, out, say, { channel: options.channel });
    value = dotenvValue();
  }
  const joinCode = value(SETUP_ENV.join_code);
  if (!joinCode) throw new Stop("no_join_code", `Setup wrote no ${SETUP_ENV.join_code} into .env.`, NEXT.setup, EXIT.refused);
  // The server's own try_url when setup kept one for this join code and channel, else the same page built here.
  const fromServer = value(SETUP_ENV.try_url);
  const url = fromServer?.includes(`/try/${encodeURIComponent(joinCode)}?`) && URL.parse(fromServer)?.searchParams.get("c") === options.channel ? fromServer : tryLink(loginUrl(), joinCode, options.channel);
  await checkTryPage(url);
  const what = options.channel === "telegram" ? "Telegram" : options.channel === "whatsapp" ? "WhatsApp" : "iMessage";
  const sayToPerson = `Open this on your phone and send the message ${what} fills in: ${url}`;
  if (json) out({ url, channel: options.channel, join_code: joinCode, say_to_person: sayToPerson });
  say(url);
  say(`Open it on a phone with ${what} and send the message it fills in, with your join code. From then on`);
  say("that phone chats with this agent while it runs (npm start), with no public URL or tunnel.");
}

/**
 * Asks flow.engineer for the try page as JSON: a channel it cannot open yet (or a join code it does
 * not know) answers {"error", "error_description", "next"}, which stops here with that next step.
 */
async function checkTryPage(url: string): Promise<void> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (response.ok) return void (await response.body?.cancel());
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {}
  const code = typeof body.error === "string" ? body.error : `http_${response.status}`;
  const detail = typeof body.error_description === "string" ? body.error_description : `${url} answered ${response.status}.`;
  throw new Stop(code, detail, typeof body.next === "string" && body.next ? body.next : undefined, EXIT.refused);
}
