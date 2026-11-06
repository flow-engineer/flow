// Flow's own read tools, defined once as Flow Framework tools: what `flow conversations`, `issues`,
// `insights`, `templates`, `logs` and `deploy status` read. They serve two ways:
//   - in an agent's folder (`flowReadTools({ dir })`): the folder's keys (FLOW_KEY, FLOW_LIVE_KEY,
//     FLOW_FRAMEWORK_CLOUD_KEY; the environment first, then the folder's .env, read again on every
//     call). `flow mcp serve` serves them on stdio, and the read commands call them in the same
//     process (testing/src/conversations.ts, templates.ts, deploy.ts);
//   - hosted (`flowReadTools({ hosted: {} })`): each call names an agent of the signed-in person
//     (or they have one), and its key comes from the server's credentials, never the model.
// Eight tools every host sees, the CLI's own four (pages of conversations and logs, the team's
// feedback, an issue's test case: kept to the CLI, mcp.clients), and hosted, list_agents. A result
// is structured content and the same data as text under a one-line summary; a failure a ToolError
// with --json's failure document. No key value is ever returned, only its prefix and last 4.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { RUN } from "../../src/names.ts";
import { ToolError, type Tool, type ToolContext } from "../../src/tools.ts";
import { ADVISORY, CLOUDS, NetworkError, textLine, type FoundKey, type Waits } from "./cloud-call.ts";
import { collectConversations, Failed, get, insightConversations, listInsights, listIssues, noKey, readKey, showConversation, sinceTime, type Access } from "./conversations.ts";
import { cloudApi, cloudOf, deployStatus, logReader, logsPage, logsWindow, NotAvailable, Refused, SEVERITIES, type Api, type LogsQuery } from "./deploy.ts";
import { packageRoot } from "./new.ts";
import type { CliConfig } from "../../cli/src/commands.ts";

/** The advisory tiers in flow.engineer's words, for the instructions and the tool descriptions. */
const KEY_TIERS = `${ADVISORY.default} ${ADVISORY.ask_user} ${ADVISORY.critical}`;

const WHAT = [
  "Flow's own record of this agent once it is hosted: its conversations and the grades of its replies, its issues, its WhatsApp templates, its deploys and its log lines. Every tool only reads.",
  "Did a tool call fail, or was a reply delivered? list_conversations (grade: wrong finds badly graded replies), then show_conversation: each agent reply carries its tool calls (name, ms, ok, error) and its delivery (queued, sent, delivered, read, or failed with the channel's code).",
  "What is live? deploy_status. Why did it error? read_logs with severity ERROR (grep narrows it), then show_conversation for the conversation involved. Recurring problems: list_issues (graded replies, with a suggested fix) and list_insights (what real people ran into in production).",
];

/** What a host is told on connecting, in an agent's folder: what the server is for, and which tool answers what. */
export const INSTRUCTIONS = [
  ...WHAT,
  "Conversations, issues and templates read FLOW_KEY (a flow_test_ key reads staging only). Production reads (environment production, Insights) read the live Flow key FLOW_LIVE_KEY when it is set, else FLOW_KEY; without one, ask the developer to run `npx @flow-engineer/flow setup --live` (the workspace's owner), which writes it with text de-identified by default. Every result says its text_mode (raw, deidentified or withheld). Logs and deploys read the CI key FLOW_FRAMEWORK_CLOUD_KEY (oci_), both environments.",
  `What the live key may do, by tier (\`npx @flow-engineer/flow keys show <kid>\` lists it, \`keys grant <name>\` adds one): ${KEY_TIERS}`,
].join("\n");

/** What a host is told on connecting to the hosted Flow MCP. */
export const HOSTED_INSTRUCTIONS = [
  WHAT[0]!.replace("this agent", "your Flow agents"),
  "Each tool reads one agent: name it with agent (its flow_agent_id or name, from list_agents); with one agent, leave it out.",
  ...WHAT.slice(1),
  "Message text is de-identified (names, phones, emails, ids and addresses are placeholders) unless the agent's owner grants raw text: every result says its text_mode.",
].join("\n");

