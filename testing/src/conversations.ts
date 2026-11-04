// `flow conversations` and `flow issues`: the hosted agent's conversations, each agent reply's grade
// (good, unhelpful or wrong, with the rule, the reason and the quoted words), and the issues the
// grades add up to, read from flow.engineer with the agent's Flow key (FLOW_KEY), so a coding agent
// finds the replies graded wrong and fixes the agent without a person reading the chats:
//   GET {cloud}/v1/agent/conversations?environment=&grade=&since=&limit=&cursor=
//   GET {cloud}/v1/agent/conversations/{id}
//   GET {cloud}/v1/agent/issues?status=
//   GET {cloud}/v1/agent/feedback?days=30 (the team's feedback, printed under the issues)
// Errors are { error: { code, message, hint } }. The reads wait out a 429 and try once more after a
// network error or a 5xx (testing/src/cloud-call.ts). With --json, stdout is one JSON document: the
// server's, or { ok: false, error: { code, message, hint? }, next } when it did not work.
// Exit status: 0 printed, 1 the server refused or could not be reached, or no key, 2 a wrong flag.
// listConversations, showConversation and listIssues return the data, for callers other than the CLI.

import { parseArgs } from "node:util";
import { OBSERVE_URL, setting } from "../../src/traces.ts";
import { cloudCall, failureDocument, keyHelp, keyRefused, KEYS_HELP, NetworkError, type FoundKey, type Waits } from "./cloud-call.ts";
import { sinceSeconds } from "./deploy.ts";
import { loadEnv } from "./report.ts";

export const CONVERSATIONS_LINES = `  flow conversations [--env staging|production] [--grade wrong|unhelpful|good] [--contact <label>] [--since 24h] [--limit n] [--json]
                            The hosted agent's conversations, with how many of its replies were
                            graded wrong or unhelpful
  flow conversations show <id> [--json]
                            One conversation, message by message, with each graded reply's label,
                            rule, reason and the words it was graded on, and each reply's tool calls
                            and delivery when Flow has them
  flow issues [--status open|resolved|ignored|all] [--json]
                            The problems the grades add up to, each with its conversations and a
                            suggested fix`;

const COMMON = `  --json                   One JSON document on stdout: the server's (pages of conversations
                           merged into one), or { ok: false, error: { code, message, hint }, next }
                           when it did not work; every other line goes to stderr
  --cloud <url>            Flow's address (default: FLOW_FRAMEWORK_CLOUD, else ${OBSERVE_URL})
  --dotenv <path>          Read the environment from this file instead of the folder's .env
  -h, --help               Show this help

Reads with the agent's Flow key, FLOW_KEY (flow setup writes it into .env); it is never printed.
A 429 (60 reads a minute per key) is waited out, up to 30 s, and said on stderr; a read that hit a
network error or a 5xx is tried once more.
Exit status: 0 printed, 1 no key, or the server refused or could not be reached (its message and
hint are printed), 2 a wrong flag.

${KEYS_HELP}`;

const CONVERSATIONS_USAGE = `Usage:
  flow conversations [options]
  flow conversations show <id> [--json]

Lists the hosted agent's conversations, newest first: id, last message, channel, the agent version
behind its latest reply, contact, messages, and how many replies were graded wrong and unhelpful. show prints one conversation, one line per
message, and under each graded agent reply its label, the rule it was graded on, why, and the quoted
words; under an agent reply, its tool calls (name, time, ok or the error) and its delivery (queued,
sent, delivered, read or failed, with the channel's code) when Flow has them. To fix bad replies:
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

The problems the grades of the agent's replies add up to: id, status, conversations, last seen,
title, and the suggested fix. flow conversations show <id> reads one of the conversations.
Then your team's feedback: checks marked out of date (change them in the scenario file) and reply
grades marked wrong.

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
  waits?: Waits;
}

/** The address and the key, after .env (or --dotenv) is read; a Failed says what is missing. */
export function access(name: string, values: { cloud?: string; dotenv?: string }): Access | Failed {
  const fromEnvironment = Boolean(process.env.FLOW_KEY?.trim());
  const envProblem = loadEnv(values.dotenv);
  if (envProblem) return new Failed(envProblem, "bad_dotenv");
  const key = process.env.FLOW_KEY?.trim();
  if (!key) return new Failed(`${name} reads with the agent's Flow key: set FLOW_KEY (flow setup writes it into .env).`, "no_flow_key", undefined, "npx @flow-engineer/flow setup");
  return {
    cloud: (values.cloud || setting("CLOUD") || OBSERVE_URL).replace(/\/+$/, ""),
    key: { kind: "flow_key", name: "FLOW_KEY", where: fromEnvironment ? "the environment" : values.dotenv ?? ".env in this folder", value: key },
  };
}

