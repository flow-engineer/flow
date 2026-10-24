// The flow.engineer side of `flow login`, `logout`, `whoami` and `setup`: every call to it, and
// where the Flow CLI token is kept. Only this file knows the server's routes and field names
// (flow.engineer's CLI sign-in contract).
//   POST /cli/device {client_name, hostname}  -> {device_code, user_code, verification_uri, verification_uri_complete, interval, expires_in}
//   POST /cli/token {device_code}             -> {access_token, expires_at, account}, or 400 {error} as RFC 8628 has it:
//                                                authorization_pending, slow_down, expired_token, access_denied, invalid_grant
//   POST /cli/revoke (bearer) {}              ends this token
//   GET  /cli/whoami (bearer)                 -> {account, email, token}
//   POST /cli/setup (bearer) {name, hostname, channels, have, workspace?, rotate?, rotate_now?}
//        -> {agent_id, workspace_id?, workspace_name?, cloud_key?, traces_key?, messaging_key?, flow_key?, model_credit?, join_code, account, app_id,
//            dashboard_url, try_url, <channel>_sender?, <channel>_link? (telegram, whatsapp, imessage: each only while
//            that shared sender is open), try_urls?, trial?, minted, next}; a 502 carries every field that worked too;
//        flow_key is the agent's one Flow key, {env: "FLOW_KEY", value: "flow_test_...", kid, mode, scopes, agent_id,
//        minted: true, previous_expires_at}, only when made in this call (in every answer of that call, errors too;
//        absent when have names FLOW_KEY and rotate does not); for now only the model uses it;
//        model_credit is the account's Flow trial model credit, {limit_usd, left_usd, base_url, default_model}, when
//        have names no provider key and the account has the credit (left_usd 0 when used up), else absent with
//        the reason in warnings; every folder's setup makes its own key, the credit is the account's;
//        rotate is true (every key) or the answer fields to make again, such as ["flow_key"]; rotate_now: true
//        ends the old FLOW_KEY at once instead of 24 h later (previous_expires_at);
//        workspace is an observe workspace's acc_ id or name (case-insensitive), 1 to 100 characters; absent: the
//        personal one; workspace_id and workspace_name are the workspace the agent and its cloud and traces keys are in
//        (whenever observe answered; an older server sends neither); 403 not_a_member, 409 workspace_ambiguous (pass the id);
//        429 slow_down with Retry-After; 403 for a trial limit (sandbox_allowance_used, ...), its next prose
//        Any answer may carry warnings: up to 20 strings to show the owner as they are.
//   GET  <model URL>/credit (bearer FLOW_KEY) -> {limit_usd, spent_usd, left_usd, default_model, models};
//        the model URL is src/model.ts's flowModelURL (flow.engineer/llm/framework/v1); 401 invalid_api_key,
//        403 insufficient_scope (the key lacks model), 402 trial_credit_used or trial_credit_unavailable
// Every error is flat: {"error": "<code>", "error_description": "<sentence>", "next": "<command, URL or sentence>"}
// (the model API's are OpenAI's shape, {"error": {message, type, code, next}}).
// The token is opaque (fcli_...), good only for /cli/*, and sent only to the server that issued it,
// over https (http only to this machine). Every request gives up after REQUEST_TIMEOUT_MS at most.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, configFile, RUN, setting } from "../../src/names.ts";

export const LOGIN_URL = "https://flow.engineer";

/** The longest one request to flow.engineer may take; login's polls are cut shorter by what is left of --timeout. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** A login URL a token may go to: https, or http to this machine only (a local flow.engineer). */
export function safeLoginUrl(url: string): boolean {
  const parsed = URL.parse(url);
  if (!parsed) return false;
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
}

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

/**
 * The token to use: FLOW_FRAMEWORK_TOKEN, else the credentials file's (with `url`, the server that
 * issued it, the only one it is sent to); undefined when signed out.
 */