const ENVIRONMENT = z.enum(["staging", "production"]);
const WHEN = "a duration back from now (30m, 24h, 7d) or a time such as 2026-11-03T09:00:00Z";
/** The most pages read_logs reads before it stops (truncated: newer lines were not read). */
const LOG_PAGES = 20;
const FLOW_KEY_NOTE = `Reads staging with FLOW_KEY (flow_test_ reads staging only); production with FLOW_LIVE_KEY when set (flow setup --live makes it), else FLOW_KEY. The result's text_mode says whether text is raw, deidentified or withheld. The live key, by tier: ${KEY_TIERS}`;
const INSIGHTS_KEY_NOTE = `Reads with FLOW_LIVE_KEY (flow setup --live makes it), else a flow_live_ FLOW_KEY: Insights reads production only, so a flow_test_ key is refused. The result's text_mode says whether text is raw, deidentified or withheld. The live key, by tier: ${KEY_TIERS}`;
const CI_KEY_NOTE = "Reads with the CI key, FLOW_FRAMEWORK_CLOUD_KEY (oci_...), staging and production.";
const HOSTED_NOTE = "The result's text_mode says whether text is raw, deidentified or withheld.";

/** How the tools reach Flow on one call: the keys as found now, and the cloud. */
export interface Reads {
  /** FLOW_KEY or the live key, by where the tool reads (readKey's rule). */
  flow(environment?: "staging" | "production"): Promise<Access>;
  /** The deploy and logs routes, with the CI key (or a hosted connection's key). */
  ci(): Promise<{ api: Api; key: FoundKey }>;
  /** The agent's folder, for its package.json; none hosted. */
  dir?: string;
}

/** The signed-in person's Flow agents and a read key for one: what a hosted server's credentials give for `credential`. */
export interface FlowAgentAccess {
  /** Their own Flow agents. A refusal is a ToolError (code, message, hint, next as the brand sent them). */
  agents(): Promise<FlowAgent[]>;
  /** A read key for one of their agents, by its flow_agent_id or name; a refusal is a ToolError. */
  key(agent: string): Promise<{ value: string; flow_agent_id: string; name: string }>;
}

export interface FlowAgent {
  flow_agent_id: string;
  name: string;
  workspace_id: string | null;
}

export type FlowReadToolsOptions =
  /** In an agent's folder: its keys, the environment first, then the folder's .env (default "."); cloud as --cloud. */
  | { dir?: string; cloud?: string; env?: NodeJS.ProcessEnv }
  /** Hosted: each call's key from context.credentials.get(credential) (default "flow"), a FlowAgentAccess; cloud default Flow's US one. */
  | { hosted: { credential?: string; cloud?: string } };

interface Read<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  /** The description, with the keys' note for the folder or for hosted. */
  description: (hosted: boolean) => string;
  input: S;
  /** The input hosted, where `input` names the folder's keys. */
  hostedInput?: S;
  /** Kept to the CLI (mcp.clients): a page or a route only the CLI's commands read. */
  cli?: true;
  run(input: z.output<S>, reads: Reads, say: Say): Promise<Record<string, unknown>>;
  /** The line said above the data. */
  summary?(data: Record<string, unknown>, input: z.output<S>): string;
}

/** How a call words a failure: the CLI's command ("flow conversations") or the tool's name. */
interface Say {
  name: string;
  cli: boolean;
}

const read = <S extends z.ZodObject>(r: Read<S>): Read => r as unknown as Read;
const keyed = (note: string) => (hosted: boolean) => (hosted ? HOSTED_NOTE : note);

