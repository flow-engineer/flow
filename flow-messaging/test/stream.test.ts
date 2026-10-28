// covers: flow-messaging/src/index.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent, type FlowEvent } from "../../src/index.ts";
import { call, respond, scriptedModel, users } from "./helpers.ts";
import { fakeFlow, received, SENDERS, type Recorded } from "./fake.ts";
import { flowMessaging, type StreamOptions } from "../src/index.ts";

const TG = { id: "conv_tg", channel: "telegram", contact: "ct_tg" } as const;
const post = (path: string) => (r: Recorded) => r.method === "POST" && r.path === path;
const lastUser = (messages: Parameters<typeof users>[0]) => users(messages).at(-1) ?? "";

/** A Telegram agent on Flow with no webhook secret, so start() opens the stream. */
function streamAgent(flow: { url: string }, options: StreamOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "flow-fm-stream-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  const events: FlowEvent[] = [];
  const fm = flowMessaging({ apiKey: "fk_test_key", webhookSecret: "", baseUrl: flow.url });
  const agent = createAgent({ dir, model: scripted.model, channels: [fm.telegram({ sender: SENDERS.telegram })], debounceMs: 0, deadlineMs: 50, scheduleCheckMs: 0, events: [(e) => events.push(e)] });
  const handle = fm.start(agent, options);
  return { agent, events, handle, ...scripted };
}

test("with no webhook secret the agent takes events from the stream: the key as a subprotocol, only the events it handles, the reply over HTTP, and a restart resumes after the last handled event", async (t) => {
  const flow = await fakeFlow();
  t.after(() => flow.close());
  flow.contacts.ct_tg = { address: { telegram_user_id: "777" } };
  const cursorFile = join(mkdtempSync(join(tmpdir(), "flow-fm-cursor-")), ".flow", "stream-cursor");
  const live = streamAgent(flow, { cursorFile });
  assert.equal(live.handle.mode, "stream");

  const first = await flow.stream(0);
  assert.deepEqual(first.protocols, ["flow", "flow.key.fk_test_key"]);
  assert.equal(first.url.pathname, "/v0/stream");
  assert.equal(first.url.searchParams.get("after"), null);
  assert.deepEqual(first.url.searchParams.getAll("type"), ["message.received", "message.failed", "reaction.added", "contact.deleted", "message.sent"]);

  const hello = received(TG, "msg_1", { kind: "basic", text: "hi from my phone" });
  first.send({ type: "event", event: hello });
  const turn = await live.nextCall(0);
  assert.equal(lastUser(turn.request.messages), "[msg_1] hi from my phone");
  turn.answer(respond(call("send_telegram", { text: "Hi!" })));
  assert.deepEqual((await flow.request(post("/v0/conversations/conv_tg/basic"))).body, { text: "Hi!" });
  await live.agent.conversation(live.events[0]!.conversationId)!.whenIdle();
  assert.equal(readFileSync(cursorFile, "utf8").trim(), hello.id);
  await live.handle.close();
  await first.ended;

  const restarted = streamAgent(flow, { cursorFile });
  t.after(() => restarted.handle.close());
  assert.equal((await flow.stream(1)).url.searchParams.get("after"), hello.id);
});

