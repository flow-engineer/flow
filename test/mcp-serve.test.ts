// covers: testing/src/mcp-serve.ts testing/src/flow-tools.ts testing/src/cli.ts testing/src/deploy.ts testing/src/conversations.ts
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { hostLogs, type HostLogLine } from "./helpers.ts";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ToolError } from "../src/tools.ts";
import { mcpServer } from "../mcp/src/server.ts";
import { flowReadTools, type FlowAgent, type FlowAgentAccess } from "../testing/src/flow-tools.ts";

const cli = fileURLToPath(new URL("../testing/src/cli.ts", import.meta.url));
const KEY = "flow_test_k1_secretvalue";

/** A fake Flow cloud answering `answer` to every request; the requests it got. */
async function fakeCloud(answer: (req: IncomingMessage) => { status: number; body: unknown }) {
  const seen: Array<{ url: string; authorization: string | undefined }> = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url!, authorization: req.headers.authorization });
    const { status, body } = answer(req);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise((done) => server.close(done)) };
}

/** `flow mcp serve` in an agent folder whose .env points at the cloud (and has `more` lines), with a connected client. */
async function serve(cloud: string, more = "") {
  const dir = mkdtempSync(join(tmpdir(), "flow-mcp-serve-"));
  writeFileSync(join(dir, ".env"), `FLOW_KEY=${KEY}\nFLOW_FRAMEWORK_CLOUD_KEY=oci_ci_secretvalue\nFLOW_FRAMEWORK_CLOUD=${cloud}\n${more}`);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !/^(FLOW_|CHINWAG_)/.test(name)) env[name] = value;
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "serve"], cwd: dir, env, stderr: "ignore" }));
  return client;
}

test("flow mcp serve lists its tools, every one read-only, and says what it is for", async () => {
  const client = await serve("http://127.0.0.1:9");
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["list_conversations", "show_conversation", "list_issues", "list_insights", "insight_conversations", "list_templates", "connect_whatsapp", "read_logs", "deploy_status"]);
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);
    assert.deepEqual((tools.find((t) => t.name === "list_issues")!.inputSchema.properties as Record<string, { enum?: string[]; default?: string }>).status, { type: "string", enum: ["open", "resolved", "ignored", "all"], default: "open", description: "Which issues" });
    assert.match(client.getInstructions() ?? "", /Did a tool call fail, or was a reply delivered\?.*show_conversation/);
  } finally {
    await client.close();
  }
});

test("the instructions and every Flow-key tool's description say the live key's three tiers in flow.engineer's words", async () => {
  const tiers = [
    "Fine by default, granted at once: de-identified reads, Insights, tests, traces, the model.",
    "Only when the user asked for it: raw message text (npx @flow-engineer/flow keys grant content).",
    "Only with the user's explicit yes: messaging customers and deploying live (npx @flow-engineer/flow keys grant send | deploy); the owner confirms once in the browser.",
  ];
  const client = await serve("http://127.0.0.1:9");
  try {
    const { tools } = await client.listTools();
    // connect_whatsapp reads with any Flow key and says nothing of the tiers.
    const flowKeyTools = tools.filter((t) => !/^(read_logs|deploy_status|connect_whatsapp)$/.test(t.name));
    assert.equal(flowKeyTools.length, 6);
    for (const text of [client.getInstructions() ?? "", ...flowKeyTools.map((t) => t.description!)]) {
      for (const tier of tiers) assert.ok(text.includes(tier), `${text.slice(0, 40)}: ${tier}`);
    }
  } finally {
    await client.close();
  }
});