/** A summary's note of the read's text mode, when it said one: " Text: de-identified (...)." */
const textNote = (mode: unknown) => (typeof mode === "string" && mode ? ` ${textLine(mode)}.` : "");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const READS: Read[] = [
  read({
    name: "list_conversations",
    title: "List conversations",
    description: (hosted) => `The hosted agent's conversations, newest first: id, channel, contact label, messages, the agent version behind its latest reply, and how many replies were graded wrong, unhelpful or good. Use it first when asked how the live agent is doing or to find a conversation, then show_conversation with an id. grade: wrong finds the replies to fix. ${keyed(FLOW_KEY_NOTE)(hosted)}`,
    input: z.object({
      environment: ENVIRONMENT.optional().describe("staging or production (default: production for a flow_live_ key, else staging)"),
      since: z.string().optional().describe(`Only conversations with a message since then: ${WHEN}`),
      grade: z.enum(["wrong", "unhelpful", "good"]).optional().describe("Only conversations with a reply graded this"),
      contact: z.string().min(1).optional().describe('Only this contact\'s, by its label as listed: "Contact 9e35" or 9e35'),
      limit: z.number().int().min(1).max(200).default(20).describe("At most this many"),
    }),
    async run(input, reads, say) {
      const since = input.since === undefined ? undefined : sinceTime(input.since);
      if (input.since !== undefined && !since) throw new Failed(`since is ${WHEN} (got "${input.since}").`, "usage");
      const where = await reads.flow(input.environment);
      const { last, conversations, cursor } = await collectConversations(async (page) => (await get(say.name, where, `/v1/agent/conversations?${page}`)).body, { ...input, since });
      return { ...last, conversations, next_cursor: cursor };
    },
    summary(data) {
      const conversations = data.conversations as Array<{ grades?: { wrong?: number } | null }>;
      const wrong = conversations.reduce((n, c) => n + (c.grades?.wrong ?? 0), 0);
      return `${plural(conversations.length, "conversation", "conversations")}${data.next_cursor ? " (more: raise limit)" : ""}, ${plural(wrong, "reply", "replies")} graded wrong.${textNote(data.text_mode)} Read one: show_conversation.`;
    },
  }),
  read({
    name: "show_conversation",
    title: "Show a conversation",
    description: (hosted) => `One conversation, message by message: each agent reply's tool calls (name, ms, ok or the error, and input and output when the account shows them), its delivery (queued, sent, delivered, read, or failed with the channel's code) and its grade (label, rule, reason, quoted words), and the issues it belongs to. Use it to answer "did that tool call fail", "was it delivered" or "why was this reply graded wrong". Text is as Flow sends it: withheld or masked for some accounts. ${keyed(FLOW_KEY_NOTE)(hosted)}`,
    input: z.object({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).describe("A conversation id from list_conversations or list_issues"),
      environment: ENVIRONMENT.optional().describe("production reads with FLOW_LIVE_KEY straight away; unset, FLOW_KEY first, then FLOW_LIVE_KEY when FLOW_KEY does not find it"),
    }),
    hostedInput: z.object({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).describe("A conversation id from list_conversations or list_issues"),
      environment: ENVIRONMENT.optional().describe("staging or production"),
    }),
    async run({ id, environment }, reads, say) {
      return (await showConversation(say.name, await reads.flow(environment), id)).body;
    },
    summary(body, { id }) {
      const messages = (body.messages as Array<{ tools?: Array<{ ok?: boolean | null } | string>; delivery?: { state?: string } | null }> | undefined) ?? [];
      const failedTools = messages.flatMap((m) => m.tools ?? []).filter((t) => typeof t === "object" && t.ok === false).length;
      const failedDeliveries = messages.filter((m) => m.delivery?.state === "failed").length;
      return `Conversation ${id}: ${messages.length} messages, ${plural(failedTools, "failed tool call", "failed tool calls")}, ${plural(failedDeliveries, "failed delivery", "failed deliveries")}.${textNote(body.text_mode)}`;
    },
  }),
  read({
    name: "list_issues",
    title: "List issues",
    description: (hosted) => `The problems the grades of the agent's replies add up to, across both environments: id, status, how many conversations, last seen, title and a suggested fix. Use it to find what to fix in the agent first; show_conversation reads the conversations behind one. ${keyed(FLOW_KEY_NOTE)(hosted)}`,
    input: z.object({ status: z.enum(["open", "resolved", "ignored", "all"]).default("open").describe("Which issues") }),
    async run({ status }, reads, say) {
      return (await listIssues(say.name, await reads.flow(), status)).body;
    },
    summary(body, { status }) {
      const n = ((body.issues as unknown[] | undefined) ?? []).length;
      return `${n} ${status === "all" ? "" : `${status} `}issue${n === 1 ? "" : "s"}.`;
    },
  }),
  read({
    name: "list_insights",
    title: "List Insights findings",
    description: (hosted) => `Flow Insights' findings over closed production conversations (24 h quiet), ranked as the dashboard ranks them: id, signal (no reply, send failed, repeated question, loop, ...), status, topic, and conversations in the window with the window before's. Use it to see what keeps going wrong with real people, or, a window after a fix is deployed, whether a finding's count dropped; insight_conversations reads one finding's conversations. ${keyed(INSIGHTS_KEY_NOTE)(hosted)}`,
    input: z.object({
      days: z.union([z.literal(7), z.literal(30)]).default(7).describe("The window: 7 or 30 days"),
      status: z.enum(["open", "fixed", "muted", "all"]).default("open").describe("Which findings"),
    }),
    async run({ days, status }, reads, say) {
      return (await listInsights(say.name, await reads.flow("production"), { days, status })).body;
    },
    summary(body, { days, status }) {
      const n = ((body.findings as unknown[] | undefined) ?? []).length;
      return `${n} ${status === "all" ? "" : `${status} `}finding${n === 1 ? "" : "s"} over ${days} days${typeof body.state === "string" ? ` (state: ${body.state})` : ""}.${textNote(body.text_mode)} Read one: insight_conversations.`;
    },
  }),
  read({
    name: "insight_conversations",
    title: "Insight conversations",
    description: (hosted) => `One Insights finding's conversations in the window: conversation id, time, why it was flagged, the person's words when the account shows them, and the window: the 3 messages before the flagged one and 2 after. Use it after list_insights to see the cases behind a finding, then show_conversation with an id (and environment production) for the whole conversation. ${keyed(INSIGHTS_KEY_NOTE)(hosted)}`,
    input: z.object({
      finding: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).describe("A finding id from list_insights"),
      days: z.union([z.literal(7), z.literal(30)]).default(7).describe("The window: 7 or 30 days"),
    }),
    async run({ finding, days }, reads, say) {
      return (await insightConversations(say.name, await reads.flow("production"), finding, days)).body;
    },
    summary(body, { finding, days }) {
      const n = Array.isArray(body.data) ? body.data.length : 0;
      return `Finding ${finding}: ${n} conversation${n === 1 ? "" : "s"} over ${days} days.${textNote(body.text_mode)} Read one: show_conversation.`;
    },
  }),
  read({
    name: "list_templates",
    title: "List WhatsApp templates",
    description: (hosted) => `The project's WhatsApp templates on Flow's dashboard as Meta approved them: name, language, category, status, body, buttons and the order a send gives its values in. Use it before declaring templates in createAgent, to copy them exactly. ${keyed(FLOW_KEY_NOTE)(hosted)}`,
    input: z.object({ status: z.enum(["approved", "all"]).default("approved").describe("approved only, or every status (pending, rejected, ...)") }),
    async run({ status }, reads, say) {
      const where = await reads.flow();
      let body: Record<string, unknown>;
      try {
        ({ body } = await get(say.name, where, "/v1/agent/templates"));
      } catch (error) {
        // flow templates' own words for a dashboard without the route.
        if (say.cli && error instanceof Failed && error.status === 404) throw new ToolError("not_available", `${say.name}: the dashboard does not serve templates yet (${where.cloud} answered 404).`);
        throw error;
      }
      const templates = ((body.templates as Array<{ status?: string }> | undefined) ?? []).filter((t) => status === "all" || t.status === "approved");
      return { ...body, templates };
    },
    summary(data, { status }) {
      const n = (data.templates as unknown[]).length;
      return `${n} ${status === "all" ? "" : "approved "}template${n === 1 ? "" : "s"}.`;
    },
  }),
  read({
    name: "read_logs",
    title: "Read logs",
    description: (hosted) => `The hosted agent's log lines, oldest first: { time, severity, text }; a stack trace split into an entry per line comes as one line. Use it for why something errored or what the service did around a time: severity ERROR shows the failures, grep narrows to a tool, an id or a message. When more lines match than limit, the newest are kept and truncated is true: narrow since, severity or grep (when it stops after 20 pages, newer_from is where the unread lines start).${hosted ? "" : ` ${CI_KEY_NOTE}`}`,
    input: z.object({
      environment: ENVIRONMENT.default("staging").describe("staging or production"),
      since: z.string().default("1h").describe(`How far back, at most 30 days: ${WHEN}`),
      until: z.string().optional().describe(`Up to when: ${WHEN}`),
      severity: z.enum(SEVERITIES).optional().describe("Only lines at this severity or above; a DEFAULT line that is plainly an uncaught error (Error:, DOMException, a stack) counts as ERROR"),
      grep: z.string().min(1).max(200).optional().describe("Only lines that hold this text (any case) anywhere in the line as printed: a JSON line's every field, not only its message (text with a quote or brace is matched over every line of the window, slower)"),
      limit: z.number().int().min(1).max(1000).default(200).describe("At most this many lines, the newest"),
    }),
    async run(input, reads) {
      // flow logs' own rule (logsWindow): a duration is that long before now for since and until alike.
      const window = logsWindow(input.since, input.until, Date.now());
      if ("wrong" in window && window.wrong === "since") throw new Failed(`since is ${WHEN}, at most 30 days back (got "${input.since}").`, "usage");
      if ("wrong" in window) throw new Failed(`until is ${WHEN}, after since (got "${input.until}").`, "usage");
      const { since, until } = window;
      const query: LogsQuery = { environment: input.environment, since, ...(until ? { until } : {}), ...(input.severity ? { severity: input.severity } : {}), ...(input.grep ? { grep: input.grep } : {}) };
      const { api } = await reads.ci();
      let lines: Array<{ time: string; severity?: string; text: string }> = [];
      let from: string | null = null;
      // Every page up to until (else now), as flow logs reads them, keeping the newest: the pages end
      // when the cursor stops moving (next null, or the after just sent); a page past that is not kept.
      let complete = false;
      const reader = logReader(input.severity);
      for (let pages = 0; pages < LOG_PAGES; pages++) {
        const page = await logsPage(api, query);
        if (pages === 0) from = page.from;
        const moved = Boolean(page.next) && page.next !== query.after;
        if (moved || pages === 0) {
          lines.push(...reader.add(page.lines));
          lines = lines.slice(-input.limit - 1);
        }
        if (!moved) { complete = true; break; }
        query.after = page.next!;
      }
      lines = [...lines, ...reader.end()].slice(-input.limit - 1);
      const truncated = lines.length > input.limit || !complete;
      const kept = lines.slice(-input.limit).map((l) => ({ time: l.time, severity: l.severity ?? null, text: l.text }));
      return { environment: input.environment, since, until: until ?? null, lines: kept, truncated, ...(complete ? {} : { newer_from: kept.at(-1)?.time ?? null }), logs_start: from };
    },
    summary(data) {
      const kept = data.lines as Array<{ time: string; severity: string | null }>;
      const complete = !("newer_from" in data);
      const errors = kept.filter((l) => ["ERROR", "CRITICAL", "ALERT", "EMERGENCY"].includes(String(l.severity).toUpperCase())).length;
      const from = data.logs_start as string | null;
      return `${kept.length} log line${kept.length === 1 ? "" : "s"} from ${data.environment}${!complete ? ` (stopped after ${LOG_PAGES} pages: newer lines from ${kept.at(-1)?.time ?? "?"} not read; call again with that since)` : data.truncated ? " (truncated: the newest kept; narrow since, severity or grep)" : ""}, ${errors} at ERROR or above.${from && Date.parse(from) - Date.parse(data.since as string) > 60_000 ? ` Logs start at ${from}.` : ""}`;
    },
  }),
  read({
    name: "deploy_status",
    title: "Deploy status",
    description: (hosted) => `What is live on Flow's hosting per environment: the deploy (id, status, version, when, framework: the Flow Framework its build used, lint findings, error), a newer one still on its way, the agent's URL, and whether its traces reach Flow; ${hosted ? "agent_framework is null here (it is the version the agent's folder pins)" : "agent_framework is the version this folder's package.json pins"}, hosting_framework the newest line Flow's hosting runs (not the agent's). Use it to answer what is live, or whether a deploy finished.${hosted ? "" : ` ${CI_KEY_NOTE}`}`,
    input: z.object({ environment: ENVIRONMENT.optional().describe("One environment (default: both)") }),
    async run({ environment }, reads) {
      const { api } = await reads.ci();
      const { environments, hostingFramework, agentFramework } = await deployStatus({ api, dir: reads.dir }, environment ? [environment] : ["staging", "production"]);
      return { agent_framework: agentFramework, hosting_framework: hostingFramework, environments: Object.fromEntries(environments.map((e) => [e.environment, e])) };
    },
    summary(data) {
      type E = { environment: string; deploy: { status: string; version?: string | null; framework?: { package: string; version: string } | null } | null; pending: { status: string } | null };
      const environments = Object.values(data.environments as Record<string, E>);
      const said = environments.map((e) => `${e.environment}: ${e.deploy ? `${e.deploy.status}${e.deploy.version ? ` ${e.deploy.version}` : ""}${e.deploy.framework ? `, built with ${e.deploy.framework.package} ${e.deploy.framework.version}` : ""}` : "no deploy known"}${e.pending ? ` (then ${e.pending.status})` : ""}`);
      const versions = [data.agent_framework && `This agent pins Flow Framework ${data.agent_framework}`, data.hosting_framework && `Flow's hosting runs up to ${data.hosting_framework} (hosting's line, not the agent's)`].filter(Boolean);
      return `${said.join("; ")}.${versions.length ? ` ${versions.join("; ")}.` : ""}`;
    },
  }),
  // The CLI's own reads: a page of conversations (flow conversations reads up to 1000, over pages),
  // a page of logs (flow logs pages to the end and follows), the team's feedback and an issue's test case.
  read({
    name: "conversations_page",
    title: "A page of conversations",
    cli: true,
    description: () => "One page of the hosted agent's conversations, as Flow answers it, for flow conversations.",
    input: z.object({
      environment: ENVIRONMENT.optional(),
      grade: z.enum(["wrong", "unhelpful", "good"]).optional(),
      since: z.string().optional().describe("An RFC 3339 time"),
      limit: z.number().int().min(1).max(100),
      cursor: z.string().optional(),
    }),
    async run({ environment, grade, since, limit, cursor }, reads, say) {
      const page = new URLSearchParams();
      if (environment) page.set("environment", environment);
      if (grade) page.set("grade", grade);
      if (since) page.set("since", since);
      page.set("limit", String(limit));
      if (cursor) page.set("cursor", cursor);
      return (await get(say.name, await reads.flow(environment), `/v1/agent/conversations?${page}`)).body;
    },
  }),
  read({
    name: "team_feedback",
    title: "Your team's feedback",
    cli: true,
    description: () => "The team's feedback of the last 30 days (checks out of date, grades marked wrong), for flow issues.",
    input: z.object({}),
    async run(_input, reads, say) {
      return (await get(say.name, await reads.flow(), "/v1/agent/feedback?days=30")).body;
    },
  }),
  read({
    name: "issue_test_case",
    title: "An issue's test case",
    cli: true,
    description: () => "The test case Flow proposes for an issue, for flow issues test-case.",
    input: z.object({ issue: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }),
    async run({ issue }, reads, say) {
      return (await get(say.name, await reads.flow(), `/v1/agent/issues/${issue}/test-case`)).body;
    },
  }),
  read({
    name: "logs_page",
    title: "A page of logs",
    cli: true,
    description: () => "One page of the hosted agent's log lines (filtered by until and grep), its cursor and where the logs start, for flow logs.",
    input: z.object({
      environment: ENVIRONMENT,
      since: z.string(),
      until: z.string().optional(),
      severity: z.string().optional(),
      grep: z.string().optional(),
      after: z.string().optional(),
    }),
    async run(query, reads) {
      const { api } = await reads.ci();
      return await logsPage(api, query);
    },
  }),
];

