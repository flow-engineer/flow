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
// denied or expired), 4 the code is still waiting for approval, or flow.engineer asked to wait
// (429 slow_down: the wait is printed, and is retry_after with --json). A server's warnings go to
// stderr one per line, and into the JSON as `warnings`.

import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  currentToken, deleteCredentials, deletePending, LoginRefused, loginUrl, pollToken, readPending, REQUEST_TIMEOUT_MS, revoke, saveCredentials, savePending,
  SETUP_ENV, setup, startDevice, TimedOut, tryLink, warningsOf, whoami, type Account, type PendingLogin, type SetupAnswer,
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
                            Write this agent's keys (test cloud, traces, Flow Messaging) and each
                            open channel's sender into ./.env (in an agent's folder: package.json)
  flow link [--channel telegram|whatsapp|imessage] [--timeout <s>] [--no-browser] [--json]
                            Print the link that opens a chat with this agent from a phone; signs in
                            and runs setup first when this folder is not set up yet`;

const USAGE = `Usage:\n${ACCOUNT_LINES}

The token is kept in ~/.config/flow-framework/credentials.json (mode 0600); FLOW_FRAMEWORK_TOKEN, when
set, is used instead. setup never prints a key, only its last 4 characters, and keeps any value
already in .env unless --replace (a name with no value counts as missing), and sets .env to 0600.
The token goes only to the server that issued it, over https (http only to localhost). CI never signs in: setup --ci says how to give it the agent's key.
Nothing asks for input. A code not approved in time is kept in ~/.config/flow-framework/pending.json
(mode 0600) until it expires, for ${RUN} login --wait. Signed in already, login says so; --force signs in again.

