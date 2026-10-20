// covers: testing/src/business.ts testing/src/client.ts testing/src/protocol.ts testing/src/suite.ts src/agent.ts
// A business run on the developer's side: the run's own agent is built with the cloud's clock and
// copies of its channels (the agent's own wrapper around a send still runs), the person is reachable
// before they write, a signed event reaches the agent's route and a wrongly signed one is refused,
// a send the agent holds goes out when the clock reaches it, with that time on the outbound, and the
// person writes as on the channel, so the agent can nudge them.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createAgent, whatsapp, type Channel, type EventSink, type Tool } from "../src/index.ts";
import { runInCloud, type ConnectOptions } from "../testing/src/client.ts";
import { isBusiness, parseScenario, waitMs } from "../testing/src/suite.ts";
import type { BusinessBuild } from "../testing/src/business.ts";
import type { BusinessOutbound, Command, StepAnswer } from "../testing/src/protocol.ts";
import { call, respond, scriptedModel, WHATSAPP } from "./helpers.ts";

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
    ...(options.testing ? { now: options.testing.now, scheduleCheckMs: options.testing.scheduleCheckMs } : {}),
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

/** A cloud that plays `script` one command at a time: the next goes once the agent answered the last (a step answer, or for a message its reply). */
async function play(script: Command[], build: ConnectOptions["build"]) {
  const answers: StepAnswer[] = [];
  const outbound: BusinessOutbound[] = [];
  const receipts: unknown[] = [];
  let opened: unknown;
  let stream: ServerResponse | undefined;
  let at = 0;
  const next = () => {
    const command = script[at++] ?? { type: "finished", summary: { sessionId: "s1", suiteHash: "", testModel: "", runs: [], dashboard: "" } };
    stream!.write(`data: ${JSON.stringify(command)}\n\n`);
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
      } else if (req.url!.endsWith("/receipts")) receipts.push(JSON.parse(body));
    });
  });
  await new Promise<void>((done) => cloud.listen(0, "127.0.0.1", done));
  try {
    await runInCloud({ cloud: `http://127.0.0.1:${(cloud.address() as AddressInfo).port}`, name: "test-agent", tools: [], files: [], log: () => {}, build });
  } finally {
    cloud.close();
  }
  return { opened, answers, outbound, receipts };
}


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

test("the format: a business run's steps parse, and a step that is two things is refused at its line", () => {
  const scenario = (opening: string, expect = "") => ({ path: "scenarios/b.yaml", content: `id: b\nchannels: [whatsapp]\nperson: { address: "+15550100001", persona: p, goal: g }\nopening:\n${opening}\n${expect}` });
  const ok = parseScenario(scenario(
    `  - event: { type: test.outbid, delivery: critical, subject: "user:1", data: { phone: "+15550100001" } }\n    at: "23:30"\n  - wait: 8h30m\n  - event: { id: e1, type: t, subject: s, data: {} }\n    signature: bad\n    answer: 401\n  - nudge: { template: { name: outbid, body: [PS5] } }\n  - say: ok`,
    `expect:\n  sent: [{ at: "08:00", template: outbid }, { phrased: true, text: PS5 }]\n  not_sent: [{}]`,
  ));
  assert.ok(isBusiness(ok));
  assert.deepEqual(ok.opening.map((s) => (s.event ? "event" : s.nudge ? "nudge" : s.wait ? "wait" : "say")), ["event", "wait", "event", "nudge", "say"]);
  assert.equal(waitMs("8h30m"), 8.5 * 3_600_000);
  assert.ok(!isBusiness(parseScenario(scenario("  - say: hi"))));
  assert.throws(() => parseScenario(scenario("  - say: hi\n    wait: 1h")), /scenarios\/b\.yaml:5: opening\[0\]: one of say, event, nudge or wait per step, not say and wait/);
  assert.throws(() => parseScenario(scenario("  - wait: soon")), /a length of time/);
  assert.throws(() => parseScenario(scenario("  - say: hi\n    answer: 202")), /belong to an event step/);
});
