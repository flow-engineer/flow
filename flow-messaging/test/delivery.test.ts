// covers: flow-messaging/src/index.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sqlite } from "../../src/index.ts";
import { LEASE_MS } from "../../src/conversation.ts";
import { call, respond, users } from "./helpers.ts";
import { event, fakeFlow, liveAgent, received, type Recorded } from "./fake.ts";

const WA = { id: "conv_wa", channel: "whatsapp", contact: "ct_maya" } as const;
const PATH = "/v0/conversations/conv_wa/basic";
const post = (r: Recorded) => r.method === "POST" && r.path === PATH;
const outbound = (id: string, status: string, extra: object = {}) => ({ id, conversation: "conv_wa", direction: "out", status, content: { kind: "basic", text: "x" }, ...extra });

/** An agent on Flow's WhatsApp whose first reply Flow answers 202 queued, as msg_w1. */
async function waiting(t: { after(fn: () => void): void }, messaging: NonNullable<Parameters<typeof liveAgent>[1]>["messaging"] = {}) {
  const flow = await fakeFlow();
  const live = await liveAgent(flow, { messaging });
  t.after(() => (flow.close(), live.close()));
  flow.contacts.ct_maya = { address: { phone: "+15550100100" } };
  flow.queued.push({ match: post, status: 202, body: outbound("msg_w1", "queued") });
  await live.deliver(received(WA, "msg_1", { kind: "basic", text: "hi" }));
  const id = live.events[0]!.conversationId;
  const outs = () => live.events.filter((e) => e.type === "message.out").length;
  return { flow, live, id, outs };
}