Exit status: 0 done, 1 usage or not signed in, 2 network, 3 refused, denied or expired,
4 still waiting for approval (run ${RUN} login --wait), or flow.engineer asked to wait (try again after the time it gives).`;

const NEXT = { login: `${RUN} login`, wait: `${RUN} login --wait`, setup: `${RUN} setup`, link: `${RUN} link` };
const CHANNELS = ["telegram", "whatsapp", "imessage"];
const EXIT = { ok: 0, usage: 1, network: 2, refused: 3, pending: 4 } as const;

class Stop extends Error {
  readonly code: string;
  readonly next: string | undefined;
  readonly exit: number;
  /** For a 429: the seconds flow.engineer asked to wait, null when it gave none. */
  retryAfter: number | null | undefined;
  /** The server's warnings that came with the error. */
  warnings: string[] = [];
  constructor(code: string, message: string, next: string | undefined, exit: number) {
    super(message);
    this.code = code;
    this.next = next;
    this.exit = exit;
  }
}

/**
 * A next step to run (a command or a URL) goes after "Next:"; anything else is a sentence for the
 * owner (a trial limit's next) and is printed on its own line as it came.
 */
const isCommand = (next: string) => /^(?:npx|npm|flow|gh) |^https?:\/\//.test(next);

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
    printWarnings(stop.warnings);
    writeAll(2, `${!stop.next ? stop.message : isCommand(stop.next) ? `${stop.message} Next: ${stop.next}` : `${stop.message}\n${stop.next}`}\n`);
    if (json) {
      out(stop instanceof Pending ? stop.report : {
        error: { code: stop.code, message: stop.message, next: stop.next ?? null, ...(stop.retryAfter !== undefined ? { retry_after: stop.retryAfter } : {}) },
        ...(stop.warnings.length ? { warnings: stop.warnings } : {}),
      });
    }
    return stop.exit;
  }
}

/** The server's warnings, one per line on stderr, as they came. */
function printWarnings(warnings: string[]): void {
  for (const warning of warnings) writeAll(2, `${warning}\n`);
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
    let stop: Stop;
    if (error.status === 401) stop = new Stop("not_signed_in", "Your sign-in has ended or was revoked.", error.next ?? NEXT.login, EXIT.refused);
    else if (error.status === 429) {
      // Asked to wait: retryable, so the same exit as a sign-in still waiting.
      const wait = error.retryAfter;
      stop = new Stop(error.code, `${error.message} ${wait !== undefined ? `Wait ${wait} s before trying again.` : "Wait a little before trying again."}`, error.next, EXIT.pending);
      stop.retryAfter = wait ?? null;
    }
    // Status 0: refused here, before any request (an http login URL).
    else stop = new Stop(error.code, error.message, error.next, error.status === 0 ? EXIT.usage : EXIT.refused);
    stop.warnings = warningsOf(error.fields);
    return stop;
  }
  if (error instanceof TimedOut) return new Stop("timeout", error.message, undefined, EXIT.network);
  const cause = (error as { cause?: { code?: string } }).cause?.code;
  return new Stop("network", `Could not reach ${loginUrl()}: ${cause ?? (error as Error).message}.`, undefined, EXIT.network);
}

/**
 * The token to send and the server to send it to. A saved token goes only to the server that issued
 * it: with FLOW_FRAMEWORK_LOGIN_URL now naming another one, it is not sent at all.
 */
function signedIn(): { token: string; url: string } {
  const url = loginUrl();
  const current = currentToken();
  if (!current) throw new Stop("not_signed_in", "Not signed in to flow.engineer.", NEXT.login, EXIT.usage);
  if (current.url && current.url !== url) {
    throw new Stop("signed_in_elsewhere", `The saved sign-in is for ${current.url}, not ${url}; its token goes only to the server that issued it.`, `${RUN} login --force`, EXIT.usage);
  }
  return { token: current.token, url };
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
  /** Start a new code whatever pending.json holds (after a resumed code expired). */
  fresh?: boolean;
}

const POLL_MIN_MS = 1000;

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
  // A waiting code's expires_at is only a hint: an approved code can still be collected for a while
  // after it, so the code is polled and the server's expired_token decides.
  let pending = (options.wait || options.resume) && !options.fresh ? readPending() : undefined;
  if (pending && pending.url !== url) {
    say(`The waiting sign-in code is from ${pending.url}, not ${url}; starting a new sign-in.`);
    deletePending();
    pending = undefined;
  } else if (options.wait && !pending && !options.fresh) say("No sign-in is waiting; starting a new one.");
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
  const startedAt = Date.now();
  const stopAt = startedAt + options.timeoutSeconds * 1000;
  for (;;) {
    await delay(Math.max(0, Math.min(interval * 1000, stopAt - Date.now())));
    let answer;
    try {
      // Each poll gets what is left of --timeout (at least POLL_MIN_MS, so --timeout 0 still asks once).
      answer = await pollToken(url, pending.device_code, Math.max(POLL_MIN_MS, Math.min(REQUEST_TIMEOUT_MS, stopAt - Date.now())));
    } catch (error) {
      if (error instanceof TimedOut && Date.now() >= stopAt) throw new Pending(pending, options.timeoutSeconds, waitNext, options.resume?.then);
      throw error;
    }
    if (answer.status === "slow_down") interval += 5; // RFC 8628: each slow_down adds 5 seconds for good
    if (answer.status === "authorization_pending" || answer.status === "slow_down") {
      if (Date.now() >= stopAt) throw new Pending(pending, options.timeoutSeconds, waitNext, options.resume?.then);
      continue;
    }
    deletePending();
    if (answer.status === "expired_token" && resumed) {
      // A code from an earlier run ran out: once, a new sign-in with what is left of --timeout.
      say("The pending sign-in code has expired; starting a new sign-in.");
      const left = Math.max(0, options.timeoutSeconds - Math.floor((Date.now() - startedAt) / 1000));
      return login({ ...options, force: true, fresh: true, timeoutSeconds: left }, json, out, say);
    }
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
  // A saved token from another server is never sent here: this server needs its own sign-in.
  if (!current || (current.url && current.url !== url)) return undefined;
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
  await revoke(current.url ?? loginUrl(), current.token);
  const deleted = deleteCredentials();
  if (json) out({ status: "signed_out", revoked: true, deleted_file: deleted });
  say("Signed out: the token is revoked on flow.engineer and deleted from this machine.");
  if (current.from === "env") say("FLOW_FRAMEWORK_TOKEN is still set in this shell: unset it.");
}

async function showAccount(json: boolean, out: Out, say: Say): Promise<void> {
  const { token, url } = signedIn();
  const account: Account = await whoami(url, token);
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

const CHANNEL_NAME: Record<string, string> = { telegram: "Telegram", whatsapp: "WhatsApp", imessage: "iMessage" };
/** Each channel's sender in .env: the agent listens on a channel only when its sender is there. */
const SENDER_ENV: Record<string, string> = { telegram: SETUP_ENV.telegram_sender, whatsapp: SETUP_ENV.whatsapp_sender, imessage: SETUP_ENV.imessage_sender };
/** What a channel on Flow's shared senders cannot do: start a conversation. */
const REPLY_ONLY: Record<string, string> = {
  whatsapp: "The agent can only reply after you write to it first, within 24 hours of your last message; it cannot message you first.",
  imessage: "The agent can only reply after you write to it first; it cannot message you first.",
};

/** Refuses a folder that is not an agent's (no package.json), before anything signs in or is minted. */
function agentFolder(dir: string): void {
  if (existsSync(join(dir, "package.json"))) return;
  throw new Stop("not_an_agent_folder", `${dir} has no package.json, so it is not an agent's folder; its keys would land in the wrong .env.`,
    `cd into your agent's folder, or make an agent here first: ${RUN} init`, EXIT.usage);
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
  const dir = process.cwd();
  agentFolder(dir);
  const { token, url } = signedIn();
  const file = join(dir, ".env");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = text ? text.split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  const before = envValues(lines);
  const named = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string }).name ?? basename(dir);
  // The server takes 1 to 64 letters, digits, spaces, -, _ and .: a package's scope and other characters go.
  const name = named.replace(/^@[^/]*\//, "").replace(/[^A-Za-z0-9 ._-]/g, "-").slice(0, 64) || "my-agent";
  // An empty value (`cp .env.example .env`) is missing: the server mints it.
  const have = Object.values(SETUP_ENV).filter((n) => n !== SETUP_ENV.try_url && before.get(n));
  let answer: SetupAnswer;
  try {
    // Every channel: each comes back with its shared sender only while it is open.
    answer = await setup(url, token, { name, hostname: hostname(), channels: [...CHANNELS], have });
  } catch (error) {
    // The keys minted anyway are not shown again, so whatever the error carries goes into .env first.
    if (error instanceof LoginRefused) {
      const written = writeEnv(file, lines, before, error.fields, replace);
      if (written.some((w) => w.action === "added" || w.action === "replaced")) say(`Kept in .env before the error: ${written.map((w) => `${w.name} ${w.action}`).join(", ")}.`);
    }
    throw error;
  }
  const warnings = warningsOf(answer as unknown as Record<string, unknown>);
  const written = writeEnv(file, lines, before, answer as unknown as Record<string, unknown>, replace);
  if (typeof answer.join_code !== "string" || !answer.join_code) {
    const kept = written.filter((w) => w.action === "added" || w.action === "replaced").map((w) => w.name);
    const stop = new Stop("no_join_code", `flow.engineer gave no join code${kept.length ? ` (the keys it made are in .env: ${kept.join(", ")})` : ""}, so there is no phone link yet.`,
      answer.next?.[0] ?? NEXT.setup, EXIT.refused);
    stop.warnings = warnings;
    throw stop;
  }
  printWarnings(warnings);

  const open = CHANNELS.filter((c) => typeof (answer as unknown as Record<string, unknown>)[`${c}_sender`] === "string");
  const links = Object.fromEntries(open.map((c) => [c, answer.try_urls?.[c] ?? (c === "telegram" && answer.try_url ? answer.try_url : tryLink(url, answer.join_code!, c))]));
  const next = [`${RUN} test --synthetic`, "npm start", ...(answer.next?.length ? answer.next : [NEXT.link])];
  if (json) {
    out({
      agent: answer.agent_id, join_code: answer.join_code, env_written: { ".env": written }, minted: answer.minted ?? [],
      dashboard_url: answer.dashboard_url ?? null, try_url: answer.try_url ?? null, telegram_link: answer.telegram_link ?? null,
      whatsapp_link: answer.whatsapp_link ?? null, imessage_link: answer.imessage_link ?? null, try_urls: links, trial: answer.trial ?? null, next, warnings,
    });
  }
  say(`Agent ${answer.agent_id}. In .env:`);
  for (const w of written) say(`  ${w.name}=${w.value}  ${w.action}${w.action === "kept" ? " (yours differs; --replace takes the new one)" : ""}`);
  if (answer.dashboard_url) say(`Its dashboard: ${answer.dashboard_url}`);
  const people = answer.trial?.imessage?.contacts;
  if (people && typeof people.used === "number" && typeof people.limit === "number") say(`iMessage: ${people.used} of ${people.limit} people`);
  if (!forLink) {
    for (const c of open) say(`On ${CHANNEL_NAME[c]}: ${links[c]}${trialNote(answer.trial?.[c])}`);
    say(`Next: ${next.join(", then ")}`);
  }
}