export function currentToken(env: NodeJS.ProcessEnv = process.env): { token: string; from: "env" | "file"; url?: string } | undefined {
  const fromEnv = setting("TOKEN", env)?.trim();
  if (fromEnv) return { token: fromEnv, from: "env" };
  const saved = readCredentials(env);
  return saved ? { token: saved.token, from: "file", url: saved.url || LOGIN_URL } : undefined;
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

/** A device code started by `flow login` and not approved yet, kept for `flow login --wait`. */
export interface PendingLogin extends DeviceStart {
  /** When the code expires, in ms since the epoch. */
  expires_at: number;
  /** The server that issued it. */
  url: string;
}

/** ~/.config/flow-framework/pending.json, written at mode 0600 and deleted once the code is used or expired. */
export function pendingPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "pending.json");
}

export function readPending(env: NodeJS.ProcessEnv = process.env): PendingLogin | undefined {
  try {
    const saved = JSON.parse(readFileSync(pendingPath(env), "utf8")) as PendingLogin;
    return typeof saved.device_code === "string" && typeof saved.expires_at === "number" ? saved : undefined;
  } catch {
    return undefined;
  }
}

export function savePending(pending: PendingLogin, env: NodeJS.ProcessEnv = process.env): void {
  const path = pendingPath(env);
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function deletePending(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(pendingPath(env), { force: true });
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

/** setup's flow_key: the agent's one Flow key, for this mode (test or live). */
export interface FlowKey {
  env?: string;
  value?: string;
  kid?: string;
  mode?: string;
  scopes?: string[];
  agent_id?: string;
  minted?: boolean;
  /** When the key it replaced stops working (null: at once, or there was none). */
  previous_expires_at?: string | null;
}

export interface SetupAnswer {
  agent_id: string;
  /** The observe workspace (acc_...) the agent and its cloud and traces keys are in; absent from an older server. */
  workspace_id?: string;
  workspace_name?: string;
  /** Only the keys minted in this call come back (those the request did not say it has). */
  cloud_key?: string;
  traces_key?: string;
  messaging_key?: string;
  /** Each channel's shared sender and phone link, only while Flow has that channel open. */
  telegram_sender?: string;
  whatsapp_sender?: string;
  imessage_sender?: string;
  whatsapp_link?: string;
  imessage_link?: string;
  /** Missing only when the server could not make one; the keys it minted are written anyway. */
  join_code?: string;
  account?: Account;
  app_id?: string;
  dashboard_url?: string;
  /** The flow.engineer page that opens Telegram with the join message filled in. */
  try_url?: string;
  telegram_link?: string;
  /** The try page per channel with a sender: {telegram: ".../try/<code>?c=telegram", ...}. */
  try_urls?: Record<string, string>;
  /**
   * The account's free-trial counts per channel; limit null is unlimited. With `held` (Flow Messaging
   * since Oct 2026) they count people, `held` those past the limit waiting for a place; without it
   * (an older answer) messages, and iMessage's `contacts` the people it may reach.
   */
  trial?: Record<string, { limit: number | null; used: number; held?: number; contacts?: { limit: number; used: number } }>;
  /** The agent's one Flow key (FLOW_KEY), only when made in this call: its value is shown once. */
  flow_key?: FlowKey;
  /** The account's Flow trial model credit, when the agent has no provider key; absent: none (warnings say why). */
  model_credit?: { limit_usd?: number; left_usd?: number; base_url?: string; default_model?: string };
  /** The answer fields of the keys made in this call. */
  minted?: string[];
  next?: string[];
  /** Up to 20 lines for the owner, shown as they are. */
  warnings?: string[];
}

/** The answer's warnings: its strings only, at most 20. */
export function warningsOf(body: Record<string, unknown>): string[] {
  return Array.isArray(body.warnings) ? body.warnings.filter((w): w is string => typeof w === "string" && w !== "").slice(0, 20) : [];
}

/** Retry-After as seconds from now (delta-seconds or an HTTP date); undefined when absent or unreadable. */
export function retryAfterSeconds(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * The server answered with an error status; `code` is its `error` field when it gave one, `next` its
 * next step, and `fields` the whole answer (a failed setup carries the keys it minted anyway).
 */
export class LoginRefused extends Error {
  readonly status: number;
  readonly code: string;
  readonly next: string | undefined;
  readonly fields: Record<string, unknown>;
  /** Seconds the server asked to wait (Retry-After), for a 429. */
  readonly retryAfter: number | undefined;
  constructor(status: number, code: string, message: string, next?: string, fields: Record<string, unknown> = {}, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.next = next;
    this.fields = fields;
    this.retryAfter = retryAfter;
  }
}

/** The server answered nothing in time: `ms` is how long this request was given. */
export class TimedOut extends Error {
  readonly ms: number;
  constructor(url: string, ms: number) {
    super(`${url} did not answer within ${Math.ceil(ms / 1000)} s.`);
    this.ms = ms;
  }
}

interface Answer { status: number; body: Record<string, unknown>; retryAfter?: number }

async function call(url: string, path: string, options: { token?: string; body?: unknown; method?: string; timeoutMs?: number } = {}): Promise<Answer> {
  if (!safeLoginUrl(url)) {
    throw new LoginRefused(0, "insecure_login_url", `${url} is not https: the sign-in and its token go only over https (http only to localhost).`, `set FLOW_FRAMEWORK_LOGIN_URL to an https address, or unset it to use ${LOGIN_URL}`);
  }
  const timeoutMs = Math.max(0, Math.min(options.timeoutMs ?? REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS));
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${url}${path}`, {
      method: options.method ?? "POST",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: options.token ? "error" : "follow", // a redirect would carry the token to another address
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    if ((error as Error).name === "TimeoutError") throw new TimedOut(url, timeoutMs);
    throw error;
  }
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    if (response.ok) throw new LoginRefused(response.status, "bad_answer", `${url}${path} answered ${response.status} with no JSON.`);
  }
  return { status: response.status, body, retryAfter: retryAfterSeconds(response.headers.get("retry-after")) };
}

function refused(path: string, answer: Answer, url: string): LoginRefused {
  // A bare 404: this server has no CLI sign-in (an older one, or not flow.engineer at all).
  if (answer.status === 404 && typeof answer.body.error !== "string") {
    return new LoginRefused(404, "server_unsupported", `${url} has no ${path}, so it cannot sign in the Flow CLI: it is an older server, or not flow.engineer.`,
      url === LOGIN_URL ? `${RUN}@latest login` : `unset FLOW_FRAMEWORK_LOGIN_URL to use ${LOGIN_URL}, or point it at a server that has /cli/`, answer.body);
  }
  const code = typeof answer.body.error === "string" ? answer.body.error : answer.status === 401 ? "not_signed_in" : `http_${answer.status}`;
  const detail = typeof answer.body.error_description === "string" ? answer.body.error_description : typeof answer.body.message === "string" ? answer.body.message : "";
  const next = typeof answer.body.next === "string" && answer.body.next ? answer.body.next : undefined;
  const sentence = detail.endsWith(".") ? detail.slice(0, -1) : detail;
  return new LoginRefused(answer.status, code, `${path} answered ${answer.status} ${code}${sentence ? `: ${sentence}` : ""}.`, next, answer.body, answer.retryAfter);
}

/** `clientName` and `hostname` are shown on the approval page. */
export async function startDevice(url: string, clientName: string, hostname: string): Promise<DeviceStart> {
  const answer = await call(url, "/cli/device", { body: { client_name: clientName, hostname } });
  if (answer.status !== 200 || typeof answer.body.device_code !== "string") throw refused("/cli/device", answer, url);
  return answer.body as unknown as DeviceStart;
}

const WAITING = new Set(["authorization_pending", "slow_down", "expired_token", "access_denied"]);

/** `timeoutMs` cuts this one poll short (login gives it what is left of --timeout). */
export async function pollToken(url: string, deviceCode: string, timeoutMs?: number): Promise<TokenAnswer> {
  const answer = await call(url, "/cli/token", { body: { device_code: deviceCode }, timeoutMs });
  const token = answer.body.access_token;
  if (answer.status === 200 && typeof token === "string") {
    return { status: "signed_in", token, expires_at: answer.body.expires_at as string | undefined, account: answer.body.account as Account | undefined };
  }
  const error = answer.body.error;
  if (typeof error === "string" && WAITING.has(error)) return { status: error as "authorization_pending" };
  throw refused("/cli/token", answer, url);
}

export async function revoke(url: string, token: string): Promise<void> {
  const answer = await call(url, "/cli/revoke", { token, body: {} });
  // 401: the token had already ended, which is what logout wants.
  if (answer.status >= 300 && answer.status !== 401) throw refused("/cli/revoke", answer, url);
}

export async function whoami(url: string, token: string): Promise<Account> {
  const answer = await call(url, "/cli/whoami", { token, method: "GET" });
  if (answer.status !== 200) throw refused("/cli/whoami", answer, url);
  return answer.body as unknown as Account;
}

export async function setup(url: string, token: string, request: { name: string; hostname: string; channels: string[]; have: string[]; workspace?: string; rotate?: true | string[]; rotate_now?: true }): Promise<SetupAnswer> {
  const answer = await call(url, "/cli/setup", { token, body: request });
  // A 200 is returned whole even without a join code: the keys it minted are shown only now.
  if (answer.status !== 200) throw refused("/cli/setup", answer, url);
  return answer.body as unknown as SetupAnswer;
}

/** GET /credit's answer: the account's Flow trial credit in US dollars. */
export interface ModelCredit {
  limit_usd?: number;
  spent_usd?: number;
  left_usd?: number;
  default_model?: string;
  models?: string[];
}

/** The credit left on the account of a FLOW_KEY; `baseURL` is Flow's model API (flowModelURL). */
export async function modelCredit(baseURL: string, key: string): Promise<ModelCredit> {
  let end = baseURL.length;
  while (end > 0 && baseURL[end - 1] === "/") end--;
  const answer = await call(baseURL.slice(0, end), "/credit", { token: key, method: "GET" });
  if (answer.status !== 200) {
    // OpenAI's error shape: {"error": {message, code, next}}.
    const inner = answer.body.error && typeof answer.body.error === "object" ? (answer.body.error as Record<string, unknown>) : undefined;
    throw refused("/credit", inner ? { ...answer, body: { error: inner.code, error_description: inner.message, next: inner.next } } : answer, baseURL);
  }
  return answer.body as ModelCredit;
}

/** The agent's .env names for what setup hands back; only the keys' and the join's names are sent as `have`. */
export const SETUP_ENV = {
  cloud_key: "FLOW_FRAMEWORK_CLOUD_KEY",
  traces_key: "FLOW_FRAMEWORK_TRACES_KEY",
  messaging_key: "FLOW_MESSAGING_KEY",
  telegram_sender: "FLOW_MESSAGING_TELEGRAM_SENDER",
  whatsapp_sender: "FLOW_MESSAGING_WHATSAPP_SENDER",
  imessage_sender: "FLOW_MESSAGING_IMESSAGE_SENDER",
  join_code: "FLOW_FRAMEWORK_JOIN_CODE",
  try_url: "FLOW_FRAMEWORK_TRY_URL",
} as const satisfies Partial<Record<keyof SetupAnswer, string>>;

/** The phone link for a join code, built as the server builds its try_url, for a .env from before setup kept it. */
export function tryLink(url: string, joinCode: string, channel: string): string {
  return `${url}/try/${encodeURIComponent(joinCode)}?c=${encodeURIComponent(channel)}`;
}
