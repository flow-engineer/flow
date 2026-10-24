// covers: flow-messaging/src/index.ts
import assert from "node:assert/strict";
import { test } from "node:test";
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