const trialNote = (t: { limit: number | null; used: number } | undefined) => (t && typeof t.limit === "number" ? ` (free trial: ${t.used} of ${t.limit} messages used)` : "");

type Written = { name: string; action: "added" | "unchanged" | "kept" | "replaced"; value: string };

/** Merges setup's fields into .env's lines and writes the file (mode 0600) when anything changed. */
function writeEnv(file: string, lines: string[], before: Map<string, string>, fields: Record<string, unknown>, replace: boolean): Written[] {
  const written: Written[] = [];
  for (const [field, envName] of Object.entries(SETUP_ENV)) {
    const value = fields[field];
    if (typeof value !== "string" || !value) continue;
    const old = before.get(envName);
    const at = lines.findIndex((line) => ENV_LINE.exec(line)?.[1] === envName);
    let action: Written["action"];
    if (!old) {
      // Missing, or there with no value (`NAME=` from .env.example): the new value takes that line.
      if (at >= 0) lines[at] = `${envName}=${value}`;
      else lines.push(`${envName}=${value}`);
      action = "added";
    } else if (old === value) action = "unchanged";
    else if (!replace) action = "kept";
    else {
      lines[at] = `${envName}=${value}`;
      action = "replaced";
    }
    before.set(envName, action === "kept" ? old! : value);
    written.push({ name: envName, action, value: masked(envName, action === "kept" ? old! : value) });
  }
  if (written.some((w) => w.action === "added" || w.action === "replaced")) writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  if (existsSync(file)) chmodSync(file, 0o600); // a .env that was there keeps its old mode on write
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
 * in .env, or no sender for a WhatsApp or iMessage link): it signs in first when it has to (the same
 * login, resuming a code already waiting) and runs setup, then asks flow.engineer for the channel's
 * page, so a channel that is not open yet answers with the server's next step instead of a link
 * that does not work.
 */