/** What to print when a read did not work; status is the server's, when it answered. */
export class Failed extends Error {
  status?: number;
  readonly code: string;
  readonly hint?: string;
  readonly next?: string;
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

/** GET path; the body's text and its JSON, or Failed with what to print. */
export async function get(name: string, where: Access, path: string): Promise<{ text: string; body: Record<string, unknown> }> {
  const { cloud, key } = where;
  let answer;
  try {
    answer = await cloudCall(`${cloud}${path}`, { headers: { authorization: `Bearer ${key.value}`, accept: "application/json" }, timeoutMs: 30_000 }, where.waits);
  } catch (error) {
    if (error instanceof NetworkError) throw new Failed(`${name}: ${error.message}.`, "network");
    throw error;
  }
  const { status, text } = answer;
  let body: unknown;
  try { body = JSON.parse(text); } catch { /* not JSON: said below */ }
  if (status < 200 || status >= 300) {
    const error = (body as { error?: ApiError } | undefined)?.error;
    const again = answer.retryAfter !== undefined ? ` Try again in ${answer.retryAfter} s.` : "";
    const said = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
    const code = (error && typeof error === "object" && error.code) || (status === 404 ? "not_found" : `http_${status}`);
    const keyLines = keyRefused(status, error?.code) ? `\n${keyHelp(name, key, { status, code: error?.code })}` : "";
    const failed = error && typeof error === "object" && error.message
      ? new Failed(`${name}: ${error.message}${error.code ? ` (${error.code}, ${status})` : ` (${status})`}${again}${error.hint ? `\n${error.hint}` : ""}${keyLines}`, code, error.hint)
      : new Failed(`${name}: ${cloud} answered ${status}${said ? `: ${said}` : ""}${status === 404 ? " (this Flow may not have this command's route yet)" : ""}.${keyLines}`, code);
    failed.status = status;
    throw failed;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Failed(`${name}: ${cloud} answered ${status} with something that is not JSON.`, "bad_answer");
  return { text, body: body as Record<string, unknown> };
}

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
export async function listConversations(name: string, where: Access, query: ListQuery): Promise<{ last: Record<string, unknown>; conversations: Conversation[]; cursor: string | null }> {
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
    last = (await get(name, where, `/v1/agent/conversations?${page}`)).body;
    const got = (last.conversations as Conversation[] | undefined) ?? [];
    all.push(...(wanted === undefined ? got : got.filter((c) => typeof c.contact === "string" && contactCode(c.contact) === wanted)));
    cursor = typeof last.next_cursor === "string" && last.next_cursor ? last.next_cursor : null;
    pages++;
  } while (cursor && all.length < query.limit && (wanted === undefined || pages < CONTACT_PAGES));
  return { last, conversations: all.slice(0, query.limit), cursor };
}

/** One conversation, as the server answers it: its text and its JSON. */
export function showConversation(name: string, where: Access, id: string): Promise<{ text: string; body: Record<string, unknown> }> {
  return get(name, where, `/v1/agent/conversations/${encodeURIComponent(id)}`);
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
  // show reads one conversation by its id: --env is taken (scripts pass it to every command) and means nothing there.
  if (show && (values.grade || values.since || values.limit || values.contact)) return usageFailed(json, `${name} show takes only an id (and --json).`, CONVERSATIONS_USAGE);
  const query: ListQuery = { limit: 20 };
  if (!show) {
    if (values.environment && !["staging", "production"].includes(values.environment)) return usageFailed(json, `--env is staging or production (got "${values.environment}").`);
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
  const where = access(name, values);
  if (where instanceof Failed) return failed(json, where);
  try {
    if (show) {
      const { text, body } = await showConversation(name, where, id!);
      if (json) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
      else console.log(transcript(body).join("\n"));
      return 0;
    }
    const { last, conversations, cursor } = await listConversations(name, where, query);
    if (json) return process.stdout.write(`${JSON.stringify({ ...last, conversations, next_cursor: cursor })}\n`), 0;
    console.log(list(conversations, cursor !== null).join("\n"));
    return 0;
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
  if (positionals.length) return usageFailed(json, `${name} takes no arguments.`, ISSUES_USAGE);
  const status = values.status ?? "open";
  if (!["open", "resolved", "ignored", "all"].includes(status)) return usageFailed(json, `--status is open, resolved, ignored or all (got "${status}").`);
  const where = access(name, values);
  if (where instanceof Failed) return failed(json, where);
  try {
    const { text, body } = await listIssues(name, where, status);
    if (json) return process.stdout.write(text.endsWith("\n") ? text : `${text}\n`), 0;
    const issues = (body.issues as Issue[] | undefined) ?? [];
    if (!issues.length) console.log(`No ${status === "all" ? "" : `${status} `}issues.`);
    else {
      const rows = issues.map((i) => [i.id, i.status ?? "", String(i.conversations ?? ""), when(i.last_seen), i.title ?? ""]);
      const [header, ...lines] = table(["ID", "STATUS", "CONVERSATIONS", "LAST SEEN", "TITLE"], rows);
      const fix = (i: Issue) => (i.suggested_fix ? indent(i.suggested_fix, "    fix: ", "         ") : []);
      console.log([header, ...lines.flatMap((line, n) => [line, ...fix(issues[n]!)])].join("\n"));
    }
    let feedback: Feedback[] = [];
    try {
      feedback = ((await get(name, where, "/v1/agent/feedback?days=30")).body.feedback as Feedback[] | undefined) ?? [];
    } catch (error) {
      if (!(error instanceof Failed)) throw error; // an older Flow without the route: nothing more to print
    }
    if (feedback.length) console.log(["", `Feedback from your team (last 30 days): ${feedback.length}`, ...feedback.flatMap(feedbackLines)].join("\n"));
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
function sinceTime(since: string): string | undefined {
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
  const rows = conversations.map((c) => [c.id, when(c.last_message_at ?? c.started_at), channels(c), c.version || "-", c.contact ?? "", String(c.messages ?? ""), c.grades ? String(c.grades.wrong ?? 0) : "-", c.grades ? String(c.grades.unhelpful ?? 0) : "-"]);
  return [
    ...table(["ID", "LAST MESSAGE", "CHANNEL", "VERSION", "CONTACT", "MESSAGES", "WRONG", "UNHELPFUL"], rows),
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
    "",
  ];
  for (const m of (body.messages as Message[] | undefined) ?? []) {
    const head = `${when(m.at)}  ${m.role === "your_code" ? "your code" : m.role ?? "?"}: `;
    const pad = " ".repeat(head.length);
    const text = typeof m.text === "string" && (m.text_state ?? "shown") === "shown" ? m.text : TEXT_STATES[m.text_state ?? "none"] ?? `(text ${m.text_state})`;
    out.push(...indent(text, head, pad));
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

/** Text over several lines: the first after `first`, the rest after `rest`. */
function indent(text: string, first: string, rest = first): string[] {
  return text.split("\n").map((line, i) => `${i === 0 ? first : rest}${line}`);
}
