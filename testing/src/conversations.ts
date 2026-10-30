// `flow conversations` and `flow issues`: the hosted agent's conversations, each agent reply's grade
// (good, unhelpful or wrong, with the rule, the reason and the quoted words), and the issues the
// grades add up to, read from flow.engineer with the agent's Flow key (FLOW_KEY), so a coding agent
// finds the replies graded wrong and fixes the agent without a person reading the chats:
//   GET {cloud}/v1/agent/conversations?environment=&grade=&since=&limit=&cursor=
//   GET {cloud}/v1/agent/conversations/{id}
//   GET {cloud}/v1/agent/issues?status=
//   GET {cloud}/v1/agent/feedback?days=30 (the team's feedback, printed under the issues)
// Errors are { error: { code, message, hint } }. Exit status: 0 printed, 1 anything else.

import { parseArgs } from "node:util";
import { OBSERVE_URL, setting } from "../../src/traces.ts";
import { sinceSeconds } from "./deploy.ts";
import { loadEnv } from "./report.ts";

export const CONVERSATIONS_LINES = `  flow conversations [--environment staging|production] [--grade wrong|unhelpful|good] [--since 24h] [--limit n] [--json]
                            The hosted agent's conversations, with how many of its replies were
                            graded wrong or unhelpful
  flow conversations show <id> [--json]
                            One conversation, message by message, with each graded reply's label,
                            rule, reason and the words it was graded on
  flow issues [--status open|resolved|ignored|all] [--json]
                            The problems the grades add up to, each with its conversations and a
                            suggested fix`;

const COMMON = `  --json                   The server's JSON on stdout (pages of conversations merged into one)
  --cloud <url>            Flow's address (default: FLOW_FRAMEWORK_CLOUD, else ${OBSERVE_URL})
  --dotenv <path>          Read the environment from this file instead of the folder's .env
  -h, --help               Show this help

Reads with the agent's Flow key, FLOW_KEY (flow setup writes it into .env); it is never printed.
Exit status: 0 printed, 1 a wrong flag, no key, or the server refused or could not be reached
(its message and hint are printed).`;

const CONVERSATIONS_USAGE = `Usage:
  flow conversations [options]
  flow conversations show <id> [--json]

Lists the hosted agent's conversations, newest first: id, last message, channel, the agent version
behind its latest reply, contact, messages, and how many replies were graded wrong and unhelpful. show prints one conversation, one line per
message, and under each graded agent reply its label, the rule it was graded on, why, and the quoted
words. To fix bad replies: flow conversations --grade wrong, then flow conversations show <id>.

Options:
  --environment <name>     staging or production (default: production for a live key, else staging)
  --grade <label>          Only conversations with a reply graded wrong, unhelpful or good
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
${COMMON}`;

interface ApiError { code?: string; type?: string; message?: string; hint?: string }
interface Grades { good?: number; unhelpful?: number; wrong?: number; not_graded?: number }
interface Conversation {
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
/** text is null unless text_state is shown; role your_code is a message the agent's own code sent, never graded. */
interface Message { id?: string; role?: string; at?: string; text?: string | null; text_state?: string; tools?: unknown[]; grade?: Grade | null }

/** What prints in place of a message's text the server does not send. */
const TEXT_STATES: Record<string, string> = {
  deleted: "(deleted by retention)",
  withheld: "(text withheld)",
  not_sent: "(not sent)",
  none: "(no text recorded)",
};
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
  help: { type: "boolean", short: "h", default: false },
} as const;

/** Arguments, or the line that says what is wrong with them. */
export function parse<T extends Record<string, { type: "string" | "boolean" }>>(name: string, args: string[], options: T, usage: string) {
  try {
    return parseArgs({ args, allowPositionals: true, strict: true, options: { ...COMMON_OPTIONS, ...options } });
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    const unknown = code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? /'([^']+)'/.exec(message)?.[1] : undefined;
    console.error(`${name}: ${unknown ? `unknown option ${unknown}` : message.split(". ")[0]}\n\n${usage}`);
    return undefined;
  }
}

