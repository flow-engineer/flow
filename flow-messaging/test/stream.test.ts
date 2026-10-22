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
  assert.equal(first.url.pathname, "/v1/stream");
  assert.equal(first.url.searchParams.get("after"), null);
  assert.deepEqual(first.url.searchParams.getAll("type"), ["message.received", "message.failed", "reaction.added", "contact.deleted", "message.sent"]);

  const hello = received(TG, "msg_1", { type: "text", text: "hi from my phone" });
  first.send({ type: "event", event: hello });
  const turn = await live.nextCall(0);
  assert.equal(lastUser(turn.request.messages), "[msg_1] hi from my phone");
  turn.answer(respond(call("send_telegram", { text: "Hi!" })));
  assert.deepEqual((await flow.request(post("/v1/conversations/conv_tg/messages"))).body.content, { type: "text", text: "Hi!", format: "markdown" });
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

  const one = received(TG, "msg_1", { type: "text", text: "one" });
  const first = await flow.stream(0);
  first.send({ type: "event", event: one });
  (await live.nextCall(0)).answer(respond(call("send_telegram", { text: "got one" })));
  await flow.request(post("/v1/conversations/conv_tg/messages"));
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
  const two = received({ id: "conv_tg2", channel: "telegram", contact: "ct_new" }, "msg_2", { type: "text", text: "two" });
  flow.queued.push({ match: (r) => r.method === "GET" && r.path === "/v1/contacts/ct_new", status: 404, body: { error: { type: "not_found", message: "No such object." } } });
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

test("a refused key stops the stream for good, with Flow's reason, and it does not reconnect", async (t) => {
  const flow = await fakeFlow();
  t.after(() => flow.close());
  const live = streamAgent(flow);
  t.after(() => live.handle.close());
  const refused = await flow.stream(0);
  refused.send({ type: "error", error: { type: "authentication", message: "This API key has been revoked." } });
  refused.close(4401, "authentication: api key revoked");
  assert.deepEqual(await live.handle.stopped, { code: 4401, type: "authentication", message: "This API key has been revoked." });
  assert.equal(flow.streams.length, 1);
});
