// `flow conversations` and `flow issues`: the hosted agent's conversations, each agent reply's grade
// (good, unhelpful or wrong, with the rule, the reason and the quoted words), and the issues the
// grades add up to, read from flow.engineer with the agent's Flow key (FLOW_KEY; production reads with
// the live Flow key FLOW_LIVE_KEY when it is set, from `flow setup --live`), so a coding agent
// finds the replies graded wrong and fixes the agent without a person reading the chats:
//   GET {cloud}/v1/agent/conversations?environment=&grade=&since=&limit=&cursor=
//   GET {cloud}/v1/agent/conversations/{id}
//   GET {cloud}/v1/agent/issues?status=
//   GET {cloud}/v1/agent/issues/{issue}/test-case (the test case Flow proposes for an issue)
//   GET {cloud}/v1/agent/feedback?days=30 (the team's feedback, printed under the issues)
// `flow insights` reads Flow Insights, what the dashboard shows of people's closed production
// conversations (where they gave up, asked again or got annoyed, by topic), and the conversations
// behind one finding:
//   GET {cloud}/v1/agent/insights?days=7|30
//   GET {cloud}/v1/agent/insights/findings/{finding}/conversations?days=7|30
// Every read says how its message text came (the Flow-Text header and the answer's text_mode: raw,
// deidentified or withheld), printed as one Text: line and kept as text_mode in --json.
// Errors are { error: { code, message, hint } }. The reads wait out a 429 and try once more after a
// network error or a 5xx (testing/src/cloud-call.ts). With --json, stdout is one JSON document: the
// server's, or { ok: false, error: { code, message, hint? }, next } when it did not work.
// Exit status: 0 printed, 1 the server refused or could not be reached, or no key, 2 a wrong flag.
// listConversations, showConversation, listIssues, listInsights and insightConversations return the
// data, for callers other than the CLI.

import { parseArgs } from "node:util";
import { OBSERVE_URL, setting } from "../../src/traces.ts";
import { cloudCall, failureDocument, keyHelp, keyRefused, KEYS_HELP, NetworkError, SETUP_LIVE, textLine, type FoundKey, type Waits } from "./cloud-call.ts";
import { sinceSeconds } from "./deploy.ts";
import { loadEnv } from "./report.ts";

export const CONVERSATIONS_LINES = `  flow conversations [--env staging|production] [--grade wrong|unhelpful|good] [--contact <label>] [--since 24h] [--limit n] [--json]
                            The hosted agent's conversations, with how many of its replies were
                            graded wrong or unhelpful
  flow conversations show <id> [--env production] [--json]
                            One conversation, message by message, with each graded reply's label,
                            rule, reason and the words it was graded on, and each reply's tool calls
                            and delivery when Flow has them
  flow issues [--status open|resolved|ignored|all] [--json]
                            The problems the grades add up to, each with its conversations and a
                            suggested fix
  flow issues test-case <id> [--json]
                            The test case Flow proposes for an issue: its rule, the reply it
                            comes from and the checks, to write a scenario from`;

const COMMON = `  --json                   One JSON document on stdout: the server's (pages of conversations
                           merged into one), or { ok: false, error: { code, message, hint }, next }
                           when it did not work; every other line goes to stderr
  --cloud <url>            Flow's address (default: FLOW_FRAMEWORK_CLOUD, else ${OBSERVE_URL})
  --dotenv <path>          Read the environment from this file instead of the folder's .env
  --server <url>           Read over a hosted Flow MCP as you (flow mcp login), not with this
                           folder's keys (default: FLOW_MCP_SERVER)
  --agent <id|name>        With --server: which of your agents (default: your only one)
  -h, --help               Show this help

Reads with the agent's Flow key, FLOW_KEY (flow setup writes it into .env); production reads
(--env production, insights) read with the live Flow key FLOW_LIVE_KEY when it is set
(${SETUP_LIVE} writes it), else FLOW_KEY. No key is ever printed. Each read prints how its
message text came, one line such as "Text: de-identified (...)"; --json keeps it as text_mode.
A 429 (60 reads a minute per key) is waited out, up to 30 s, and said on stderr; a read that hit a
network error or a 5xx is tried once more.
Exit status: 0 printed, 1 no key, or the server refused or could not be reached (its message and
hint are printed), 2 a wrong flag.

${KEYS_HELP}`;

const CONVERSATIONS_USAGE = `Usage:
  flow conversations [options]
  flow conversations show <id> [--env production] [--json]

Lists the hosted agent's conversations, newest first: id, last message, channel, the agent version
behind its latest reply, contact, messages, and how many replies were graded wrong and unhelpful. show prints one conversation, one line per
message, and under each graded agent reply its label, the rule it was graded on, why, and the quoted
words; under an agent reply, its tool calls (name, time, ok or the error) and its delivery (queued,
sent, delivered, read or failed, with the channel's code) when Flow has them. show reads with
FLOW_KEY and, when Flow does not find the id with it, once more with FLOW_LIVE_KEY when set;
show --env production reads with FLOW_LIVE_KEY straight away. To fix bad replies:
flow conversations --grade wrong, then flow conversations show <id>.

Options:
  --env <name>             staging or production (default: production for a live key, else
                           staging); --environment works too
  --grade <label>          Only conversations with a reply graded wrong, unhelpful or good
  --contact <label>        Only this contact's conversations, by its label as listed: "Contact 9e35"
                           or 9e35 (read over as many pages as it takes)
  --since <when>           Only conversations with a message since then: 30m, 24h, 7d, or a time
                           such as 2026-10-29T09:00:00Z
  --limit <n>              At most this many conversations (default: 20, at most 1000), asked for 100 a
                           page over as many pages as it takes
${COMMON}`;

const ISSUES_USAGE = `Usage:
  flow issues [--status open|resolved|ignored|all] [--json]
  flow issues test-case <id> [--json]

The problems the grades of the agent's replies add up to: id, status, conversations, last seen,
title, and the suggested fix. flow conversations show <id> reads one of the conversations.
Then your team's feedback: checks marked out of date (change them in the scenario file) and reply
grades marked wrong. test-case prints the test case Flow proposes for one issue (on stdout only; it
writes no file): write a scenario in tests/scenarios from it, then flow test --only <that scenario>.

Options:
  --status <status>        open (the default), resolved, ignored or all
  --env, --environment     Taken and ignored: issues cover both environments
${COMMON}`;

