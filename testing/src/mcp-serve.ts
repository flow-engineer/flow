// `flow mcp serve`: what `flow conversations`, `issues`, `insights`, `templates`, `logs` and `deploy status` read,
// as an MCP server on stdio for the coding agent working in the agent's folder:
//   claude mcp add flow -- npx @flow-engineer/flow mcp serve
// Read-only tools on the same functions the commands use (testing/src/conversations.ts,
// testing/src/deploy.ts, testing/src/cloud-call.ts): the same keys, waits, retries and refusals.
// Each call reads the keys again (the environment the server started with wins over the folder's
// .env), so a key fixed in .env works on the next call. A result is structuredContent and the same
// data as text under a one-line summary (a host that reads only text still gets it); a failure is
// isError with --json's failure document. No key value is ever returned, only its prefix and last 4.
// Loaded only by `flow mcp serve`: it needs @modelcontextprotocol/server, an optional peer.

import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { ProtocolError, ProtocolErrorCode, Server, type CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { RUN } from "../../src/names.ts";
import { ADVISORY, NetworkError, textLine, type FoundKey } from "./cloud-call.ts";
import { Failed, get, insightConversations, listConversations, listInsights, listIssues, noKey, readKey, showConversation, sinceTime, type Access } from "./conversations.ts";
import { cloudOf, deployStatus, logsPage, NotAvailable, Refused, SEVERITIES, type LogsQuery } from "./deploy.ts";
import { packageRoot } from "./new.ts";

const MCP_SERVE_USAGE = `Usage:
  flow mcp serve [--dir <folder>] [--cloud <url>]

This agent's conversations, issues, templates, logs and deploys as read-only MCP tools for your
coding agent, served on stdio.

Add it to Claude Code from the agent's folder:
  claude mcp add flow -- npx @flow-engineer/flow mcp serve
Any other MCP host: the command npx, the arguments @flow-engineer/flow mcp serve, run in the
agent's folder (or add --dir <folder>).

Tools (all read-only): list_conversations, show_conversation, list_issues, list_insights,
insight_conversations, list_templates, read_logs, deploy_status. They read what flow
conversations, flow issues, flow insights, flow templates, flow logs and flow deploy status
print, as JSON.

  --dir <folder>   The agent's folder, whose .env holds the keys (default: .)
  --cloud <url>    Flow's address (default: FLOW_FRAMEWORK_CLOUD, else https://flow.engineer/observe)
  -h, --help       Show this help

Keys: each call reads them again, the environment the server started with first, then the
folder's .env, so a key fixed in .env works on the next call without a restart.
  FLOW_KEY                  list_conversations, show_conversation, list_issues, list_templates.
                            flow_test_... reads staging only
  FLOW_LIVE_KEY             The live Flow key, for production reads whenever it is set:
                            list_conversations and show_conversation with environment production,
                            list_insights, insight_conversations (else FLOW_KEY); show_conversation
                            tries it once when FLOW_KEY does not find the id. Text is de-identified
                            unless it was made with --content; flow setup --live makes it.
                            What it may do, by tier (flow keys grant adds one):
                            ${ADVISORY.default}
                            ${ADVISORY.ask_user}
                            ${ADVISORY.critical}
  FLOW_FRAMEWORK_CLOUD_KEY  read_logs, deploy_status: the CI key (oci_...), staging and production
Nothing goes to stdout but the protocol; waits and retries are said on stderr.`;

/** The advisory tiers in flow.engineer's words, for the instructions and the tool descriptions. */
const KEY_TIERS = `${ADVISORY.default} ${ADVISORY.ask_user} ${ADVISORY.critical}`;

/** What a host is told on connecting: what the server is for, and which tool answers what. */
export const INSTRUCTIONS = [
  "Flow's own record of this agent once it is hosted: its conversations and the grades of its replies, its issues, its WhatsApp templates, its deploys and its log lines. Every tool only reads.",
  "Did a tool call fail, or was a reply delivered? list_conversations (grade: wrong finds badly graded replies), then show_conversation: each agent reply carries its tool calls (name, ms, ok, error) and its delivery (queued, sent, delivered, read, or failed with the channel's code).",
  "What is live? deploy_status. Why did it error? read_logs with severity ERROR (grep narrows it), then show_conversation for the conversation involved. Recurring problems: list_issues (graded replies, with a suggested fix) and list_insights (what real people ran into in production).",
  "Conversations, issues and templates read FLOW_KEY (a flow_test_ key reads staging only). Production reads (environment production, Insights) read the live Flow key FLOW_LIVE_KEY when it is set, else FLOW_KEY; without one, ask the developer to run `npx @flow-engineer/flow setup --live` (the workspace's owner), which writes it with text de-identified by default. Every result says its text_mode (raw, deidentified or withheld). Logs and deploys read the CI key FLOW_FRAMEWORK_CLOUD_KEY (oci_), both environments.",
  `What the live key may do, by tier (\`npx @flow-engineer/flow keys show <kid>\` lists it, \`keys grant <name>\` adds one): ${KEY_TIERS}`,
].join("\n");

const ENVIRONMENT = z.enum(["staging", "production"]);
const WHEN = "a duration back from now (30m, 24h, 7d) or a time such as 2026-11-03T09:00:00Z";
const FLOW_KEY_NOTE = `Reads staging with FLOW_KEY (flow_test_ reads staging only); production with FLOW_LIVE_KEY when set (flow setup --live makes it), else FLOW_KEY. The result's text_mode says whether text is raw, deidentified or withheld. The live key, by tier: ${KEY_TIERS}`;
const INSIGHTS_KEY_NOTE = `Reads with FLOW_LIVE_KEY (flow setup --live makes it), else a flow_live_ FLOW_KEY: Insights reads production only, so a flow_test_ key is refused. The result's text_mode says whether text is raw, deidentified or withheld. The live key, by tier: ${KEY_TIERS}`;

interface ServeTool {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  /** The data, and the one line said above it. */
  run(input: never, reads: Reads): Promise<{ data: Record<string, unknown>; summary: string }>;
}

/** How the tools reach Flow: the keys as found on this call, and the cloud. */
interface Reads {
  /** FLOW_KEY or the live key, by where the tool reads (readKey's rule). */
  flow(environment?: "staging" | "production"): Access;
  ci(): ReturnType<typeof cloudOf> & { key: FoundKey };
  dir: string;
}

/** A summary's note of the read's text mode, when it said one: " Text: de-identified (...)." */
const textNote = (mode: unknown) => (typeof mode === "string" && mode ? ` ${textLine(mode)}.` : "");

const tool = <S extends z.ZodObject>(t: { name: string; title: string; description: string; input: S; run(input: z.output<S>, reads: Reads): Promise<{ data: Record<string, unknown>; summary: string }> }): ServeTool => t as unknown as ServeTool;

/** The tools `flow mcp serve` serves. */
export const TOOLS: ServeTool[] = [
  tool({
    name: "list_conversations",
    title: "List conversations",
    description: `The hosted agent's conversations, newest first: id, channel, contact label, messages, the agent version behind its latest reply, and how many replies were graded wrong, unhelpful or good. Use it first when asked how the live agent is doing or to find a conversation, then show_conversation with an id. grade: wrong finds the replies to fix. ${FLOW_KEY_NOTE}`,
    input: z.object({
      environment: ENVIRONMENT.optional().describe("staging or production (default: production for a flow_live_ key, else staging)"),
      since: z.string().optional().describe(`Only conversations with a message since then: ${WHEN}`),
      grade: z.enum(["wrong", "unhelpful", "good"]).optional().describe("Only conversations with a reply graded this"),
      contact: z.string().min(1).optional().describe('Only this contact\'s, by its label as listed: "Contact 9e35" or 9e35'),
      limit: z.number().int().min(1).max(200).default(20).describe("At most this many"),
    }),
    async run(input, reads) {
      const since = input.since === undefined ? undefined : sinceTime(input.since);
      if (input.since !== undefined && !since) throw new Failed(`since is ${WHEN} (got "${input.since}").`, "usage");
      const { last, conversations, cursor } = await listConversations("list_conversations", reads.flow(input.environment), { ...input, since });
      const wrong = conversations.reduce((n, c) => n + (c.grades?.wrong ?? 0), 0);
      return {
        data: { ...last, conversations, next_cursor: cursor },
        summary: `${conversations.length} conversation${conversations.length === 1 ? "" : "s"}${cursor ? " (more: raise limit)" : ""}, ${wrong} repl${wrong === 1 ? "y" : "ies"} graded wrong.${textNote(last.text_mode)} Read one: show_conversation.`,
      };
    },
  }),
  tool({
    name: "show_conversation",
    title: "Show a conversation",
    description: `One conversation, message by message: each agent reply's tool calls (name, ms, ok or the error, and input and output when the account shows them), its delivery (queued, sent, delivered, read, or failed with the channel's code) and its grade (label, rule, reason, quoted words), and the issues it belongs to. Use it to answer "did that tool call fail", "was it delivered" or "why was this reply graded wrong". Text is as Flow sends it: withheld or masked for some accounts. ${FLOW_KEY_NOTE}`,
    input: z.object({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).describe("A conversation id from list_conversations or list_issues"),
      environment: ENVIRONMENT.optional().describe("production reads with FLOW_LIVE_KEY straight away; unset, FLOW_KEY first, then FLOW_LIVE_KEY when FLOW_KEY does not find it"),
    }),
    async run({ id, environment }, reads) {
      const { body } = await showConversation("show_conversation", reads.flow(environment), id);
      const messages = (body.messages as Array<{ tools?: Array<{ ok?: boolean | null } | string>; delivery?: { state?: string } | null }> | undefined) ?? [];
      const failedTools = messages.flatMap((m) => m.tools ?? []).filter((t) => typeof t === "object" && t.ok === false).length;
      const failedDeliveries = messages.filter((m) => m.delivery?.state === "failed").length;
      return { data: body, summary: `Conversation ${id}: ${messages.length} messages, ${failedTools} failed tool call${failedTools === 1 ? "" : "s"}, ${failedDeliveries} failed deliver${failedDeliveries === 1 ? "y" : "ies"}.${textNote(body.text_mode)}` };
    },
  }),
  tool({
    name: "list_issues",
    title: "List issues",
    description: `The problems the grades of the agent's replies add up to, across both environments: id, status, how many conversations, last seen, title and a suggested fix. Use it to find what to fix in the agent first; show_conversation reads the conversations behind one. ${FLOW_KEY_NOTE}`,
    input: z.object({ status: z.enum(["open", "resolved", "ignored", "all"]).default("open").describe("Which issues") }),
    async run({ status }, reads) {
      const { body } = await listIssues("list_issues", reads.flow(), status);
      const n = ((body.issues as unknown[] | undefined) ?? []).length;
      return { data: body, summary: `${n} ${status === "all" ? "" : `${status} `}issue${n === 1 ? "" : "s"}.` };
    },
  }),
  tool({
    name: "list_insights",
    title: "List Insights findings",
    description: `Flow Insights' findings over closed production conversations (24 h quiet), ranked as the dashboard ranks them: id, signal (no reply, send failed, repeated question, loop, ...), status, topic, and conversations in the window with the window before's. Use it to see what keeps going wrong with real people, or, a window after a fix is deployed, whether a finding's count dropped; insight_conversations reads one finding's conversations. ${INSIGHTS_KEY_NOTE}`,
    input: z.object({
      days: z.union([z.literal(7), z.literal(30)]).default(7).describe("The window: 7 or 30 days"),
      status: z.enum(["open", "fixed", "muted", "all"]).default("open").describe("Which findings"),
    }),
    async run({ days, status }, reads) {
      const { body } = await listInsights("list_insights", reads.flow("production"), { days, status });
      const n = ((body.findings as unknown[] | undefined) ?? []).length;
      return { data: body, summary: `${n} ${status === "all" ? "" : `${status} `}finding${n === 1 ? "" : "s"} over ${days} days${typeof body.state === "string" ? ` (state: ${body.state})` : ""}.${textNote(body.text_mode)} Read one: insight_conversations.` };
    },
  }),
  tool({
    name: "insight_conversations",
    title: "Insight conversations",
    description: `One Insights finding's conversations in the window: conversation id, time, why it was flagged, the person's words when the account shows them, and the window: the 3 messages before the flagged one and 2 after. Use it after list_insights to see the cases behind a finding, then show_conversation with an id (and environment production) for the whole conversation. ${INSIGHTS_KEY_NOTE}`,
    input: z.object({
      finding: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).describe("A finding id from list_insights"),
      days: z.union([z.literal(7), z.literal(30)]).default(7).describe("The window: 7 or 30 days"),
    }),
    async run({ finding, days }, reads) {
      const { body } = await insightConversations("insight_conversations", reads.flow("production"), finding, days);
      const n = Array.isArray(body.data) ? body.data.length : 0;
      return { data: body, summary: `Finding ${finding}: ${n} conversation${n === 1 ? "" : "s"} over ${days} days.${textNote(body.text_mode)} Read one: show_conversation.` };
    },
  }),
  tool({
    name: "list_templates",
    title: "List WhatsApp templates",
    description: `The project's WhatsApp templates on Flow's dashboard as Meta approved them: name, language, category, status, body, buttons and the order a send gives its values in. Use it before declaring templates in createAgent, to copy them exactly. ${FLOW_KEY_NOTE}`,
    input: z.object({ status: z.enum(["approved", "all"]).default("approved").describe("approved only, or every status (pending, rejected, ...)") }),
    async run({ status }, reads) {
      const { body } = await get("list_templates", reads.flow(), "/v1/agent/templates");
      const templates = ((body.templates as Array<{ status?: string }> | undefined) ?? []).filter((t) => status === "all" || t.status === "approved");
      return { data: { ...body, templates }, summary: `${templates.length} ${status === "all" ? "" : "approved "}template${templates.length === 1 ? "" : "s"}.` };
    },
  }),
  tool({
    name: "read_logs",
    title: "Read logs",
    description: "The hosted agent's log lines, oldest first: { time, severity, text }. Use it for why something errored or what the service did around a time: severity ERROR shows the failures, grep narrows to a tool, an id or a message. When more lines match than limit, the newest are kept and truncated is true: narrow since, severity or grep. Reads with the CI key, FLOW_FRAMEWORK_CLOUD_KEY (oci_...), staging and production.",
    input: z.object({
      environment: ENVIRONMENT.default("staging").describe("staging or production"),
      since: z.string().default("1h").describe(`How far back, at most 30 days: ${WHEN}`),
      until: z.string().optional().describe(`Up to when: ${WHEN}`),
      severity: z.enum(SEVERITIES).optional().describe("Only lines at this severity or above"),
      grep: z.string().min(1).max(200).optional().describe("Only lines that hold this text (any case)"),
      limit: z.number().int().min(1).max(1000).default(200).describe("At most this many lines, the newest"),
    }),
    async run(input, reads) {
      const since = sinceTime(input.since);
      if (!since || Date.now() - Date.parse(since) > 30 * 86400_000) throw new Failed(`since is ${WHEN}, at most 30 days back (got "${input.since}").`, "usage");
      const until = input.until === undefined ? undefined : sinceTime(input.until);
      if (input.until !== undefined && (!until || Date.parse(until) <= Date.parse(since))) throw new Failed(`until is ${WHEN}, after since (got "${input.until}").`, "usage");
      const query: LogsQuery = { environment: input.environment, since, ...(until ? { until } : {}), ...(input.severity ? { severity: input.severity } : {}), ...(input.grep ? { grep: input.grep } : {}) };
      const { api } = reads.ci();
      let lines: Array<{ time: string; severity?: string; text: string }> = [];
      let from: string | null = null;
      // Pages of 1000 up to now, as flow logs reads them; at most 10, keeping the newest.
      for (let pages = 0; pages < 10; pages++) {
        const page = await logsPage(api, query);
        if (pages === 0) from = page.from;
        lines = [...lines, ...page.lines].slice(-input.limit - 1);
        if (!page.next || !page.full) break;
        query.after = page.next;
      }
      const truncated = lines.length > input.limit;
      const kept = lines.slice(-input.limit).map((l) => ({ time: l.time, severity: l.severity ?? null, text: l.text }));
      const errors = kept.filter((l) => ["ERROR", "CRITICAL", "ALERT", "EMERGENCY"].includes(String(l.severity).toUpperCase())).length;
      return {
        data: { environment: input.environment, since, until: until ?? null, lines: kept, truncated, logs_start: from },
        summary: `${kept.length} log line${kept.length === 1 ? "" : "s"} from ${input.environment}${truncated ? " (truncated: the newest kept; narrow since, severity or grep)" : ""}, ${errors} at ERROR or above.${from && Date.parse(from) - Date.parse(since) > 60_000 ? ` Logs start at ${from}.` : ""}`,
      };
    },
  }),
  tool({
    name: "deploy_status",
    title: "Deploy status",
    description: "What is live on Flow's hosting per environment: the deploy (id, status, version, when, framework, lint findings, error), a newer one still on its way, the agent's URL, and whether its traces reach Flow. Use it to answer what is live, or whether a deploy finished. Reads with the CI key, FLOW_FRAMEWORK_CLOUD_KEY (oci_...), staging and production.",
    input: z.object({ environment: ENVIRONMENT.optional().describe("One environment (default: both)") }),
    async run({ environment }, reads) {
      const { api } = reads.ci();
      const { environments, framework } = await deployStatus({ api, dir: reads.dir }, environment ? [environment] : ["staging", "production"]);
      const said = environments.map((e) => `${e.environment}: ${e.deploy ? `${e.deploy.status}${e.deploy.version ? ` ${e.deploy.version}` : ""}` : "no deploy known"}${e.pending ? ` (then ${e.pending.status})` : ""}`);
      return { data: { framework, environments: Object.fromEntries(environments.map((e) => [e.environment, e])) }, summary: `${said.join("; ")}.` };
    },
  }),
];

