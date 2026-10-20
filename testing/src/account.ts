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
  modelCredit, SETUP_ENV, setup, startDevice, TimedOut, tryLink, warningsOf, whoami, type Account, type ModelCredit, type PendingLogin, type SetupAnswer,
} from "./flow-login.ts";
import { packageRoot, setDisplayName } from "./new.ts";
import { flowModelURL, hasModelKey, MODEL_KEY_NAMES, NO_MODEL_KEY } from "../../src/model.ts";
import { RUN } from "../../src/names.ts";
import { runningAgent } from "../../src/local.ts";

export const ACCOUNT_COMMANDS = new Set(["login", "logout", "whoami", "setup", "link", "status"]);

export const ACCOUNT_LINES = `  flow login [--wait | --no-wait] [--timeout <s>] [--force] [--no-browser] [--json]
                            Sign in to flow.engineer: opens the browser, prints the link and code,
                            and waits up to --timeout (default 120) for approval; --wait goes on
                            waiting for the same code, --no-wait returns at once
  flow logout [--json]      End this machine's sign-in and delete its token
  flow whoami [--json]      Show the account you are signed in as
  flow setup [--replace] [--rotate <keys> [--now]] [--workspace <name|acc_id>] [--display-name <name>] [--ci] [--json]
                            Write this agent's keys (its Flow key FLOW_KEY, which also pays for the
                            model on the account's trial credit when there is no provider key, test
                            cloud, traces, Flow Messaging) and each open channel's sender into
                            ./.env (in an agent's folder: package.json); --rotate key,cloud,traces,
                            messaging or all makes those keys again (the old FLOW_KEY works 24 h
                            more; --now ends it at once). --workspace (here and on link) puts the
                            agent in that observe workspace of yours, kept in .env as
                            FLOW_FRAMEWORK_WORKSPACE; a new one makes the cloud and traces keys again
  flow link [--channel telegram|whatsapp|imessage] [--workspace <name|acc_id>] [--display-name <name>] [--timeout <s>] [--no-browser] [--json]
                            Print the link that opens a chat with this agent from a phone; signs in
                            and runs setup first when this folder is not set up yet. --display-name
                            (here and on setup) renames the agent: package.json's displayName and
                            its prompt, agent/AGENTS.md; the phone link then says "Hi <name>"
  flow status [--json]      What this folder has and lacks: FLOW_KEY and the model key (never their
                            values) with the trial credit left, the workspace, the
                            sign-in, each channel's sender in .env, and, signed in, which channels
                            are open now and their free-trial counts`;

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
/** After link and status: the step that keeps the agent answering once this machine sleeps. */
const DEPLOY_HINT = `To keep it answering while this machine sleeps: ${RUN} deploy (Flow's hosting, staging first).`;
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
        ...(command === "setup" ? { replace: { type: "boolean", default: false }, rotate: { type: "string" }, now: { type: "boolean", default: false }, ci: { type: "boolean", default: false } } : {}),
        ...(command === "link" ? { channel: { type: "string", default: "telegram" } } : {}),
        ...(command === "link" || command === "setup" ? { "display-name": { type: "string" }, workspace: { type: "string" } } : {}),
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
  const rotate = values.rotate === undefined ? [] : String(values.rotate).split(",").map((k) => k.trim());
  if (rotate.some((k) => !(k in ROTATE)) || (rotate.includes("all") && rotate.length > 1)) {
    console.error(`flow setup: --rotate takes ${Object.keys(ROTATE).filter((k) => k !== "all").join(", ")} (comma-separated), or all.\n\n${USAGE}`);
    return EXIT.usage;
  }
  if (values.now === true && !rotate.includes("key") && !rotate.includes("all")) {
    console.error(`flow setup: --now goes with --rotate key (or all): it ends the old FLOW_KEY at once.\n\n${USAGE}`);
    return EXIT.usage;
  }
  const workspace = typeof values.workspace === "string" ? values.workspace.trim() : undefined;
  // flow.engineer takes a workspace's acc_ id or its name: 1 to 100 characters, no control characters.
  if (workspace !== undefined && (!workspace || workspace.length > 100 || /[\u0000-\u001f\u007f]/.test(workspace))) {
    console.error(`flow ${command}: --workspace takes a workspace's name or its acc_ id, 1 to 100 characters.\n\n${USAGE}`);
    return EXIT.usage;
  }
  const json = values.json === true;
  // Straight to the file descriptors, never buffered: a coding agent's cut-off command keeps every line.
  const out = (report: unknown) => writeAll(1, `${JSON.stringify(report)}\n`);
  const say = (line: string) => writeAll(json ? 2 : 1, `${line}\n`);
  let renamed = false;
  try {
    if (typeof values["display-name"] === "string" && values.ci !== true) {
      agentFolder(process.cwd());
      const before = agentDisplayName();
      let named: ReturnType<typeof setDisplayName>;
      try {
        named = setDisplayName(process.cwd(), values["display-name"]);
      } catch (error) {
        throw new Stop("bad_display_name", (error as Error).message, undefined, EXIT.usage);
      }
      renamed = named.displayName !== before || named.prompt;
      if (json) out({ display_name: named.displayName, prompt_renamed: named.prompt });
      say(`People call it "${named.displayName}" now (package.json displayName${named.prompt ? " and agent/AGENTS.md" : "; agent/AGENTS.md named neither the old name nor Pip, so it is as it was"}).`);
    }
    if (command === "login") {
      await login({ noBrowser: values["no-browser"] === true, wait: values.wait === true, noWait: values["no-wait"] === true, force: values.force === true, timeoutSeconds }, json, out, say);
    }
    else if (command === "logout") await logout(json, out, say);
    else if (command === "whoami") await showAccount(json, out, say);
    else if (command === "status") await status(json, out, say);
    else if (command === "setup") await setupEnv({ replace: values.replace === true, rotate, now: values.now === true, ci: values.ci === true, workspace }, json, out, say);
    else await link({ channel, noBrowser: values["no-browser"] === true, timeoutSeconds, renamed, workspace }, json, out, say);
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

const SECRET = new Set<string>([SETUP_ENV.cloud_key, SETUP_ENV.traces_key, SETUP_ENV.messaging_key, ...MODEL_KEY_NAMES]);
const masked = (name: string, value: string) => (SECRET.has(name) ? `${/^[a-z]+_(?:test_|live_)?/.exec(value)?.[0] ?? ""}…${value.slice(-4)}` : value);
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** `--rotate`'s names and the answer field each makes again; `all` is every key. */
const ROTATE: Record<string, string> = { key: "flow_key", cloud: "cloud_key", traces: "traces_key", messaging: "messaging_key", all: "" };

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

/** The agent's one Flow key; for the model it is last in the model keys' order, so a provider key the owner sets wins. */
const FLOW_KEY = MODEL_KEY_NAMES.at(-1)!;

/** The account's Flow trial credit as setup's answer or GET /credit gave it; a field it left out is absent. */
interface FlowCredit {
  limit_usd?: number;
  left_usd?: number;
  spent_usd?: number;
}

/** Where the agent's model key stands, the same in setup, link and status (never its value). */
interface ModelKeyReport {
  set: boolean;
  /** The first name with a value, in .env or the environment. */
  env: string | null;
  /** Flow's trial credit, when setup's answer or GET /credit named it. */
  flow_credit: FlowCredit | null;
  /** With no key, or Flow's key with no credit left: the sentence that says so. */
  message?: string;
}

const USED_UP = "This account's Flow trial credit is used up.";
const NO_CREDIT = `Flow has no trial model credit for this account, so ${FLOW_KEY} cannot pay for the model.`;
const OWN_KEY = "add your own model key to .env";

/** setup's model_credit or GET /credit's answer as FlowCredit: its numbers only. */
function creditOf(from: SetupAnswer["model_credit"] | ModelCredit | undefined): FlowCredit | null {
  if (!from) return null;
  const credit: FlowCredit = {};
  for (const field of ["limit_usd", "left_usd", "spent_usd"] as const) {
    const n = (from as Record<string, unknown>)[field];
    if (typeof n === "number" && Number.isFinite(n)) credit[field] = n;
  }
  return credit;
}

const dollars = (n: number) => `$${n.toFixed(2)}`;

/**
 * The model key's state: `line` to print, and with no key the step that gets one, which goes first
 * in the run's one `next`. `credit`: Flow's credit from setup's answer or GET /credit. `afterSetup`:
 * setup ran just now, so its answer says why there is none.
 */
function modelKeyReport(value: (name: string) => string | undefined, credit: SetupAnswer["model_credit"] | ModelCredit | undefined, afterSetup: boolean): { report: ModelKeyReport; line: string; next?: string } {
  const env = MODEL_KEY_NAMES.find((name) => value(name)) ?? null;
  const flowCredit = creditOf(credit);
  const usedUp = flowCredit?.left_usd !== undefined && flowCredit.left_usd <= 0;
  if (env && env !== FLOW_KEY) return { report: { set: true, env, flow_credit: null }, line: `Model: ${env} is set` };
  if (env) {
    if (usedUp) return { report: { set: true, env, flow_credit: flowCredit, message: USED_UP }, line: USED_UP, next: OWN_KEY };
    // Setup just ran and gave no credit (warnings say why): FLOW_KEY is there, but cannot pay for the model.
    if (afterSetup && !flowCredit) return { report: { set: true, env, flow_credit: null, message: NO_CREDIT }, line: NO_CREDIT, next: OWN_KEY };
    const left = flowCredit?.left_usd !== undefined ? ` (${dollars(flowCredit.left_usd)} left)` : "";
    return { report: { set: true, env, flow_credit: flowCredit }, line: `Model: Flow trial credit${left}` };
  }
  // No key, and the account's credit is used up: setup made none.
  if (usedUp) return { report: { set: false, env: null, flow_credit: flowCredit, message: USED_UP }, line: USED_UP, next: OWN_KEY };
  const report = { set: false, env: null, flow_credit: null, message: NO_MODEL_KEY.message };
  // Setup ran and flow.engineer gave no FLOW_KEY (an older server, or none for this account now).
  if (afterSetup) return { report, line: NO_MODEL_KEY.message, next: `${OWN_KEY} (flow.engineer gave no trial credit)` };
  return { report, line: NO_MODEL_KEY.message, next: NO_MODEL_KEY.nextLine.replace(/^Next: /, "").replace(/\.$/, "") };
}

/** What people call this folder's agent (package.json displayName, from `flow init`), else its package name in words. */
function agentDisplayName(dir = process.cwd()): string {
  const file = join(dir, "package.json");
  const pkg = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { name?: string; displayName?: string }) : {};
  const named = typeof pkg.displayName === "string" ? pkg.displayName.trim() : "";
  return named || (pkg.name ?? basename(dir)).replace(/^@[^/]+\//, "").replace(/-/g, " ");
}

/** The /try page with the agent's name (`n`), so it fills in "Hi <name> (ref <code>)". */
function namedPage(url: string, name: string): string {
  const parsed = URL.parse(url);
  if (!parsed) return url;
  parsed.searchParams.set("n", name);
  return parsed.toString();
}

/** A channel's direct link (t.me, wa.me or sms:), the message it fills in, and its /try page for a computer. */
interface DirectLink {
  link: string;
  message: string;
  page: string;
}

/** How to use each channel's direct link. */
const OPEN_HINT: Record<string, string> = {
  telegram: "Open it and press Start.",
  whatsapp: "Open it and send the message it fills in.",
  imessage: "Open it on an iPhone or a Mac and send the message it fills in.",
};

/** The observe workspace this folder's agent was put in by --workspace (its acc_ id); unset: the personal one. */
const WORKSPACE_ENV = "FLOW_FRAMEWORK_WORKSPACE";
/** The answer's workspace_id, under the name setupEnv gives it only when a workspace was asked for. */
const WORKSPACE_FIELD = "workspace_kept";

/** --workspace names another workspace than the one .env's cloud and traces keys are in (none named yet: the personal one). */
function movesWorkspace(workspace: string | undefined, value: (name: string) => string | undefined): boolean {
  if (workspace === undefined) return false;
  const stored = value(WORKSPACE_ENV);
  if (stored) return workspace.toLowerCase() !== stored.toLowerCase();
  return Boolean(value(SETUP_ENV.cloud_key) || value(SETUP_ENV.traces_key));
}

interface SetupOptions {
  replace: boolean;
  /** --rotate's names (key, cloud, traces, messaging, or all). */
  rotate: string[];
  /** --now: the old FLOW_KEY stops working at once instead of 24 h later. */
  now?: boolean;
  ci: boolean;
  /** --workspace: an observe workspace's name or acc_ id; undefined sends .env's FLOW_FRAMEWORK_WORKSPACE, if any. */
  workspace?: string;
}

async function setupEnv(options: SetupOptions, json: boolean, out: Out, say: Say, forLink?: { channel: string }): Promise<{ answer: SetupAnswer; warnings: string[] }> {
  if (options.ci) {
    const steps = [
      `CI never signs in. It runs the tests with the agent's test cloud key, ${SETUP_ENV.cloud_key}, as a secret.`,
      `Run ${NEXT.setup} on your machine first, then copy the key from .env into your CI without printing it, for GitHub:`,
      `  grep '^${SETUP_ENV.cloud_key}=' .env | cut -d= -f2- | gh secret set ${SETUP_ENV.cloud_key}`,
      `and in the workflow: ${RUN} test --synthetic --json`,
    ];
    if (json) out({ ci: { secret: SETUP_ENV.cloud_key, steps } });
    for (const line of steps) say(line);
    return { answer: {} as SetupAnswer, warnings: [] };
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
  const all = options.rotate.includes("all");
  const rotated = new Set(all ? Object.values(ROTATE).filter(Boolean) : options.rotate.map((k) => ROTATE[k]!));
  // The workspace asked for: --workspace, else the one an earlier --workspace kept in .env.
  const workspace = options.workspace ?? (before.get(WORKSPACE_ENV) || undefined);
  // Another workspace: the cloud and traces keys in .env are the old one's, so they are made again
  // there (Messaging's key and FLOW_KEY are not bound to a workspace).
  const moving = movesWorkspace(options.workspace, (n) => before.get(n));
  if (moving) for (const field of ["cloud_key", "traces_key"]) rotated.add(field);
  const rotatedEnv = new Set([...rotated].map((field) => (field === "flow_key" ? FLOW_KEY : SETUP_ENV[field as keyof typeof SETUP_ENV])));
  // An empty value (`cp .env.example .env`) is missing: the server mints it. A model key counts in
  // the shell too (npm start reads both): FLOW_KEY is made only when it is not named as had, and
  // the trial model credit is given only when no provider key is.
  const have = [
    ...Object.values(SETUP_ENV).filter((n) => n !== SETUP_ENV.try_url && before.get(n)),
    ...MODEL_KEY_NAMES.filter((n) => before.get(n) || process.env[n]?.trim()),
  ].filter((n) => !rotatedEnv.has(n));
  // Dropping a key's name from `have` makes it again; `rotate` names them too, so the server replaces
  // (and, for FLOW_KEY, ends) the old one rather than adding a second.
  const rotate = all ? true : rotated.size ? [...rotated] : undefined;
  const rotateNow = options.now === true && rotated.has("flow_key");
  // FLOW_FRAMEWORK_TRY_URL is one channel's page: link's channel when it is open, else the server's (Telegram's).
  const withTryUrl = (fields: Record<string, unknown>): Record<string, unknown> => {
    const code = fields.join_code;
    // The workspace the answer put the agent in, kept only when one was asked for.
    if (workspace !== undefined && typeof fields.workspace_id === "string" && fields.workspace_id) fields = { ...fields, [WORKSPACE_FIELD]: fields.workspace_id };
    if (!forLink || typeof fields[`${forLink.channel}_sender`] !== "string" || typeof code !== "string" || !code) return fields;
    const pages = fields.try_urls as Record<string, unknown> | undefined;
    const page = typeof pages?.[forLink.channel] === "string" ? (pages[forLink.channel] as string) : tryLink(url, code, forLink.channel);
    return { ...fields, try_url: page };
  };
  const chosenPage = (n: string) => (forLink !== undefined && n === SETUP_ENV.try_url) || n === WORKSPACE_ENV;
  let answer: SetupAnswer;
  // For link: the server's refusal when Messaging's part came (a join code) and only observe's failed.
  let observeFailed: { why: string; fix: string | undefined } | undefined;
  try {
    // Every channel: each comes back with its shared sender only while it is open.
    answer = await setup(url, token, { name, hostname: hostname(), channels: [...CHANNELS], have, ...(workspace !== undefined ? { workspace } : {}), ...(rotate ? { rotate } : {}), ...(rotateNow ? { rotate_now: true as const } : {}) });
  } catch (error) {
    // Texting needs only Messaging's part, so link goes on without observe's (traces and the test
    // cloud) and says what is missing; setup alone, whose job is both, still stops.
    if (forLink && error instanceof LoginRefused && typeof error.fields.join_code === "string" && error.fields.join_code) {
      const { error: _code, error_description: why, next: fix, ...rest } = error.fields;
      answer = rest as unknown as SetupAnswer;
      observeFailed = { why: typeof why === "string" && why ? why : error.message, fix: typeof fix === "string" && fix ? fix : error.next };
    } else {
      // The keys minted anyway are not shown again, so whatever the error carries goes into .env first.
      if (error instanceof LoginRefused) {
      const written = writeEnv(file, lines, before, envEntries(withTryUrl(error.fields)), (n) => options.replace || rotatedEnv.has(n) || chosenPage(n));
        if (written.some((w) => w.action === "added" || w.action === "replaced")) say(`Kept in .env before the error: ${written.map((w) => `${w.name} ${w.action}`).join(", ")}.`);
      }
      throw error;
    }
  }
  const fields = answer as unknown as Record<string, unknown>;
  const warnings = warningsOf(fields);
  const had = new Map(before);
  // --replace takes every new value but a model key: only --rotate key replaces FLOW_KEY.
  const written = writeEnv(file, lines, before, envEntries(withTryUrl(fields)), (n) => rotatedEnv.has(n) || (options.replace && !MODEL_KEY_NAMES.includes(n)) || chosenPage(n));
  // An older flow.engineer ignores the field and sets the agent up in the personal workspace.
  if (workspace !== undefined && !observeFailed && (typeof answer.workspace_id !== "string" || !answer.workspace_id)) {
    const stop = new Stop("workspace_unsupported", "flow.engineer does not support --workspace yet; the agent was set up in your personal workspace.", undefined, EXIT.refused);
    stop.warnings = warnings;
    throw stop;
  }
  if (typeof answer.join_code !== "string" || !answer.join_code) {
    const kept = written.filter((w) => w.action === "added" || w.action === "replaced").map((w) => w.name);
    const stop = new Stop("no_join_code", `flow.engineer gave no join code${kept.length ? ` (the keys it made are in .env: ${kept.join(", ")})` : ""}, so there is no phone link yet.`,
      answer.next?.[0] ?? NEXT.setup, EXIT.refused);
    stop.warnings = warnings;
    throw stop;
  }
  if (observeFailed) {
    // Moving workspaces, the old workspace's keys still in .env do not count.
    const missing = [SETUP_ENV.cloud_key, SETUP_ENV.traces_key].filter((n) => !before.get(n) || (moving && before.get(n) === had.get(n)));
    const why = observeFailed.why.replace(/\.$/, "");
    warnings.push(`Traces and tests won't work${missing.length ? ` until .env has ${missing.join(" and ")}` : ""}: ${why}.${observeFailed.fix ? ` Then: ${observeFailed.fix}` : ""}`);
  }
  printWarnings(warnings);

  const open = CHANNELS.filter((c) => typeof fields[`${c}_sender`] === "string");
  const displayName = agentDisplayName(dir);
  const links = Object.fromEntries(open.map((c) => [c, namedPage(answer.try_urls?.[c] ?? (c === "telegram" && answer.try_url ? answer.try_url : tryLink(url, answer.join_code!, c)), displayName)]));
  // Said by link instead, which asks for its own; a page that does not answer leaves only the page.
  const direct: Record<string, DirectLink> = {};
  if (!forLink) {
    for (const c of open) {
      const found = await directLink(links[c]!).catch((error: unknown) => (error instanceof Stop ? undefined : Promise.reject(error)));
      if (found) direct[c] = found;
    }
  }
  // A closed channel's trial counts are not shown: only the open ones'.
  const trial = answer.trial ? Object.fromEntries(Object.entries(answer.trial).filter(([c]) => open.includes(c))) : null;
  const model = modelKeyReport((n) => before.get(n) || process.env[n]?.trim() || undefined, objectField<SetupAnswer["model_credit"]>(fields, "model_credit"), true);
  const flowKey = objectField<SetupAnswer["flow_key"]>(fields, "flow_key");
  // A rotated FLOW_KEY: when the one it replaced stops working.
  const previous = rotated.has("flow_key") && flowKey?.minted
    ? flowKey.previous_expires_at ? `The old ${FLOW_KEY} works until ${flowKey.previous_expires_at}.` : rotateNow ? `The old ${FLOW_KEY} stopped working now.` : undefined
    : undefined;
  // A first run's order: a model key if there is none, the playground (npm start), then the phone.
  // chat and test --synthetic are the coding agent's own checks, not the owner's way to test.
  const next = [...(model.next ? [model.next] : []), "npm start", ...(answer.next?.length ? answer.next : [NEXT.link])];
  if (json) {
    out({
      agent: answer.agent_id, join_code: answer.join_code, env_written: { ".env": written }, minted: answer.minted ?? [],
      dashboard_url: answer.dashboard_url ?? null, try_url: answer.try_url ?? null, telegram_link: answer.telegram_link ?? null,
      whatsapp_link: answer.whatsapp_link ?? null, imessage_link: answer.imessage_link ?? null, try_urls: links,
      direct_links: Object.fromEntries(Object.entries(direct).map(([c, d]) => [c, d.link])), join_message: Object.values(direct)[0]?.message ?? null,
      trial, model_key: model.report,
      workspace: typeof answer.workspace_id === "string" && answer.workspace_id ? { id: answer.workspace_id, name: answer.workspace_name ?? null } : null,
      // FLOW_KEY's state, never its value: made in this call, with its id, mode and scopes.
      flow_key: { set: Boolean(before.get(FLOW_KEY) || process.env[FLOW_KEY]?.trim()), minted: flowKey?.minted === true,
        ...(flowKey?.minted ? { kid: flowKey.kid ?? null, mode: flowKey.mode ?? null, scopes: flowKey.scopes ?? [], previous_expires_at: flowKey.previous_expires_at ?? null } : {}) },
      // link's own line (or its error) has the run's next steps: one list per run.
      ...(forLink ? {} : { next }), warnings,
    });
  }
  say(answer.agent_id ? `Agent ${answer.agent_id}. In .env:` : "In .env:");
  for (const w of written) say(`  ${w.name}=${w.value}  ${w.action}${w.action === "kept" ? (w.name === FLOW_KEY ? " (--rotate key makes a new one)" : " (yours differs; --replace takes the new one)") : ""}`);
  if (previous) say(previous);
  if (answer.workspace_id) say(`Workspace: ${answer.workspace_name ? `${answer.workspace_name} (${answer.workspace_id})` : answer.workspace_id}`);
  if (answer.dashboard_url) say(`Its dashboard: ${answer.dashboard_url}`);
  // Said by link instead, once, with its link.
  if (!forLink) say(model.line);
  // link says its own channel's trial line instead.
  if (!forLink) {
    const people = peopleLine(trial?.imessage);
    if (people) say(people);
    for (const c of open) say(`On ${CHANNEL_NAME[c]}: ${direct[c] ? `${direct[c]!.link} (on a computer: ${links[c]})` : links[c]}${trialNote(trial?.[c])}`);
    const added = addedToRunning((n) => had.get(n) || process.env[n]?.trim(), (n) => before.get(n) || process.env[n]?.trim());
    if (added) say(`If npm start is running, restart it to add ${added}.`);
    say(`Next: ${next.join(", then ")}`);
  }
  return { answer, warnings };
}

/** iMessage's count of the people it may reach on the trial, as a line; undefined when the answer had none. */
function peopleLine(t: { contacts?: { limit: number; used: number } } | undefined): string | undefined {
  const people = t?.contacts;
  return people && typeof people.used === "number" && typeof people.limit === "number" ? `iMessage: ${people.used} of ${people.limit} people` : undefined;
}

const trialNote = (t: { limit: number | null; used: number } | undefined) => (t && typeof t.limit === "number" ? ` (free trial: ${t.used} of ${t.limit} messages used)` : "");

/** An answer's field when it is an object (flow_key, model_credit), else undefined (an older server sends none). */
function objectField<T>(fields: Record<string, unknown>, name: string): T | undefined {
  const value = fields[name];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : undefined;
}

/**
 * The .env lines an answer gives: SETUP_ENV's fields, then the agent's Flow key as FLOW_KEY (no
 * other name: a provider key the owner typed is never written over, and wins for the model).
 */
function envEntries(fields: Record<string, unknown>): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = Object.entries(SETUP_ENV).map(([field, envName]) => [envName, fields[field]]);
  entries.push([WORKSPACE_ENV, fields[WORKSPACE_FIELD]]);
  const key = objectField<SetupAnswer["flow_key"]>(fields, "flow_key");
  if ((key?.env ?? FLOW_KEY) === FLOW_KEY && typeof key?.value === "string") entries.push([FLOW_KEY, key.value]);
  return entries;
}

type Written = { name: string; action: "added" | "unchanged" | "kept" | "replaced"; value: string };

/** Merges the entries into .env's lines and writes the file (mode 0600) when anything changed; `replace(name)` says when a value there gives way. */
function writeEnv(file: string, lines: string[], before: Map<string, string>, entries: Array<[string, unknown]>, replace: (name: string) => boolean): Written[] {
  const written: Written[] = [];
  for (const [envName, value] of entries) {
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
    else if (!replace(envName)) action = "kept";
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

/**
 * What a running agent (npm start reads .env once, when it starts) lacks after .env changed from
 * `had` to `now`: the channels it is not on yet and a model key, as words ("Telegram and the model
 * key"); undefined when nothing it uses is new.
 */
function addedToRunning(had: (name: string) => string | undefined, now: (name: string) => string | undefined): string | undefined {
  // The starter is on Telegram whenever it has the Flow Messaging key, and on WhatsApp and iMessage
  // when .env names their senders; without the key it was on no channel at all.
  const on = (env: (name: string) => string | undefined, c: string) => Boolean(env(SETUP_ENV.messaging_key) && (c === "telegram" || env(SENDER_ENV[c]!)));
  const channels = CHANNELS.filter((c) => on(now, c) && !on(had, c)).map((c) => CHANNEL_NAME[c]!);
  const model = !MODEL_KEY_NAMES.some((n) => had(n)) && MODEL_KEY_NAMES.some((n) => now(n)) ? ["the model key"] : [];
  const what = [...channels, ...model];
  if (!what.length) return undefined;
  return `${what.length === 1 ? what[0] : `${what.slice(0, -1).join(", ")} and ${what.at(-1)}`}`;
}

/**
 * `flow status`: what this folder has and lacks, read from .env and the environment, and, when
 * signed in and set up, flow.engineer's answer for which channels are open now and their trial
 * counts. It changes nothing: setup is asked with every key named as had, so nothing is made, and
 * its answer is not written. Not signed in, or flow.engineer unreachable: that part is left out.
 */
async function status(json: boolean, out: Out, say: Say): Promise<void> {
  const value = dotenvValue();
  const model = await flowModelStatus(value);
  const joinCode = value(SETUP_ENV.join_code) ?? null;
  let account: Account | null = null;
  let server: SetupAnswer | null = null;
  const current = currentToken();
  const url = loginUrl();
  if (current && (!current.url || current.url === url)) {
    try {
      account = await whoami(url, current.token);
      if (joinCode && existsSync(join(process.cwd(), "package.json"))) {
        const named = (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { name?: string }).name ?? basename(process.cwd());
        const name = named.replace(/^@[^/]*\//, "").replace(/[^A-Za-z0-9 ._-]/g, "-").slice(0, 64) || "my-agent";
        const have = [...Object.values(SETUP_ENV).filter((n) => n !== SETUP_ENV.try_url), ...MODEL_KEY_NAMES];
        const workspace = value(WORKSPACE_ENV);
        server = await setup(url, current.token, { name, hostname: hostname(), channels: [...CHANNELS], have, ...(workspace ? { workspace } : {}) });
      }
    } catch {
      // Signed out on the server, or not reachable: status says what it can from here.
    }
  }
  const fields = (server ?? {}) as Record<string, unknown>;
  const channels = Object.fromEntries(CHANNELS.map((c) => [c, {
    sender: Boolean(c === "telegram" ? value(SETUP_ENV.messaging_key) : value(SENDER_ENV[c]!)),
    open: server ? typeof fields[`${c}_sender`] === "string" : null,
    trial: server && typeof fields[`${c}_sender`] === "string" ? server.trial?.[c] ?? null : null,
  }]));
  // The playground (npm start) before the phone, as setup's next.
  const next = [
    ...(model.next ? [model.next] : []),
    ...(model.report.set && !model.next ? ["npm start"] : []),
    ...(!joinCode || !value(SETUP_ENV.messaging_key) ? [NEXT.link] : CHANNELS.filter((c) => channels[c]!.open && !channels[c]!.sender).map((c) => `${NEXT.link} --channel ${c}`)),
  ];
  const workspace = value(WORKSPACE_ENV) || "personal";
  if (json) out({ model_key: model.report, flow_key: { set: Boolean(value(FLOW_KEY)) }, workspace, signed_in: account ? { email: account.email, account: account.account } : false, join_code: joinCode, messaging_key: Boolean(value(SETUP_ENV.messaging_key)), channels, next });
  if (model.report.env && model.report.env !== FLOW_KEY) say(value(FLOW_KEY) ? `${FLOW_KEY} is set.` : `${FLOW_KEY}: not set yet (${RUN} setup writes it).`);
  say(model.line);
  say(`Workspace: ${workspace}`);
  say(account ? `Signed in as ${account.email}.` : current ? "Not signed in here (or flow.engineer could not be reached)." : "Not signed in.");
  for (const c of CHANNELS) {
    const { sender, open, trial } = channels[c]!;
    const where = sender ? "in .env" : "not in .env";
    const now = open === null ? "" : open ? "; open now" : "; not open yet";
    say(`${CHANNEL_NAME[c]}: ${c === "telegram" ? `Flow Messaging key ${where}` : `sender ${where}`}${now}${trialNote(trial ?? undefined)}`);
  }
  if (next.length) say(`Next: ${next.join(", then ")}`);
  say(DEPLOY_HINT);
}

/**
 * status's model line. Flow's key the active one: its credit from GET /credit. A key Flow does not
 * know says so with the step that makes a new one; Flow not reachable leaves the credit unknown.
 */
async function flowModelStatus(value: (name: string) => string | undefined): Promise<ReturnType<typeof modelKeyReport>> {
  const local = modelKeyReport(value, undefined, false);
  if (local.report.env !== FLOW_KEY) return local;
  const key = value(FLOW_KEY)!;
  try {
    return modelKeyReport(value, await modelCredit(flowModelURL({ ...process.env, FLOW_MODEL_URL: value("FLOW_MODEL_URL") }), key), false);
  } catch (error) {
    if (error instanceof LoginRefused && (error.status === 401 || error.status === 403)) {
      const message = error.status === 401
        ? `${FLOW_KEY} is not a key Flow knows (revoked, or from another server).`
        : `${FLOW_KEY} may not call Flow's models (its scopes lack model).`;
      return { report: { ...local.report, message }, line: message, next: `${RUN} setup --rotate key` };
    }
    if (error instanceof LoginRefused && error.status === 402) {
      const message = error.code === "trial_credit_used" ? USED_UP : NO_CREDIT;
      return { report: { ...local.report, flow_credit: error.code === "trial_credit_used" ? { left_usd: 0 } : null, message }, line: message, next: OWN_KEY };
    }
    return { ...local, line: `${local.line} (credit left unknown: Flow could not be reached)` };
  }
}

interface LinkOptions {
  channel: string;
  noBrowser: boolean;
  timeoutSeconds: number;
  /** --display-name changed the name just now, which a running agent reads only when it starts. */
  renamed?: boolean;
  /** --workspace: setup runs again when it names another workspace than .env's. */
  workspace?: string;
}

/** The names set in ./.env, with what the environment sets winning. */
function dotenvValue(): (name: string) => string | undefined {
  const file = join(process.cwd(), ".env");
  const saved = existsSync(file) ? envValues(readFileSync(file, "utf8").split("\n")) : new Map<string, string>();
  return (name) => process.env[name]?.trim() || saved.get(name);
}

/**
 * The phone link for this folder's join code. Not set up yet (no join code or no Flow Messaging key
 * in .env, or no sender for a WhatsApp or iMessage link): it signs in first when it has to (the same
 * login, resuming a code already waiting) and runs setup, then asks flow.engineer for the channel's
 * page. A channel that is not open yet is said once, with the links of the channels that are (exit
 * 0); with none open, it stops with the server's next step. A setup whose observe part failed but
 * whose Messaging part came goes on the same way, with one warning (setupEnv).
 */
async function link(options: LinkOptions, json: boolean, out: Out, say: Say): Promise<void> {
  const again = `${NEXT.link}${options.channel === "telegram" ? "" : ` --channel ${options.channel}`}`;
  const what = CHANNEL_NAME[options.channel]!;
  const needsSender = options.channel !== "telegram";
  let value = dotenvValue();
  let credit: SetupAnswer["model_credit"] | undefined;
  let trial: SetupAnswer["trial"] | undefined;
  let had: ((name: string) => string | undefined) | undefined;
  let warnings: string[] = [];
  const newWorkspace = options.workspace !== undefined && (movesWorkspace(options.workspace, value) || !value(WORKSPACE_ENV));
  if (newWorkspace || !value(SETUP_ENV.join_code) || !value(SETUP_ENV.messaging_key) || (needsSender && !value(SENDER_ENV[options.channel]!))) {
    agentFolder(process.cwd());
    if (!(await signedInAccount(loginUrl()))) {
      say("Not signed in to flow.engineer yet: signing in first.");
      await login({ noBrowser: options.noBrowser, wait: false, noWait: false, force: true, timeoutSeconds: options.timeoutSeconds, resume: { then: again } }, json, out, say);
    }
    say("Setting up this agent's keys in .env.");
    had = value;
    ({ answer: { model_credit: credit, trial }, warnings } = await setupEnv({ replace: false, rotate: [], ci: false, workspace: options.workspace }, json, out, say, { channel: options.channel }));
    value = dotenvValue();
  }
  const joinCode = value(SETUP_ENV.join_code);
  if (!joinCode) throw new Stop("no_join_code", `Setup wrote no ${SETUP_ENV.join_code} into .env.`, NEXT.setup, EXIT.refused);
  // The server's own try_url when setup kept one for this join code and channel, else the same page built here.
  const fromServer = value(SETUP_ENV.try_url);
  const name = agentDisplayName();
  const pageFor = (channel: string) =>
    namedPage(fromServer?.includes(`/try/${encodeURIComponent(joinCode)}?`) && URL.parse(fromServer)?.searchParams.get("c") === channel ? fromServer : tryLink(loginUrl(), joinCode, channel), name);
  /** The channel's direct link, or the Stop that says it is not open (no sender in .env, or the try page says channel_not_open). */
  const open = async (channel: string): Promise<DirectLink | Stop> => {
    if (channel !== "telegram" && !value(SENDER_ENV[channel]!)) {
      return new Stop("channel_not_open", `${CHANNEL_NAME[channel]} is not open on Flow's shared senders yet, so setup got no ${SENDER_ENV[channel]}.`, NEXT.link, EXIT.refused);
    }
    try {
      return await directLink(pageFor(channel));
    } catch (error) {
      if (error instanceof Stop && error.code === "channel_not_open") return error;
      throw error;
    }
  };
  const model = modelKeyReport(value, credit, had !== undefined);
  const asked = await open(options.channel);
  let links: Array<[string, DirectLink]>;
  let notOpen: string | undefined;
  if (!(asked instanceof Stop)) links = [[options.channel, asked]];
  else {
    // The asked-for channel is closed: the others' links instead, each checked the same way.
    links = [];
    for (const c of CHANNELS.filter((c) => c !== options.channel)) {
      const other = await open(c);
      if (!(other instanceof Stop)) links.push([c, other]);
    }
    if (!links.length) throw asked;
    notOpen = `${what} isn't open yet; here ${links.length === 1 ? "is your" : "are your"} ${links.map(([c]) => CHANNEL_NAME[c]).join(" and ")} link${links.length === 1 ? "" : "s"}.`;
  }
  const [channel, first] = links[0]!;
  const replyOnly = REPLY_ONLY[channel];
  const sayToPerson = `${notOpen ? `${what} isn't open yet. ` : ""}Your ${CHANNEL_NAME[channel]} link: ${first.link} ${OPEN_HINT[channel]} `
    + `On a computer without ${CHANNEL_NAME[channel]}, open ${first.page} instead.${replyOnly ? ` ${replyOnly}` : ""}`;
  const added = had ? addedToRunning(had, value) : undefined;
  // npm start reads .env and its name once, when it starts. Not running: start it. Running (its
  // .flow/running.json names a live process): restart it when setup wrote .env, the name changed
  // just now or a model key is still to come, else it is ready as it is.
  const running = runningAgent();
  const runStep = !running
    ? "npm start, then send the link above"
    : had || options.renamed || model.next
      ? `restart npm start (it runs at ${running.url}${added ? ` and lacks ${added}` : " and reads .env and its name only when it starts"}), then send the link above`
      : `send the link above (npm start is running at ${running.url})`;
  const next = [...(model.next ? [model.next] : []), runStep];
  if (json) {
    out({
      url: first.link, page: first.page, join_message: first.message, channel, join_code: joinCode, reply_only: Boolean(replyOnly), say_to_person: sayToPerson,
      ...(notOpen ? { not_open: options.channel, message: notOpen, links: Object.fromEntries(links.map(([c, d]) => [c, d.link])) } : {}),
      model_key: model.report, running: running ? { url: running.url } : false, next: next.join(", then "),
      // Setup's warnings when it ran just now (also on its own line above), such as observe's part failing.
      ...(warnings.length ? { warnings } : {}),
    });
  }
  if (notOpen) {
    say(notOpen);
    for (const [c, d] of links) say(`On ${CHANNEL_NAME[c]}: ${d.link} (on a computer: ${d.page})`);
  } else {
    say(first.link);
    say(`On a computer without ${CHANNEL_NAME[channel]}: ${first.page}`);
  }
  // The trial's counts for the channel the link is on, when setup just gave them; no other channel's.
  const counts = trial?.[channel];
  if (counts) {
    const note = trialNote(counts);
    if (note) say(`${CHANNEL_NAME[channel]} ${note.trim().slice(1, -1)}`); // "WhatsApp free trial: 3 of 300 messages used"
    if (channel === "imessage") {
      const people = peopleLine(counts);
      if (people) say(people);
    }
  }
  if (model.report.set) say(model.line);
  const one = notOpen && links.length > 1 ? "one" : "it";
  say(`${channel === "telegram" ? `Open ${one} on a phone and press Start` : `Open ${one} on a phone and send the message it fills in, "${first.message}"`}. From then on`);
  // No model key: the agent cannot answer yet, so the phone does not chat with it until there is one.
  say(model.report.set ? "that phone chats with this agent while it runs (npm start), with no public URL or tunnel." : "that phone reaches this agent while it runs (npm start), but it answers only once .env has a model key:");
  if (model.next) say(model.line);
  for (const [c] of links) if (REPLY_ONLY[c]) say(REPLY_ONLY[c]!);
  say(`Next: ${next.join(", then ")}.`);
  say(DEPLOY_HINT);
}

/**
 * Asks flow.engineer's /try page for its direct link as JSON ({"channel", "message", "link", "page"}):
 * a channel it cannot open yet (or a join code it does not know) answers {"error",
 * "error_description", "next"}, which stops here with that next step.
 */
async function directLink(url: string): Promise<DirectLink> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    if ((error as Error).name === "TimeoutError") throw new TimedOut(url, REQUEST_TIMEOUT_MS);
    throw error;
  }
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {}
  if (response.ok) {
    const { link, message, page } = body;
    if (typeof link === "string" && link && typeof message === "string" && message) return { link, message, page: typeof page === "string" && page ? page : url };
    throw new Stop("bad_answer", `${url} answered without a link.`, undefined, EXIT.refused);
  }
  const code = typeof body.error === "string" ? body.error : `http_${response.status}`;
  const detail = typeof body.error_description === "string" ? body.error_description : `${url} answered ${response.status}.`;
  throw new Stop(code, detail, typeof body.next === "string" && body.next ? body.next : undefined, EXIT.refused);
}