interface ApiError { code?: string; type?: string; message?: string; hint?: string }
interface Grades { good?: number; unhelpful?: number; wrong?: number; not_graded?: number }
export interface Conversation {
  id: string;
  environment?: string;
  channel?: string;
  /** Every channel the conversation used, when the server sends them. */
  channels?: string[];
  contact?: string;
  started_at?: string;
  last_message_at?: string;
  messages?: number;
  /** null when the grades cannot be read now. */
  grades?: Grades | null;
  /** The agent version behind its latest reply, and where Flow got it (trace, run or deploy); null when none is known. */
  version?: string | null;
  version_source?: string | null;
  /** Its replies came from more than one version. */
  version_changed?: boolean;
  /** test for a conversation of flow test, flow chat or the playground (never graded), else production. */
  run_kind?: string;
}
/** rule, reason and quote are null when the account's data keeps them back. */
interface Grade { label?: string; verdict?: string | null; rule?: string | null; reason?: string | null; quote?: string | null; graded_at?: string }
/** A tool call of an agent reply's turn: a name (older servers), or its time, outcome and, when the account shows them, input and output. */
type ToolCall = string | { name?: string; tool?: string; ms?: number | null; ok?: boolean | null; error?: { code?: string | null; message?: string | null } | null; input?: unknown; output?: unknown; truncated?: boolean };
/** Where an agent reply got to on its channel; code and error_type are the channel's when it failed. */
interface Delivery { state?: string; code?: string | number | null; error_type?: string | null; at?: string | null }
/** text is null unless text_state is shown; role your_code is a message the agent's own code sent, never graded. */
interface Message { id?: string; role?: string; at?: string; text?: string | null; text_state?: string; tools?: ToolCall[]; delivery?: Delivery | null; grade?: Grade | null }

/** What prints in place of a message's text the server does not send. */
const TEXT_STATES: Record<string, string> = {
  deleted: "(deleted by retention)",
  withheld: "(text withheld)",
  not_sent: "(text not sent to Flow)",
  none: "(no text recorded)",
};
/** The line under a message whose text was never sent (observe's messages.no_text). */
const NOT_SENT_WHY = "its trace carried no text: the agent traced metadata only (FLOW_FRAMEWORK_TRACES_CONTENT off), or the message had none (a photo, video or voice note without a caption); never graded";
/** check and note are null when the account's data keeps the words back. */
interface Feedback {
  id?: string; kind?: string; reason?: string; todo?: string | null; note?: string | null; at?: string;
  scenario?: string | null; channel?: string | null; check?: string | null; check_index?: number | null;
  conversation?: string | null; message?: string | null; rules?: string[] | null;
}
interface Issue { id: string; title?: string; status?: string; conversations?: number; first_seen?: string; last_seen?: string; suggested_fix?: string | null }

const COMMON_OPTIONS = {
  json: { type: "boolean", default: false },
  cloud: { type: "string" },
  dotenv: { type: "string" },
  server: { type: "string" },
  agent: { type: "string" },
  env: { type: "string" },
  environment: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
} as const;

/** The exit status of a wrong flag. */
export const USAGE_EXIT = 2;

/** Arguments, or undefined once what is wrong with them is printed (as --json's document when --json is among them). */
export function parse<T extends Record<string, { type: "string" | "boolean" }>>(name: string, args: string[], options: T, usage: string) {
  try {
    const parsed = parseArgs({ args, allowPositionals: true, strict: true, options: { ...COMMON_OPTIONS, ...options } });
    const { env, environment } = parsed.values as { env?: string; environment?: string };
    if (env !== undefined && environment !== undefined && env !== environment) throw new Error(`--env and --environment name different environments (${env}, ${environment}): give one`);
    (parsed.values as { environment?: string }).environment = environment ?? env;
    return parsed;
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    const unknown = code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? /'([^']+)'/.exec(message)?.[1] : undefined;
    usageFailed(args.includes("--json"), `${name}: ${unknown ? `unknown option ${unknown}` : message.split(". ")[0]}`, usage);
    return undefined;
  }
}

/** A wrong flag: the line and the usage on stderr, the failure document on stdout with --json; the exit status. */
export function usageFailed(json: boolean, message: string, usage?: string): number {
  if (json) process.stdout.write(failureDocument("usage", message));
  console.error(usage ? `${message}\n\n${usage}` : message);
  return USAGE_EXIT;
}

/** Where a command reads: Flow's address and the key it found, with where it found it. */
export interface Access {
  cloud: string;
  key: FoundKey;
  /** The live key, for showConversation's one more try when FLOW_KEY does not find the id (a production conversation). */
  fallback?: FoundKey;
  waits?: Waits;
}

/** The live Flow key's name in .env (flow setup --live writes it). */
export const LIVE_KEY = "FLOW_LIVE_KEY";

/**
 * The key a read uses, by where it reads: production with the live key when it is set, else
 * FLOW_KEY; staging with FLOW_KEY, else the live key (it reads staging too); unnamed (show without
 * --env) as staging, with the live key as the fallback. `found` gives a name's value and where it was.
 */
export function readKey(environment: "staging" | "production" | undefined, found: (name: string) => { value: string; where: string } | undefined): { key: FoundKey; fallback?: FoundKey } | undefined {
  const flow = found("FLOW_KEY");
  const read = found(LIVE_KEY);
  const flowKey: FoundKey | undefined = flow && { kind: "flow_key", name: "FLOW_KEY", ...flow };
  const liveKey: FoundKey | undefined = read && { kind: "live_key", name: LIVE_KEY, ...read };
  const [first, second] = environment === "production" ? [liveKey, flowKey] : [flowKey, liveKey];
  if (!first) return second && { key: second };
  return { key: first, ...(environment === undefined && second && first === flowKey ? { fallback: second } : {}) };
}

/** What a read says with no key; for production it names the live key first. */
export function noKey(name: string, environment: "staging" | "production" | undefined): Failed {
  return environment === "production"
    ? new Failed(`${name} reads production with the agent's live Flow key: set ${LIVE_KEY} (${SETUP_LIVE} writes it into .env), or a flow_live_ FLOW_KEY.`, "no_live_key", undefined, SETUP_LIVE)
    : new Failed(`${name} reads with the agent's Flow key: set FLOW_KEY (flow setup writes it into .env).`, "no_flow_key", undefined, "npx @flow-engineer/flow setup");
}

/** The address and the key for reading `environment`, after .env (or --dotenv) is read; a Failed says what is missing. */
export function access(name: string, values: { cloud?: string; dotenv?: string }, environment?: "staging" | "production"): Access | Failed {
  const fromEnvironment = new Set(["FLOW_KEY", LIVE_KEY].filter((n) => process.env[n]?.trim()));
  const envProblem = loadEnv(values.dotenv);
  if (envProblem) return new Failed(envProblem, "bad_dotenv");
  const keys = readKey(environment, (n) => {
    const value = process.env[n]?.trim();
    return value ? { value, where: fromEnvironment.has(n) ? "the environment" : values.dotenv ?? ".env in this folder" } : undefined;
  });
  if (!keys) return noKey(name, environment);
  return { cloud: (values.cloud || setting("CLOUD") || OBSERVE_URL).replace(/\/+$/, ""), ...keys };
}

