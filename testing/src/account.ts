// `flow login | logout | whoami | setup | link`: sign in to flow.engineer once, then get the
// agent's keys into .env and a link to chat with it from a phone (Telegram), with no key made by hand.
// The calls to flow.engineer are in testing/src/flow-login.ts. Every command takes --json: one JSON
// object per line on stdout (login prints a "pending" line first, so a coding agent can show the
// link while it waits), every human line on stderr. Errors are {"error":{code,message,next}}.
// Exit status: 0 done, 1 usage or not signed in, 2 network, 3 the server refused (or the code was
// denied or expired).

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  currentToken, deleteCredentials, LoginRefused, loginUrl, pollToken, readCredentials, revoke, saveCredentials,
  SETUP_ENV, setup, startDevice, tryLink, whoami, type Account, type SetupAnswer,
} from "./flow-login.ts";

export const ACCOUNT_COMMANDS = new Set(["login", "logout", "whoami", "setup", "link"]);

export const ACCOUNT_LINES = `  flow login [--no-browser] [--json]
                            Sign in to flow.engineer (opens the browser; prints the link and code too)
  flow logout [--json]      End this machine's sign-in and delete its token
  flow whoami [--json]      Show the account you are signed in as
  flow setup [--replace] [--ci] [--json]
                            Write this agent's keys (test cloud, traces, Flow Messaging) into ./.env
  flow link [--json]        Print the link that opens a chat with this agent on Telegram`;

const USAGE = `Usage:\n${ACCOUNT_LINES}

The token is kept in ~/.config/flow-framework/credentials.json (mode 0600); FLOW_FRAMEWORK_TOKEN, when
set, is used instead. setup never prints a key, only its last 4 characters, and keeps any value
already in .env unless --replace. CI never signs in: setup --ci says how to give it the agent's key.

Exit status: 0 done, 1 usage or not signed in, 2 network, 3 refused, denied or expired.`;

const NEXT = { login: "npx flow login", setup: "npx flow setup" };
const EXIT = { ok: 0, usage: 1, network: 2, refused: 3 } as const;

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
  let values: Record<string, boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      options: {
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        ...(command === "login" ? { "no-browser": { type: "boolean", default: false } } : {}),
        ...(command === "setup" ? { replace: { type: "boolean", default: false }, ci: { type: "boolean", default: false } } : {}),
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
  const json = values.json === true;
  const out = (report: unknown) => process.stdout.write(`${JSON.stringify(report)}\n`);
  const say = json ? (line: string) => console.error(line) : (line: string) => console.log(line);
  try {
    if (command === "login") await login(values["no-browser"] === true, json, out, say);
    else if (command === "logout") await logout(json, out, say);
    else if (command === "whoami") await showAccount(json, out, say);
    else if (command === "setup") await setupEnv(values.replace === true, values.ci === true, json, out, say);
    else link(json, out, say);
    return EXIT.ok;
  } catch (error) {
    const stop = asStop(error);
    console.error(stop.next ? `${stop.message} Next: ${stop.next}` : stop.message);
    if (json) out({ error: { code: stop.code, message: stop.message, next: stop.next ?? null } });
    return stop.exit;
  }
}

type Out = (report: unknown) => void;
type Say = (line: string) => void;

function asStop(error: unknown): Stop {
  if (error instanceof Stop) return error;
  if (error instanceof LoginRefused) {
    if (error.status === 401) return new Stop("not_signed_in", "Your sign-in has ended or was revoked.", NEXT.login, EXIT.refused);
    return new Stop(error.code, error.message, undefined, EXIT.refused);
  }
  const cause = (error as { cause?: { code?: string } }).cause?.code;
  return new Stop("network", `Could not reach ${loginUrl()}: ${cause ?? (error as Error).message}.`, undefined, EXIT.network);
}

function signedIn(): string {
  const current = currentToken();
  if (!current) throw new Stop("not_signed_in", "Not signed in to flow.engineer.", NEXT.login, EXIT.usage);
  return current.token;
}