test("a reconnect frame, a dropped socket and a failed event each reconnect from the last handled event, and a replayed event is not handled twice", async (t) => {
  const flow = await fakeFlow();
  t.after(() => flow.close());
  flow.contacts.ct_tg = { address: { telegram_user_id: "777" } };
  const live = streamAgent(flow);
  t.after(() => live.handle.close());

  const one = received(TG, "msg_1", { kind: "basic", text: "one" });
  const first = await flow.stream(0);
  first.send({ type: "event", event: one });
  (await live.nextCall(0)).answer(respond(call("send_telegram", { text: "got one" })));
  await flow.request(post("/v0/conversations/conv_tg/basic"));
  await live.agent.conversation(live.events[0]!.conversationId)!.whenIdle();

  // Flow is restarting: it says reconnect, then closes with 1012.
  first.send({ type: "reconnect", after: one.id });
  first.close(1012, "server restarting; reconnect with after");
  const second = await flow.stream(1);
  assert.equal(second.url.searchParams.get("after"), one.id);
  second.send({ type: "event", event: one }); // replayed: already handled, so the model is not called again

  // The connection drops with no close frame.
  second.drop();
  const third = await flow.stream(2);
  assert.equal(third.url.searchParams.get("after"), one.id);

  // The contact lookup fails once: the event is not acknowledged, and comes again on the next connection.
  const two = received({ id: "conv_tg2", channel: "telegram", contact: "ct_new" }, "msg_2", { kind: "basic", text: "two" });
  flow.queued.push({ match: (r) => r.method === "GET" && r.path === "/v0/contacts/ct_new", status: 404, body: { error: { type: "not_found", message: "No such object." } } });
  third.send({ type: "event", event: two });
  const fourth = await flow.stream(3);
  assert.equal(fourth.url.searchParams.get("after"), one.id);
  flow.contacts.ct_new = { address: { telegram_user_id: "888" } };
  fourth.send({ type: "event", event: one });
  fourth.send({ type: "event", event: two });
  const again = await live.nextCall(1);
  assert.equal(lastUser(again.request.messages), "[msg_2] two");
  assert.equal(live.calls.length, 2);
  again.answer(respond(call("send_telegram", { text: "got two" })));
  await live.agent.conversation(live.events.find((e) => e.type === "message.in" && e.conversationId !== live.events[0]!.conversationId)!.conversationId)!.whenIdle();
});

/**
 * The stream's reconnect timing, on a stand-in WebSocket and fake timers: each socket the adapter
 * opens is kept, and the test opens, feeds and closes it by hand. Math.random is fixed at 0.5, so a
 * full-jitter wait is half its ceiling.
 */
function timedStream(t: import("node:test").TestContext) {
  const sockets: Array<{ open(): void; frame(f: unknown): void; closed(code: number): void }> = [];
  class StandIn {
    onopen?: () => void;
    onmessage?: (m: { data: string }) => void;
    onerror?: () => void;
    onclose?: (e: { code: number; reason: string }) => void;
    constructor() {
      sockets.push({ open: () => this.onopen?.(), frame: (f) => this.onmessage?.({ data: JSON.stringify(f) }), closed: (code) => this.onclose?.({ code, reason: "" }) });
    }
    close() {}
  }
  t.mock.property(globalThis, "WebSocket", StandIn as unknown as typeof WebSocket);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0.5);
  const warnings: string[] = [];
  t.mock.method(console, "warn", (line: string) => void warnings.push(line));
  t.mock.method(console, "debug", () => {});
  const fm = flowMessaging({ apiKey: "fk_test_key", webhookSecret: "", baseUrl: "http://flow.test" });
  const handle = fm.stream({} as never);
  t.after(() => handle.close());
  /** The latest socket: it opens, Flow refuses it with one error frame, and closes it with `code`. */
  const refuse = (code: number, error: Record<string, unknown> = { type: "not_found" }) => {
    const s = sockets.at(-1)!;
    s.open();
    s.frame({ type: "error", error });
    s.closed(code);
  };
  /** Asserts the next socket opens exactly `ms` after the last close, not a millisecond sooner. */
  const reconnectsAfter = (ms: number) => {
    const before = sockets.length;
    t.mock.timers.tick(ms - 1);
    assert.equal(sockets.length, before, `no reconnect before ${ms} ms`);
    t.mock.timers.tick(1);
    assert.equal(sockets.length, before + 1, `a reconnect at ${ms} ms`);
  };
  return { sockets, handle, refuse, reconnectsAfter, warnings };
}