/** Where a command reads over a hosted Flow MCP (--server, else FLOW_MCP_SERVER) and which agent. */
export interface Hosted {
  server: string;
  agent?: string;
}

/**
 * --server (else FLOW_MCP_SERVER) and --agent: the hosted Flow MCP a command reads over, what is
 * wrong with them, or undefined to read with this folder's keys.
 */
export function hostedOf(values: { server?: string; agent?: string; cloud?: string; dotenv?: string }, env: NodeJS.ProcessEnv = process.env): Hosted | string | undefined {
  const server = values.server ?? (env.FLOW_MCP_SERVER?.trim() || undefined);
  if (!server) return values.agent === undefined ? undefined : "--agent goes with --server (or FLOW_MCP_SERVER): it names which of your agents a hosted Flow MCP reads.";
  if (values.cloud !== undefined || values.dotenv !== undefined) return "--server reads as you, signed in with flow mcp login, not with this folder's keys: --cloud and --dotenv do not go with it.";
  if (values.agent !== undefined && !values.agent.trim()) return "--agent is one of your agents' flow_agent_id or name.";
  return { server, ...(values.agent ? { agent: values.agent.trim() } : {}) };
}

/** A hosted tool's result as the commands print a read: --json's text, its JSON and its text mode. */
export function answerOf(body: Record<string, unknown>): { text: string; body: Record<string, unknown>; textMode?: string } {
  return { text: JSON.stringify(body), body, ...(typeof body.text_mode === "string" && body.text_mode ? { textMode: body.text_mode } : {}) };
}

/** Runs `run` with the hosted Flow MCP's reads when the command has one (else with none), closing them after. */
export async function withHosted<T>(hosted: Hosted | undefined, command: string, run: (read: HostedRead | undefined) => Promise<T>): Promise<T> {
  if (!hosted) return run(undefined);
  const { connectHosted } = await import("./flow-tools.ts");
  const read = await connectHosted(hosted.server, hosted.agent, command);
  try {
    return await run(read);
  } finally {
    await read.close();
  }
}

/** One of the hosted Flow MCP's tools, called for a command: its result, or Failed. */
export type HostedRead = (tool: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** A page's query as conversations_page takes it. */
const pageInput = (page: URLSearchParams): Record<string, unknown> => Object.fromEntries([...page].map(([k, v]) => [k, k === "limit" ? Number(v) : v]));

/** What to print when a read did not work; status is the server's, when it answered. */
export class Failed extends Error {
  status?: number;
  readonly code: string;
  readonly hint?: string;
  readonly next?: string;
  /** The server's error message as it wrote it, when it sent one. */
  said?: string;
  constructor(message: string, code = "failed", hint?: string, next?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.next = next;
  }
}

/** A failed read on stderr, and on stdout as --json's one document; the exit status. */
export function failed(json: boolean, error: Failed): number {
  if (json) process.stdout.write(failureDocument(error.code, error.message, error.hint, error.next));
  console.error(error.message);
  return 1;
}

/** The most conversations the server answers in one page. */
const PAGE_LIMIT = 100;
/** With --contact, the most pages read looking for its conversations. */
const CONTACT_PAGES = 100;

/**
 * GET path (or POST it with no body); the body's text and its JSON ({} for a 204), or Failed with what
 * to print. The text mode (the answer's text_mode, else its Flow-Text header) is `textMode`, put in
 * the body as text_mode when only the header said it.
 */
export async function get(name: string, where: Access, path: string, method: "GET" | "POST" = "GET"): Promise<{ text: string; body: Record<string, unknown>; textMode?: string }> {
  const { cloud, key } = where;
  let answer;
  try {
    answer = await cloudCall(`${cloud}${path}`, { method, headers: { authorization: `Bearer ${key.value}`, accept: "application/json" }, timeoutMs: 30_000 }, where.waits);
  } catch (error) {
    if (error instanceof NetworkError) throw new Failed(`${name}: ${error.message}.`, "network");
    throw error;
  }
  const { status } = answer;
  let { text } = answer;
  let body: unknown;
  try { body = JSON.parse(text); } catch { /* not JSON: said below */ }
  if (status < 200 || status >= 300) {
    const error = (body as { error?: ApiError } | undefined)?.error;
    const again = answer.retryAfter !== undefined ? ` Try again in ${answer.retryAfter} s.` : "";
    const said = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
    const code = (error && typeof error === "object" && error.code) || (status === 404 ? "not_found" : `http_${status}`);
    const keyLines = keyRefused(status, error?.code) ? `\n${keyHelp(name, key, { status, code: error?.code, hint: error?.hint })}` : "";
    const failed = error && typeof error === "object" && error.message
      ? new Failed(`${name}: ${error.message}${error.code ? ` (${error.code}, ${status})` : ` (${status})`}${again}${error.hint ? `\n${error.hint}` : ""}${keyLines}`, code, error.hint)
      : new Failed(`${name}: ${cloud} answered ${status}${said ? `: ${said}` : ""}${status === 404 ? " (this Flow may not have this command's route yet)" : ""}.${keyLines}`, code);
    failed.status = status;
    if (error && typeof error === "object" && error.message) failed.said = error.message;
    throw failed;
  }
  if (status === 204) return { text: "", body: {} };
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Failed(`${name}: ${cloud} answered ${status} with something that is not JSON.`, "bad_answer");
  const said = (body as { text_mode?: unknown }).text_mode;
  const textMode = typeof said === "string" && said ? said : answer.textMode;
  if (textMode && said === undefined) {
    body = { ...(body as Record<string, unknown>), text_mode: textMode };
    text = JSON.stringify(body);
  }
  return { text, body: body as Record<string, unknown>, ...(textMode ? { textMode } : {}) };
}

/** The lines with the Text: line first, when the read said its text mode. */
const withTextLine = (textMode: unknown, lines: string[]) => (typeof textMode === "string" && textMode ? [textLine(textMode), ...lines] : lines);

/** What `flow conversations` asks for. */
export interface ListQuery {
  environment?: "staging" | "production";
  grade?: "wrong" | "unhelpful" | "good";
  /** An RFC 3339 time. */
  since?: string;
  /** At most this many (1 to 1000). */
  limit: number;
  /** Only this contact's, by its label ("Contact 9e35" or 9e35). */
  contact?: string;
}

/** A contact label's code: "Contact 9e35" and "9e35" are both 9e35. */
const contactCode = (label: string) => label.trim().replace(/^contact\s+/i, "").toLowerCase();

/**
 * The conversations a query matches, newest first: pages of 100 followed by next_cursor until the
 * limit or the last page; with a contact, only that contact's (read over at most 100 pages). The
 * last page's fields, the conversations, and the cursor of the pages not read (null: none).
 */
export function listConversations(name: string, where: Access, query: ListQuery): Promise<{ last: Record<string, unknown>; conversations: Conversation[]; cursor: string | null }> {
  return collectConversations(async (page) => (await get(name, where, `/v1/agent/conversations?${page}`)).body, query);
}

/** listConversations' pages and filter over any reader of one page (`page`: its query, as sent). */
export async function collectConversations(read: (page: URLSearchParams) => Promise<Record<string, unknown>>, query: ListQuery): Promise<{ last: Record<string, unknown>; conversations: Conversation[]; cursor: string | null }> {
  const params = new URLSearchParams();
  if (query.environment) params.set("environment", query.environment);
  if (query.grade) params.set("grade", query.grade);
  if (query.since) params.set("since", query.since);
  const wanted = query.contact === undefined ? undefined : contactCode(query.contact);
  const all: Conversation[] = [];
  let last: Record<string, unknown> = {};
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = new URLSearchParams(params);
    page.set("limit", String(wanted === undefined ? Math.min(PAGE_LIMIT, query.limit - all.length) : PAGE_LIMIT));
    if (cursor) page.set("cursor", cursor);
    last = await read(page);
    const got = (last.conversations as Conversation[] | undefined) ?? [];
    all.push(...(wanted === undefined ? got : got.filter((c) => typeof c.contact === "string" && contactCode(c.contact) === wanted)));
    cursor = typeof last.next_cursor === "string" && last.next_cursor ? last.next_cursor : null;
    pages++;
  } while (cursor && all.length < query.limit && (wanted === undefined || pages < CONTACT_PAGES));
  return { last, conversations: all.slice(0, query.limit), cursor };
}