async function login(noBrowser: boolean, json: boolean, out: Out, say: Say): Promise<void> {
  const url = loginUrl();
  const start = await startDevice(url, hostname());
  const page = start.verification_uri_complete || start.verification_uri;
  const opened = !noBrowser && openBrowser(page);
  if (json) out({ status: "pending", verification_uri: start.verification_uri, verification_uri_complete: page, user_code: start.user_code, expires_in: start.expires_in, opened_browser: opened });
  say(`${opened ? "Opened your browser at" : "Open"} ${page}`);
  say(`and check it shows the code ${start.user_code}, then approve. Waiting...`);
  let interval = start.interval;
  const deadline = Date.now() + start.expires_in * 1000;
  for (;;) {
    await delay(interval * 1000);
    if (Date.now() > deadline) throw expired();
    const answer = await pollToken(url, start.device_code);
    if (answer.status === "authorization_pending") continue;
    if (answer.status === "slow_down") {
      interval += 5; // RFC 8628: each slow_down adds 5 seconds for good
      continue;
    }
    if (answer.status === "expired_token") throw expired();
    if (answer.status === "access_denied") throw new Stop("access_denied", "The sign-in was denied in the browser.", NEXT.login, EXIT.refused);
    const path = saveCredentials({ token: answer.token, ...(answer.expires_at ? { expires_at: answer.expires_at } : {}), url });
    const account = answer.account ?? (await whoami(url, answer.token));
    if (json) out({ status: "signed_in", account, token_path: path });
    say(`Signed in as ${account.email}. The token is in ${path}.`);
    say(`Next, from your agent's folder: ${NEXT.setup}`);
    return;
  }
}

const expired = () => new Stop("expired_token", "The code expired before it was approved.", NEXT.login, EXIT.refused);

/** Opens the page in the default browser; false when there is no way to (it is printed anyway). */
function openBrowser(page: string): boolean {
  const [command, ...args] = process.platform === "darwin" ? ["open", page] : process.platform === "win32" ? ["cmd", "/c", "start", "", page] : ["xdg-open", page];
  try {
    const child = spawn(command!, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
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

async function setupEnv(replace: boolean, ci: boolean, json: boolean, out: Out, say: Say): Promise<void> {
  if (ci) {
    const steps = [
      `CI never signs in. It runs the tests with the agent's test cloud key, ${SETUP_ENV.cloud_key}, as a secret.`,
      `Run ${NEXT.setup} on your machine first, then copy the key from .env into your CI without printing it, for GitHub:`,
      `  grep '^${SETUP_ENV.cloud_key}=' .env | cut -d= -f2- | gh secret set ${SETUP_ENV.cloud_key}`,
      "and in the workflow: npx flow test --synthetic --json",
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
  const name = (existsSync(packageJson) ? (JSON.parse(readFileSync(packageJson, "utf8")) as { name?: string }).name : undefined) ?? basename(dir);
  const have = Object.values(SETUP_ENV).filter((n) => before.get(n));
  const answer = await setup(loginUrl(), token, { name, hostname: hostname(), channels: ["telegram"], have });

  const written: Array<{ name: string; action: "added" | "unchanged" | "kept" | "replaced"; value: string }> = [];
  for (const [field, envName] of Object.entries(SETUP_ENV) as Array<[keyof SetupAnswer, string]>) {
    const value = answer[field];
    if (typeof value !== "string" || !value) continue;
    const old = before.get(envName);
    let action: (typeof written)[number]["action"];
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

  const next = ["npx flow test --synthetic", "npm start", "npx flow link"];
  if (json) out({ agent: answer.agent_id, join_code: answer.join_code, env_written: { ".env": written }, next });
  say(`Agent ${answer.agent_id}. In .env:`);
  for (const w of written) say(`  ${w.name}=${w.value}  ${w.action}${w.action === "kept" ? " (yours differs; --replace takes the new one)" : ""}`);
  say(`Next: ${next.join(", then ")}`);
}

function link(json: boolean, out: Out, say: Say): void {
  const file = join(process.cwd(), ".env");
  const joinCode = process.env[SETUP_ENV.join_code] || (existsSync(file) ? envValues(readFileSync(file, "utf8").split("\n")).get(SETUP_ENV.join_code) : undefined);
  if (!joinCode) throw new Stop("no_join_code", `No ${SETUP_ENV.join_code} in .env.`, NEXT.setup, EXIT.usage);
  const url = tryLink(loginUrl(), joinCode, "telegram");
  const sayToPerson = `Open this on your phone and send the message Telegram fills in: ${url}`;
  if (json) out({ url, channel: "telegram", join_code: joinCode, say_to_person: sayToPerson });
  say(url);
  say("Open it on a phone with Telegram: it opens Flow's test bot with your join code filled in. Send it, and");
  say("from then on that phone chats with this agent while it runs (npm start). The link lasts as long as the app.");
}