test("a stream refused right after it opens backs off and the wait grows: from 30 s up to 5 min after 4404 or 4429, doubling to 30 s otherwise", (t) => {
  const s = timedStream(t);
  // 4404 (the route is gone) with no retry_after: 30 s plus a jittered part whose ceiling doubles to 5 min.
  s.refuse(4404);
  s.reconnectsAfter(45_000); // 30 s + 0.5 × 30 s
  s.refuse(4404);
  s.reconnectsAfter(75_000); // 30 s + 0.5 × 90 s
  s.refuse(4404);
  s.reconnectsAfter(135_000); // 30 s + 0.5 × 210 s
  s.refuse(4429, { type: "rate_limited" });
  s.reconnectsAfter(165_000); // 30 s + 0.5 × 270 s: the 5 min cap
  s.refuse(4429, { type: "rate_limited" });
  s.reconnectsAfter(165_000);
  assert.equal(s.warnings.at(-1), "@flow-engineer/flow/flow-messaging: the stream closed (4429 rate_limited); reconnecting in 165.0 s");
  // Any other close (a server error, a dropped connection) doubles up to 30 s, and the count goes on.
  s.refuse(4500, { type: "api_error" });
  s.reconnectsAfter(15_000); // 0.5 × min(30 s, 1 s × 2^5)
});

test("a retry_after in the error frame is waited first, with the backoff on top", (t) => {
  const s = timedStream(t);
  s.refuse(4429, { type: "rate_limited", retry_after: 1 });
  s.reconnectsAfter(1_500); // 1 s + 0.5 × 1 s
  s.refuse(4503, { type: "api_error", retry_after: 20 });
  s.reconnectsAfter(21_000); // 20 s + 0.5 × 2 s
  s.refuse(4404, { type: "not_found", retry_after: 3 });
  s.reconnectsAfter(5_000); // 3 s + 0.5 × 4 s
});

test("the backoff starts again only once a connection delivers an event or stays open 30 s, never on open alone", (t) => {
  const s = timedStream(t);
  s.refuse(4500, { type: "api_error" });
  s.reconnectsAfter(500);
  s.refuse(4500, { type: "api_error" });
  s.reconnectsAfter(1_000);
  s.refuse(4500, { type: "api_error" });
  s.reconnectsAfter(2_000);

  // Open 30 s, then dropped: the next wait is the first one again.
  s.sockets.at(-1)!.open();
  t.mock.timers.tick(30_000);
  s.sockets.at(-1)!.closed(1006);
  s.reconnectsAfter(500);
  s.refuse(4500, { type: "api_error" });
  s.reconnectsAfter(1_000);

  // Open 29 s is not enough.
  s.sockets.at(-1)!.open();
  t.mock.timers.tick(29_000);
  s.sockets.at(-1)!.closed(1006);
  s.reconnectsAfter(2_000);

  // An event is: the backoff starts again at once.
  const last = s.sockets.at(-1)!;
  last.open();
  last.frame({ type: "event", event: { id: "evt_1", type: "contact.deleted", data: {} } });
  last.closed(1006);
  s.reconnectsAfter(500);
});

test("a stream stopped because the plan ended says why and Flow's hint, for the developer to show rather than retry", async (t) => {
  const s = timedStream(t);
  const hint = "Choose a plan at https://flow.engineer/dashboard/plans?plan=shared; this key works again once the plan is active.";
  s.refuse(4401, { type: "authentication", channel_code: "plan_ended", message: "This live key is paused.", hint, doc_url: "https://api.flow.engineer/docs/errors/authentication" });
  assert.deepEqual(await s.handle.stopped, { code: 4401, type: "authentication", message: "This live key is paused.", channelCode: "plan_ended", hint, docUrl: "https://api.flow.engineer/docs/errors/authentication" });
  assert.equal(s.warnings.at(-1), `@flow-engineer/flow/flow-messaging: the stream stopped: authentication (plan_ended, 4401). ${hint} (https://api.flow.engineer/docs/errors/authentication)`);
});

for (const [code, type] of [[4401, "authentication"], [4403, "permission"], [4400, "invalid_request"]] as const) {
  test(`a stream refused with ${code} stops for good, with no reconnect`, async (t) => {
    const s = timedStream(t);
    s.refuse(code, { type, message: "No." });
    assert.deepEqual(await s.handle.stopped, { code, type, message: "No." });
    t.mock.timers.tick(600_000);
    assert.equal(s.sockets.length, 1);
  });
}