/**
 * One conversation, as the server answers it: its text and its JSON. Not found with FLOW_KEY (a test
 * key does not find a production conversation), it is asked once more with the fallback, the live key.
 */
export async function showConversation(name: string, where: Access, id: string): Promise<{ text: string; body: Record<string, unknown>; textMode?: string }> {
  const path = `/v1/agent/conversations/${encodeURIComponent(id)}`;
  try {
    return await get(name, where, path);
  } catch (error) {
    if (!(error instanceof Failed) || error.status !== 404 || !where.fallback) throw error;
    return get(name, { cloud: where.cloud, key: where.fallback, waits: where.waits }, path);
  }
}

/** The issues with a status, as the server answers them. */
export function listIssues(name: string, where: Access, status: string): Promise<{ text: string; body: Record<string, unknown> }> {
  return get(name, where, `/v1/agent/issues?status=${encodeURIComponent(status)}`);
}

/** Runs `flow conversations ...`; resolves to the exit status. */
export async function conversationsCli(args: string[]): Promise<number> {
  const name = "flow conversations";
  const parsed = parse(name, args, {
    grade: { type: "string" },
    since: { type: "string" },
    limit: { type: "string" },
    contact: { type: "string" },
  }, CONVERSATIONS_USAGE);
  if (!parsed) return USAGE_EXIT;
  const { values, positionals } = parsed;
  const json = values.json === true;
  if (values.help) return console.log(CONVERSATIONS_USAGE), 0;
  const show = positionals[0] === "show";
  if (show ? positionals.length !== 2 : positionals.length !== 0) return usageFailed(json, `${name} takes no arguments, or show <id>.`, CONVERSATIONS_USAGE);
  // show reads one conversation by its id: --env production reads it with the live key.
  if (show && (values.grade || values.since || values.limit || values.contact)) return usageFailed(json, `${name} show takes only an id (and --env, --json).`, CONVERSATIONS_USAGE);
  if (values.environment && !["staging", "production"].includes(values.environment)) return usageFailed(json, `--env is staging or production (got "${values.environment}").`);
  const query: ListQuery = { limit: 20 };
  if (!show) {
    if (values.grade && !["wrong", "unhelpful", "good"].includes(values.grade)) return usageFailed(json, `--grade is wrong, unhelpful or good (got "${values.grade}").`);
    if (values.limit !== undefined) {
      query.limit = /^\d+$/.test(values.limit) ? Number(values.limit) : NaN;
      if (!(query.limit >= 1 && query.limit <= 1000)) return usageFailed(json, `--limit is a whole number from 1 to 1000 (got "${values.limit}").`);
    }
    if (values.contact !== undefined && !contactCode(values.contact)) return usageFailed(json, `--contact is a contact's label as flow conversations lists it, such as "Contact 9e35" or 9e35.`);
    query.environment = values.environment as ListQuery["environment"];
    query.grade = values.grade as ListQuery["grade"];
    query.contact = values.contact;
    if (values.since) {
      query.since = sinceTime(values.since);
      if (!query.since) return usageFailed(json, `--since is a duration such as 30m, 24h or 7d, or a time such as 2026-10-29T09:00:00Z (got "${values.since}").`);
    }
  }
  const id = positionals[1];
  if (show && !/^[A-Za-z0-9_-]{1,100}$/.test(id!)) return usageFailed(json, `"${id}" is not a conversation id: use one from flow conversations.`);
  const hosted = hostedOf(values);
  if (typeof hosted === "string") return usageFailed(json, hosted, CONVERSATIONS_USAGE);
  const where = hosted ? undefined : access(name, values, values.environment as ListQuery["environment"]);
  if (where instanceof Failed) return failed(json, where);
  try {
    return await withHosted(hosted, show ? "conversations show" : "conversations", async (read) => {
      if (show) {
        const environment = values.environment ? { environment: values.environment } : {};
        const { text, body, textMode } = read ? answerOf(await read("show_conversation", { id: id!, ...environment })) : await showConversation(name, where!, id!);
        if (json) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
        else console.log(withTextLine(textMode, transcript(body)).join("\n"));
        return 0;
      }
      const { last, conversations, cursor } = read ? await collectConversations((page) => read("conversations_page", pageInput(page)), query) : await listConversations(name, where!, query);
      if (json) return process.stdout.write(`${JSON.stringify({ ...last, conversations, next_cursor: cursor })}\n`), 0;
      console.log(withTextLine(last.text_mode, list(conversations, cursor !== null)).join("\n"));
      return 0;
    });
  } catch (error) {
    if (error instanceof Failed) return failed(json, error);
    throw error;
  }
}

