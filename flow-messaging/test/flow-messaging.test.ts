// covers: flow-messaging/src/index.ts flow-messaging/src/client.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sqlite } from "../../src/index.ts";
import { call, respond, users } from "./helpers.ts";
import { fakeFlow, liveAgent, received, event, sign, SECRET, type Recorded } from "./fake.ts";
import { flowMessaging } from "../src/index.ts";

const WA = { id: "conv_wa", channel: "whatsapp", contact: "ct_maya" } as const;
const SMS = { id: "conv_sms", channel: "sms", contact: "ct_sam" } as const;
const TG = { id: "conv_tg", channel: "telegram", contact: "ct_tg" } as const;
const lastUser = (messages: Parameters<typeof users>[0]) => users(messages).at(-1) ?? "";
const post = (path: string) => (r: Recorded) => r.method === "POST" && r.path === path;

test("a WhatsApp message reaches the agent with its quote, and the reply, read receipt and typing go into its Flow conversation", async (t) => {
  const flow = await fakeFlow();
  const live = await liveAgent(flow);
  t.after(() => (flow.close(), live.close()));
  flow.contacts.ct_maya = { id: "ct_maya", channel: "whatsapp", address: { phone: "+15550100100" } };
  flow.messages.msg_q = { id: "msg_q", conversation: "conv_wa", direction: "out", content: { type: "text", text: "Which size?" } };

  const answer = await live.deliver(received(WA, "msg_1", { type: "text", text: "Medium please" }, { reply_to: "msg_q" }));
  assert.deepEqual(answer, { status: 200, body: "{}" });
  const first = await live.nextCall(0);
  assert.equal(lastUser(first.request.messages), '[whatsapp · msg_1, replying to your message "Which size?"] Medium please');
  first.answer(respond(call("send_whatsapp", { text: "Medium it is. Pay now?", buttons: ["Pay now", "Change"], reply_to: "msg_1" })));

  const sent = await flow.request(post("/v1/conversations/conv_wa/messages"));
  assert.deepEqual(sent.body, { content: { type: "buttons", text: "Medium it is. Pay now?", buttons: [{ id: "Pay now", label: "Pay now" }, { id: "Change", label: "Change" }] }, reply_to: "msg_1" });
  assert.equal(sent.headers.authorization, "Bearer fk_test_key");
  assert.equal(sent.headers["flow-version"], "2026-11-01");
  assert.ok(sent.headers["idempotency-key"]);
  assert.deepEqual((await flow.request(post("/v1/conversations/conv_wa/read"))).body, { up_to: "msg_1" });
  assert.deepEqual((await flow.request(post("/v1/conversations/conv_wa/typing"))).body, { state: "on" });
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();
});

test("a link goes as a url button and a photo as media with its caption; a photo with buttons goes just before them", async (t) => {
  const flow = await fakeFlow();
  const live = await liveAgent(flow);
  t.after(() => (flow.close(), live.close()));
  flow.contacts.ct_maya = { address: { phone: "+15550100100" } };
  await live.deliver(received(WA, "msg_1", { type: "text", text: "show me" }));
  const photo = "https://example.com/room.jpg";
  (await live.nextCall(0)).answer(
    respond(
      call("send_whatsapp", { text: "Book it here", link: { label: "Book", url: "https://example.com/book" } }),
      call("send_whatsapp", { text: "The sea view room", image: { url: photo } }),
      call("send_whatsapp", { text: "Want it?", image: { url: photo }, buttons: ["Yes", "No"] }),
    ),
  );
  const path = "/v1/conversations/conv_wa/messages";
  await flow.request((r) => post(path)(r) && r.body.content.text === "Want it?");
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();
  assert.deepEqual(
    flow.sends(path).map((r) => r.body.content),
    [
      { type: "buttons", text: "Book it here", buttons: [{ url: "https://example.com/book", label: "Book" }] },
      { type: "media", kind: "image", url: photo, caption: "The sea view room" },
      { type: "media", kind: "image", url: photo },
      { type: "buttons", text: "Want it?", buttons: [{ id: "Yes", label: "Yes" }, { id: "No", label: "No" }] },
    ],
  );
});