/** The descriptors tools/list sends: JSON Schemas as the framework's MCP server makes them, every tool read-only. */
export function descriptors() {
  return TOOLS.map((t) => {
    const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(t.input, { target: "draft-2020-12", unrepresentable: "throw", io: "input" }) as Record<string, unknown>;
    return {
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: inputSchema as { type: "object" },
      annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    };
  });
}

/** A failure as --json's document says it: code, message, hint and what to do next. */
function failure(code: string, message: string, hint?: string, next?: string): CallToolResult {
  const document = { ok: false, error: { code, message, ...(hint ? { hint } : {}) }, next: next ?? null };
  return { isError: true, structuredContent: document, content: [{ type: "text", text: `${message}${next ? `\nNext: ${next}` : ""}\n${JSON.stringify(document)}` }] };
}

/** Runs one tool; every way it can fail is a tool error the coding agent can act on. */
async function call(t: ServeTool, input: unknown, reads: Reads): Promise<CallToolResult> {
  try {
    const { data, summary } = await t.run(input as never, reads);
    return { structuredContent: data, content: [{ type: "text", text: `${summary}\n${JSON.stringify(data)}` }] };
  } catch (error) {
    // The key story is the CLI's; here a flag is an argument.
    if (error instanceof Failed) return failure(error.code, error.message.replace("add --env staging", 'call it with environment "staging"'), error.hint, error.next);
    if (error instanceof Refused) return failure(error.code, `Refused: ${error.message}`, undefined, error.next);
    if (error instanceof NotAvailable) return failure("not_available", error.message);
    if (error instanceof NetworkError) return failure("network", `Could not reach the cloud: ${error.message}.`);
    return failure("internal", `${t.name} failed: ${(error as Error).message}`);
  }
}