test("a send waits for its message.sent; a message.failed instead fails it, and the agent is told Not delivered once", async (t) => {
  const { flow, live, outs } = await waiting(t);
  (await live.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Hello" })));
  await flow.request(post);
  assert.equal(outs(), 0, "not out before the channel took it");
  const failed = outbound("msg_w1", "failed", { error: { type: "channel_error", channel_code: "131026", message: "The number is not on WhatsApp." } });
  assert.equal((await live.deliver(event("message.failed", WA, { message: failed }))).status, 200);
  const next = await live.nextCall(1);
  assert.match(users(next.request.messages).at(-1) ?? "", /^\[Not delivered\] "Hello": channel_error \(131026\): The number is not on WhatsApp\./);
  assert.equal(live.events.filter((e) => e.type === "message.undelivered").length, 1);
  next.answer(respond());
});

test("a template Flow accepted that the channel fails later, to someone this process never heard from, is logged at error level and told to the agent with the message's id and error", async (t) => {
  const flow = await fakeFlow();
  const live = await liveAgent(flow);
  t.after(() => (flow.close(), live.close()));
  const errors: string[] = [];
  t.mock.method(console, "error", (line: string) => void errors.push(line));
  flow.contacts.ct_new = { address: { phone: "+15550100200" } };
  flow.templates.push({ id: "tpl_order", sender: "snd_WA", name: "order_update", language: "en_US", status: "approved" });
  const nudge = await live.agent.nudge({ to: { channel: "whatsapp", address: "+15550100200" }, template: { name: "order_update", body: ["Maya", "1042"] } });
  assert.equal(nudge.status, "sent");
  const out = live.events.find((e) => e.type === "message.out")!;
  assert.equal(out.messageId, "msg_out1", "the send names Flow's message id, for its trace");

  const error = { type: "permission", channel_code: "131042", message: "The WhatsApp Business Account has no valid payment method.", hint: "Add one in WhatsApp Manager.", doc_url: "https://api.flow.engineer/docs/errors/permission" };
  const failed = { id: "msg_out1", conversation: "conv_new", direction: "out", status: "failed", content: { kind: "template", template_id: "tpl_order", language: "en_US" }, error };
  assert.equal((await live.deliver(event("message.failed", { id: "conv_new", channel: "whatsapp", contact: "ct_new" }, { message: failed }))).status, 200);
  assert.deepEqual(errors, ["@flow-engineer/flow/flow-messaging: message msg_out1 on whatsapp (conversation conv_new) was not delivered (type permission, channel_code 131042): The WhatsApp Business Account has no valid payment method. Add one in WhatsApp Manager. (https://api.flow.engineer/docs/errors/permission)"]);
  const told = live.events.filter((e) => e.type === "message.undelivered").map(({ text, channel, messageId, errorType, channelCode }) => ({ text, channel, messageId, errorType, channelCode }));
  assert.deepEqual(told, [{ text: "template order_update", channel: "whatsapp", messageId: "msg_out1", errorType: "permission", channelCode: "131042" }]);
  const next = await live.nextCall(0);
  assert.match(users(next.request.messages).at(-1) ?? "", /^\[Not delivered\] "template order_update": permission \(131042\): The WhatsApp Business Account has no valid payment method\. It will fail again/);
  next.answer(respond());
  await live.agent.conversation(out.conversationId)!.whenIdle();
});

test("a message.sent heard before Flow's 202 came back settles its send at once", async (t) => {
  const { flow, live, id, outs } = await waiting(t);
  assert.equal((await live.deliver(event("message.sent", WA, { message: outbound("msg_w1", "sent") }))).status, 200);
  (await live.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Hello" })));
  await live.agent.conversation(id)!.whenIdle();
  assert.equal(outs(), 1);
  assert.equal(flow.requests.filter((r) => r.method === "GET" && r.path.startsWith("/v0/messages/")).length, 0, "nothing read back");
});

test("with no signal within waitTimeoutMs the send goes on as message.slow and is never posted again", async (t) => {
  const { flow, live, id, outs } = await waiting(t, { waitTimeoutMs: 50 });
  (await live.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Hello" })));
  await live.agent.conversation(id)!.whenIdle();
  assert.equal(outs(), 1);
  assert.equal(live.events.filter((e) => e.type === "message.slow").length, 1);
  assert.equal(flow.sends(PATH).length, 1);
});

test("waitFor delivered waits past message.sent for message.delivered; waitFor queued goes on at the 202", async (t) => {
  const delivered = await waiting(t, { waitFor: "delivered" });
  (await delivered.live.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Hello" })));
  await delivered.flow.request(post);
  await delivered.live.deliver(event("message.sent", WA, { message: outbound("msg_w1", "sent") }));
  assert.equal(delivered.outs(), 0, "sent is not yet delivered");
  await delivered.live.deliver(event("message.delivered", WA, { message: outbound("msg_w1", "delivered") }));
  await delivered.live.agent.conversation(delivered.id)!.whenIdle();
  assert.equal(delivered.outs(), 1);

  const queued = await waiting(t, { waitFor: "queued" });
  (await queued.live.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Hello" })));
  await queued.live.agent.conversation(queued.id)!.whenIdle();
  assert.equal(queued.outs(), 1);
  assert.equal(queued.live.events.filter((e) => e.type === "message.slow").length, 0);
});

test("a turn run again by a process that never saw their message is sent into their conversation, with no sender to start one", async (t) => {
  const flow = await fakeFlow();
  t.after(() => flow.close());
  const path = join(mkdtempSync(join(tmpdir(), "flow-fm-db-")), "flow.db");
  const TG = { id: "conv_tg", channel: "telegram", contact: "ct_tg" } as const;
  flow.contacts.ct_tg = { address: { telegram_user_id: "777" } };
  flow.messages.msg_1 = { id: "msg_1", conversation: "conv_tg", direction: "in", status: "received", content: { kind: "basic", text: "open today?" } };
  const before = await liveAgent(flow, { database: sqlite(path), telegramSender: null });
  t.after(() => before.close());
  await before.deliver(received(TG, "msg_1", { kind: "basic", text: "open today?" }));
  await before.nextCall(0); // the process is stopped while the model thinks
  await before.agent.conversation(before.events[0]!.conversationId)!.stored();

  // A new process, past the old one's lease: its adapter has never seen conv_tg.
  const after = await liveAgent(flow, { database: sqlite(path), telegramSender: null, dir: before.dir, now: () => Date.now() + LEASE_MS });
  t.after(() => after.close());
  const rerun = await after.nextCall(0);
  rerun.answer(respond(call("send_telegram", { text: "Yes, until 22:00." })));
  const sent = await flow.request((r) => r.method === "POST" && r.path === "/v0/conversations/conv_tg/basic");
  assert.equal(sent.body.text, "Yes, until 22:00.");
  assert.ok(flow.requests.some((r) => r.method === "GET" && r.path === "/v0/messages/msg_1"), "found from their latest message");
  assert.ok(!flow.requests.some((r) => r.method === "POST" && r.path === "/v0/messages"), "no new conversation was started");
});
