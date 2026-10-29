// covers: src/traces.ts src/agent.ts src/conversation.ts src/schedules.ts src/store.ts mcp/src/server.ts mcp/src/terminal.ts flow-messaging/src/index.ts
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent, customUI, sqlite, tool, z, type Agent, type AgentOptions, type Channel, type NudgeInput, type Outbound } from "../src/index.ts";
import { NUDGE_TRIGGER } from "../src/business-events/engine.ts";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { flowMessaging } from "../flow-messaging/src/index.ts";
import { mcpServer } from "../mcp/src/index.ts";
import { terminalServer } from "../mcp/src/terminal.ts";
import { agentVersion, traces, tracesFromEnv } from "../src/traces.ts";
import { SMS, call, gate, respond, scriptedModel } from "./helpers.ts";

const KEY = "trace_key_do-not-log-me";

/** A traces endpoint, played: each request is kept, and `next(n)` waits for the n-th. */
async function fakeEndpoint(status = 200) {
  const requests: Array<{ headers: IncomingMessage["headers"]; body: any; path: string }> = [];
  const waiters: Array<() => void> = [];
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: JSON.parse(text), path: req.url ?? "" });
      res.writeHead(status, { "content-type": "application/json" }).end("{}");
      waiters.splice(0).forEach((w) => w());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  async function next(n: number) {
    while (requests.length < n) await new Promise<void>((r) => waiters.push(r));
    return requests[n - 1];
  }
  return { url: `http://127.0.0.1:${port}`, requests, next, close: () => server.close() };
}