/** The keys and the cloud as found now: the environment the server started with, then the folder's .env. */
function readsIn(dir: string, env: NodeJS.ProcessEnv, cloud: string | undefined): Reads {
  const found = () => cloudOf(dir, env, cloud);
  return {
    dir,
    flow(environment) {
      const { cloud: address, dotEnv } = found();
      const keys = readKey(environment, (name) => {
        const fromEnvironment = env[name]?.trim();
        const value = fromEnvironment || dotEnv.get(name)?.trim();
        return value ? { value, where: fromEnvironment ? "the environment" : join(dir, ".env") } : undefined;
      });
      if (!keys) throw noKey("This tool", environment);
      return { cloud: address, ...keys };
    },
    ci() {
      const now = found();
      if (!now.key) throw new Failed("This tool reads with the agent's CI key: set FLOW_FRAMEWORK_CLOUD_KEY (oci_...) in the agent's .env (flow setup writes it there).", "no_ci_key", undefined, `${RUN} setup`);
      return now as ReturnType<typeof cloudOf> & { key: FoundKey };
    },
  };
}

/** The MCP server for one connection, on the low-level Server as mcp/src/server.ts makes it. */
export function serveServer(reads: Reads, version: string): Server {
  const server = new Server({ name: "flow", version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const listed = descriptors();
  server.setRequestHandler("tools/list", async () => ({ tools: listed }));
  server.setRequestHandler("tools/call", async (request) => {
    const t = TOOLS.find((x) => x.name === request.params.name);
    if (!t) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No tool named ${request.params.name}.`);
    const parsed = t.input.safeParse(request.params.arguments ?? {});
    if (!parsed.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid arguments for ${t.name}: ${parsed.error.message}`);
    return call(t, parsed.data, reads);
  });
  return server;
}

/** `flow mcp serve`: serves until the host closes stdin; resolves to the exit status. */
export async function mcpServeCli(args: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ args, strict: true, options: { dir: { type: "string", default: "." }, cloud: { type: "string" }, help: { type: "boolean", short: "h" } } }));
  } catch (error) {
    console.error(`flow mcp serve: ${(error as Error).message}\n\n${MCP_SERVE_USAGE}`);
    return 2;
  }
  if (values.help) return console.log(MCP_SERVE_USAGE), 0;
  const dir = resolve(values.dir!);
  const reads = readsIn(dir, { ...process.env }, values.cloud);
  const version = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")).version as string;
  const closed = new Promise<void>((done) => process.stdin.once("close", done).once("end", done));
  const handle = serveStdio(() => serveServer(reads, version), { onerror: (error) => console.error(`flow mcp serve: ${error.message}`) });
  await closed;
  await handle.close();
  return 0;
}