/** Runs `flow issues`; resolves to the exit status. */
export async function issuesCli(args: string[]): Promise<number> {
  const name = "flow issues";
  const parsed = parse(name, args, { status: { type: "string" } }, ISSUES_USAGE);
  if (!parsed) return USAGE_EXIT;
  const { values, positionals } = parsed;
  const json = values.json === true;
  if (values.help) return console.log(ISSUES_USAGE), 0;
  const hosted = hostedOf(values);
  if (typeof hosted === "string") return usageFailed(json, hosted, ISSUES_USAGE);
  if (positionals[0] === "test-case" && positionals.length === 2 && !values.status) return issueTestCase(name, positionals[1]!, values, hosted);
  if (positionals.length) return usageFailed(json, `${name} takes no arguments, or test-case <id>.`, ISSUES_USAGE);
  const status = values.status ?? "open";
  if (!["open", "resolved", "ignored", "all"].includes(status)) return usageFailed(json, `--status is open, resolved, ignored or all (got "${status}").`);
  const where = hosted ? undefined : access(name, values);
  if (where instanceof Failed) return failed(json, where);
  try {
    return await withHosted(hosted, "issues", (read) => printIssues(name, json, status, where, read));
  } catch (error) {
    if (error instanceof Failed) return failed(json, error);
    throw error;
  }
}

/** flow issues' reads and lines: locally with the folder's key (`where`), else over the hosted Flow MCP (`read`). */
async function printIssues(name: string, json: boolean, status: string, where: Access | undefined, read: HostedRead | undefined): Promise<number> {
  const { text, body } = read ? answerOf(await read("list_issues", { status })) : await listIssues(name, where!, status);
  if (json) return process.stdout.write(text.endsWith("\n") ? text : `${text}\n`), 0;
  const issues = (body.issues as Issue[] | undefined) ?? [];
  for (const line of withTextLine(body.text_mode, [])) console.log(line);
  if (!issues.length) console.log(`No ${status === "all" ? "" : `${status} `}issues.`);
  else {
    const rows = issues.map((i) => [i.id, i.status ?? "", String(i.conversations ?? ""), when(i.last_seen), i.title ?? ""]);
    const [header, ...lines] = table(["ID", "STATUS", "CONVERSATIONS", "LAST SEEN", "TITLE"], rows);
    const fix = (i: Issue) => (i.suggested_fix ? indent(i.suggested_fix, "    fix: ", "         ") : []);
    console.log([header, ...lines.flatMap((line, n) => [line, ...fix(issues[n]!)])].join("\n"));
  }
  let feedback: Feedback[] = [];
  try {
    feedback = ((read ? await read("team_feedback", {}) : (await get(name, where!, "/v1/agent/feedback?days=30")).body).feedback as Feedback[] | undefined) ?? [];
  } catch (error) {
    if (!(error instanceof Failed)) throw error; // an older Flow without the route: nothing more to print
  }
  if (feedback.length) console.log(["", `Feedback from your team (last 30 days): ${feedback.length}`, ...feedback.flatMap(feedbackLines)].join("\n"));
  return 0;
}

/** rule_id, from and expectations are the server's; from is null when no stored reply is behind it. */
interface TestCase {
  issue?: string; rule_id?: string; from?: { conversation?: string; message?: string } | null;
  expectations?: { includes?: string[]; must_not?: string[]; expect?: string[]; rubrics?: string[] };
}

/** `flow issues test-case <id>`: the proposed test case's fields as the server sends them. A scenario also needs the
 * person, the opening and the channels, which the test case does not carry, so it is not printed as a scenario file. */
async function issueTestCase(name: string, id: string, values: { json?: boolean; cloud?: string; dotenv?: string }, hosted: Hosted | undefined): Promise<number> {
  const json = values.json === true;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return usageFailed(json, `"${id}" is not an issue id: use one from flow issues.`);
  const where = hosted ? undefined : access(name, values);
  if (where instanceof Failed) return failed(json, where);
  try {
    const { text, body } = await withHosted(hosted, "issues test-case", async (read) => (read ? answerOf(await read("issue_test_case", { issue: id })) : await get(name, where!, `/v1/agent/issues/${id}/test-case`)));
    if (json) return process.stdout.write(text.endsWith("\n") ? text : `${text}\n`), 0;
    const tc = (body.test_case ?? {}) as TestCase;
    const e = tc.expectations ?? {};
    const list = (label: string, items: string[] | undefined) => (items?.length ? [`${label}:`, ...items.map((item) => `  - ${JSON.stringify(item)}`)] : []);
    console.log([
      ...withTextLine(body.text_mode, []),
      `issue: ${tc.issue ?? id}`,
      `rule: ${tc.rule_id ?? "-"}`,
      tc.from ? `from: conversation ${tc.from.conversation ?? "?"}, reply ${tc.from.message ?? "?"}` : "from: none of the agent's stored replies",
      ...list("includes", e.includes), ...list("must_not", e.must_not), ...list("expect", e.expect), ...list("rubrics", e.rubrics),
      "",
      "These are Flow's fields, not a scenario file: a scenario also needs the person, the opening and the channels.",
      `Write tests/scenarios/<name>.yaml from them${tc.from?.conversation ? ` and flow conversations show ${tc.from.conversation}` : ""} (expect as its expect.judge), then run flow test --only <name>.`,
    ].join("\n"));
    return 0;
  } catch (error) {
    if (error instanceof Failed) return failed(json, error);
    throw error;
  }
}

/** One piece of the team's feedback: a test check marked out of date, or a reply's grade marked wrong. */
function feedbackLines(f: Feedback): string[] {
  const what = f.kind === "test_check"
    ? `  check out of date  ${f.scenario ?? "?"}${f.channel ? ` (${f.channel})` : ""}, check ${(f.check_index ?? 0) + 1}${f.check ? `: ${f.check}` : ""}`
    : `  grade marked wrong  conversation ${f.conversation ?? "?"}, reply ${f.message ?? "?"}, rules ${f.rules?.length ? f.rules.join(", ") : "-"}`;
  return [
    what,
    ...(f.note ? indent(f.note, "    note: ", "          ") : []),
    ...(f.todo ? indent(f.todo, "    todo: ", "          ") : []),
  ];
}

/** --since as an RFC 3339 time: a duration back from now, or a time given as one. */
export function sinceTime(since: string): string | undefined {
  const seconds = sinceSeconds(since);
  if (seconds !== undefined) return seconds > 0 ? new Date(Date.now() - seconds * 1000).toISOString() : undefined;
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(since) && !Number.isNaN(Date.parse(since)) ? since : undefined;
}

