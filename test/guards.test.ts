// covers: src/guards.ts src/conversation.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { guards, linkAllowlist, noRepeats, noWriteButtons, oncePerChat, type OutboundMessage, type SendContext } from "../src/index.ts";
import { SMS, call, last, multi, respond } from "./helpers.ts";

const ctx = (sent: string[] = [], origin: SendContext["origin"] = "agent"): SendContext => ({ conversationId: "c1", channel: "sms", info: SMS, address: "+15550100100", origin, sent });
const text = (t: string, extra: Partial<Extract<OutboundMessage, { type: "message" }>> = {}): OutboundMessage => ({ type: "message", text: t, ...extra });

test("oncePerChat takes out a line already sent and refuses a message that was only that line", async () => {
  const once = oncePerChat("I'm an AI assistant.");
  assert.equal(await once(text("I'm an AI assistant. How can I help?"), ctx()), undefined, "the first time it goes");
  const said = ["I'm an AI assistant. How can I help?"];
  assert.deepEqual(await once(text("i'm an AI   assistant. Your order ships today."), ctx(said)), text("Your order ships today."));
  assert.ok("refuse" in ((await once(text("I'm an AI assistant."), ctx(said))) as object));
});

test("noRepeats refuses a long message already sent, any case or spacing; short replies may repeat", async () => {
  const check = noRepeats();
  const said = ["Your table for two is booked for 8pm.", "Got it."];
  assert.ok("refuse" in ((await check(text("your table for two  is booked for 8pm."), ctx(said))) as object));
  assert.equal(await check(text("Got it."), ctx(said)), undefined);
  assert.equal(await check(text("Your table for two is booked for 9pm."), ctx(said)), undefined);
});

test("linkAllowlist allows a host and its subdomains, in the text, a link button or a photo, and refuses any other", async () => {
  const check = linkAllowlist(["example.com", /^cdn\d\.img\.net$/]);
  assert.equal(await check(text("See https://shop.example.com/menu.", { link: { label: "Menu", url: "https://example.com/m" }, image: { url: "https://cdn2.img.net/a.jpg" } }), ctx()), undefined);
  const refused = await check(text("Try https://elsewhere.io/deal"), ctx());
  assert.deepEqual(refused, { refuse: "it links to elsewhere.io, which is not an allowed site; leave that link out." });
  assert.ok("refuse" in ((await check(text("hi", { link: { label: "x", url: "https://notexample.com" } }), ctx())) as object));
});

test("noWriteButtons refuses a button or list row that would do an action with one tap, by whole word", async () => {
  const check = noWriteButtons(["pay", "confirm order"]);
  assert.ok("refuse" in ((await check(text("Ready?", { buttons: ["Confirm order"] }), ctx())) as object));
  assert.ok("refuse" in ((await check(text("Ready?", { buttons: [{ id: "pay", label: "Go ahead" }] }), ctx())) as object), "an id counts too");
  assert.equal(await check(text("Which?", { buttons: ["Paypal info", "Payment options"] }), ctx()), undefined);
});

test("guards run in order on the message the one before left, the first refusal wins, and only the agent's own sends are checked by default", async () => {
  const both = guards(oncePerChat("Hi, I'm Ava."), noRepeats());
  const said = ["Hi, I'm Ava.", "Your parcel is out for delivery."];
  assert.ok("refuse" in ((await both(text("Hi, I'm Ava. Your parcel is out for delivery."), ctx(said))) as object), "the repeat is seen once the greeting is out");
  assert.equal(await both(text("Hi, I'm Ava."), ctx(said, "direct")), undefined, "a scheduled message is not checked");
  assert.deepEqual(await guards(noRepeats({ origins: ["direct"] }))(text("Your parcel is out for delivery."), ctx(said, "direct")), { refuse: "you already sent this exact message; say something new, or nothing." });
});

test("what was sent reaches beforeSend from the stored history, so a once-per-chat line holds after a restart", async () => {
  const beforeSend = oncePerChat("I'm an AI assistant.");
  const h = multi({ channels: { sms: { info: SMS, phone: true } }, beforeSend });
  const a = await h.message("sms", "+15550100100", "hi");
  (await h.nextCall(0)).answer(respond(call("send_sms", { text: "I'm an AI assistant. How can I help?" })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  await h.agent.conversation(a!.conversationId)!.stored();

  const restarted = multi({ channels: { sms: { info: SMS, phone: true } }, database: h.database, beforeSend });
  await restarted.agent.resume();
  await restarted.message("sms", "+15550100100", "where is my order?");
  const turn = await restarted.nextCall(0);
  turn.answer(respond(call("send_sms", { text: "I'm an AI assistant. It ships today." })));
  await restarted.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(restarted.texts(), ["It ships today."]);
  assert.deepEqual(JSON.parse(last(restarted.followUps[0].messages).content).sent, { text: "It ships today." }, "the agent is told what went");
});