/** What a host gets for a thrown error: the CLI's words when the CLI called, else a model's. */
function failure(error: unknown, say: Say): ToolError {
  if (error instanceof ToolError) return error;
  // The key story is the CLI's; for a model a flag is an argument.
  if (error instanceof Failed) return new ToolError(error.code, say.cli ? error.message : error.message.replace("add --env staging", 'call it with environment "staging"'), { ...(error.hint ? { hint: error.hint } : {}), ...(error.next ? { next: error.next } : {}) });
  if (error instanceof Refused) return new ToolError(error.code, `Refused: ${error.message}`, error.next ? { next: error.next } : {});
  if (error instanceof NotAvailable) return new ToolError("not_available", error.message);
  if (error instanceof NetworkError) return new ToolError("network", `Could not reach the cloud: ${error.message}.`);
  return new ToolError("internal", `${say.name} failed: ${(error as Error).message}`);
}

/** The words a failure names its caller by: "flow conversations" for the CLI's `conversations show`, else the tool. */
function sayFor(tool: string, context: ToolContext): Say {
  const command = context.cli?.command;
  return command ? { name: `flow ${command.split(" ")[0]}`, cli: true } : { name: tool, cli: false };
}

/** The read tools over `reads` (each call's keys), or hosted. */
export function readTools(reads: ((input: { agent?: string }, context: ToolContext) => Promise<Reads>), hosted: boolean): Tool[] {
  const agent = z.string().min(1).max(200).optional().describe("The agent: its flow_agent_id (agt_...) or name, from list_agents; leave it out when you have one");
  const tools: Tool[] = READS.map((r) => ({
    name: r.name,
    title: r.title,
    description: r.description(hosted),
    input: hosted ? (r.hostedInput ?? r.input).extend({ agent }) : r.input,
    output: z.record(z.string(), z.unknown()),
    signIn: hosted ? "required" : "none",
    hints: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
    ...(r.cli ? { mcp: { clients: ["cli" as const] } } : {}),
    async run(input: Record<string, unknown>, context: ToolContext) {
      const say = sayFor(r.name, context);
      try {
        return await r.run(input as never, await reads(input, context), say);
      } catch (error) {
        throw failure(error, say);
      }
    },
    format: (data: Record<string, unknown>, input: Record<string, unknown>) => `${r.summary ? `${r.summary(data, input as never)}\n` : ""}${JSON.stringify(data)}`,
  }));
  return tools;
}