/** A server time as "2026-10-29 09:00:00Z": no T, no fractions. */
function when(at: string | undefined): string {
  return at ? at.replace("T", " ").replace(/\.\d+(?=Z|[+-]\d\d:\d\d$)/, "") : "?";
}

/** Rows under a header, each column as wide as its widest cell. */
export function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  return [header, ...rows].map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ").trimEnd());
}

function list(conversations: Conversation[], more: boolean): string[] {
  if (!conversations.length) return ["No conversations."];
  const rows = conversations.map((c) => [c.id, when(c.last_message_at ?? c.started_at), channels(c), c.run_kind || "-", c.version || "-", c.contact ?? "", String(c.messages ?? ""), c.grades ? String(c.grades.wrong ?? 0) : "-", c.grades ? String(c.grades.unhelpful ?? 0) : "-"]);
  return [
    ...table(["ID", "LAST MESSAGE", "CHANNEL", "KIND", "VERSION", "CONTACT", "MESSAGES", "WRONG", "UNHELPFUL"], rows),
    "",
    `${conversations.length} conversation${conversations.length === 1 ? "" : "s"}${more ? " (more: raise --limit)" : ""}${conversations.some((c) => !c.grades) ? "; - is grades unavailable" : ""}. Read one: flow conversations show <id>`,
  ];
}

/** The version behind a conversation's latest reply, with where it came from: "5f056b6 (from its traces)". */
function version(c: Conversation): string {
  if (!c.version) return "unknown";
  const from = { trace: "from its traces", run: "from its flow test run", deploy: "matched by deploy time" }[c.version_source ?? ""];
  const notes = [from, c.version_changed ? "its replies came from more than one version" : undefined].filter(Boolean);
  return notes.length ? `${c.version} (${notes.join("; ")})` : c.version;
}

/** The channels a conversation used: channels when sent, else channel. */
function channels(c: Conversation): string {
  return c.channels?.length ? c.channels.join(",") : c.channel ?? "";
}

