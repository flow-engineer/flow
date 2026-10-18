// The flow.engineer side of `flow login`, `logout`, `whoami` and `setup`: every call to it, and
// where the Flow CLI token is kept. Only this file knows the server's routes and field names.
//   POST /cli/device {client_name, hostname}  -> {device_code, user_code, verification_uri, verification_uri_complete?, interval, expires_in}
//   POST /cli/token {device_code}             -> {access_token, expires_at, account?}, or {error} as RFC 8628 has it:
//                                                authorization_pending, slow_down, expired_token, access_denied
//   POST /cli/revoke (bearer)                 ends this token
//   GET  /cli/whoami (bearer)                 -> {email, account}
//   POST /cli/setup (bearer) {name, hostname, channels, have}
//        -> {agent_id, cloud_key?, traces_key?, messaging_key?, telegram_sender?, join_code}
// The token is opaque (fcli_...), good only for /cli/*, and never sent to any other host.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, configFile, setting } from "../../src/names.ts";

export const LOGIN_URL = "https://flow.engineer";

/** flow.engineer, or FLOW_FRAMEWORK_LOGIN_URL, without trailing slashes (trimmed from the end, in linear time). */
export function loginUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = setting("LOGIN_URL", env) || LOGIN_URL;
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return url.slice(0, end);
}

/** ~/.config/flow-framework/credentials.json (XDG_CONFIG_HOME when set), written at mode 0600. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "credentials.json");
}

/** The credentials file to read or delete: credentialsPath, else ~/.config/chinwag/credentials.json while only it exists. */
const savedCredentialsPath = (env: NodeJS.ProcessEnv) => configFile("credentials.json", env);

export interface Credentials {
  token: string;
  expires_at?: string;
  /** The server that issued it, so logout revokes it there. */
  url: string;
}

/** The token to use: FLOW_FRAMEWORK_TOKEN, else the credentials file's; undefined when signed out. */
export function currentToken(env: NodeJS.ProcessEnv = process.env): { token: string; from: "env" | "file" } | undefined {
  const fromEnv = setting("TOKEN", env)?.trim();
  if (fromEnv) return { token: fromEnv, from: "env" };
  const saved = readCredentials(env);
  return saved ? { token: saved.token, from: "file" } : undefined;
}

export function readCredentials(env: NodeJS.ProcessEnv = process.env): Credentials | undefined {
  const path = savedCredentialsPath(env);
  if (!existsSync(path)) return undefined;
  try {
    const saved = JSON.parse(readFileSync(path, "utf8")) as Credentials;
    return typeof saved.token === "string" && saved.token ? saved : undefined;
  } catch {
    return undefined;
  }
}

export function saveCredentials(credentials: Credentials, env: NodeJS.ProcessEnv = process.env): string {
  const path = credentialsPath(env);
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // a file that was already there keeps its mode on write
  return path;
}

export function deleteCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = savedCredentialsPath(env);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval: number;
  expires_in: number;
}

export type TokenAnswer =
  | { status: "signed_in"; token: string; expires_at?: string; account?: Account }
  | { status: "authorization_pending" | "slow_down" | "expired_token" | "access_denied" };

export interface Account {
  email: string;
  account: string;
}

export interface SetupAnswer {
  agent_id: string;
  /** Only the keys the request said it lacks come back. */
  cloud_key?: string;
  traces_key?: string;
  messaging_key?: string;
  telegram_sender?: string;
  join_code: string;
}

/** The server answered with an error status; `code` is its `error` field when it gave one. */
export class LoginRefused extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call(url: string, path: string, options: { token?: string; body?: unknown; method?: string } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${url}${path}`, {
    method: options.method ?? "POST",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    if (response.ok) throw new LoginRefused(response.status, "bad_answer", `${url}${path} answered ${response.status} with no JSON.`);
  }
  return { status: response.status, body };
}

function refused(path: string, answer: { status: number; body: Record<string, unknown> }): LoginRefused {
  const code = typeof answer.body.error === "string" ? answer.body.error : answer.status === 401 ? "not_signed_in" : `http_${answer.status}`;
  const detail = typeof answer.body.error_description === "string" ? answer.body.error_description : typeof answer.body.message === "string" ? answer.body.message : "";
  return new LoginRefused(answer.status, code, `${path} answered ${answer.status} ${code}${detail ? `: ${detail}` : ""}.`);
}

export async function startDevice(url: string, hostname: string): Promise<DeviceStart> {
  const answer = await call(url, "/cli/device", { body: { client_name: "@flow-engineer/flow", hostname } });
  if (answer.status !== 200 || typeof answer.body.device_code !== "string") throw refused("/cli/device", answer);
  return answer.body as unknown as DeviceStart;
}

const WAITING = new Set(["authorization_pending", "slow_down", "expired_token", "access_denied"]);

export async function pollToken(url: string, deviceCode: string): Promise<TokenAnswer> {
  const answer = await call(url, "/cli/token", { body: { device_code: deviceCode } });
  const token = answer.body.access_token;
  if (answer.status === 200 && typeof token === "string") {
    return { status: "signed_in", token, expires_at: answer.body.expires_at as string | undefined, account: answer.body.account as Account | undefined };
  }
  const error = answer.body.error;
  if (typeof error === "string" && WAITING.has(error)) return { status: error as "authorization_pending" };
  throw refused("/cli/token", answer);
}

export async function revoke(url: string, token: string): Promise<void> {
  const answer = await call(url, "/cli/revoke", { token, body: {} });
  // 401: the token had already ended, which is what logout wants.
  if (answer.status >= 300 && answer.status !== 401) throw refused("/cli/revoke", answer);
}

export async function whoami(url: string, token: string): Promise<Account> {
  const answer = await call(url, "/cli/whoami", { token, method: "GET" });
  if (answer.status !== 200) throw refused("/cli/whoami", answer);
  return answer.body as unknown as Account;
}

export async function setup(url: string, token: string, request: { name: string; hostname: string; channels: string[]; have: string[] }): Promise<SetupAnswer> {
  const answer = await call(url, "/cli/setup", { token, body: request });
  if (answer.status !== 200 || typeof answer.body.join_code !== "string") throw refused("/cli/setup", answer);
  return answer.body as unknown as SetupAnswer;
}

/** The agent's .env names for what setup hands back. */
export const SETUP_ENV = {
  cloud_key: "FLOW_FRAMEWORK_CLOUD_KEY",
  traces_key: "FLOW_FRAMEWORK_TRACES_KEY",
  messaging_key: "FLOW_MESSAGING_KEY",
  telegram_sender: "FLOW_MESSAGING_TELEGRAM_SENDER",
  join_code: "FLOW_FRAMEWORK_JOIN_CODE",
} as const satisfies Partial<Record<keyof SetupAnswer, string>>;

/** The phone link for a join code: a flow.engineer page that opens the channel with the join message filled in. */
export function tryLink(url: string, joinCode: string, channel: string): string {
  return `${url}/try/${encodeURIComponent(joinCode)}?c=${encodeURIComponent(channel)}`;
}