/** The keys and the cloud as found on each call in a folder: the environment it was given, then the folder's .env. */
export function folderReads(dir: string, env: NodeJS.ProcessEnv, cloud: string | undefined, waits?: Waits): Reads {
  const found = () => cloudOf(dir, env, cloud, waits);
  return {
    dir,
    async flow(environment) {
      const { cloud: address, dotEnv } = found();
      const keys = readKey(environment, (name) => {
        const fromEnvironment = env[name]?.trim();
        const value = fromEnvironment || dotEnv.get(name)?.trim();
        return value ? { value, where: fromEnvironment ? "the environment" : join(dir, ".env") } : undefined;
      });
      if (!keys) throw noKey("This tool", environment);
      return { cloud: address, ...keys, ...(waits ? { waits } : {}) };
    },
    async ci() {
      const now = found();
      if (!now.key) throw new Failed("This tool reads with the agent's CI key: set FLOW_FRAMEWORK_CLOUD_KEY (oci_...) in the agent's .env (flow setup writes it there).", "no_ci_key", undefined, `${RUN} setup`);
      return { api: now.api, key: now.key };
    },
  };
}

/** One call's reads, hosted: the agent it names (or the person's only one) and the key their credentials give for it. */
async function hostedReads(agent: string | undefined, context: ToolContext, credential: string, cloud: string): Promise<Reads> {
  const access = await agentAccess(context, credential);
  const chosen = agent ?? (await onlyAgent(access)).flow_agent_id;
  const given = await access.key(chosen);
  const key: FoundKey = { kind: "connection", name: given.name, where: "this connection", value: given.value };
  return { flow: async () => ({ cloud, key }), ci: async () => ({ api: cloudApi(cloud, key), key }) };
}