async function link(options: LinkOptions, json: boolean, out: Out, say: Say): Promise<void> {
  const again = `${NEXT.link}${options.channel === "telegram" ? "" : ` --channel ${options.channel}`}`;
  const what = CHANNEL_NAME[options.channel]!;
  const needsSender = options.channel !== "telegram";
  let value = dotenvValue();
  let restart = false;
  if (!value(SETUP_ENV.join_code) || !value(SETUP_ENV.messaging_key) || (needsSender && !value(SENDER_ENV[options.channel]!))) {
    agentFolder(process.cwd());
    if (!(await signedInAccount(loginUrl()))) {
      say("Not signed in to flow.engineer yet: signing in first.");
      await login({ noBrowser: options.noBrowser, wait: false, noWait: false, force: true, timeoutSeconds: options.timeoutSeconds, resume: { then: again } }, json, out, say);
    }
    say("Setting up this agent's keys in .env.");
    await setupEnv(false, false, json, out, say, { channel: options.channel });
    value = dotenvValue();
    restart = true;
  }
  const joinCode = value(SETUP_ENV.join_code);
  if (!joinCode) throw new Stop("no_join_code", `Setup wrote no ${SETUP_ENV.join_code} into .env.`, NEXT.setup, EXIT.refused);
  if (needsSender && !value(SENDER_ENV[options.channel]!)) {
    throw new Stop("channel_not_open", `${what} is not open on Flow's shared senders yet, so setup got no ${SENDER_ENV[options.channel]}.`, NEXT.link, EXIT.refused);
  }
  // The server's own try_url when setup kept one for this join code and channel, else the same page built here.
  const fromServer = value(SETUP_ENV.try_url);
  const url = fromServer?.includes(`/try/${encodeURIComponent(joinCode)}?`) && URL.parse(fromServer)?.searchParams.get("c") === options.channel ? fromServer : tryLink(loginUrl(), joinCode, options.channel);
  await checkTryPage(url);
  const replyOnly = REPLY_ONLY[options.channel];
  const sayToPerson = `Open this on your phone and send the message ${what} fills in: ${url}${replyOnly ? ` ${replyOnly}` : ""}`;
  if (json) out({ url, channel: options.channel, join_code: joinCode, reply_only: Boolean(replyOnly), say_to_person: sayToPerson });
  say(url);
  say(`Open it on a phone with ${what} and send the message it fills in, with your join code. From then on`);
  say("that phone chats with this agent while it runs (npm start), with no public URL or tunnel.");
  if (replyOnly) say(replyOnly);
  if (restart) say("If the agent is running already, restart it (npm start) so it picks up the new .env.");
}

/**
 * Asks flow.engineer for the try page as JSON: a channel it cannot open yet (or a join code it does
 * not know) answers {"error", "error_description", "next"}, which stops here with that next step.
 */
async function checkTryPage(url: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    if ((error as Error).name === "TimeoutError") throw new TimedOut(url, REQUEST_TIMEOUT_MS);
    throw error;
  }
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