test("a photo arrives as an attachment whose bytes come from Flow's files API with the app key", async (t) => {
  const flow = await fakeFlow();
  const live = await liveAgent(flow);
  t.after(() => (flow.close(), live.close()));
  live.model.reads = { images: true };
  flow.contacts.ct_maya = { address: { phone: "+15550100100" } };
  flow.files.file_1 = Buffer.from([1, 2, 3]);
  const photo = { type: "media", kind: "image", url: `${flow.url}/v1/files/file_1`, file_id: "file_1", mime_type: "image/png", size_bytes: 3, caption: "is this ripe?" };

  await live.deliver(received(WA, "msg_1", photo));
  const first = await live.nextCall(0);
  assert.deepEqual(first.request.messages.filter((m) => m.role === "user").at(-1), {
    role: "user",
    content: "[whatsapp · msg_1] [photo] is this ripe?",
    media: [{ kind: "image", mime: "image/png", data: "AQID" }],
  });
  assert.equal((await flow.request((r) => r.path === "/v1/files/file_1")).headers.authorization, "Bearer fk_test_key");
  first.answer(respond(call("send_whatsapp", { text: "Yes, ripe" })));
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();
});

test("taps come as choices and reactions to the agent's messages as reactions", async (t) => {
  const flow = await fakeFlow();
  const live = await liveAgent(flow);
  t.after(() => (flow.close(), live.close()));
  flow.contacts.ct_maya = { address: { phone: "+15550100100" } };
  flow.messages.msg_out1 = { id: "msg_out1", conversation: "conv_wa", direction: "out", content: { type: "buttons", text: "Booked for Tuesday", buttons: [] } };

  await live.deliver(received(WA, "msg_1", { type: "button_reply", button_id: "tue", label: "Tuesday" }));
  const first = await live.nextCall(0);
  assert.equal(lastUser(first.request.messages), "[whatsapp · msg_1, tapped] Tuesday");
  first.answer(respond(call("send_whatsapp", { text: "Booked for Tuesday" })));
  await flow.request(post("/v1/conversations/conv_wa/messages"));

  assert.equal((await live.deliver(event("reaction.added", WA, { message_id: "msg_out1", emoji: "👍" }))).status, 200);
  await live.deliver(received(WA, "msg_2", { type: "text", text: "thanks" }));
  const second = await live.nextCall(1);
  assert.ok(users(second.request.messages).some((m) => m.includes('[They reacted 👍 to your message: "Booked for Tuesday"]')));
  second.answer(respond(call("send_whatsapp", { text: "Anytime" })));
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();
});

test("a delivery reaches the agent only when Flow signed it, and only once", async (t) => {
  const flow = await fakeFlow();
  const live = await liveAgent(flow);
  t.after(() => (flow.close(), live.close()));
  flow.contacts.ct_maya = { address: { phone: "+15550100100" } };
  const e = received(WA, "msg_1", { type: "text", text: "hi" });
  const body = JSON.stringify(e);

  assert.equal((await live.deliver(e, sign(body, "whsec_other"))).status, 401);
  assert.equal((await live.deliver(e, sign(body, SECRET, Math.floor(Date.now() / 1000) - 301))).status, 401);
  // While a secret is rotated, the header carries one v1 per secret.
  const rotating = `${sign(body, "whsec_old")},v1=${sign(body).split("v1=")[1]}`;
  assert.equal((await live.deliver(e, rotating)).status, 200);
  assert.equal((await live.deliver(e)).status, 200, "a redelivery is acknowledged");

  const first = await live.nextCall(0);
  first.answer(respond(call("send_whatsapp", { text: "Hi!" })));
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();
  assert.equal(live.events.filter((x) => x.type === "message.in").length, 1);
});

test("a send Flow rate-limits is retried with the same Idempotency-Key; another send gets its own", async (t) => {
  const flow = await fakeFlow();
  const live = await liveAgent(flow);
  t.after(() => (flow.close(), live.close()));
  flow.contacts.ct_maya = { address: { phone: "+15550100100" } };
  const path = "/v1/conversations/conv_wa/messages";
  flow.queued.push({ match: post(path), status: 429, body: { error: { type: "rate_limited", message: "Slow down.", hint: "", doc_url: "", retry_after: 0 } } });

  await live.deliver(received(WA, "msg_1", { type: "text", text: "hi" }));
  const first = await live.nextCall(0);
  first.answer(respond(call("send_whatsapp", { text: "One" }), call("send_whatsapp", { text: "Two" })));
  await flow.request((r) => post(path)(r) && r.body.content.text === "Two");
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();

  const keys = (text: string) => flow.sends(path).filter((r) => r.body.content.text === text).map((r) => r.headers["idempotency-key"]);
  assert.equal(keys("One").length, 2, "tried again after the 429");
  assert.equal(keys("One")[0], keys("One")[1]);
  assert.notEqual(keys("Two")[0], keys("One")[0]);
  assert.ok(live.events.some((x) => x.type === "message.out" && x.text === "One"), "the retried send counts as delivered");
});