/** The address and the key, after .env (or --dotenv) is read; a string says what is missing. */
export function access(name: string, values: { cloud?: string; dotenv?: string }): { cloud: string; key: string } | string {
  const envProblem = loadEnv(values.dotenv);
  if (envProblem) return envProblem;
  const key = process.env.FLOW_KEY?.trim();
  if (!key) return `${name} reads with the agent's Flow key: set FLOW_KEY (flow setup writes it into .env).`;
  return { cloud: (values.cloud || setting("CLOUD") || OBSERVE_URL).replace(/\/+$/, ""), key };
}

/** What to print when a read did not work; status is the server's, when it answered. */
export class Failed extends Error {
  status?: number;
}

/** The most conversations the server answers in one page. */
const PAGE_LIMIT = 100;

/** GET path; the body's text and its JSON, or Failed with what to print. */
export async function get(name: string, cloud: string, key: string, path: string): Promise<{ text: string; body: Record<string, unknown> }> {
  let status: number;
  let text: string;
  let retryAfter: string | null;
  try {
    const response = await fetch(`${cloud}${path}`, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    status = response.status;
    retryAfter = response.headers.get("retry-after");
    text = await response.text();
  } catch (error) {
    const cause = (error as Error).cause as NodeJS.ErrnoException | undefined;
    const why = (error as Error).name === "TimeoutError" ? "no answer in 30 s" : cause?.code ?? (error as Error).message;
    throw new Failed(`${name}: could not reach ${cloud}: ${why}.`);
  }
  let body: unknown;
  try { body = JSON.parse(text); } catch { /* not JSON: said below */ }
  if (status < 200 || status >= 300) {
    const error = (body as { error?: ApiError } | undefined)?.error;
    const again = retryAfter && /^\d+$/.test(retryAfter) ? ` Try again in ${retryAfter} s.` : "";
    const said = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
    const failed = error && typeof error === "object" && error.message
      ? new Failed(`${name}: ${error.message}${error.code ? ` (${error.code}, ${status})` : ` (${status})`}${again}${error.hint ? `\n${error.hint}` : ""}`)
      : new Failed(`${name}: ${cloud} answered ${status}${said ? `: ${said}` : ""}${status === 404 ? " (this Flow may not have this command's route yet)" : ""}.`);
    failed.status = status;
    throw failed;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Failed(`${name}: ${cloud} answered ${status} with something that is not JSON.`);
  return { text, body: body as Record<string, unknown> };
}

/** Runs `flow conversations ...`; resolves to the exit status. */
export async function conversationsCli(args: string[]): Promise<number> {
  const name = "flow conversations";
  const parsed = parse(name, args, {
    environment: { type: "string" },
    grade: { type: "string" },
    since: { type: "string" },
    limit: { type: "string" },
  }, CONVERSATIONS_USAGE);
  if (!parsed) return 1;
  const { values, positionals } = parsed;
  if (values.help) return console.log(CONVERSATIONS_USAGE), 0;
  const show = positionals[0] === "show";
  if (show ? positionals.length !== 2 : positionals.length !== 0) {
    return console.error(`${name} takes no arguments, or show <id>.\n\n${CONVERSATIONS_USAGE}`), 1;
  }
  if (show && (values.environment || values.grade || values.since || values.limit)) {
    return console.error(`${name} show takes only an id (and --json).\n\n${CONVERSATIONS_USAGE}`), 1;
  }
  const query = new URLSearchParams();
  let limit = 20;
  if (!show) {
    if (values.environment && !["staging", "production"].includes(values.environment)) return console.error(`--environment is staging or production (got "${values.environment}").`), 1;
    if (values.grade && !["wrong", "unhelpful", "good"].includes(values.grade)) return console.error(`--grade is wrong, unhelpful or good (got "${values.grade}").`), 1;
    if (values.limit !== undefined) {
      limit = /^\d+$/.test(values.limit) ? Number(values.limit) : NaN;
      if (!(limit >= 1 && limit <= 1000)) return console.error(`--limit is a whole number from 1 to 1000 (got "${values.limit}").`), 1;
    }
    if (values.environment) query.set("environment", values.environment);
    if (values.grade) query.set("grade", values.grade);
    if (values.since) {
      const since = sinceTime(values.since);
      if (!since) return console.error(`--since is a duration such as 30m, 24h or 7d, or a time such as 2026-10-29T09:00:00Z (got "${values.since}").`), 1;
      query.set("since", since);
    }
  }
  const id = positionals[1];
  if (show && !/^[A-Za-z0-9_-]{1,100}$/.test(id!)) return console.error(`"${id}" is not a conversation id: use one from flow conversations.`), 1;
  const where = access(name, values);
  if (typeof where === "string") return console.error(where), 1;
  try {
    if (show) {
      const { text, body } = await get(name, where.cloud, where.key, `/v1/agent/conversations/${id}`);
      if (values.json) process.stdout.write(text);
      else console.log(transcript(body).join("\n"));
      return 0;
    }
    const all: Conversation[] = [];
    let last: Record<string, unknown> = {};
    let cursor: string | null = null;
    do {
      const page = new URLSearchParams(query);
      page.set("limit", String(Math.min(PAGE_LIMIT, limit - all.length)));
      if (cursor) page.set("cursor", cursor);
      last = (await get(name, where.cloud, where.key, `/v1/agent/conversations?${page}`)).body;
      all.push(...((last.conversations as Conversation[] | undefined) ?? []));
      cursor = typeof last.next_cursor === "string" && last.next_cursor ? last.next_cursor : null;
    } while (cursor && all.length < limit);
    const conversations = all.slice(0, limit);
    if (values.json) return process.stdout.write(`${JSON.stringify({ ...last, conversations, next_cursor: cursor })}\n`), 0;
    console.log(list(conversations, cursor !== null).join("\n"));
    return 0;
  } catch (error) {
    if (error instanceof Failed) return console.error(error.message), 1;
    throw error;
  }
}

/** Runs `flow issues`; resolves to the exit status. */
export async function issuesCli(args: string[]): Promise<number> {
  const name = "flow issues";
  const parsed = parse(name, args, { status: { type: "string" } }, ISSUES_USAGE);
  if (!parsed) return 1;
  const { values, positionals } = parsed;
  if (values.help) return console.log(ISSUES_USAGE), 0;
  if (positionals.length) return console.error(`${name} takes no arguments.\n\n${ISSUES_USAGE}`), 1;
  const status = values.status ?? "open";
  if (!["open", "resolved", "ignored", "all"].includes(status)) return console.error(`--status is open, resolved, ignored or all (got "${status}").`), 1;
  const where = access(name, values);
  if (typeof where === "string") return console.error(where), 1;
  try {
    const { text, body } = await get(name, where.cloud, where.key, `/v1/agent/issues?status=${status}`);
    if (values.json) return process.stdout.write(text), 0;
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
      feedback = ((await get(name, where.cloud, where.key, "/v1/agent/feedback?days=30")).body.feedback as Feedback[] | undefined) ?? [];
    } catch (error) {
      if (!(error instanceof Failed)) throw error; // an older Flow without the route: nothing more to print
    }
    if (feedback.length) console.log(["", `Feedback from your team (last 30 days): ${feedback.length}`, ...feedback.flatMap(feedbackLines)].join("\n"));
    return 0;
  } catch (error) {
    if (error instanceof Failed) return console.error(error.message), 1;
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
    if (m.tools?.length) out.push(`${pad}[tools: ${m.tools.map(toolName).join(", ")}]`);
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
