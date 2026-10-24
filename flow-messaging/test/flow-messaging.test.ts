// covers: flow-messaging/src/index.ts flow-messaging/src/client.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sqlite, type ChatMessage } from "../../src/index.ts";
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
  flow.messages.msg_q = { id: "msg_q", conversation: "conv_wa", direction: "out", content: { kind: "basic", text: "Which size?" } };

  const answer = await live.deliver(received(WA, "msg_1", { kind: "basic", text: "Medium please" }, { reply_to: "msg_q" }));
  assert.deepEqual(answer, { status: 200, body: "{}" });
  const first = await live.nextCall(0);
  assert.equal(lastUser(first.request.messages), '[whatsapp · msg_1, replying to your message "Which size?"] Medium please');
  first.answer(respond(call("send_whatsapp", { text: "Medium it is. Pay now?", buttons: ["Pay now", "Change"], reply_to: "msg_1" })));

  const sent = await flow.request(post("/v0/conversations/conv_wa/buttons"));
  assert.deepEqual(sent.body, { text: "Medium it is. Pay now?", buttons: [{ id: "Pay now", label: "Pay now" }, { id: "Change", label: "Change" }], reply_to: "msg_1" });
  assert.equal(sent.headers.authorization, "Bearer fk_test_key");
  assert.equal(sent.headers["flow-version"], "2026-11-01");
  assert.ok(sent.headers["idempotency-key"]);
  assert.deepEqual((await flow.request(post("/v0/conversations/conv_wa/read"))).body, { up_to: "msg_1" });
  // Typing has no state: the call shows it, and it clears itself when the reply goes.
  assert.deepEqual((await flow.request(post("/v0/conversations/conv_wa/typing"))).body, {});
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();
});

test("a link goes as a url button and a photo as media with its caption; a photo with buttons or a link is their message's image header, by URL or Flow file id", async (t) => {
  const flow = await fakeFlow();
  const live = await liveAgent(flow);
  t.after(() => (flow.close(), live.close()));
  flow.contacts.ct_maya = { address: { phone: "+15550100100" } };
  await live.deliver(received(WA, "msg_1", { kind: "basic", text: "show me" }));
  const photo = "https://example.com/room.jpg";
  (await live.nextCall(0)).answer(
    respond(
      call("send_whatsapp", { text: "Book it here", link: { label: "Book", url: "https://example.com/book" } }),
      call("send_whatsapp", { text: "The sea view room", image: { url: photo } }),
      call("send_whatsapp", { text: "Want it?", image: { url: photo }, buttons: ["Yes", "No"] }),
      call("send_whatsapp", { text: "Or this one", image: { file_id: "file_7" }, link: { label: "Book", url: "https://example.com/book" } }),
    ),
  );
  await flow.request((r) => r.method === "POST" && r.body?.text === "Or this one");
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();
  assert.deepEqual(
    flow.into("conv_wa").map((r) => [r.path.split("/").at(-1), r.body]),
    [
      ["buttons", { text: "Book it here", buttons: [{ url: "https://example.com/book", label: "Book" }] }],
      ["basic", { media: { type: "image", url: photo }, text: "The sea view room" }],
      ["buttons", { text: "Want it?", buttons: [{ id: "Yes", label: "Yes" }, { id: "No", label: "No" }], header: { type: "image", url: photo } }],
      ["buttons", { text: "Or this one", buttons: [{ url: "https://example.com/book", label: "Book" }], header: { type: "image", file_id: "file_7" } }],
    ],
  );
});

test("a carousel goes as one Flow carousel, each card's photo its header and each button its own id, labels repeating across cards", async (t) => {
  const flow = await fakeFlow();
  const live = await liveAgent(flow);
  t.after(() => (flow.close(), live.close()));
  flow.contacts.ct_maya = { address: { phone: "+15550100100" } };
  await live.deliver(received(WA, "msg_1", { kind: "basic", text: "what rooms?" }));
  const first = await live.nextCall(0);
  const tool = first.request.tools.find((x) => x.name === "send_whatsapp");
  assert.ok(JSON.stringify(tool).includes('"carousel"'), "WhatsApp on Flow offers carousels");
  first.answer(
    respond(
      call("send_whatsapp", {
        text: "Two rooms free tonight",
        carousel: [
          { image: { url: "https://example.com/sea.jpg" }, text: "Sea view", buttons: [{ id: "book:sea", label: "Book" }] },
          { image: { file_id: "file_9" }, buttons: [{ id: "book:garden", label: "Book" }] },
        ],
      }),
    ),
  );
  const sent = await flow.request(post("/v0/conversations/conv_wa/carousel"));
  assert.deepEqual(sent.body, {
    text: "Two rooms free tonight",
    cards: [
      { header: { type: "image", url: "https://example.com/sea.jpg" }, text: "Sea view", buttons: [{ id: "book:sea", label: "Book" }] },
      { header: { type: "image", file_id: "file_9" }, buttons: [{ id: "book:garden", label: "Book" }] },
    ],
  });
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();
});

