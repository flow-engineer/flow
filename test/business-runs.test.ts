// covers: testing/src/business.ts testing/src/client.ts testing/src/protocol.ts testing/src/suite.ts src/agent.ts src/conversation.ts src/business-events/engine.ts
// A business run on the developer's side: the run's own agent is built with the cloud's clock and
// copies of its channels (the agent's own wrapper around a send still runs), the person is reachable
// before they write, a signed event reaches the agent's route and a wrongly signed one is refused,
// a send the agent holds goes out when the clock reaches it, with that time on the outbound, and the
// person writes as on the channel, so the agent can nudge them. A restart mid-turn (a crash, a
// deploy) answers each message once, on the store the run's agents share.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createAgent, flowEvents, tool, whatsapp, z, type Channel, type EventSink, type FlowEvent, type Tool } from "../src/index.ts";
import { LEASE_MS } from "../src/conversation.ts";
import { runInCloud, type ConnectOptions } from "../testing/src/client.ts";
import { isBusiness, parseScenario, waitMs } from "../testing/src/suite.ts";
import type { BusinessBuild } from "../testing/src/business.ts";
import type { BusinessOutbound, Command, StepAnswer } from "../testing/src/protocol.ts";
import { call, gate, respond, scriptedModel, WHATSAPP } from "./helpers.ts";

const PERSON = "+15550100001";
const START = Date.UTC(2026, 9, 20, 18, 0); // 23:30 in Kolkata
const RELEASE = Date.UTC(2026, 9, 21, 2, 30); // 08:00 in Kolkata

/** An agent the way an app builds it: its own route for events, a send held until 08:00 by its own timer, and a wrapper around each channel's send. */
function buildAgent(options: { tools: Tool[]; events: EventSink[] } & Partial<BusinessBuild>, wrapped: string[], model = scriptedModel().model) {
  const held: string[] = [];
  const channels = (options.channels ?? [whatsapp({ sendMessage: async () => {} })]).map((c): Channel => {
    const send = c.send.bind(c);
    return { ...c, send: (address, outbound) => (wrapped.push(outbound.type), send(address, outbound)) };
  });
  const now = options.testing?.now ?? Date.now;
  const agent = createAgent({
    files: { "AGENTS.md": "A test agent." },
    model,
    tools: options.tools,
    events: options.events,
    channels,
    // As the skill says: the run's clock, store and runner name, spread as they are.
    ...options.testing,
    routes: {
      "/v1/events": async (request) => {
        const body = await request.text();
        const [t, v1] = (request.headers.get("flow-signature") ?? "").split(",").map((p) => p.split("=")[1]);
        const want = createHmac("sha256", options.testing?.eventsSecret ?? "").update(`t.${t}.${body}`).digest("hex");
        if (v1 !== want || Math.abs(Number(t) * 1000 - now()) > 300_000) return Response.json({ error: "bad signature" }, { status: 401 });
        held.push((JSON.parse(body) as { data: { phone: string } }).data.phone);
        return Response.json({ status: "accepted" }, { status: 202 });
      },
    },
    onTick: async (at) => {
      if (at < RELEASE) return;
      for (const phone of held.splice(0)) await agent.nudge({ to: { channel: "whatsapp", address: phone }, template: { name: "outbid", body: ["PS5"] }, respectQuietHours: false });
    },
  });
  return agent;
}

/**
 * A cloud that plays `script` one command at a time: the next goes once the agent answered the last (a step answer,
 * or for a message its reply; a restart right after a message goes once it is taken, while its turn runs).
 * `before(i)` holds the i-th command (the script's length: the end) until the test lets it go; `taken` hears each receipt.
 */