test("Flow's outside_window refusal is the Flow Framework's outside_window, and a template goes out by its approved id with its header, body and button values", async (t) => {
  const flow = await fakeFlow();
  const live = await liveAgent(flow);
  t.after(() => (flow.close(), live.close()));
  flow.contacts.ct_maya = { address: { phone: "+15550100100" } };
  flow.templates.push({ id: "tpl_order", sender: "snd_WA", name: "order_update", language: "en_US", status: "approved" });
  await live.deliver(received(WA, "msg_1", { type: "text", text: "hi" }));
  (await live.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Hi!" })));
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();
  const to = { channel: "whatsapp", address: "+15550100100" };

  const path = "/v1/conversations/conv_wa/messages";
  flow.queued.push({ match: post(path), status: 409, body: { error: { type: "outside_window", message: "Last message was 31h ago.", hint: "", doc_url: "" } } });
  const refused = await live.agent.nudge({ to, text: "Your order shipped" });
  assert.deepEqual([refused.status, refused.reason], ["failed", "outside_window"]);

  const result = await live.agent.nudge({ to, template: { name: "order_update", variables: { "2": "1042", "1": "Maya" } } });
  assert.equal(result.status, "sent");
  assert.match((await flow.request((r) => r.method === "GET" && r.path.startsWith("/v1/templates"))).path, /sender=snd_WA&status=approved/);
  assert.deepEqual(flow.sends(path).at(-1)!.body, { content: { type: "template", template_id: "tpl_order", language: "en_US", params: { body: ["Maya", "1042"] } } });

  const full = { name: "order_update", header: { kind: "image" as const, fileId: "file_box" }, body: ["Maya", "1042"], buttons: [{ index: 0, value: "1042" }, { index: 1, value: "reschedule" }] };
  assert.equal((await live.agent.nudge({ to, template: full })).status, "sent");
  assert.deepEqual(flow.sends(path).at(-1)!.body.content.params, {
    header: { kind: "image", file_id: "file_box" },
    body: ["Maya", "1042"],
    buttons: [{ index: 0, value: "1042" }, { index: 1, value: "reschedule" }],
  });
});

test("failures reach the agent as Not delivered: a permanent refusal once, untried again, and a late message.failed", async (t) => {
  const flow = await fakeFlow();
  const live = await liveAgent(flow);
  t.after(() => (flow.close(), live.close()));
  flow.contacts.ct_sam = { address: { phone: "+15550100111" } };
  const path = "/v1/conversations/conv_sms/messages";
  flow.queued.push({ match: post(path), status: 403, body: { error: { type: "permission", channel_code: "contact_opted_out", message: "The contact opted out.", hint: "", doc_url: "" } } });

  await live.deliver(received(SMS, "msg_1", { type: "text", text: "hi" }));
  (await live.nextCall(0)).answer(respond(call("send_sms", { text: "Hello" })));
  const second = await live.nextCall(1);
  assert.equal(lastUser(second.request.messages), "[Not delivered] \"Hello\": permission (contact_opted_out): The contact opted out. It will fail again: don't resend it.");
  assert.equal(flow.sends(path).length, 1, "a permanent refusal is not tried again");

  second.answer(respond(call("send_sms", { text: "Are you there?" })));
  await flow.request((r) => post(path)(r) && r.body.content.text === "Are you there?");
  const failed = { id: "msg_out1", conversation: "conv_sms", direction: "out", status: "failed", content: { type: "text", text: "Are you there?" }, error: { type: "channel_error", channel_code: "carrier_filtered", message: "A carrier filtered it." } };
  assert.equal((await live.deliver(event("message.failed", SMS, { message: failed }))).status, 200);
  const third = await live.nextCall(2);
  assert.equal(lastUser(third.request.messages), "[Not delivered] \"Are you there?\": channel_error (carrier_filtered): A carrier filtered it. It will fail again: don't resend it.");
  third.answer(respond(call("send_sms", { text: "Sorry about that" })));
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();
});

test("after a restart, a nudge with no known Flow conversation starts one from the channel's sender (Telegram, Markdown)", async (t) => {
  const flow = await fakeFlow();
  const database = join(mkdtempSync(join(tmpdir(), "flow-fm-db-")), "agent.db");
  flow.contacts.ct_tg = { address: { telegram_user_id: "777", username: "maya" } };
  const before = await liveAgent(flow, { database: sqlite(database) });
  await before.deliver(received(TG, "msg_1", { type: "text", text: "hi" }));
  (await before.nextCall(0)).answer(respond(call("send_telegram", { text: "Hi!" })));
  await before.agent.conversation(before.events[0].conversationId)!.whenIdle();
  before.close();

  const after = await liveAgent(flow, { database: sqlite(database) });
  t.after(() => (flow.close(), after.close()));
  assert.equal((await after.agent.nudge({ to: { channel: "telegram", address: "777" }, text: "Your table is **ready**" })).status, "sent");
  assert.deepEqual((await flow.request(post("/v1/messages"))).body, { sender: "snd_TG", to: { telegram_user_id: "777" }, content: { type: "text", text: "Your table is **ready**", format: "markdown" } });
});

test("the key and base URL come from FLOW_MESSAGING_KEY and FLOW_MESSAGING_BASE_URL, as in Flow's SDKs, else the older names", async (t) => {
  const flow = await fakeFlow();
  t.after(() => flow.close());
  const names = ["FLOW_MESSAGING_KEY", "FLOW_MESSAGING_API_KEY", "FLOW_MESSAGING_BASE_URL", "FLOW_MESSAGING_API_URL"];
  const saved = names.map((n) => [n, process.env[n]] as const);
  t.after(() => saved.forEach(([n, v]) => (v === undefined ? delete process.env[n] : (process.env[n] = v))));
  const nudge = async (text: string) => {
    const channel = flowMessaging({ webhookSecret: SECRET }).telegram({ sender: "snd_TG" });
    await channel.send("777", { type: "message", text });
    return flow.request((r) => post("/v1/messages")(r) && r.body.content.text === text);
  };

  names.forEach((n) => delete process.env[n]);
  process.env.FLOW_MESSAGING_KEY = "fk_test_new";
  process.env.FLOW_MESSAGING_BASE_URL = flow.url;
  process.env.FLOW_MESSAGING_API_KEY = "fk_test_old";
  process.env.FLOW_MESSAGING_API_URL = "http://127.0.0.1:1";
  assert.equal((await nudge("one")).headers.authorization, "Bearer fk_test_new");

  delete process.env.FLOW_MESSAGING_KEY;
  delete process.env.FLOW_MESSAGING_BASE_URL;
  process.env.FLOW_MESSAGING_API_URL = flow.url;
  assert.equal((await nudge("two")).headers.authorization, "Bearer fk_test_old");
});

test("contact.deleted forgets the contact's Flow conversation: a later nudge starts a new one from the sender", async (t) => {
  const flow = await fakeFlow();
  const live = await liveAgent(flow);
  t.after(() => (flow.close(), live.close()));
  flow.contacts.ct_maya = { address: { phone: "+15550100100" } };
  await live.deliver(received(WA, "msg_1", { type: "text", text: "hi" }));
  (await live.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Hi!" })));
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();
  assert.equal(flow.sends("/v1/conversations/conv_wa/messages").length, 1);

  // contact.deleted has no conversation (the spec's ContactDeletedEvent).
  const now = new Date().toISOString();
  const deleted = { id: "evt_deleted", type: "contact.deleted", created_at: now, app: "app_test", livemode: false, timing: { received_at: now, stored_at: now }, data: { contact: "ct_maya" } };
  assert.equal((await live.deliver(deleted)).status, 200);
  delete flow.contacts.ct_maya;

  assert.equal((await live.agent.nudge({ to: { channel: "whatsapp", address: "+15550100100" }, text: "We kept nothing about you" })).status, "sent");
  assert.deepEqual((await flow.request(post("/v1/messages"))).body, { sender: "snd_WA", to: { phone: "+15550100100" }, content: { type: "text", text: "We kept nothing about you", format: "plain" } });
  assert.equal(flow.sends("/v1/conversations/conv_wa/messages").length, 1, "nothing more into the erased conversation");
});

test("trailing slashes come off the base URL, in linear time even on a long run of slashes that does not end the URL", async (t) => {
  const flow = await fakeFlow();
  t.after(() => flow.close());
  const started = performance.now();
  flowMessaging({ apiKey: "fk_test_key", webhookSecret: SECRET, baseUrl: "http://127.0.0.1:1" + "/".repeat(200_000) + "x" });
  assert.ok(performance.now() - started < 1000, "a quadratic trim takes seconds on this input");

  const channel = flowMessaging({ apiKey: "fk_test_key", webhookSecret: SECRET, baseUrl: flow.url + "///" }).telegram({ sender: "snd_TG" });
  await channel.send("777", { type: "message", text: "slashes" });
  assert.ok(await flow.request((r) => post("/v1/messages")(r) && r.body.content.text === "slashes"));
});