test("a photo arrives as an attachment whose bytes come from Flow's files API with the app key", async (t) => {
  const flow = await fakeFlow();
  const live = await liveAgent(flow);
  t.after(() => (flow.close(), live.close()));
  live.model.reads = { images: true };
  flow.contacts.ct_maya = { address: { phone: "+15550100100" } };
  flow.files.file_1 = Buffer.from([1, 2, 3]);
  const photo = { kind: "basic", text: "is this ripe?", media: { type: "image", url: `${flow.url}/v0/files/file_1`, file_id: "file_1", mime_type: "image/png", size_bytes: 3 } };

  await live.deliver(received(WA, "msg_1", photo));
  const first = await live.nextCall(0);
  assert.deepEqual(first.request.messages.filter((m) => m.role === "user").at(-1), {
    role: "user",
    content: "[whatsapp · msg_1] [photo] is this ripe?",
    media: [{ kind: "image", mime: "image/png", data: "AQID" }],
  });
  assert.equal((await flow.request((r) => r.path === "/v0/files/file_1")).headers.authorization, "Bearer fk_test_key");
  first.answer(respond(call("send_whatsapp", { text: "Yes, ripe" })));
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();
});

test("taps come as choices, with the button's id (info.buttonIds says so), and reactions to the agent's messages as reactions", async (t) => {
  const fm = flowMessaging({ apiKey: "fk_test_key" });
  assert.equal(fm.whatsapp({ sender: "snd_wa" }).info.buttonIds, true);
  assert.equal(fm.telegram({ sender: "snd_tg" }).info.buttonIds, true);
  assert.equal(fm.whatsapp({ sender: "snd_wa2", disable: ["buttons"] }).info.buttonIds, undefined, "no buttons, no claim about their ids");
  const flow = await fakeFlow();
  const live = await liveAgent(flow);
  t.after(() => (flow.close(), live.close()));
  flow.contacts.ct_maya = { address: { phone: "+15550100100" } };
  flow.messages.msg_out1 = { id: "msg_out1", conversation: "conv_wa", direction: "out", content: { kind: "buttons", text: "Booked for Tuesday", buttons: [] } };

  await live.deliver(received(WA, "msg_1", { kind: "button_reply", button_id: "tue", label: "Tuesday" }));
  const first = await live.nextCall(0);
  assert.equal(lastUser(first.request.messages), "[whatsapp · msg_1, tapped] Tuesday (tue)");
  assert.deepEqual(live.events.find((e) => e.type === "message.in")?.choice, { id: "tue", title: "Tuesday" });
  first.answer(respond(call("send_whatsapp", { text: "Booked for Tuesday" })));
  await flow.request(post("/v0/conversations/conv_wa/basic"));
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();

  assert.equal((await live.deliver(event("reaction.added", WA, { message_id: "msg_out1", emoji: "👍" }))).status, 200);
  await live.deliver(received(WA, "msg_2", { kind: "basic", text: "thanks" }));
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
  const e = received(WA, "msg_1", { kind: "basic", text: "hi" });
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
  const path = "/v0/conversations/conv_wa/basic";
  flow.queued.push({ match: post(path), status: 429, body: { error: { type: "rate_limited", message: "Slow down.", hint: "", doc_url: "", retry_after: 0 } } });

  await live.deliver(received(WA, "msg_1", { kind: "basic", text: "hi" }));
  const first = await live.nextCall(0);
  first.answer(respond(call("send_whatsapp", { text: "One" }), call("send_whatsapp", { text: "Two" })));
  await flow.request((r) => post(path)(r) && r.body.text === "Two");
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();

  const keys = (text: string) => flow.sends(path).filter((r) => r.body.text === text).map((r) => r.headers["idempotency-key"]);
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
  await live.deliver(received(WA, "msg_1", { kind: "basic", text: "hi" }));
  (await live.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Hi!" })));
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();
  const to = { channel: "whatsapp", address: "+15550100100" };

  const path = "/v0/conversations/conv_wa/basic";
  const templates = "/v0/conversations/conv_wa/template";
  flow.queued.push({ match: post(path), status: 409, body: { error: { type: "outside_window", message: "Last message was 31h ago.", hint: "", doc_url: "" } } });
  const refused = await live.agent.nudge({ to, text: "Your order shipped" });
  assert.deepEqual([refused.status, refused.reason], ["failed", "outside_window"]);

  const result = await live.agent.nudge({ to, template: { name: "order_update", variables: { "2": "1042", "1": "Maya" } } });
  assert.equal(result.status, "sent");
  assert.match((await flow.request((r) => r.method === "GET" && r.path.startsWith("/v0/templates"))).path, /sender=snd_WA&status=approved/);
  assert.deepEqual(flow.sends(templates).at(-1)!.body, { template_id: "tpl_order", language: "en_US", params: { body: ["Maya", "1042"] } });

  const full = { name: "order_update", header: { kind: "image" as const, fileId: "file_box" }, body: ["Maya", "1042"], buttons: [{ index: 0, value: "1042" }, { index: 1, value: "reschedule" }] };
  assert.equal((await live.agent.nudge({ to, template: full })).status, "sent");
  assert.deepEqual(flow.sends(templates).at(-1)!.body.params, {
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
  const path = "/v0/conversations/conv_sms/basic";
  flow.queued.push({ match: post(path), status: 403, body: { error: { type: "permission", channel_code: "contact_opted_out", message: "The contact opted out.", hint: "", doc_url: "" } } });

  await live.deliver(received(SMS, "msg_1", { kind: "basic", text: "hi" }));
  (await live.nextCall(0)).answer(respond(call("send_sms", { text: "Hello" })));
  const second = await live.nextCall(1);
  assert.equal(lastUser(second.request.messages), "[Not delivered] \"Hello\": permission (contact_opted_out): The contact opted out. It will fail again: don't resend it.");
  assert.equal(flow.sends(path).length, 1, "a permanent refusal is not tried again");

  second.answer(respond(call("send_sms", { text: "Are you there?" })));
  await flow.request((r) => post(path)(r) && r.body.text === "Are you there?");
  const failed = { id: "msg_out1", conversation: "conv_sms", direction: "out", status: "failed", content: { kind: "basic", text: "Are you there?" }, error: { type: "channel_error", channel_code: "carrier_filtered", message: "A carrier filtered it." } };
  assert.equal((await live.deliver(event("message.failed", SMS, { message: failed }))).status, 200);
  const third = await live.nextCall(2);
  assert.equal(lastUser(third.request.messages), "[Not delivered] \"Are you there?\": channel_error (carrier_filtered): A carrier filtered it. It will fail again: don't resend it.");
  third.answer(respond(call("send_sms", { text: "Sorry about that" })));
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();
});

test("on Telegram a send resolves with Flow's message id, which the agent edits (PATCH /v0/messages/{id}) and unsends (DELETE) by; an edit Flow refuses at the call goes back to it as Flow's error", async (t) => {
  const flow = await fakeFlow();
  const live = await liveAgent(flow);
  t.after(() => (flow.close(), live.close()));
  flow.contacts.ct_tg = { address: { telegram_user_id: "777" } };
  const tools = (r: { request: { messages: ChatMessage[] } }) => r.request.messages.flatMap((m) => (m.role === "tool" ? [m.content] : []));

  await live.deliver(received(TG, "msg_1", { kind: "basic", text: "top bid?" }));
  (await live.nextCall(0)).answer(respond(call("send_telegram", { text: "Top bid ₹47,133" }), call("send_telegram", { text: "Bid?" })));
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();
  await live.deliver(received(TG, "msg_2", { kind: "basic", text: "hm" }));
  const second = await live.nextCall(1);
  assert.deepEqual(tools(second).slice(-2).map((r) => JSON.parse(r).message_id), ["msg_out1", "msg_out2"]);
  flow.queued.push({ match: (r) => r.method === "PATCH" && r.path === "/v0/messages/msg_out2", status: 422, body: { error: { type: "unsupported_content", param: "kind", channel: "telegram", message: "This message can no longer be edited.", hint: "", doc_url: "" } } });
  second.answer(respond(call("edit_message", { message_id: "msg_out1", text: "Top bid **₹39,500**" }), call("edit_message", { message_id: "msg_out2", text: "Bid now?" }), call("unsend_message", { message_id: "msg_out2" })));
  const third = await live.nextCall(2);
  assert.deepEqual(tools(third).slice(-3), [
    JSON.stringify({ edited: true, channel: "telegram", message_id: "msg_out1" }),
    "Not edited: unsupported_content (param kind, on telegram): This message can no longer be edited.",
    JSON.stringify({ unsent: true, channel: "telegram", message_id: "msg_out2" }),
  ]);
  // The new text goes as a send's would: the agent's Markdown as Telegram's HTML.
  assert.deepEqual((await flow.request((r) => r.method === "PATCH" && r.path === "/v0/messages/msg_out1")).body, { text: "Top bid <b>₹39,500</b>", telegram: { parse_mode: "HTML" } });
  const unsend = await flow.request((r) => r.method === "DELETE" && r.path === "/v0/messages/msg_out2");
  assert.equal(unsend.body, undefined, "an unsend has no body");
  third.answer(respond(call("send_telegram", { text: "Corrected above." })));
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();

  // An edit Flow took that the channel refused later (a message of kind edit) comes back as what it was.
  const failed = { id: "msg_e1", conversation: "conv_tg", direction: "out", status: "failed", content: { kind: "edit", message_id: "msg_out1", text: "Top bid <b>₹39,500</b>", telegram: { parse_mode: "HTML" } }, error: { type: "channel_error", message: "Telegram refused the edit." } };
  await live.deliver(event("message.failed", TG, { message: failed }));
  const told = await live.nextCall(3);
  assert.equal(lastUser(told.request.messages), "[Not delivered] \"edit of msg_out1: Top bid <b>₹39,500</b>\": channel_error: Telegram refused the edit. It will fail again: don't resend it.");
  told.answer(respond(call("send_telegram", { text: "Top bid is ₹39,500." })));
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();
  // So does an unsend the channel refused.
  await live.deliver(event("message.failed", TG, { message: { id: "msg_u1", conversation: "conv_tg", direction: "out", status: "failed", content: { kind: "unsend", message_id: "msg_out2" }, error: { type: "unsupported_content", channel_code: "unsend_window_closed", message: "Telegram allows unsends within 48 hours of sending." } } }));
  const toldUnsend = await live.nextCall(4);
  assert.match(lastUser(toldUnsend.request.messages), /^\[Not delivered\] "unsend of msg_out2": unsupported_content \(unsend_window_closed\): Telegram allows unsends within 48 hours of sending\./);
  toldUnsend.answer(respond(call("send_telegram", { text: "Sorry, that last one stays." })));
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();
});

test("after a restart, a nudge with no known Flow conversation starts one from the channel's sender (Telegram, Markdown); a sent nudge gives the message's id", async (t) => {
  const flow = await fakeFlow();
  const database = join(mkdtempSync(join(tmpdir(), "flow-fm-db-")), "agent.db");
  flow.contacts.ct_tg = { address: { telegram_user_id: "777", username: "maya" } };
  const before = await liveAgent(flow, { database: sqlite(database) });
  await before.deliver(received(TG, "msg_1", { kind: "basic", text: "hi" }));
  (await before.nextCall(0)).answer(respond(call("send_telegram", { text: "Hi!" })));
  await before.agent.conversation(before.events[0].conversationId)!.whenIdle();
  before.close();

  const after = await liveAgent(flow, { database: sqlite(database) });
  t.after(() => (flow.close(), after.close()));
  const nudged = await after.agent.nudge({ to: { channel: "telegram", address: "777" }, text: "Your table is **ready**" });
  assert.deepEqual([nudged.status, nudged.messageId], ["sent", "msg_out2"], "a sent nudge names the message Flow sent");
  // A start is a basic message with where it goes; the agent's Markdown goes as Telegram's HTML.
  assert.deepEqual((await flow.request(post("/v0/messages"))).body, { sender: "snd_TG", to: { telegram_user_id: "777" }, kind: "basic", text: "Your table is <b>ready</b>", telegram: { parse_mode: "HTML" } });
  // A prompt nudge names the agent's first message.
  const prompted = after.agent.nudge({ to: { channel: "telegram", address: "777" }, prompt: "Their table is ready" });
  (await after.nextCall(0)).answer(respond(call("send_telegram", { text: "Your table is ready!" }), call("send_telegram", { text: "See you soon." })));
  assert.deepEqual([(await prompted).status, (await prompted).messageId], ["sent", "msg_out3"]);
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
    return flow.request((r) => post("/v0/messages")(r) && r.body.text === text);
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
  await live.deliver(received(WA, "msg_1", { kind: "basic", text: "hi" }));
  (await live.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Hi!" })));
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();
  assert.equal(flow.into("conv_wa").length, 1);

  // contact.deleted has no conversation (the spec's ContactDeletedEvent).
  const now = new Date().toISOString();
  const deleted = { id: "evt_deleted", type: "contact.deleted", created_at: now, app: "app_test", livemode: false, timing: { received_at: now, stored_at: now }, data: { contact: "ct_maya" } };
  assert.equal((await live.deliver(deleted)).status, 200);
  delete flow.contacts.ct_maya;

  assert.equal((await live.agent.nudge({ to: { channel: "whatsapp", address: "+15550100100" }, text: "We kept nothing about you" })).status, "sent");
  // A message the business starts goes with link previews off, so its text is the phone's notification.
  assert.deepEqual((await flow.request(post("/v0/messages"))).body, { sender: "snd_WA", to: { phone: "+15550100100" }, kind: "basic", text: "We kept nothing about you", link_preview: false });
  assert.equal(flow.into("conv_wa").length, 1, "nothing more into the erased conversation");
});

test("trailing slashes come off the base URL, in linear time even on a long run of slashes that does not end the URL", async (t) => {
  const flow = await fakeFlow();
  t.after(() => flow.close());
  const started = performance.now();
  flowMessaging({ apiKey: "fk_test_key", webhookSecret: SECRET, baseUrl: "http://127.0.0.1:1" + "/".repeat(200_000) + "x" });
  assert.ok(performance.now() - started < 1000, "a quadratic trim takes seconds on this input");

  const channel = flowMessaging({ apiKey: "fk_test_key", webhookSecret: SECRET, baseUrl: flow.url + "///" }).telegram({ sender: "snd_TG" });
  await channel.send("777", { type: "message", text: "slashes" });
  assert.ok(await flow.request((r) => post("/v0/messages")(r) && r.body.text === "slashes"));
});

test("a nudge's send carries an Idempotency-Key from its id, the same in every process that sends it", async (t) => {
  const flow = await fakeFlow();
  const live = await liveAgent(flow);
  t.after(() => (flow.close(), live.close()));
  flow.contacts.ct_maya = { address: { phone: "+15550100100" } };
  flow.templates.push({ id: "tpl_order", sender: "snd_WA", name: "order_update", language: "en_US", status: "approved" });
  await live.deliver(received(WA, "msg_1", { kind: "basic", text: "hi" }));
  (await live.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Hi!" })));
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();
  const to = { channel: "whatsapp", address: "+15550100100" };

  const text = await live.agent.nudge({ to, text: "Your order shipped" });
  assert.equal(text.status, "sent");
  assert.equal(flow.sends("/v0/conversations/conv_wa/basic").at(-1)!.headers["idempotency-key"], `nudge:${text.id}`);
  const template = await live.agent.nudge({ to, template: { name: "order_update", body: ["Maya", "1042"] } });
  assert.equal(template.status, "sent");
  assert.equal(flow.sends("/v0/conversations/conv_wa/template").at(-1)!.headers["idempotency-key"], `nudge:${template.id}`);
});

test("events in the older shape (an app Flow still serves through its bridge to the older API) read as their kinds: text, a photo with its caption, a file Flow did not keep, a quote", async (t) => {
  const flow = await fakeFlow();
  const live = await liveAgent(flow);
  t.after(() => (flow.close(), live.close()));
  live.model.reads = { images: true };
  flow.contacts.ct_maya = { address: { phone: "+15550100100" } };
  flow.files.file_1 = Buffer.from([1, 2, 3]);
  flow.messages.msg_q = { id: "msg_q", conversation: "conv_wa", direction: "out", content: { type: "text", text: "Which size?" } };

  await live.deliver(received(WA, "msg_1", { type: "text", text: "Medium" }, { reply_to: "msg_q" }));
  const first = await live.nextCall(0);
  assert.equal(lastUser(first.request.messages), '[whatsapp · msg_1, replying to your message "Which size?"] Medium');
  first.answer(respond(call("send_whatsapp", { text: "ok" })));
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();

  await live.deliver(received(WA, "msg_2", { type: "media", kind: "image", url: `${flow.url}/v1/files/file_1`, file_id: "file_1", mime_type: "image/png", caption: "this one" }));
  const second = await live.nextCall(1);
  assert.deepEqual(second.request.messages.filter((m) => m.role === "user").at(-1), { role: "user", content: "[whatsapp · msg_2] [photo] this one", media: [{ kind: "image", mime: "image/png", data: "AQID" }] });
  second.answer(respond(call("send_whatsapp", { text: "ok" })));
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();

  await live.deliver(received(WA, "msg_3", { type: "file_blocked", kind: "document", reason: "malware", caption: "the invoice" }));
  const third = await live.nextCall(2);
  assert.equal(lastUser(third.request.messages), "[whatsapp · msg_3] the invoice [document: not received (malware)]");
  third.answer(respond(call("send_whatsapp", { text: "ok" })));
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();

  // The same file not kept, in the new shape: its media kind is `media_type`, since `kind` is the message's.
  await live.deliver(received(WA, "msg_4", { kind: "file_blocked", media_type: "document", reason: "too_large" }));
  const fourth = await live.nextCall(3);
  assert.equal(lastUser(fourth.request.messages), "[whatsapp · msg_4] [document: not received (too_large)]");
  fourth.answer(respond(call("send_whatsapp", { text: "ok" })));
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();
});

test("on Telegram the agent's Markdown goes as Telegram's HTML, and a carousel as its text, then one message per card: its photo, text and buttons (a card with no buttons, its photo), each keyed from the carousel's key", async (t) => {
  const flow = await fakeFlow();
  const live = await liveAgent(flow);
  t.after(() => (flow.close(), live.close()));
  flow.contacts.ct_tg = { address: { telegram_user_id: "777" } };
  await live.deliver(received(TG, "msg_1", { kind: "basic", text: "rooms?" }));
  (await live.nextCall(0)).answer(respond(call("send_telegram", { text: "Two **rooms** & a _view_" }), call("send_telegram", { text: "Plain text" })));
  await flow.request((r) => r.method === "POST" && r.body?.text === "Plain text");
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();
  assert.deepEqual(
    flow.into("conv_tg").map((r) => r.body),
    [{ text: "Two <b>rooms</b> &amp; a <i>view</i>", telegram: { parse_mode: "HTML" } }, { text: "Plain text" }],
  );

  const channel = flowMessaging({ apiKey: "fk_test_key", baseUrl: flow.url }).telegram({ sender: "snd_TG" });
  const cards = [
    { image: { url: "https://example.com/sea.jpg" }, text: "**Sea** view", buttons: [{ id: "book:sea", label: "Book" }] },
    { image: { fileId: "file_9" }, text: "Garden", link: { label: "See", url: "https://example.com/garden" } },
    { image: { url: "https://example.com/roof.jpg" } },
  ];
  assert.equal((await channel.send("777", { type: "carousel", text: "Tonight", cards, idempotencyKey: "nudge:7" }))?.status, "sent");
  const pieces = flow.requests.filter((r) => r.method === "POST" && r.headers["idempotency-key"]?.toString().startsWith("nudge:7"));
  assert.deepEqual(
    pieces.map((r) => [r.path, r.headers["idempotency-key"], r.body]),
    [
      ["/v0/messages", "nudge:7:text", { sender: "snd_TG", to: { telegram_user_id: "777" }, kind: "basic", text: "Tonight" }],
      ["/v0/conversations/conv_started/buttons", "nudge:7:card:0", { text: "<b>Sea</b> view", telegram: { parse_mode: "HTML" }, buttons: [{ id: "book:sea", label: "Book" }], header: { type: "image", url: "https://example.com/sea.jpg" } }],
      ["/v0/conversations/conv_started/buttons", "nudge:7:card:1", { text: "Garden", buttons: [{ url: "https://example.com/garden", label: "See" }], header: { type: "image", file_id: "file_9" } }],
      ["/v0/conversations/conv_started/basic", "nudge:7:card:2", { media: { type: "image", url: "https://example.com/roof.jpg" } }],
    ],
  );
  // Telegram shows a card's buttons under its text, and Flow takes no buttons message without one: refused before anything is sent.
  const before = flow.requests.length;
  await assert.rejects(async () => channel.send("777", { type: "carousel", text: "Tonight", cards: [cards[0]!, { image: { url: "https://example.com/x.jpg" }, buttons: ["Book"] }] }), /card 2 has none/);
  assert.equal(flow.requests.length, before);
});

test("on WhatsApp a list goes as Flow's list with its label and row descriptions, and more than 3 buttons as a list under Choose", async (t) => {
  const flow = await fakeFlow();
  const live = await liveAgent(flow);
  t.after(() => (flow.close(), live.close()));
  flow.contacts.ct_maya = { address: { phone: "+15550100100" } };
  await live.deliver(received(WA, "msg_1", { kind: "basic", text: "which day?" }));
  const first = await live.nextCall(0);
  const tool = first.request.tools.find((x) => x.name === "send_whatsapp");
  assert.ok(JSON.stringify(tool).includes('"maxLength":24'), "list rows take WhatsApp's 24 characters");
  first.answer(respond(call("send_whatsapp", { text: "Pick a day", list: { button: "Days", rows: [{ id: "mon", title: "Monday", description: "From 9am" }, { id: "tue", title: "Tuesday" }] } })));
  const list = await flow.request(post("/v0/conversations/conv_wa/list"));
  assert.deepEqual(list.body, { text: "Pick a day", button: "Days", sections: [{ rows: [{ id: "mon", title: "Monday", description: "From 9am" }, { id: "tue", title: "Tuesday" }] }] });
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();

  // A channel of its own, which starts the conversation with a text first.
  const channel = flowMessaging({ apiKey: "fk_test_key", baseUrl: flow.url }).whatsapp({ sender: "snd_WA" });
  await channel.send("+15550100100", { type: "message", text: "Hi" });
  await channel.send("+15550100100", { type: "message", text: "Size?", buttons: ["S", "M", "L", "XL"], idempotencyKey: "k1" });
  assert.equal((await flow.request((r) => r.headers["idempotency-key"] === "k1")).path, "/v0/conversations/conv_started/list");
  assert.deepEqual((await flow.request((r) => r.headers["idempotency-key"] === "k1")).body, { text: "Size?", button: "Choose", sections: [{ rows: ["S", "M", "L", "XL"].map((b) => ({ id: b, title: b })) }] });
});

test("a 422 unsupported_content reaches the agent saying what the channel does not take, where and why; a first message that is not text is refused before anything is sent", async (t) => {
  const flow = await fakeFlow();
  const live = await liveAgent(flow);
  t.after(() => (flow.close(), live.close()));
  flow.contacts.ct_sam = { address: { phone: "+15550100111" } };
  await live.deliver(received(SMS, "msg_1", { kind: "basic", text: "hi" }));
  const unsupported = { error: { type: "unsupported_content", message: "This number cannot send media.", hint: "Send the text alone.", doc_url: "", param: "media", channel: "sms", channel_code: "no_mms" } };
  flow.queued.push({ match: post("/v0/conversations/conv_sms/basic"), status: 422, body: unsupported });
  (await live.nextCall(0)).answer(respond(call("send_sms", { text: "Hello" })));
  const next = await live.nextCall(1);
  assert.equal(lastUser(next.request.messages), '[Not delivered] "Hello": unsupported_content (no_mms, param media, on sms): This number cannot send media. It will fail again: don\'t resend it.');
  next.answer(respond(call("send_sms", { text: "ok" })));
  await live.agent.conversation(live.events[0].conversationId)!.whenIdle();

  const channel = flowMessaging({ apiKey: "fk_test_key", baseUrl: flow.url }).whatsapp({ sender: "snd_WA" });
  const before = flow.requests.length;
  await assert.rejects(async () => channel.send("+15550100199", { type: "message", text: "Pick", buttons: ["A", "B"] }), /a first message can only be a text or a template \(this is a buttons message\)/);
  assert.equal(flow.requests.length, before);
  await channel.send("+15550100199", { type: "message", text: "Book here", link: { label: "Book", url: "https://example.com/book" }, preview: false });
  assert.deepEqual((await flow.request((r) => post("/v0/messages")(r) && r.body.to.phone === "+15550100199")).body, { sender: "snd_WA", to: { phone: "+15550100199" }, kind: "basic", text: "Book here\nhttps://example.com/book", link_preview: false });
});