async function play(script: Command[], build: ConnectOptions["build"], hooks: { before?: (index: number) => Promise<unknown>; taken?: (messageId: string) => void; tools?: Tool[] } = {}) {
  const before = hooks.before ?? (async () => {});
  const answers: StepAnswer[] = [];
  const outbound: BusinessOutbound[] = [];
  const receipts: unknown[] = [];
  const events: FlowEvent[] = [];
  let opened: unknown;
  let stream: ServerResponse | undefined;
  let at = 0;
  const next = () => {
    if (at > script.length) return; // the end was sent
    const index = at++;
    void before(index).then(() => {
      const command = script[index] ?? { type: "finished", summary: { sessionId: "s1", suiteHash: "", testModel: "", runs: [], dashboard: "" } };
      stream!.write(`data: ${JSON.stringify(command)}\n\n`);
    });
  };
  const cloud = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url === "/api/sessions") {
        opened = JSON.parse(body);
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s1", token: "t", missing: [], dashboard: "", idempotency: true, business: true }));
      }
      if (req.url!.endsWith("/stream")) {
        stream = res.writeHead(200, { "content-type": "text/event-stream" });
        return next();
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      if (req.url!.endsWith("/steps")) {
        answers.push(JSON.parse(body));
        next();
      } else if (req.url!.endsWith("/outbound")) {
        const sent = JSON.parse(body) as BusinessOutbound;
        outbound.push(sent);
        if (sent.outbound.type === "message" && script[at - 1]?.type === "message") next();
      } else if (req.url!.endsWith("/receipts")) {
        receipts.push(JSON.parse(body));
        hooks.taken?.((JSON.parse(body) as { messageId: string }).messageId);
        if (script[at - 1]?.type === "message" && script[at]?.type === "restart") next();
      } else if (req.url!.endsWith("/events")) events.push(...(JSON.parse(body) as { events: FlowEvent[] }).events);
    });
  });
  await new Promise<void>((done) => cloud.listen(0, "127.0.0.1", done));
  let summary: Awaited<ReturnType<typeof runInCloud>>;
  try {
    summary = await runInCloud({ cloud: `http://127.0.0.1:${(cloud.address() as AddressInfo).port}`, name: "test-agent", tools: hooks.tools ?? [], files: [], log: () => {}, build });
  } finally {
    cloud.close();
  }
  return { opened, answers, outbound, receipts, events, summary };
}

/** Each message the agent sent, with the runner that sent it (runner-1, runner-2, ...). */
const sentBy = (events: FlowEvent[]) => events.filter((e) => e.type === "message.out").map((e) => [e.text, String(e.runner).split(":")[0]]);
/** Each turn's start and end, with its number and runner. */
const turns = (events: FlowEvent[]) => events.filter((e) => e.type === "turn.start" || e.type === "turn.end").map((e) => [e.type, e.turn, String(e.runner).split(":")[0]]);


test("a business run: its own clock and channels, a signed event, and a held send at 08:00", async () => {
  const conversationId = "whatsapp:p1";
  const envelope = { id: "evt_1", type: "test.outbid", occurredAt: new Date(START).toISOString(), subject: "user:1", delivery: "standard", data: { phone: PERSON } };
  const wrapped: string[] = [];
  const { opened, answers, outbound } = await play([
    { type: "open", conversationId, channelName: "whatsapp", channel: WHATSAPP, address: PERSON, now: START },
    { type: "event", conversationId, step: 1, envelope },
    { type: "event", conversationId, step: 2, envelope: { ...envelope, id: "evt_2" }, signature: "bad" },
    { type: "advance", conversationId, step: 3, to: RELEASE + 10 * 60_000 },
  ], (options) => buildAgent(options, wrapped));
  assert.equal((opened as { business?: boolean }).business, true);
  assert.deepEqual(answers.map((a) => [a.step, a.answer?.status ?? null, a.error ?? null]), [[0, null, null], [1, 202, null], [2, 401, null], [3, null, null]]);
  assert.equal(answers[3].at, RELEASE + 10 * 60_000);
  assert.deepEqual(outbound.map((o) => [o.conversationId, o.outbound.type, o.at]), [[conversationId, "template", RELEASE]]);
  assert.deepEqual(wrapped, ["template"]);
});