/** An SMS agent with one tool (or on `channels`, whose sends are kept, not made), tracing to `url`. */
function agentFor(url: string, content: boolean, intercept?: AgentOptions["intercept"], channels?: Channel[], version: string | null = "v7") {
  const dir = mkdtempSync(join(tmpdir(), "flow-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  const sent: string[] = [];
  const send = (_: string, o: Outbound) => void (o.type === "message" && sent.push(o.text));
  const sms: Channel = { name: "sms", kind: "sms", info: SMS, phone: true, send };
  const lookup = tool({ name: "lookup", description: "Finds a slot.", input: z.object({ day: z.string() }), run: async ({ day }) => `free on ${day}` });
  const agent = createAgent({ dir, model: scripted.model, tools: [lookup], channels: channels?.map((c) => ({ ...c, send })) ?? [sms], debounceMs: 0, scheduleCheckMs: 0, id: "cafe", traces: { url, key: KEY, content, version: version ?? undefined }, intercept, testPeople: [{ name: "Maria", phone: "+15550100123" }] });
  return { agent, sent, ...scripted };
}

/** One turn: the person asks, the agent acknowledges and looks it up, then answers. */
async function playTurn(h: ReturnType<typeof agentFor>, from: string, offset = 0) {
  await h.agent.message({ channel: "sms", from, message: "Can I move my check-in to Thursday?", messageId: `SM-${offset}` });
  (await h.nextCall(offset)).answer(respond(call("send_sms", { text: "One sec" }), call("lookup", { day: "thursday" })));
  (await h.nextCall(offset + 1)).answer(respond(call("send_sms", { text: "Done: Thursday at 10:00." })));
}

const attrs = (span: any) => Object.fromEntries(span.attributes.map((a: any) => [a.key, Object.values(a.value)[0]]));

/** Every trace the endpoint got, in the order they came: its spans, its root and the root's attributes. */
function tracesOf(endpoint: { requests: Array<{ body: any }> }) {
  const byId = new Map<string, any[]>();
  for (const request of endpoint.requests) for (const span of request.body.resourceSpans[0].scopeSpans[0].spans) byId.set(span.traceId, [...(byId.get(span.traceId) ?? []), span]);
  return [...byId.values()].map((spans) => {
    const root = spans.find((s: any) => !s.parentSpanId);
    return { spans, root, attrs: attrs(root), replies: spans.flatMap((s: any) => attrs(s)["chinwag.agent_reply"] ?? []) };
  });
}

const BUYER = "+15550100123";
const SELLER = "+15550100124";

/**
 * A marketplace agent tracing to `url`: its tool `answer_buyer`, called in the seller's
 * conversation, queues the seller's answer for the buyer as written (`at` when given).
 */
function marketplace(url: string, options: { database?: AgentOptions["database"]; now?: () => number; at?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "flow-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  const sent: string[] = [];
  const waiters: Array<() => void> = [];
  const sms: Channel = { name: "sms", kind: "sms", info: SMS, phone: true, send: (_: string, o: Outbound) => void (o.type === "message" && sent.push(o.text), waiters.splice(0).forEach((w) => w())) };
  let agent!: Agent;
  const answer = tool({
    name: "answer_buyer",
    description: "Passes the seller's answer on to the buyer.",
    input: z.object({ text: z.string() }),
    run: async ({ text }) => (await agent.recordNudge({ to: { channel: "sms", address: BUYER }, text: `The seller answered your question: ${text}`, ...(options.at ? { at: options.at } : {}) })).status,
  });
  agent = createAgent({ dir, model: scripted.model, tools: [answer], channels: [sms], debounceMs: 0, scheduleCheckMs: 0, id: "market", traces: { url, key: KEY, content: true, version: "v7" }, ...(options.database ? { database: options.database } : {}), ...(options.now ? { now: options.now } : {}) });
  async function sentText(text: string) {
    while (!sent.includes(text)) await new Promise<void>((r) => waiters.push(r));
  }
  return { agent, sent, sentText, ...scripted };
}

/** The buyer asks, then the seller answers and the agent passes it on with answer_buyer: their conversations' ids. */
async function sellerAnswers(h: ReturnType<typeof marketplace>, from = 0) {
  const buyer = (await h.agent.message({ channel: "sms", from: BUYER, message: "Does it ship Monday?", messageId: `SM-${from}` }))!;
  (await h.nextCall(from)).answer(respond(call("send_sms", { text: "I'll ask the seller." })));
  await h.agent.conversation(buyer.conversationId)!.whenIdle();
  const seller = (await h.agent.message({ channel: "sms", from: SELLER, message: "Yes, Monday.", messageId: `SM-${from + 1}` }))!;
  (await h.nextCall(from + 1)).answer(respond(call("send_sms", { text: "Thanks!" }), call("answer_buyer", { text: "yes, it ships Monday." })));
  (await h.nextCall(from + 2)).answer(respond(call("send_sms", { text: "Thanks, I told them." })));
  await h.agent.conversation(seller.conversationId)!.whenIdle();
  return { buyer: buyer.conversationId, seller: seller.conversationId };
}

/** The flow.origin.* attributes of a root, and what a trace that queued from `tool` in `conversation` should say. */
const originOf = (a: Record<string, unknown>) => Object.fromEntries(Object.entries(a).filter(([k]) => k.startsWith("flow.origin.")));
const queuedFrom = (tool: any, conversation: string) => ({
  "flow.origin.trace_id": tool.traceId,
  "flow.origin.span_id": tool.spanId,
  "flow.origin.conversation_id": conversation,
  "flow.origin.tool_call_id": attrs(tool)["gen_ai.tool.call.id"],
  "flow.origin.tool_name": "answer_buyer",
});
const QUEUED_BY = (tool: any) => [{ traceId: tool.traceId, spanId: tool.spanId, attributes: [{ key: "flow.link.kind", value: { stringValue: "queued_by" } }] }];

test("each turn is one trace: the person's ids and channel, its model calls, tools and replies", async () => {
  const endpoint = await fakeEndpoint();
  // This path assertion also covers long trailing-slash runs without regex backtracking.
  const h = agentFor(endpoint.url + "/".repeat(100_000), true);
  await playTurn(h, "+15550100123");
  const request = await endpoint.next(1);
  endpoint.close();

  assert.equal(request.path, "/v1/traces");
  assert.equal(request.headers.authorization, `Bearer ${KEY}`);
  assert.equal(request.headers["content-type"], "application/json");
  const [resourceSpans] = request.body.resourceSpans;
  assert.deepEqual(attrs(resourceSpans.resource), { "service.name": "cafe", "telemetry.sdk.name": "chinwag", "chinwag.run_kind": "production", "service.version": "v7" });
  const spans = resourceSpans.scopeSpans[0].spans;
  assert.equal(new Set(spans.map((s: any) => s.traceId)).size, 1, "one trace");
  assert.match(spans[0].traceId, /^[0-9a-f]{32}$/);
  const roots = spans.filter((s: any) => !s.parentSpanId);
  assert.equal(roots.length, 1);
  const root = attrs(roots[0]);
  assert.equal(root["gen_ai.operation.name"], "invoke_agent");
  assert.match(String(root["chinwag.conversation_id"]), /^p_/);
  assert.equal(root["chinwag.contact_id"], root["chinwag.conversation_id"]);
  assert.equal(root["chinwag.channel"], "sms");
  assert.equal(root["chinwag.message_id"], "SM-0");
  assert.equal(root["chinwag.user_message"], "Can I move my check-in to Thursday?");
  assert.ok(BigInt(roots[0].endTimeUnixNano) >= BigInt(roots[0].startTimeUnixNano));

  const children = spans.filter((s: any) => s.parentSpanId === roots[0].spanId);
  assert.equal(children.length, spans.length - 1, "every other span hangs off the root");
  const replies = children.filter((s: any) => attrs(s)["chinwag.agent_reply"] !== undefined).map((s: any) => attrs(s)["chinwag.agent_reply"]);
  assert.deepEqual(replies, ["One sec", "Done: Thursday at 10:00."], "the replies exactly as sent");
  const tool = attrs(children.find((s: any) => s.name === "execute_tool lookup"));
  assert.equal(tool["gen_ai.tool.name"], "lookup");
  assert.equal(tool["gen_ai.tool.call.arguments"], '{"day":"thursday"}');
  assert.equal(tool["gen_ai.tool.call.result"], "free on thursday");
  assert.ok(children.filter((s: any) => attrs(s)["gen_ai.operation.name"] === "chat").length >= 2, "a span per model call");
});

test("a message intercept answers, and its reply, are traces of their own, also while a turn is open", async () => {
  const endpoint = await fakeEndpoint();
  const h = agentFor(endpoint.url, true, (_id, text) => (/chest pain/.test(text) ? "Call 911 now." : null));
  const a = await h.agent.message({ channel: "sms", from: "+15550100123", message: "Can I move my check-in?", messageId: "SM-1" });
  const thinking = await h.nextCall(0);
  await h.agent.message({ channel: "sms", from: "+15550100123", message: "chest pain", messageId: "SM-2" });
  thinking.answer(respond(call("send_sms", { text: "Yes, to when?" })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  await h.agent.flushTraces();
  endpoint.close();
  const traces = new Map<string, any[]>();
  for (const request of endpoint.requests) for (const span of request.body.resourceSpans[0].scopeSpans[0].spans) traces.set(span.traceId, [...(traces.get(span.traceId) ?? []), span]);
  const shown = [...traces.values()].map((spans) => {
    const root = attrs(spans.find((s: any) => !s.parentSpanId));
    return [root["chinwag.user_message"] ?? null, spans.flatMap((s: any) => attrs(s)["chinwag.agent_reply"] ?? []), spans.some((s: any) => s.name.startsWith("chat"))];
  });
  assert.deepEqual(shown.sort((a, b) => String(a[0]).localeCompare(String(b[0]))), [
    ["Can I move my check-in?", ["Yes, to when?"], true],
    ["chest pain", [], false],
    [null, ["Call 911 now."], false],
  ]);
});

test("under flow test, every trace says it is a test's and names the test session, so it is kept apart from real conversations", async (t) => {
  process.env.FLOW_FRAMEWORK_RUN_KIND = "test";
  process.env.FLOW_FRAMEWORK_TEST_SESSION = "tse_01JTESTSESSION0000000000000";
  t.after(() => {
    delete process.env.FLOW_FRAMEWORK_RUN_KIND;
    delete process.env.FLOW_FRAMEWORK_TEST_SESSION;
  });
  const endpoint = await fakeEndpoint();
  const h = agentFor(endpoint.url, false);
  await playTurn(h, "+15550100123");
  const request = await endpoint.next(1);
  endpoint.close();
  const [resourceSpans] = request.body.resourceSpans;
  assert.equal(attrs(resourceSpans.resource)["chinwag.run_kind"], "test");
  const root = resourceSpans.scopeSpans[0].spans.find((s: any) => !s.parentSpanId);
  assert.equal(attrs(root)["chinwag.test.session"], "tse_01JTESTSESSION0000000000000");
});

test("without content on, traces hold no text: no messages, replies, tool inputs or results", async () => {
  const endpoint = await fakeEndpoint();
  const h = agentFor(endpoint.url, false);
  await playTurn(h, "+15550100123");
  const request = await endpoint.next(1);
  endpoint.close();
  const all = request.body.resourceSpans[0].scopeSpans[0].spans.flatMap((s: any) => s.attributes.map((a: any) => a.key));
  for (const key of ["chinwag.user_message", "chinwag.agent_reply", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result"]) assert.ok(!all.includes(key), key);
  assert.ok(all.includes("chinwag.conversation_id"));
  assert.doesNotMatch(JSON.stringify(request.body), /Thursday|thursday/);
});

test("the endpoint refusing traces never touches the conversation, is logged once, and never shows the key", async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => void warnings.push(args.map(String).join(" ")));
  const endpoint = await fakeEndpoint(500);
  const h = agentFor(endpoint.url, true);
  await playTurn(h, "+15550100123");
  await endpoint.next(1);
  await h.agent.flushTraces();
  await playTurn(h, "+15550100123", 2);
  await endpoint.next(2);
  await h.agent.flushTraces();
  endpoint.close();
  assert.deepEqual(h.sent, ["One sec", "Done: Thursday at 10:00.", "One sec", "Done: Thursday at 10:00."]);
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /HTTP 500/);
  assert.doesNotMatch(warnings.join(""), /do-not-log-me/);
});

test("from the environment: a trace key goes to flow.engineer/observe unless a URL is set, content only with FLOW_FRAMEWORK_TRACES_CONTENT=1 or under flow test (unless 0), never under node --test; the CHINWAG_ names still work", () => {
  assert.equal(tracesFromEnv({}), undefined);
  assert.deepEqual(tracesFromEnv({ FLOW_FRAMEWORK_TRACES_KEY: KEY }), { key: KEY, url: "https://flow.engineer/observe", content: false });
  assert.deepEqual(tracesFromEnv({ FLOW_FRAMEWORK_TRACES_KEY: KEY, FLOW_FRAMEWORK_TRACES_URL: "  " }), { key: KEY, url: "https://flow.engineer/observe", content: false });
  assert.deepEqual(tracesFromEnv({ FLOW_FRAMEWORK_TRACES_KEY: KEY, FLOW_FRAMEWORK_TRACES_URL: "https://example.test/traces" }), { key: KEY, url: "https://example.test/traces", content: false });
  assert.deepEqual(tracesFromEnv({ FLOW_FRAMEWORK_TRACES_KEY: KEY, FLOW_FRAMEWORK_TRACES_URL: "https://example.test/traces", FLOW_FRAMEWORK_TRACES_CONTENT: "1" }), { key: KEY, url: "https://example.test/traces", content: true });
  assert.equal(tracesFromEnv({ FLOW_FRAMEWORK_TRACES_KEY: KEY, NODE_TEST_CONTEXT: "child-v8" }), undefined);
  assert.equal(tracesFromEnv({ FLOW_FRAMEWORK_TRACES_KEY: KEY, FLOW_FRAMEWORK_RUN_KIND: "test" })?.content, true, "flow test's files are synthetic");
  assert.equal(tracesFromEnv({ FLOW_FRAMEWORK_TRACES_KEY: KEY, FLOW_FRAMEWORK_RUN_KIND: "test", FLOW_FRAMEWORK_TRACES_CONTENT: "0" })?.content, false);
  assert.equal(tracesFromEnv({ FLOW_FRAMEWORK_TRACES_KEY: KEY, FLOW_FRAMEWORK_RUN_KIND: "production" })?.content, false);
  assert.deepEqual(tracesFromEnv({ CHINWAG_TRACES_KEY: KEY, CHINWAG_TRACES_URL: "https://example.test/traces", CHINWAG_TRACES_CONTENT: "1" }), { key: KEY, url: "https://example.test/traces", content: true });
  assert.deepEqual(tracesFromEnv({ FLOW_FRAMEWORK_TRACES_KEY: KEY, CHINWAG_TRACES_KEY: "old", CHINWAG_TRACES_URL: "https://example.test/old" }), { key: KEY, url: "https://example.test/old", content: false });
});

// Turn trace tests never exercise standalone calls, which have no conversation to attach to.
test("standalone calls export one trace each with host metadata and content only when enabled, and feedback always", async (t) => {
  for (const content of [false, true]) {
    const endpoint = await fakeEndpoint();
    t.after(endpoint.close);
    let key = "";
    const lookup = tool({ name: "lookup", description: "Look up.", input: z.object({ secret: z.string() }), output: z.object({ result: z.string() }), signIn: "none", run: (input, ctx) => { key = ctx.idempotencyKey; return { result: input.secret }; } });
    const mcp = mcpServer({ name: "tools", version: "1", tools: [lookup], traces: { url: endpoint.url, key: KEY, content } });
    const http = createServer((req, res) => void mcp.node(req, res));
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    t.after(() => http.close());
    const c = new Client({ name: "test-host", version: "2" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(http.address() as any).port}/mcp/plugin`)));
    try {
      await c.callTool({ name: "lookup", arguments: { secret: "private-tool-data" }, _meta: { "chinwag/surface": "cli", "chinwag/command": "site view", "chinwag/idempotency-key": "retry-7" } });
      await mcp.flushTraces();
      assert.equal(key, "retry-7");
      const spans = endpoint.requests.flatMap(r => r.body.resourceSpans[0].scopeSpans[0].spans);
      assert.equal(spans.length, 1);
      const root = attrs(spans[0]);
      assert.equal(spans[0].name, "mcp.call lookup");
      assert.equal(root["chinwag.surface"], "cli");
      assert.equal(root["chinwag.mcp.client"], "test-host");
      assert.equal(root["chinwag.mcp.client_version"], "2");
      assert.equal(root["chinwag.command"], "site view");
      assert.equal(root["chinwag.conversation_id"], undefined);
      assert.equal(root["openinference.span.kind"], "TOOL");
      assert.equal(JSON.stringify(spans).includes("private-tool-data"), content);

      await c.callTool({ name: "feedback", arguments: { about: "tooling", message: "lookup needs a limit", tool: "lookup" } });
      await mcp.flushTraces();
      const feedback = attrs(endpoint.requests.flatMap(r => r.body.resourceSpans[0].scopeSpans[0].spans).at(-1));
      assert.equal(feedback["gen_ai.tool.name"], "feedback");
      assert.equal(feedback["flow.feedback.about"], "tooling");
      assert.equal(feedback["flow.feedback.message"], "lookup needs a limit", "written for the team, so sent with content off too");
      assert.equal(feedback["flow.feedback.tool"], "lookup");
    } finally { await c.close(); }
  }
});

// The first test is SMS by hand; this one takes each channel as its adapter makes it.
test("a trace names the platform the turn was on, the same on the root span and its send spans: Flow Messaging's own, a custom UI's web, the terminal's cli", async () => {
  const fm = flowMessaging({ apiKey: "fk_test_key" });
  const terminal = terminalServer({ agent: () => { throw new Error("not called"); }, auth: { verify: async () => null } }).channel;
  const channels = [fm.telegram(), fm.imessage(), fm.whatsapp(), fm.sms(), customUI("app", { sendMessage: async () => {} }), terminal];
  const expected = ["telegram", "imessage", "whatsapp", "sms", "web", "cli"];
  const endpoint = await fakeEndpoint();
  try {
    const h = agentFor(endpoint.url, false, undefined, channels);
    for (const [i, c] of channels.entries()) {
      await h.agent.message({ channel: c.name, from: `+1555010020${i}`, message: "Hi" });
      (await h.nextCall(i)).answer(respond(call(`send_${c.name}`, { text: "Hello" })));
      await endpoint.next(i + 1);
    }
    const shown = endpoint.requests.map((r) => {
      const spans = r.body.resourceSpans[0].scopeSpans[0].spans;
      return [...new Set(spans.filter((s: any) => !s.parentSpanId || s.name.startsWith("send ")).map((s: any) => attrs(s)["chinwag.channel"]))];
    });
    assert.deepEqual(shown, expected.map((kind) => [kind]));
  } finally { endpoint.close(); }
});

// The other tests are real traffic; playground turns share their process and run_kind.
test("a playground turn's root span has chinwag.via playground, also for what is answered or sent outside a turn; a real message, from the same person, has none", async () => {
  const endpoint = await fakeEndpoint();
  const h = agentFor(endpoint.url, false, (_id, text) => (/chest pain/.test(text) ? "Call 911 now." : null));
  const roots = () => endpoint.requests.flatMap((r) => r.body.resourceSpans[0].scopeSpans[0].spans.filter((s: any) => !s.parentSpanId).map(attrs));
  try {
    const played = await h.agent.simulate({ person: "+15550100123", channel: "sms", message: "Can I move my check-in?" });
    (await h.nextCall(0)).answer(respond(call("send_sms", { text: "Yes, to when?" })));
    await h.agent.conversation(played!.conversationId)!.whenIdle();
    await h.agent.simulate({ person: "+15550100123", channel: "sms", message: "chest pain" });
    await h.agent.flushTraces();
    assert.deepEqual(roots().map((r) => r["chinwag.via"]), ["playground", "playground", "playground"], "the turn, the intercepted message and its answer");

    await h.agent.message({ channel: "sms", from: "+15550100123", message: "Thursday then", messageId: "SM-9" });
    (await h.nextCall(1)).answer(respond(call("send_sms", { text: "Done." })));
    await h.agent.conversation(played!.conversationId)!.whenIdle();
    await h.agent.flushTraces();
    const real = roots().find((r) => r["chinwag.message_id"] === "SM-9")!;
    assert.equal(real["chinwag.via"], undefined);
    assert.equal(real["chinwag.channel"], "sms");
  } finally { endpoint.close(); }
});

test("the agent's version needs no setting: the option, FLOW_AGENT_VERSION, AGENT_VERSION (Flow's hosting), the CI's commit, the folder's git commit (+dirty), package.json's version, in that order", () => {
  const folder = (version?: string) => {
    const dir = mkdtempSync(join(tmpdir(), "flow-version-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify(version ? { version } : {}));
    return dir;
  };
  const committed = (dirty: boolean) => {
    const dir = folder("0.1.0");
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" }).toString().trim();
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
    if (dirty) writeFileSync(join(dir, "package.json"), "{}");
    return { dir, sha: git("rev-parse", "HEAD") };
  };
  const clean = committed(false);
  const all = { FLOW_AGENT_VERSION: "release-3", AGENT_VERSION: "hosted-2", GITHUB_SHA: "ci1", CI_COMMIT_SHA: "ci2", BUILDKITE_COMMIT: "ci3", CIRCLE_SHA1: "ci4", GIT_COMMIT: "ci5" };
  const order: Array<[keyof typeof all | undefined, string]> = [];
  const env: Record<string, string> = { ...all };
  for (const name of [...Object.keys(all), undefined] as Array<keyof typeof all | undefined>) {
    order.push([name, agentVersion({ dir: clean.dir, env })!.version]);
    if (name) delete env[name];
  }
  assert.deepEqual(order.map(([, v]) => v), ["release-3", "hosted-2", "ci1", "ci2", "ci3", "ci4", "ci5", clean.sha]);
  assert.match(clean.sha, /^[0-9a-f]{40}$/, "the full commit, as a CI names it");
  assert.deepEqual(agentVersion({ given: "mine", dir: clean.dir, env: all }), { version: "mine", from: "given" });
  const dirty = committed(true);
  assert.deepEqual(agentVersion({ dir: dirty.dir, env: {} }), { version: `${dirty.sha}+dirty`, from: "git" });
  // No repository (Flow's hosting packs the folder without .git): package.json's version, else none.
  assert.deepEqual(agentVersion({ dir: folder("1.4.0"), env: {} }), { version: "1.4.0", from: "package.json" });
  assert.equal(agentVersion({ dir: folder(), env: {} }), undefined);
});

test("a version Flow does not keep is never sent: the next one is, with a warning for one set by hand", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const env = { FLOW_AGENT_VERSION: "+15550100123", AGENT_VERSION: "has spaces", GITHUB_SHA: "x".repeat(101), CI_COMMIT_SHA: "abc1234" };
  assert.deepEqual(agentVersion({ given: "v1;rm", env }), { version: "abc1234", from: "CI_COMMIT_SHA" });
  const lines = warn.mock.calls.map((c) => String(c.arguments[0]));
  assert.deepEqual(lines, [
    "flow: the version given is not sent: a version is 1 to 100 letters, digits and . _ : / + -",
    "flow: the version in FLOW_AGENT_VERSION is not sent: a version is 1 to 100 letters, digits and . _ : / + -",
    "flow: the version in AGENT_VERSION is not sent: a version is 1 to 100 letters, digits and . _ : / + -",
  ]);
  assert.ok(!lines.some((l) => l.includes("+15550100123")), "the value itself is never logged");
});

test("with no version option, traces carry the agent's version as service.version, its status says it, and it is logged once when the agent starts", async (t) => {
  const saved = { version: process.env.FLOW_AGENT_VERSION, context: process.env.NODE_TEST_CONTEXT };
  const warn = t.mock.method(console, "warn", () => {});
  process.env.FLOW_AGENT_VERSION = "build-42";
  delete process.env.NODE_TEST_CONTEXT; // the line is left out of an agent's own tests
  const endpoint = await fakeEndpoint();
  let h: ReturnType<typeof agentFor>;
  try {
    h = agentFor(endpoint.url, false, undefined, undefined, null);
    agentFor(endpoint.url, false, undefined, undefined, null);
  } finally {
    process.env.NODE_TEST_CONTEXT = saved.context;
    if (saved.version === undefined) delete process.env.FLOW_AGENT_VERSION;
    else process.env.FLOW_AGENT_VERSION = saved.version;
  }
  let request;
  try {
    assert.equal(h.agent.status().version, "build-42");
    assert.deepEqual(warn.mock.calls.map((c) => c.arguments[0]).filter((l) => String(l).includes("agent version")), ["flow: agent version build-42 (from FLOW_AGENT_VERSION)"]);
    await playTurn(h, "+15550100123");
    request = await endpoint.next(1);
  } finally { endpoint.close(); }
  assert.equal(attrs(request.body.resourceSpans[0].resource)["service.version"], "build-42");
});

test("a message a tool queues for another person is a trace of its own, sent as written, linked to the tool call that queued it", async () => {
  const endpoint = await fakeEndpoint();
  const h = marketplace(endpoint.url);
  const { buyer, seller } = await sellerAnswers(h);
  await h.sentText("The seller answered your question: yes, it ships Monday.");
  await h.agent.conversation(buyer)!.whenIdle();
  await h.agent.flushTraces();
  endpoint.close();

  const all = tracesOf(endpoint);
  const sellerTurn = all.find((t) => t.attrs["chinwag.conversation_id"] === seller)!;
  const tool = sellerTurn.spans.find((s: any) => s.name === "execute_tool answer_buyer");
  assert.equal(sellerTurn.attrs["flow.turn.trigger"], "person");
  const queued = all.filter((t) => t.attrs["chinwag.conversation_id"] === buyer && t.attrs["flow.turn.trigger"] === "queued_message");
  assert.equal(queued.length, 1);
  const [trace] = queued;
  assert.equal(trace.spans.length, 2, "its root and its send, nothing of a turn");
  const send = trace.spans.find((s: any) => s.parentSpanId);
  assert.deepEqual([attrs(send)["flow.message.as_written"], attrs(send)["chinwag.agent_reply"]], [true, "The seller answered your question: yes, it ships Monday."]);
  assert.deepEqual(trace.root.links, QUEUED_BY(tool));
  assert.deepEqual(originOf(trace.attrs), queuedFrom(tool, seller));
  // The buyer's own turn is the person's, and holds only what the agent wrote them.
  const own = all.find((t) => t.attrs["chinwag.conversation_id"] === buyer && t.attrs["flow.turn.trigger"] === "person")!;
  assert.deepEqual([own.replies, own.root.links, originOf(own.attrs)], [["I'll ask the seller."], undefined, {}]);
});

test("a message sent as written is a trace of its own, also while a turn is open in its conversation", async () => {
  const endpoint = await fakeEndpoint();
  const t = traces({ url: endpoint.url, key: KEY, content: true, version: "v7" }, { service: "market", kindOf: () => "sms" });
  const at = Date.now();
  t.sink({ type: "message.in", conversationId: "c1", at, text: "Does it ship Monday?", channel: "sms" });
  t.sink({ type: "turn.start", conversationId: "c1", at, turn: 1, trigger: "person" });
  t.sink({ type: "message.out", conversationId: "c1", at: at + 1, text: "The seller answered your question: yes.", channel: "sms", direct: true, trigger: "queued_message" });
  t.sink({ type: "message.out", conversationId: "c1", at: at + 2, text: "Let me check.", channel: "sms" });
  t.sink({ type: "turn.end", conversationId: "c1", at: at + 3 });
  await t.flush();
  endpoint.close();
  const shown = tracesOf(endpoint).map((x) => [x.attrs["flow.turn.trigger"], x.replies, x.spans.filter((s: any) => s.parentSpanId).map((s: any) => attrs(s)["flow.message.as_written"] ?? false)]);
  assert.deepEqual(shown.sort((a, b) => String(a[0]).localeCompare(String(b[0]))), [
    ["person", ["Let me check."], [false]],
    ["queued_message", ["The seller answered your question: yes."], [true]],
  ]);
});

test("each trace's root says what started it, with the instruction or result it began with", async () => {
  const endpoint = await fakeEndpoint();
  const clock = { now: Date.UTC(2026, 9, 12, 16) };
  const dir = mkdtempSync(join(tmpdir(), "flow-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  const released = gate<string>();
  const slow = tool({ name: "refund", description: "Checks a refund.", input: z.object({}), deadlineMs: 1, run: () => released.promise });
  const sms: Channel = { name: "sms", kind: "sms", info: SMS, phone: true, send: () => {} };
  const agent = createAgent({ dir, model: scripted.model, tools: [slow], channels: [sms], debounceMs: 0, scheduleCheckMs: 0, id: "shop", now: () => clock.now, intercept: (_id, text) => (/chest pain/.test(text) ? "Call 911 now." : null), traces: { url: endpoint.url, key: KEY, content: true, version: "v7" } });
  const to = { channel: "sms", address: BUYER };
  const answer = async (n: number, text: string) => (await scripted.nextCall(n)).answer(respond(call("send_sms", { text })));

  const { conversationId } = (await agent.message({ channel: "sms", from: BUYER, message: "Hi", messageId: "SM-1" }))!;
  const conversation = () => agent.conversation(conversationId)!;
  await answer(0, "Hello!");
  await conversation().whenIdle();
  const nudged = agent.nudge({ to, prompt: "Tell them their order shipped." });
  await answer(1, "Your order shipped.");
  await nudged;
  const event = agent.nudge({ to, prompt: "Tell them the sale starts Friday.", [NUDGE_TRIGGER]: "event" } as NudgeInput);
  await answer(2, "The sale starts Friday.");
  await event;
  await conversation().whenIdle();
  await agent.wakeUp({ to, note: "Check whether they found a size.", inMs: 120_000, respectQuietHours: false });
  clock.now += 120_000;
  await agent.runDue();
  await answer(3, "Did you find a size?");
  await conversation().whenIdle();
  await agent.nudge({ to, text: "Sale today: 20% off." });
  await agent.message({ channel: "sms", from: BUYER, message: "Where is my refund?", messageId: "SM-2" });
  (await scripted.nextCall(4)).answer(respond(call("send_sms", { text: "Checking, one moment." }), call("refund")));
  (await scripted.nextCall(5)).answer(respond());
  released.open("refund sent");
  await answer(6, "Your refund went out.");
  await conversation().whenIdle();
  await agent.message({ channel: "sms", from: BUYER, message: "chest pain", messageId: "SM-3" });
  await conversation().whenIdle();
  await agent.flushTraces();
  endpoint.close();

  const shown = tracesOf(endpoint).map((t) => [t.attrs["flow.turn.trigger"], t.attrs["flow.turn.trigger_text"] ?? null, t.replies]);
  const order = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort();
  assert.deepEqual(order(shown), order([
    ["person", null, ["Hello!"]],
    ["nudge", "Tell them their order shipped.", ["Your order shipped."]],
    ["event", "Tell them the sale starts Friday.", ["The sale starts Friday."]],
    ["wake_up", "Check whether they found a size.", ["Did you find a size?"]],
    ["queued_message", null, ["Sale today: 20% off."]],
    ["person", null, ["Checking, one moment."]],
    ["task", "refund (task_1): refund sent", ["Your refund went out."]],
    ["person", null, []],
    ["direct", null, ["Call 911 now."]],
  ]));
});

test("a queued message's origin is kept with it: queued for later, it is sent after a restart still linked to the tool call that queued it", async () => {
  const endpoint = await fakeEndpoint();
  const file = join(mkdtempSync(join(tmpdir(), "flow-")), "flow.db");
  const clock = { now: Date.UTC(2026, 9, 12, 16) };
  const first = marketplace(endpoint.url, { database: sqlite(file), now: () => clock.now, at: clock.now + 120_000 });
  await first.agent.resume();
  const { buyer, seller } = await sellerAnswers(first);
  await first.agent.flushTraces();
  assert.deepEqual(first.sent, ["I'll ask the seller.", "Thanks!", "Thanks, I told them."], "nothing for the buyer yet");
  const tool = tracesOf(endpoint).find((t) => t.attrs["chinwag.conversation_id"] === seller)!.spans.find((s: any) => s.name === "execute_tool answer_buyer");

  const second = marketplace(endpoint.url, { database: sqlite(file), now: () => clock.now });
  await second.agent.resume();
  clock.now += 120_000;
  await second.agent.runDue();
  await second.sentText("The seller answered your question: yes, it ships Monday.");
  await second.agent.conversation(buyer)!.whenIdle();
  await second.agent.flushTraces();
  endpoint.close();
  const queued = tracesOf(endpoint).find((t) => t.attrs["flow.turn.trigger"] === "queued_message")!;
  assert.equal(queued.attrs["chinwag.conversation_id"], buyer);
  assert.deepEqual(queued.root.links, QUEUED_BY(tool));
  assert.deepEqual(originOf(queued.attrs), queuedFrom(tool, seller));
});