/** A grade's label, coloured only in a terminal that takes colour. */
function label(text: string): string {
  const colour = { WRONG: 31, UNHELPFUL: 33, GOOD: 32 }[text];
  return colour && process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${colour}m${text}\x1b[0m` : text;
}

/** A tool call's name, whatever shape the server sends it in. */
function toolName(tool: unknown): string {
  if (typeof tool === "string") return tool;
  const o = (tool ?? {}) as Record<string, unknown>;
  for (const field of ["name", "tool"]) if (typeof o[field] === "string") return o[field] as string;
  return JSON.stringify(tool);
}

/** A value of a tool call as one line, cut at 300 characters. */
function shortValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  const line = text.replace(/\s*\n\s*/g, " ");
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/** A tool call under its reply: "tool find_order 120 ms ok", its error when it failed, its input and output when sent. */
function toolLines(tool: ToolCall, pad: string): string[] {
  if (typeof tool === "string") return [`${pad}tool ${tool}`];
  const ms = typeof tool.ms === "number" ? ` ${Math.round(tool.ms)} ms` : "";
  const error = tool.error ? `: ${[tool.error.code, tool.error.message].filter(Boolean).join(": ")}` : "";
  const outcome = tool.ok === false || (tool.ok !== true && error) ? ` FAILED${error}` : tool.ok === true ? " ok" : "";
  return [
    `${pad}tool ${toolName(tool)}${ms}${outcome}${tool.truncated ? " (cut by Flow)" : ""}`,
    ...(tool.input !== undefined ? [`${pad}  input: ${shortValue(tool.input)}`] : []),
    ...(tool.output !== undefined ? [`${pad}  output: ${shortValue(tool.output)}`] : []),
  ];
}

/** An agent reply's delivery: "delivery: FAILED 131042 (error_type) at 2026-10-29 09:00:05Z". */
function deliveryLine(d: Delivery): string {
  const code = d.code !== undefined && d.code !== null && d.code !== "" ? ` ${d.code}` : "";
  const type = d.error_type ? ` (${d.error_type})` : "";
  const word = d.state === "queued" ? "queued (Flow took it; the channel has not said it was sent)" : d.state === "failed" ? "FAILED" : d.state;
  return `delivery: ${word}${code}${type}${d.at ? ` at ${when(d.at)}` : ""}`;
}

function transcript(body: Record<string, unknown>): string[] {
  const c = (body.conversation ?? {}) as Conversation;
  const g = c.grades;
  const out = [
    `Conversation ${c.id ?? "?"}: ${[c.environment, channels(c), c.contact].filter(Boolean).join(", ")}`,
    `  started ${when(c.started_at)}, last message ${when(c.last_message_at)}, ${c.messages ?? "?"} messages`,
    `  version ${version(c)}`,
    g ? `  replies: ${g.wrong ?? 0} wrong, ${g.unhelpful ?? 0} unhelpful, ${g.good ?? 0} good, ${g.not_graded ?? 0} not graded` : "  replies: grades unavailable",
    ...(c.run_kind === "test" ? ["  A test conversation (flow chat, the playground or flow test): never graded, never in Insights"]
      : c.environment === "staging" ? ["  On a test key (staging): never in Insights, which reads production conversations on a live key"] : []),
    "",
  ];
  for (const m of (body.messages as Message[] | undefined) ?? []) {
    const head = `${when(m.at)}  ${m.role === "your_code" ? "your code" : m.role ?? "?"}: `;
    const pad = " ".repeat(head.length);
    out.push(...indent(messageText(m), head, pad));
    if (m.text_state === "not_sent") out.push(`${pad}  ${NOT_SENT_WHY}`);
    const tools = m.tools ?? [];
    // An older server sends names only: one line, as before. A newer one each call's time and outcome.
    const namesOnly = tools.every((t) => typeof t === "string" || Object.keys(t).every((k) => k === "name" || k === "tool"));
    if (tools.length && namesOnly) out.push(`${pad}[tools: ${tools.map(toolName).join(", ")}]`);
    else for (const tool of tools) out.push(...toolLines(tool, pad));
    if (m.delivery?.state) out.push(`${pad}${deliveryLine(m.delivery)}`);
    const grade = m.grade;
    if (!grade) continue;
    const verdict = grade.verdict && grade.verdict !== grade.label ? `  verdict: ${grade.verdict}` : "";
    out.push(`${pad}${label((grade.label ?? "graded").toUpperCase())}${verdict}${grade.rule ? `  rule: ${grade.rule}` : ""}`);
    if (grade.reason) out.push(...indent(grade.reason, `${pad}  why: `, `${pad}       `));
    if (grade.quote) out.push(...indent(`"${grade.quote}"`, `${pad}  quote: `, `${pad}         `));
    if (grade.label !== "good" && !grade.rule && !grade.reason && !grade.quote) out.push(`${pad}  (rule, reason and quote withheld)`);
  }
  const issues = (body.issues as Issue[] | undefined) ?? [];
  if (issues.length) out.push("", "Issues:", ...issues.map((i) => `  ${i.id}  ${i.title ?? ""}`.trimEnd()));
  return out;
}

/** A message's text, or what stands in for a text the server does not send. */
function messageText(m: { text?: string | null; text_state?: string }): string {
  return typeof m.text === "string" && (m.text_state ?? "shown") === "shown" ? m.text : TEXT_STATES[m.text_state ?? "none"] ?? `(text ${m.text_state})`;
}

/** Text over several lines: the first after `first`, the rest after `rest`. */
function indent(text: string, first: string, rest = first): string[] {
  return text.split("\n").map((line, i) => `${i === 0 ? first : rest}${line}`);
}

export const INSIGHTS_LINES = `  flow insights [--days 7|30] [--status open|fixed|muted|all] [--json]
                            Flow Insights' findings: where people gave up, asked again or got
                            annoyed in the agent's closed production conversations, by topic
  flow insights show <finding> [--days 7|30] [--json]
                            One finding's conversations, each with why it was flagged and the
                            messages around the flagged one`;

const INSIGHTS_USAGE = `Usage:
  flow insights [--days 7|30] [--status open|fixed|muted|all] [--json]
  flow insights show <finding> [--days 7|30] [--json]

Lists Flow Insights' findings as the dashboard ranks them: id, status, conversations in the window
(with the window before's: "4 (was 9)"), topic, and what happened. show prints one finding's
conversations: id, time, why it was flagged, the person's words and, when Flow sends them, the
3 messages before the flagged one and 2 after. Insights reads only closed production conversations
(quiet for 24 h), so it reads with the live Flow key, FLOW_LIVE_KEY (${SETUP_LIVE}), else a
flow_live_ FLOW_KEY. To check
a finding: flow insights show <finding>, then flow conversations show <id>; once a fix is deployed
and a window has passed, flow insights again to see its count drop.

Options:
  --days <n>               The window: 7 (the default) or 30 days
  --status <status>        open (the default), fixed, muted or all
${COMMON}`;

/** Each signal in the dashboard's words (observe's web/src/flow/insights.ts); another is its name in words. */
const SIGNALS: Record<string, string> = {
  no_reply: "No reply",
  failed_send: "Send failed",
  re_ask: "Repeated question",
  agent_loop: "Loop",
  canned_fallback: "Fallback reply",
  couldnt_answer: "Unanswered",
  deflected: "Deflected",
  wants_person: "Handoff requested",
  thumbs_down: "Thumbs down",
  stopped: "Opted out",
  left_mid_task: "Drop-off",
  came_back: "Repeat contact",
  frustrated: "Frustrated",
  annoyed_re_asked_detail: "Got annoyed when the agent re-asked for a detail they had given",
  annoyed_canned_or_off_topic: "Got annoyed when the agent sent a canned or off-topic reply",
  annoyed_wrong_fact: "Got annoyed when the agent got a fact wrong",
  annoyed_slow_or_no_reply: "Got annoyed when the agent was slow or did not reply",
  annoyed_refused: "Got annoyed when the agent refused",
  annoyed_loop: "Got annoyed when the agent repeated itself",
  annoyed_service_problem: "Got annoyed about the service itself (not the agent)",
  annoyed_other: "Got annoyed (other reason)",
};

function signalTitle(signal: string): string {
  const words = signal.replace(/[_-]+/g, " ").trim();
  return SIGNALS[signal] ?? (words ? words[0]!.toUpperCase() + words.slice(1) : "Finding");
}

export interface Finding {
  id: string; signal: string; status?: string; topic?: { id: string; name: string } | null;
  conversations?: number; previous?: number | null; tag_only?: boolean;
}
/** quote is the person's words, null unless the account's data lets them be shown. */
interface FindingConversation { conversation: string; at?: string; annoyed?: boolean; cause?: string | null; quote?: string | null; window?: Message[] | null }

/** "4 (was 9)": the window's conversations, and the window before's when the server sent it. */
function counted(f: Finding): string {
  return `${f.conversations ?? 0}${typeof f.previous === "number" ? ` (was ${f.previous})` : ""}`;
}

/** An Insights read: the server's text and JSON, or Failed; a workspace Insights is not open to (not_found) and a test
 * key (403 scope: Insights is production traffic) say so in words, with the server's code and hint kept. */
async function insightsGet(name: string, where: Access, path: string, finding: boolean): Promise<{ text: string; body: Record<string, unknown> }> {
  try {
    return await get(name, where, path);
  } catch (error) {
    if (!(error instanceof Failed)) throw error;
    // A live key refused for a scope is the right key without that grant: its own message (Flow's hint, the grant) stands.
    const words = error.status === 403 && error.code === "scope" && where.key.kind === "flow_key"
      ? `Insights reads production conversations, so it needs a live key: ${SETUP_LIVE} writes the live key FLOW_LIVE_KEY, which Insights then reads with (flow setup writes only a test key, flow_test_).`
      // Both routes answer not_found until Insights is open to the workspace; a finding's also for one not the agent's.
      : error.code === "not_found" && !finding ? "Insights is not open to this workspace yet." : undefined;
    const message = words ? `${name}: ${words}${error.hint ? `\n${error.hint}` : ""}`
      : `${error.message}${error.code === "not_found" ? "\nflow insights lists the findings, or says Insights is not open to this workspace yet." : ""}`;
    const said = new Failed(message, error.code, error.hint, error.next);
    said.status = error.status;
    throw said;
  }
}

/** Insights over the last `days` (7 or 30), as the server answers; with a status other than all, body's findings are only
 * those (text stays the server's whole answer). */
export async function listInsights(name: string, where: Access, query: { days: 7 | 30; status?: "open" | "fixed" | "muted" | "all" }): Promise<{ text: string; body: Record<string, unknown> }> {
  const { text, body } = await insightsGet(name, where, `/v1/agent/insights?days=${query.days}`, false);
  const status = query.status ?? "all";
  if (status === "all" || !Array.isArray(body.findings)) return { text, body };
  return { text, body: { ...body, findings: (body.findings as Finding[]).filter((f) => f.status === status) } };
}

/** One finding's conversations over the last `days`, as the server answers them: { finding, data }. */
export function insightConversations(name: string, where: Access, finding: string, days: 7 | 30): Promise<{ text: string; body: Record<string, unknown> }> {
  return insightsGet(name, where, `/v1/agent/insights/findings/${encodeURIComponent(finding)}/conversations?days=${days}`, true);
}

/** Runs `flow insights ...`; resolves to the exit status. */
export async function insightsCli(args: string[]): Promise<number> {
  const name = "flow insights";
  const parsed = parse(name, args, { days: { type: "string" }, status: { type: "string" } }, INSIGHTS_USAGE);
  if (!parsed) return USAGE_EXIT;
  const { values, positionals } = parsed;
  const json = values.json === true;
  if (values.help) return console.log(INSIGHTS_USAGE), 0;
  const show = positionals[0] === "show";
  if (show ? positionals.length !== 2 : positionals.length !== 0) return usageFailed(json, `${name} takes no arguments, or show <finding>.`, INSIGHTS_USAGE);
  if (show && values.status) return usageFailed(json, `${name} show takes a finding, --days and --json.`, INSIGHTS_USAGE);
  const days = values.days ?? "7";
  if (days !== "7" && days !== "30") return usageFailed(json, `--days is 7 or 30 (got "${days}").`);
  const status = values.status ?? "open";
  if (!["open", "fixed", "muted", "all"].includes(status)) return usageFailed(json, `--status is open, fixed, muted or all (got "${status}").`);
  const id = positionals[1];
  if (show && !/^[A-Za-z0-9_-]{1,100}$/.test(id!)) return usageFailed(json, `"${id}" is not a finding id: use one from flow insights.`);
  const hosted = hostedOf(values);
  if (typeof hosted === "string") return usageFailed(json, hosted, INSIGHTS_USAGE);
  const where = hosted ? undefined : access(name, values, "production");
  if (where instanceof Failed) return failed(json, where);
  try {
    const { text, body } = await withHosted(hosted, show ? "insights show" : "insights", async (read) => {
      if (!read) {
        return show
          ? await insightConversations(name, where!, id!, Number(days) as 7 | 30)
          : await listInsights(name, where!, { days: Number(days) as 7 | 30, status: status as "open" });
      }
      if (show) return answerOf(await read("insight_conversations", { finding: id!, days: Number(days) }));
      // --json prints the whole answer, as Flow sent it; the lines only the findings of the status.
      const all = answerOf(await read("list_insights", { days: Number(days), status: "all" }));
      if (status === "all" || !Array.isArray(all.body.findings)) return all;
      return { text: all.text, body: { ...all.body, findings: (all.body.findings as Finding[]).filter((f) => f.status === status) } };
    });
    if (json) return process.stdout.write(text.endsWith("\n") ? text : `${text}\n`), 0;
    console.log(withTextLine(body.text_mode, show ? findingLines(body, days) : insightsLines(body, status)).join("\n"));
    return 0;
  } catch (error) {
    if (error instanceof Failed) return failed(json, error);
    throw error;
  }
}

/** The findings' table (tag-only ones named under it), the window's line and what its state means; findings already of the status. */
function insightsLines(body: Record<string, unknown>, status: string): string[] {
  const state = String(body.state ?? "");
  const window = Number(body.window_days ?? 7);
  const note = typeof body.note === "string" && body.note ? [body.note] : [];
  if (state === "off_health") return note.length ? note : ["Insights is off for this workspace."];
  const findings = (body.findings as Finding[] | undefined) ?? [];
  const rows = findings.filter((f) => !f.tag_only);
  const tags = findings.filter((f) => f.tag_only);
  const out = state === "no_data" ? [] : rows.length
    ? [...table(["ID", "STATUS", "CONVERSATIONS", "TOPIC", "FINDING"], rows.map((f) => [f.id, f.status ?? "", counted(f), f.topic?.name ?? "-", signalTitle(f.signal)])), ""]
    : [`No ${status === "all" ? "" : `${status} `}findings in the last ${window} days.`, ""];
  out.push(`Last ${window} days: ${body.closed_sessions ?? 0} closed sessions from ${body.people ?? 0} people.`);
  const min = (body.small_numbers as { rates_min_sessions?: number } | undefined)?.rates_min_sessions ?? 20;
  if (state === "collecting") out.push(`Collecting: counts only, no rates or topics, until ${min} closed sessions.`);
  if (state === "no_data") {
    out.push("Nothing graded yet: Insights grades only closed (24 h quiet) production conversations on a live key.",
      "Test-key traffic, flow chat, the playground and flow test conversations are never graded.");
  }
  out.push(...note);
  const noText = Number(body.messages_without_text ?? 0);
  if (noText > 0) out.push(`${noText} messages came without their text (trace content off): Insights reads none of them.`);
  if (tags.length) out.push(`Low-confidence tags, left out above: ${tags.map((f) => `${f.id} ${signalTitle(f.signal)} (${f.conversations ?? 0})`).join(", ")}.`);
  if (rows.length || tags.length) out.push("Read one: flow insights show <finding>");
  return out;
}

/** One finding's head line, then each conversation: id, time, why, the person's words and the next step. */
function findingLines(body: Record<string, unknown>, days: string): string[] {
  const f = (body.finding ?? {}) as Finding;
  const title = `${signalTitle(f.signal ?? "")}${f.topic ? ` · ${f.topic.name}` : ""}`;
  const out = [`${f.id ?? "?"}  ${f.status ?? ""}  ${title}: ${counted(f)} conversations in the last ${days} days`, ""];
  const data = (body.data as FindingConversation[] | undefined) ?? [];
  if (!data.length) out.push("No conversations in this window.");
  // An annoyed_ finding's cause is its signal; another finding's conversation may also say why the person got annoyed.
  const signal = (f.signal ?? "").startsWith("annoyed_") ? [] : [signalTitle(f.signal ?? "")];
  for (const c of data) {
    const why = [...signal, ...(c.cause ? [signalTitle(`annoyed_${c.cause}`)] : c.annoyed ? ["Got annoyed"] : [])];
    out.push(`${c.conversation}  ${when(c.at)}  ${why.join("; ") || signalTitle(f.signal ?? "")}`);
    if (typeof c.quote === "string" && c.quote) out.push(`    "${c.quote}"`);
    if (c.window?.length) {
      out.push("    around it:");
      for (const m of c.window) {
        const head = `      ${when(m.at)}  ${m.role === "your_code" ? "your code" : m.role ?? "?"}: `;
        out.push(...indent(messageText(m), head, " ".repeat(head.length)));
      }
    }
    out.push(`    next: flow conversations show ${c.conversation}`);
  }
  return out;
}