test("in a business run the person writes as on the channel, so the agent can nudge them inside their window", async () => {
  const conversationId = "whatsapp:p2";
  const scripted = scriptedModel();
  const { answers, outbound, receipts } = await (async () => {
    const played = play([
      { type: "open", conversationId, channelName: "whatsapp", channel: WHATSAPP, address: PERSON, now: START },
      { type: "message", conversationId, messageId: "m1", incoming: { text: "hi" }, channel: WHATSAPP, channelName: "whatsapp" },
      { type: "nudge", conversationId, step: 2, nudge: { text: "Your bid was outbid." } },
    ], (options) => buildAgent(options, [], scripted.model));
    (await scripted.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Hello!" })));
    return played;
  })();
  assert.deepEqual(receipts, [{ conversationId, messageId: "m1", status: "taken" }]);
  assert.deepEqual(answers.map((a) => [a.step, a.nudge?.status ?? null]), [[0, null], [2, "sent"]]);
  assert.deepEqual(outbound.flatMap((o) => (o.outbound.type === "message" ? [[o.outbound.text, o.at]] : [])), [["Hello!", START], ["Your bid was outbid.", START]]);
});

test("a business run against flowEvents' own route: a signed event is 202, a wrongly signed one 401, a malformed one 400 naming the field", async () => {
  const conversationId = "whatsapp:p3";
  const order = { id: "evt_10", type: "order.shipped", occurredAt: new Date(START).toISOString(), subject: "order:1", data: { user: { phone: PERSON }, consent: { whatsappUpdates: true }, order: "A-100" } };
  let events: ReturnType<typeof flowEvents> | undefined;
  const { answers } = await play([
    { type: "open", conversationId, channelName: "whatsapp", channel: WHATSAPP, address: PERSON, now: START },
    { type: "event", conversationId, step: 1, envelope: order },
    { type: "event", conversationId, step: 2, envelope: { ...order, id: "evt_11" }, signature: "bad" },
    { type: "event", conversationId, step: 3, envelope: { ...order, id: "evt_12", data: { consent: { whatsappUpdates: true }, order: "A-100" } } },
  ], (options) => {
    if (!options.testing) return buildAgent(options, []);
    events = flowEvents({
      secret: options.testing.eventsSecret,
      now: options.testing.now,
      log: () => {},
      catalog: {
        "order.shipped": {
          level: "critical",
          message: (e) => ({ template: { name: "order_shipped", body: [String(e.data.order)] }, text: `Order ${e.data.order} shipped.`, values: [String(e.data.order)], link: { label: "Track", url: "https://example.com/o/1" } }),
        },
      },
    });
    const agent = createAgent({ files: { "AGENTS.md": "A test agent." }, model: scriptedModel().model, tools: options.tools, events: options.events, channels: options.channels, now: options.testing.now, scheduleCheckMs: options.testing.scheduleCheckMs, routes: events.routes, onTick: events.onTick });
    events.attach(agent);
    return agent;
  });
  assert.deepEqual(answers.map((a) => [a.step, a.answer?.status ?? null, a.error ?? null]), [[0, null, null], [1, 202, null], [2, 401, null], [3, 400, null]]);
  assert.deepEqual(answers[1].answer!.body, { status: "accepted" });
  assert.deepEqual(answers[3].answer!.body, { field: "data.user.phone", error: "required, E.164" });
  await events!.idle();
});

test("the format: a business run's steps parse (expect.sent may ask for a carousel), and a step that is two things is refused at its line", () => {
  const scenario = (opening: string, expect = "") => ({ path: "scenarios/b.yaml", content: `id: b\nchannels: [whatsapp]\nperson: { address: "+15550100001", persona: p, goal: g }\nopening:\n${opening}\n${expect}` });
  const ok = parseScenario(scenario(
    `  - event: { type: test.outbid, delivery: critical, subject: "user:1", data: { phone: "+15550100001" } }\n    at: "23:30"\n  - wait: 8h30m\n  - event: { id: e1, type: t, subject: s, data: {} }\n    signature: bad\n    answer: 401\n  - nudge: { template: { name: outbid, body: [PS5] } }\n  - say: ok`,
    `expect:\n  sent: [{ at: "08:00", template: outbid }, { phrased: true, text: PS5 }, { carousel: true, text: PS5 }]\n  not_sent: [{}]`,
  ));
  assert.deepEqual(ok.expect.sent?.[2], { carousel: true, text: "PS5" });
  assert.ok(isBusiness(ok));
  assert.deepEqual(ok.opening.map((s) => (s.event ? "event" : s.nudge ? "nudge" : s.wait ? "wait" : "say")), ["event", "wait", "event", "nudge", "say"]);
  assert.equal(waitMs("8h30m"), 8.5 * 3_600_000);
  assert.ok(!isBusiness(parseScenario(scenario("  - say: hi"))));
  assert.throws(() => parseScenario(scenario("  - say: hi\n    wait: 1h")), /scenarios\/b\.yaml:5: opening\[0\]: one of say, event, nudge, wait or restart per step, not say and wait/);
  const restarts = parseScenario(scenario("  - say: hi\n  - restart: crash\n  - restart: deploy"));
  assert.ok(isBusiness(restarts));
  assert.deepEqual(restarts.opening.map((s) => s.restart ?? null), [null, "crash", "deploy"]);
  assert.throws(() => parseScenario(scenario("  - restart: reboot")), /restart: crash or deploy/);
  assert.throws(() => parseScenario(scenario("  - wait: soon")), /a length of time/);
  assert.throws(() => parseScenario(scenario("  - say: hi\n    answer: 202")), /belong to an event step/);
  assert.throws(() => parseScenario(scenario("  - say: hi", "expect:\n  sent: [{ carousel: true, template: outbid }]")), /a carousel is not a template/);
});

test("a crash mid-turn: the dead agent sends nothing more, and its turn runs once on the next one after its lease", async () => {
  const conversationId = "whatsapp:p4";
  const scripted = scriptedModel();
  const played = play([
    { type: "open", conversationId, channelName: "whatsapp", channel: WHATSAPP, address: PERSON, now: START },
    { type: "message", conversationId, messageId: "m1", incoming: { text: "when is my class?" }, channel: WHATSAPP, channelName: "whatsapp" },
    { type: "restart", conversationId, step: 2, mode: "crash" },
  ], (options) => buildAgent(options, [], scripted.model), { before: async (i) => i === 2 && scripted.nextCall(0) }); // it dies while the model thinks
  const again = await scripted.nextCall(1);
  assert.deepEqual(again.request.messages.filter((m) => m.role === "user").map((m) => m.content), ["[m1] when is my class?"]);
  again.answer(respond(call("send_whatsapp", { text: "Thursday at 10." })));
  scripted.calls[0].answer(respond(call("send_whatsapp", { text: "From the dead runner." }))); // too late: it is gone
  const { opened, answers, outbound, events } = await played;
  assert.equal((opened as { restart?: boolean }).restart, true);
  assert.deepEqual(answers.map((a) => [a.step, a.at, a.error ?? null]), [[0, START, null], [2, START + LEASE_MS, null]]);
  assert.deepEqual([answers[1].restart?.stopped.split(":")[0], answers[1].restart?.started.split(":")[0]], ["runner-1", "runner-2"]);
  assert.deepEqual(outbound.flatMap((o) => (o.outbound.type === "message" ? [o.outbound.text] : [])), ["Thursday at 10."]);
  assert.deepEqual(sentBy(events), [["Thursday at 10.", "runner-2"]]);
  assert.deepEqual(turns(events), [["turn.start", 1, "runner-1"], ["turn.start", 1, "runner-2"], ["turn.end", 1, "runner-2"]]);
});

test("a deploy mid-turn: the old agent finishes its turn and a message the new one took meanwhile, then the new one carries on", async () => {
  const conversationId = "whatsapp:p5";
  const scripted = scriptedModel();
  const message = (messageId: string, text: string): Command => ({ type: "message", conversationId, messageId, incoming: { text }, channel: WHATSAPP, channelName: "whatsapp" });
  const m2 = gate();
  const m3 = gate();
  const done = gate();
  const agents: Array<ReturnType<typeof buildAgent>> = [];
  const played = play([
    { type: "open", conversationId, channelName: "whatsapp", channel: WHATSAPP, address: PERSON, now: START },
    message("m1", "when is my class?"),
    { type: "restart", conversationId, step: 2, mode: "deploy" },
    message("m2", "and where?"), // reaches the new agent while the old one's turn runs
    message("m3", "thanks!"),
  ], (options) => agents[agents.length] = buildAgent(options, [], scripted.model), {
    before: async (i) => {
      if (i === 2) await scripted.nextCall(0); // the new revision comes up while the model thinks
      if (i === 5) await done.promise;
      if (i !== 4) return;
      // Once the old one let go of the conversation (it stops then).
      await m3.promise;
      const old = agents[1]!.conversation((await agents[2]!.reach({ channel: "whatsapp", address: PERSON })).conversationId);
      await old?.whenIdle();
      await old?.stored();
    },
    taken: (id) => id === "m2" && m2.open(),
  });
  const first = await scripted.nextCall(0);
  await m2.promise;
  first.answer(respond(call("send_whatsapp", { text: "Thursday at 10." })));
  const second = await scripted.nextCall(1);
  assert.deepEqual(second.request.messages.filter((m) => m.role === "user").map((m) => m.content), ["[m1] when is my class?", "[m2] and where?"]);
  second.answer(respond(call("send_whatsapp", { text: "At the studio." })));
  m3.open();
  const third = await scripted.nextCall(2);
  assert.deepEqual(third.request.messages.filter((m) => m.role === "user").map((m) => m.content), ["[m1] when is my class?", "[m2] and where?", "[m3] thanks!"]);
  third.answer(respond(call("send_whatsapp", { text: "Any time." })));
  await agents[2]!.conversation((await agents[2]!.reach({ channel: "whatsapp", address: PERSON })).conversationId)?.whenIdle();
  done.open();
  const { answers, events } = await played;
  assert.deepEqual(answers.map((a) => [a.step, a.error ?? null]), [[0, null], [2, null]]);
  assert.deepEqual(sentBy(events), [["Thursday at 10.", "runner-1"], ["At the studio.", "runner-1"], ["Any time.", "runner-2"]]);
  assert.equal(scripted.calls.length, 3, "no turn ran twice");
});

test("a run that starts from an earlier conversation: the open says the client seeds it, the history on a business open or a run's first message is in the store before the message, and the model reads it as said", async () => {
  const history = [{ from: "person" as const, text: "Book a table for Friday" }, { from: "agent" as const, text: "Done: Friday, 8 pm." }, { from: "person" as const, text: "Thanks" }];
  const scripted = scriptedModel();
  const played = play([
    { type: "open", conversationId: "whatsapp:h1", channelName: "whatsapp", channel: WHATSAPP, address: PERSON, now: START, history },
    { type: "message", conversationId: "whatsapp:h1", messageId: "m1", incoming: { text: "Can we move it to 9?" }, channel: WHATSAPP, channelName: "whatsapp" },
    // A run that is not the business's: the history comes with its first message, on the session's agent.
    { type: "message", conversationId: "c2", messageId: "m2", incoming: { text: "And for two?" }, channel: WHATSAPP, history: history.slice(0, 2) },
  ], (options) => buildAgent(options, [], scripted.model));
  const said = (request: { messages: Array<{ role: string; content?: string | null; toolCalls?: Array<{ arguments: string }> }> }) =>
    request.messages.flatMap((m) => (m.role === "user" && m.content ? [`person: ${m.content}`] : m.role === "assistant" ? (m.toolCalls ?? []).map((c) => `agent: ${JSON.parse(c.arguments).text}`) : []));
  const business = await scripted.nextCall(0);
  assert.match(said(business.request).join("\n"), /Book a table for Friday[\s\S]*agent: Done: Friday, 8 pm\.[\s\S]*Thanks[\s\S]*Can we move it to 9\?/);
  business.answer(respond(call("send_whatsapp", { text: "Moved to 9." })));
  const plain = await scripted.nextCall(1);
  assert.match(said(plain.request).join("\n"), /Book a table for Friday[\s\S]*agent: Done: Friday, 8 pm\.[\s\S]*And for two\?/);
  plain.answer(respond(call("send_chat", { text: "Yes." })));
  const { opened, answers, summary } = await played;
  assert.equal((opened as { history?: boolean }).history, true);
  assert.deepEqual(answers.map((a) => [a.step, a.error ?? null]), [[0, null]]);
  assert.equal(summary.sendPath, undefined, "every message went through the agent's send");
});

test("a message that reaches the cloud without the agent's send is a second path: the session's summary names the conversation", async () => {
  const scripted = scriptedModel();
  const conversationId = "whatsapp:s1";
  const played = play([
    { type: "open", conversationId, channelName: "whatsapp", channel: WHATSAPP, address: PERSON, now: START },
    { type: "message", conversationId, messageId: "m1", incoming: { text: "hi" }, channel: WHATSAPP, channelName: "whatsapp" },
  ], (options) => {
    // The app's channel wrapper sends one more message of its own, which the agent never announces.
    const channels = options.channels?.map((c): Channel => ({ ...c, send: async (address, outbound) => { await c.send(address, outbound); if (outbound.type === "message") await c.send(address, { type: "message", text: "PS: rate us!" }); } }));
    return buildAgent({ ...options, ...(channels ? { channels } : {}) }, [], scripted.model);
  });
  (await scripted.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Hello!" })));
  const { summary } = await played;
  assert.deepEqual(summary.sendPath, [{ conversationId, delivered: 2, announced: 1 }]);
});

test("a tool run for real is the agent's own, as in production: buildAgent knows it by identity, and context.events is the run's own events side", async () => {
  // As an app writes it: a module's tool that buildAgent swaps (by identity) for one keeping this agent's own state,
  // and a module's tool that keeps what the person watches in its agent's events side through context.events.
  const moduleNotes: string[] = [];
  const noteTool = (notes: string[]) => tool({ name: "note", description: "Keeps a note.", input: z.object({ text: z.string() }), run: ({ text }) => void notes.push(text) });
  const note = noteTool(moduleNotes);
  const keepPosted = tool({
    name: "keep_me_posted",
    description: "Watches a topic for the person.",
    input: z.object({ topic: z.string() }),
    run: ({ topic }, context) => context.events?.watch({ address: context.address!, topic }).outcome ?? "no events side",
  });
  const built: Array<{ notes: string[]; events: ReturnType<typeof flowEvents>; testing: boolean }> = [];
  const scripted = scriptedModel();
  const build = (options: { tools: Tool[]; events: EventSink[] } & Partial<BusinessBuild>) => {
    const notes: string[] = [];
    const events = flowEvents({ secret: options.testing?.eventsSecret ?? "whsec_prod", now: options.testing?.now, log: () => {}, catalog: {} });
    const agent = createAgent({
      files: { "AGENTS.md": "A test agent." },
      model: scripted.model,
      tools: options.tools.map((t) => (t === note ? noteTool(notes) : t)),
      events: options.events,
      channels: options.channels ?? [whatsapp({ sendMessage: async () => {} })],
      ...options.testing,
      routes: events.routes,
      onTick: events.onTick,
    });
    events.attach(agent);
    built.push({ notes, events, testing: options.testing !== undefined });
    return agent;
  };
  // The person asks; the agent answers and calls both tools; its next step ends the turn.
  const turn = async (index: number) => {
    (await scripted.nextCall(index)).answer(respond(call("send_whatsapp", { text: "Sure." }), call("note", { text: "wants PS5 news" }), call("keep_me_posted", { topic: "listing:ps5" })));
    const next = await scripted.nextCall(index + 1);
    next.answer(respond());
    return next.request.messages.filter((m) => m.role === "tool").map((m) => m.content);
  };

  // Production: buildAgent with the module's tools.
  const production = build({ tools: [note, keepPosted], events: [] });
  await production.message({ channel: "whatsapp", from: PERSON, message: "keep me posted on the PS5" });
  const inProduction = await turn(0);
  await production.conversation((await production.reach({ channel: "whatsapp", address: PERSON })).conversationId)!.whenIdle();

  // flow test: a business run that runs both for real.
  const conversationId = "whatsapp:r1";
  const ended = gate();
  const played = play([
    { type: "open", conversationId, channelName: "whatsapp", channel: WHATSAPP, address: PERSON, now: START, realTools: ["note", "keep_me_posted"] },
    { type: "message", conversationId, messageId: "m1", incoming: { text: "keep me posted on the PS5" }, channel: WHATSAPP, channelName: "whatsapp" },
  ], build, { tools: [note, keepPosted], before: async (i) => i === 2 && ended.promise }); // the session ends once the turn has
  const inTest = await turn(2);
  ended.open();
  await played;

  const run = built.find((b) => b.testing)!;
  assert.deepEqual(inTest, inProduction, "the tools answered the run as they answer in production");
  assert.deepEqual(inTest.slice(-1), ["saved"]);
  for (const b of [built[0]!, run]) {
    assert.deepEqual(b.notes, ["wants PS5 news"], "saved into its own agent's state");
    assert.deepEqual(b.events.state.watches.map((w) => [w.address, w.topic]), [[PERSON, "listing:ps5"]]);
  }
  assert.deepEqual(moduleNotes, [], "never into the module's");
  assert.equal(built.filter((b) => b.events.state.watches.length).length, 2, "the session's own agent watched nothing");
});