async function agentAccess(context: ToolContext, credential: string): Promise<FlowAgentAccess> {
  if (!context.credentials) throw new ToolError("no_credentials", `This server gives its tools no credentials, so it cannot read Flow: give mcpServer credentials whose "${credential}" is a FlowAgentAccess.`);
  return context.credentials.get<FlowAgentAccess>(credential);
}

async function onlyAgent(access: FlowAgentAccess): Promise<FlowAgent> {
  const agents = await access.agents();
  if (agents.length === 1) return agents[0]!;
  if (!agents.length) throw new ToolError("no_agents", "You have no Flow agents yet: make one with npx @flow-engineer/flow setup in its folder.", { next: `${RUN} setup` });
  throw new ToolError("agent_required", `You have ${agents.length} Flow agents: name one with agent (${agents.map((a) => a.name).join(", ")}).`, { next: "list_agents" });
}

/**
 * Flow's read tools and what a host is told on connecting, for mcpServer({ tools, instructions }).
 * In a folder: the eight tools `flow mcp serve` serves (and the CLI's own four, which no host sees).
 * Hosted: every tool takes `agent`, plus list_agents; serve them with auth (sign-in required), and
 * credentials whose `credential` ("flow") is a FlowAgentAccess for the signed-in person.
 */
export function flowReadTools(options: FlowReadToolsOptions = {}): { tools: Tool[]; instructions: string } {
  if ("hosted" in options) {
    const credential = options.hosted.credential ?? "flow";
    const cloud = (options.hosted.cloud ?? CLOUDS.us).replace(/\/+$/, "");
    const listAgents: Tool = {
      name: "list_agents",
      title: "List your agents",
      description: "Your Flow agents: flow_agent_id, name and workspace. Every other tool reads one of them: pass its flow_agent_id or name as agent.",
      input: z.object({}),
      output: z.record(z.string(), z.unknown()),
      hints: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
      async run(_input, context) {
        return { agents: await (await agentAccess(context, credential)).agents() };
      },
      format: (data: Record<string, unknown>) => `${plural((data.agents as unknown[]).length, "agent", "agents")}.\n${JSON.stringify(data)}`,
    };
    return { tools: [listAgents, ...readTools((input, context) => hostedReads(input.agent, context, credential, cloud), true)], instructions: HOSTED_INSTRUCTIONS };
  }
  const reads = folderReads(resolve(options.dir ?? "."), options.env ?? { ...process.env }, options.cloud);
  return { tools: readTools(async () => reads, false), instructions: INSTRUCTIONS };
}