test("list_conversations reads the cloud with FLOW_KEY and returns the conversations as structured data", async () => {
  const conversation = { id: "cnv_1", environment: "staging", channel: "whatsapp", contact: "Contact 0100", messages: 4, grades: { good: 1, unhelpful: 0, wrong: 2, not_graded: 1 } };
  const cloud = await fakeCloud(() => ({ status: 200, body: { conversations: [conversation], next_cursor: null } }));
  const client = await serve(cloud.url);
  try {
    const result = await client.callTool({ name: "list_conversations", arguments: { environment: "staging", grade: "wrong" } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { conversations: [conversation], next_cursor: null });
    assert.match((result.content as Array<{ text: string }>)[0]!.text, /^1 conversation, 2 replies graded wrong\./);
    assert.deepEqual(cloud.seen, [{ url: "/v1/agent/conversations?environment=staging&grade=wrong&limit=20", authorization: `Bearer ${KEY}` }]);
  } finally {
    await client.close();
    await cloud.close();
  }
});

test("connect_whatsapp gives the link a person opens in Meta's window until the number is connected, then the number; a dashboard without the route says so", async () => {
  const link = "https://flow.engineer/dashboard/projects/agt_1/connections/platform/whatsapp#own-number";
  const answers = [
    { status: 200, body: { connected: false, needs_person: true, link } },
    { status: 200, body: { connected: true, needs_person: false, link, phone: "+447700900142", name: "Larkspur Bakery", state: "live", onboarding: "new", display_name: "not_reviewed", payment_method: "missing", templates: 0 } },
    { status: 404, body: {} },
  ];
  const cloud = await fakeCloud(() => answers.shift()!);
  const client = await serve(cloud.url);
  try {
    const waiting = await client.callTool({ name: "connect_whatsapp", arguments: {} });
    assert.deepEqual(waiting.structuredContent, { needs_person: true, link, next: "Ask the owner to open the link; call again to see the number" });
    const connected = await client.callTool({ name: "connect_whatsapp", arguments: {} });
    assert.deepEqual(connected.structuredContent, { phone: "+447700900142", name: "Larkspur Bakery", state: "live", display_name: "not_reviewed", payment_method: "missing", templates: 0 });
    assert.match((connected.content as Array<{ text: string }>)[0]!.text, /^WhatsApp: \+447700900142 · Larkspur Bakery · live\./);
    const older = await client.callTool({ name: "connect_whatsapp", arguments: {} });
    assert.equal(older.isError, true);
    assert.equal((older.structuredContent as { error: { code: string } }).error.code, "not_available");
    assert.deepEqual(cloud.seen.map((r) => [r.url, r.authorization]), Array(3).fill(["/v1/agent/whatsapp", `Bearer ${KEY}`]));
  } finally {
    await client.close();
    await cloud.close();
  }
});

test("read_logs follows the cursor until it stops moving and keeps the newest lines under its limit", async () => {
  const line = (n: number) => ({ time: `2026-11-04T09:00:0${n}Z`, severity: "INFO", text: `line ${n}` });
  // Page 1 (no after), page 2 (after c1), then the host answers its last cursor again: the end.
  const pages: Record<string, { lines: unknown[]; next: string | null }> = { "": { lines: [line(1), line(2)], next: "c1" }, c1: { lines: [line(3), line(4)], next: "c2" }, c2: { lines: [line(4)], next: "c2" } };
  // As observe's logs route: a limit outside 1 to 500 is refused (0.16.0's release candidate asked for 1000).
  const cloud = await fakeCloud((req) => {
    const asked = new URL(req.url!, "http://x").searchParams;
    const limit = Number(asked.get("limit") ?? 500);
    if (!(limit >= 1 && limit <= 500)) return { status: 400, body: { error: { code: "invalid_request", message: "limit must be 1 to 500" } } };
    return { status: 200, body: pages[asked.get("after") ?? ""] };
  });
  const client = await serve(cloud.url);
  try {
    const result = await client.callTool({ name: "read_logs", arguments: { limit: 3 } });
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    const data = result.structuredContent as { lines: Array<{ text: string }>; truncated: boolean };
    assert.deepEqual(data.lines.map((l) => l.text), ["line 2", "line 3", "line 4"]);
    assert.equal(data.truncated, true);
    assert.equal(cloud.seen.length, 3);
  } finally {
    await client.close();
    await cloud.close();
  }
});

// 0.16.0's release candidate refused since "30d" (its own clock moved between two reads of it) and every until (a later page sent no since).
test("read_logs takes flow logs' window, since 30d and a relative until across pages, and joins a split stack", async () => {
  const start = Date.now() - 29 * 86_400_000;
  const lines: HostLogLine[] = Array.from({ length: 600 }, (_, i) => ({ time: new Date(start + i * 60_000).toISOString(), severity: "INFO", text: `line ${i}` }));
  const at = new Date(start + 600 * 60_000).toISOString();
  // As Cloud Run stamps a split stack's lines: microseconds apart, no severity, no instance from an older host.
  const later = at.replace(/Z$/, "").padEnd(23, "0") + "026Z";
  lines.push({ time: at.replace(/Z$/, "001Z"), severity: "DEFAULT", text: "Error: boom" }, { time: later, severity: "DEFAULT", text: "    at run (file:///app/a.js:1:2)" });
  const cloud = await fakeCloud((req) => hostLogs(new URL(req.url!, "http://x").searchParams, lines, Date.now()));
  const client = await serve(cloud.url);
  try {
    const result = await client.callTool({ name: "read_logs", arguments: { since: "30d", until: "1d", limit: 1000 } });
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    const data = result.structuredContent as { lines: Array<{ text: string }>; truncated: boolean };
    assert.equal(data.lines.length, 601);
    assert.deepEqual([data.lines[0]!.text, data.lines.at(-1)!.text, data.truncated], ["line 0", "Error: boom\n    at run (file:///app/a.js:1:2)", false]);
    assert.ok(cloud.seen.length >= 2 && cloud.seen.every((s) => /[?&]since=/.test(s.url) && /[?&]until=/.test(s.url)), "since and until on every page");
  } finally {
    await client.close();
    await cloud.close();
  }
});

// A hosted 0.15.x runtime's own errors are plain console text at DEFAULT: read_logs with severity ERROR missed them.
test("read_logs severity ERROR reads a DEFAULT line that is plainly an uncaught error as ERROR and asks the host for every line", async () => {
  const start = Date.now() - 30 * 60_000;
  const at = (minute: number) => new Date(start + minute * 60_000).toISOString();
  const lines: HostLogLine[] = [
    { time: at(1), severity: "INFO", text: "booted" },
    { time: at(2), severity: "DEFAULT", text: "flow: scheduled messages: Error: flow-agent-store: unfinished: HTTP 503" },
    { time: at(3), severity: "DEFAULT", text: "listening on 8080" },
    { time: at(4), severity: "DEFAULT", text: "AbortError: This operation was aborted" },
    { time: at(5), severity: "ERROR", text: "tool book failed" },
  ];
  const cloud = await fakeCloud((req) => hostLogs(new URL(req.url!, "http://x").searchParams, lines, Date.now()));
  const client = await serve(cloud.url);
  try {
    const result = await client.callTool({ name: "read_logs", arguments: { severity: "ERROR" } });
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    const data = result.structuredContent as { lines: Array<{ severity: string; text: string }> };
    assert.deepEqual(data.lines.map((l) => [l.severity, l.text]), [
      ["ERROR", "flow: scheduled messages: Error: flow-agent-store: unfinished: HTTP 503"],
      ["ERROR", "AbortError: This operation was aborted"],
      ["ERROR", "tool book failed"],
    ]);
    assert.match((result.content as Array<{ text: string }>)[0]!.text, /^3 log lines from staging, 3 at ERROR or above\./);
    assert.ok(cloud.seen.every((s) => !/[?&]severity=/.test(s.url)), "no severity sent: the host would leave DEFAULT out");
  } finally {
    await client.close();
    await cloud.close();
  }
});

test("a refused key is a tool error naming the key it read, never its value, and how to get the right one", async () => {
  const cloud = await fakeCloud(() => ({ status: 401, body: { error: { code: "bad_key", message: "This key is not valid." } } }));
  const client = await serve(cloud.url);
  try {
    const result = await client.callTool({ name: "list_issues", arguments: {} });
    assert.equal(result.isError, true);
    const { error } = result.structuredContent as { error: { code: string; message: string } };
    assert.equal(error.code, "bad_key");
    assert.match(error.message, /It found FLOW_KEY=flow_test_…alue in .*\.env\..*\nGet the right one: npx @flow-engineer\/flow setup/s);
    assert.doesNotMatch(JSON.stringify(result), /secretvalue/);
  } finally {
    await client.close();
    await cloud.close();
  }
});

test("production tools read with FLOW_LIVE_KEY when .env has it, staging ones with FLOW_KEY, and each result keeps the text mode Flow sent", async () => {
  const live = "flow_live_FAKElive00_0000FAKE0000live0000R3ad";
  const cloud = await fakeCloud((req) => ({ status: 200, body: req.url!.startsWith("/v1/agent/insights") ? { state: "on", findings: [], text_mode: "deidentified" } : { conversations: [], next_cursor: null, text_mode: "deidentified" } }));
  const client = await serve(cloud.url, `FLOW_LIVE_KEY=${live}\n`);
  try {
    const insights = await client.callTool({ name: "list_insights", arguments: {} });
    assert.equal((insights.structuredContent as { text_mode?: string }).text_mode, "deidentified");
    assert.match((insights.content as Array<{ text: string }>)[0]!.text, /Text: de-identified/);
    await client.callTool({ name: "list_conversations", arguments: { environment: "production" } });
    await client.callTool({ name: "list_conversations", arguments: { environment: "staging" } });
    assert.deepEqual(cloud.seen.map((s) => s.authorization), [`Bearer ${live}`, `Bearer ${live}`, `Bearer ${KEY}`]);
    const { tools } = await client.listTools();
    assert.match(tools.find((t) => t.name === "list_insights")!.description!, /flow setup --live/);
  } finally {
    await client.close();
    await cloud.close();
  }
});

const CONNECTION_KEY = "flow_live_conn01_connectionsecret";
const SHOP: FlowAgent = { flow_agent_id: "agt_1", name: "shop", workspace_id: "acc_1" };
const CAFE: FlowAgent = { flow_agent_id: "agt_2", name: "cafe", workspace_id: "acc_1" };

/** A person's agents and keys as the hosted project's credentials give them; cafe's key is refused as flow-mono refuses one. */
function scriptedAccess(agents: FlowAgent[], asked: string[] = []): FlowAgentAccess {
  return {
    agents: async () => agents,
    async key(agent) {
      asked.push(agent);
      const found = agents.find((a) => a.flow_agent_id === agent || a.name === agent);
      if (!found) throw new ToolError("not_found", `You have no agent ${agent}.`, { next: "list_agents" });
      if (found.name === "cafe") throw new ToolError("owner_only", "Only cafe's workspace owner can read it.", { hint: "Ask the owner to read it.", next: "list_agents" });
      return { value: CONNECTION_KEY, flow_agent_id: found.flow_agent_id, name: found.name };
    },
  };
}

test("hosted, every tool reads the agent the call names (or the person's only one) with the key the server's credentials give for it, and list_agents lists them", async () => {
  const cloud = await fakeCloud(() => ({ status: 200, body: { issues: [{ id: "iss_1", status: "open" }] } }));
  const asked: string[] = [];
  const { tools, instructions } = flowReadTools({ hosted: { cloud: cloud.url } });
  const handle = mcpServer({ name: "flow", version: "1", tools, instructions, feedback: false, traces: false, credentials: (name) => (name === "flow" ? scriptedAccess([SHOP, CAFE], asked) : undefined) });
  const server = createServer((req, res) => void handle.node(req, res));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));
    const listed = (await client.listTools()).tools;
    // The CLI's own reads stay the CLI's: a host sees list_agents and the nine.
    assert.deepEqual(listed.map((t) => t.name), ["list_agents", "list_conversations", "show_conversation", "list_issues", "list_insights", "insight_conversations", "list_templates", "connect_whatsapp", "read_logs", "deploy_status"]);
    assert.ok(listed.slice(1).every((t) => "agent" in (t.inputSchema.properties as object)), "every read takes agent");
    assert.doesNotMatch(JSON.stringify(listed), /FLOW_KEY|\.env/);
    assert.deepEqual((await client.callTool({ name: "list_agents", arguments: {} })).structuredContent, { agents: [SHOP, CAFE] });
    const unnamed = await client.callTool({ name: "list_issues", arguments: {} });
    assert.equal(unnamed.isError, true);
    assert.deepEqual(unnamed.structuredContent, { ok: false, error: { code: "agent_required", message: "You have 2 Flow agents: name one with agent (shop, cafe)." }, next: "list_agents" });
    const read = await client.callTool({ name: "list_issues", arguments: { agent: "shop" } });
    assert.equal(read.isError, undefined, JSON.stringify(read.structuredContent));
    assert.deepEqual(read.structuredContent, { issues: [{ id: "iss_1", status: "open" }] });
    assert.deepEqual(cloud.seen, [{ url: "/v1/agent/issues?status=open", authorization: `Bearer ${CONNECTION_KEY}` }]);
    const refused = await client.callTool({ name: "deploy_status", arguments: { agent: "cafe" } });
    assert.deepEqual(refused.structuredContent, { ok: false, error: { code: "owner_only", message: "Only cafe's workspace owner can read it.", hint: "Ask the owner to read it." }, next: "list_agents" });
    assert.deepEqual(asked, ["shop", "cafe"]);
    assert.doesNotMatch(JSON.stringify([unnamed, read, refused]), /connectionsecret/);
  } finally {
    await client.close();
    await new Promise((done) => server.close(done));
    await cloud.close();
  }
});

/** The flow command, with only `env` set beyond the PATH: its exit status and output. */
function flow(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH!, HOME: mkdtempSync(join(tmpdir(), "flow-mcp-home-")), ...env } }, (error, stdout, stderr) => done({ code: error ? (error as { code?: number }).code ?? 1 : 0, stdout, stderr }));
  });
}

test("the read commands with --server read over a hosted Flow MCP as the person signed in, through the CLI's own tools, and say its refusals as their own", async () => {
  const conversation = { id: "cnv_1", environment: "staging", channel: "whatsapp", contact: "Contact 0100", messages: 2 };
  const cloud = await fakeCloud(() => ({ status: 200, body: { conversations: [conversation], next_cursor: null } }));
  const { tools, instructions } = flowReadTools({ hosted: { cloud: cloud.url } });
  // As the OAuth bridge says it: the token's person, their credentials, and the CLI as the client (which sees the CLI's own tools).
  const people: Record<string, FlowAgent[]> = { one: [SHOP], two: [SHOP, CAFE] };
  const handle = mcpServer({
    name: "flow", version: "1", tools, instructions, feedback: false, traces: false,
    auth: { issuer: "https://issuer.invalid", verify: (token) => (people[token] ? { key: `person-${token}`, client: { id: "flow-cli", kind: "cli" }, credentials: (name) => (name === "flow" ? scriptedAccess(people[token]!) : undefined) } : null) },
  });
  const server = createServer((req, res) => void handle.node(req, res));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  try {
    const listedJson = await flow(["conversations", "--json"], { FLOW_MCP_SERVER: url, FLOW_MCP_TOKEN: "one" });
    assert.equal(listedJson.code, 0, listedJson.stderr);
    assert.deepEqual(JSON.parse(listedJson.stdout), { conversations: [conversation], next_cursor: null });
    assert.deepEqual(cloud.seen, [{ url: "/v1/agent/conversations?limit=20", authorization: `Bearer ${CONNECTION_KEY}` }]);
    const unnamed = await flow(["deploy", "status", "--server", url, "--json"], { FLOW_MCP_TOKEN: "two" });
    assert.equal(unnamed.code, 1);
    assert.deepEqual(JSON.parse(unnamed.stdout), { ok: false, error: { code: "agent_required", message: "You have 2 Flow agents: name one with agent (shop, cafe)." }, next: "list_agents" });
    const refused = await flow(["issues", "--server", url, "--agent", "cafe"], { FLOW_MCP_TOKEN: "two" });
    assert.deepEqual([refused.code, refused.stdout, refused.stderr], [1, "", "Only cafe's workspace owner can read it.\n"]);
    const signedOut = await flow(["templates", "--server", url, "--json"], { FLOW_MCP_TOKEN: "nobody" });
    assert.equal(signedOut.code, 1);
    assert.equal(JSON.parse(signedOut.stdout).error.code, "signed_out");
    assert.match(signedOut.stderr, /flow mcp login/);
    const mixed = await flow(["insights", "--server", url, "--cloud", cloud.url], {});
    assert.deepEqual([mixed.code, mixed.stderr.split("\n")[0]], [2, "--server reads as you, signed in with flow mcp login, not with this folder's keys: --cloud and --dotenv do not go with it."]);
    assert.equal(cloud.seen.length, 1);
  } finally {
    await new Promise((done) => server.close(done));
    await cloud.close();
  }
});