/** This package's version, as the servers say it. */
export function flowVersion(): string {
  return JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")).version as string;
}

/**
 * The CLI that reaches a hosted Flow MCP: `flow mcp login` and `logout` sign in to it, and the read
 * commands' --server call its tools. Its sign-ins are kept apart from `flow login`'s, in
 * ~/.config/flow-mcp; FLOW_MCP_TOKEN is a token for CI and agents, FLOW_MCP_SERVER the default --server.
 */
export const FLOW_MCP_CLI: CliConfig = {
  name: "flow",
  signIn: { login: "mcp login", logout: "mcp logout" },
  tokenEnv: "FLOW_MCP_TOKEN",
  serverEnv: "FLOW_MCP_SERVER",
  directory: join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "flow-mcp"),
  welcome: false,
  discoveryCache: false,
};

/** One command's reads over a hosted Flow MCP: a tool's result, or Failed as the command prints one. */
export interface HostedReads {
  (tool: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/**
 * Connects `command` ("conversations show") to the hosted Flow MCP at `server`, as the person signed
 * in with flow mcp login (or FLOW_MCP_TOKEN), reading `agent` (else their only one). Loaded only
 * with --server: it needs @modelcontextprotocol/client and @stricli/core, the CLI's optional peers.
 */
export async function connectHosted(server: string, agent: string | undefined, command: string): Promise<HostedReads> {
  const name = `flow ${command.split(" ")[0]}`;
  let cli: typeof import("../../cli/src/run.ts");
  try {
    cli = await import("../../cli/src/run.ts");
  } catch (error) {
    const missing = /Cannot find package '([^']+)'/.exec((error as Error).message)?.[1];
    if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND" || !missing) throw error;
    throw new Failed(`${name} --server needs ${missing}: run it from your agent's folder, or npm install ${missing}.`, "missing_peer");
  }
  // Sign-in (3), a server out of reach (5) and wrong arguments (2) are said as the CLI says them; the command exits 1.
  const said = (error: unknown) =>
    error instanceof ToolError ? new Failed(error.message, error.code, error.hint, error.next)
    : error instanceof cli.CliExit ? new Failed(error.message, error.code === 3 ? "signed_out" : error.code === 5 ? "network" : error.code === 2 ? "usage" : "failed")
    : error;
  let connection: Awaited<ReturnType<typeof cli.connectCli>>;
  try {
    connection = await cli.connectCli(FLOW_MCP_CLI, { server });
  } catch (error) {
    throw said(error);
  }
  const read = async (tool: string, input: Record<string, unknown>) => {
    try {
      return (await connection.call(tool, { ...input, ...(agent ? { agent } : {}) }, { command })) as Record<string, unknown>;
    } catch (error) {
      throw said(error);
    }
  };
  return Object.assign(read, { close: () => connection.close() });
}
