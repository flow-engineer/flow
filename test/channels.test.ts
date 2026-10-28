// covers: src/conversation.ts src/talk.ts src/channels.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { SMS as SMS_INFO, SMS_KEYWORDS, US_CARRIER_KEYWORDS, WHATSAPP as WHATSAPP_INFO, customUI, fitOutbound, fitText, keywordOf, sms, whatsapp } from "../src/channels.ts";
import { talkInstructions } from "../src/talk.ts";
import type { ChannelInfo } from "../src/types.ts";
import { IMESSAGE, TELEGRAM } from "../flow-messaging/src/index.ts";
import { channelOf, platform } from "../simulators/src/platforms.ts";
import { SMS, WHATSAPP, call, harness, respond, say, users } from "./helpers.ts";

test("every chat channel's prompt says how messages read; only channels with buttons or lists say when to offer them", () => {
  const prompt = (name: string, info: ChannelInfo) => talkInstructions([{ name, info }], { shareUpdates: true });
  const texting = "- Write like a person texting: one idea per message or short paragraph. Split a long answer into a few short messages, not one dense block.";
  const items = '- Name items from a catalogue or tool in plain words ("an oat latte", not "LATTE OAT LG 16OZ"); keep the exact title only where precision matters, such as an order summary or a list row.';
  const wa = prompt("whatsapp", whatsapp({ sendMessage: async () => {} }).info);
  assert.ok(
    wa.endsWith(
      [texting, items, "- Buttons (or a list when there are more than 3) only when their next step is to pick one of a few options, so they can tap; otherwise none, and never a button that just repeats your text."].join("\n"),
    ),
    wa,
  );
  const channels = {
    sms: sms({ sendMessage: async () => {} }).info,
    imessage: IMESSAGE,
    telegram: TELEGRAM,
    web: channelOf(platform("web")),
    app: customUI("app", { sendMessage: async () => {} }).info,
  };
  for (const [name, info] of Object.entries(channels)) {
    const text = prompt(name, info);
    assert.ok(text.includes(`${texting}\n${items}`), name);
    assert.equal(/only when their next step is to pick/.test(text), Boolean(info.buttons || info.lists), name);
  }
  assert.match(prompt("telegram", TELEGRAM), /\n- Buttons only when their next step/);
});

test("a channel without reactions or status offers only its send tool", async () => {
  const h = harness([], 50, { reactions: false, status: false });
  h.send("c11", "hi");
  const first = await h.nextCall(0);
  const names = first.request.tools.map((t) => t.name);
  assert.ok(names.includes("send_chat"));
  assert.ok(!names.includes("react") && !names.includes("share_updates"));
  assert.doesNotMatch(first.request.system, /react/, "no reactions: not offered and not mentioned");
  first.answer(respond(say("Hi!")));
  await h.agent.conversation("c11")!.whenIdle();
});

test("SMS offers no buttons, replies, reactions or images, and asks for plain text; a link's URL goes after the text", async () => {
  const h = harness([], 50, SMS);
  h.send("w1", "hi");
  const first = await h.nextCall(0);
  const send = first.request.tools.find((t) => t.name === "send_chat")!;
  assert.deepEqual(Object.keys((send.parameters as { properties: object }).properties), ["text", "link"]);
  assert.match(first.request.system, /Write plain text, not Markdown/);
  first.answer(respond(call("send_chat", { text: "Your order:", link: { label: "Track it", url: "https://example.com/o/42" } })));
  await h.agent.conversation("w1")!.whenIdle();
  assert.deepEqual(h.out.filter((o) => o.type === "message"), [{ type: "message", text: "Your order:\nhttps://example.com/o/42" }]);
});

test("WhatsApp: read receipts when the agent picks a message up, quotes and taps both ways", async () => {
  const h = harness([], 50, WHATSAPP);
  h.agent.receive("w3", { text: "Fri 9:00 AM", choice: { title: "Fri 9:00 AM" }, replyTo: { text: "Which time works?", fromAgent: true } }, (o) => void h.out.push(o), { channel: WHATSAPP });
  const first = await h.nextCall(0);
  assert.equal(users(first.request.messages).at(-1), '[m1, replying to your message "Which time works?", tapped] Fri 9:00 AM');
  assert.deepEqual(h.out.find((o) => o.type === "read"), { type: "read", messageIds: ["m1"] });
  first.answer(respond(call("send_chat", { text: "Booked!", reply_to: "m1" })));
  await h.agent.conversation("w3")!.whenIdle();
  assert.deepEqual(h.out.find((o) => o.type === "message"), { type: "message", text: "Booked!", replyTo: "m1" });
});

test("a keyword is the whole message, in any case, with only spaces, punctuation or emoji around it", () => {
  for (const [text, kind] of [["STOP", "stop"], [" stop. ", "stop"], ["Stop!! 🙏", "stop"], ["Start", "start"], ["help?", "help"]] as const) {
    assert.equal(keywordOf(SMS_KEYWORDS, text), kind, text);
  }
  for (const text of ["stop by tomorrow", "please stop", "stop 2", "st op", "STOPPED", "don't stop", "🛑", ""]) {
    assert.equal(keywordOf(SMS_KEYWORDS, text), null, text);
  }
});

test("SMS takes only STOP to opt out by default; the fuller US carrier list is opt in", () => {
  const plain = sms({ sendMessage: async () => {} });
  for (const text of ["unsubscribe", "cancel", "quit", "end", "stopall"]) assert.equal(keywordOf(plain.keywords, text), null, text);
  assert.equal(keywordOf(plain.keywords, "STOP"), "stop");
  const carrier = sms({ sendMessage: async () => {} }, { keywords: US_CARRIER_KEYWORDS });
  for (const text of ["STOP", "unsubscribe", "Cancel.", "quit", "end", "stopall"]) assert.equal(keywordOf(carrier.keywords, text), "stop", text);
  assert.equal(keywordOf(carrier.keywords, "unstop"), "start");
  for (const text of ["cancel my order", "end of the day"]) assert.equal(keywordOf(carrier.keywords, text), null, text);
});

test("on WhatsApp, Markdown and HTML it does not read become its own marks, each fix named, and a fixed text stays as it is", () => {
  const cases: Array<[string, string, string[]]> = [
    ["Our **best sellers** and __new__ ones", "Our *best sellers* and *new* ones", ["markdown_bold"]],
    ["***Last*** day", "*_Last_* day", ["markdown_bold"]],
    ["~~₹1,999~~ ₹1,499", "~₹1,999~ ₹1,499", ["markdown_strike"]],
    ["## Delivery\nTwo days.", "*Delivery*\nTwo days.", ["header"]],
    ["# **Sizes** #", "*Sizes*", ["markdown_bold", "header"]],
    ["See [the size guide](https://shop.example/sizes).", "See the size guide (https://shop.example/sizes).", ["link"]],
    ["[https://shop.example](https://shop.example) or <https://shop.example/help>", "https://shop.example or https://shop.example/help", ["link"]],
    ["| Size | Chest | Price |\n|---|:---:|---:|\n| M | 40in | ₹1,499 |\n| L | 42in | ₹1,599 |", "Size — Chest — Price\nM — 40in — ₹1,499\nL — 42in — ₹1,599", ["table"]],
    ["Size | Price\n--- | ---\nM | ₹1,499\n\nAnything else?", "Size — Price\nM — ₹1,499\n\nAnything else?", ["table"]],
    ["| M | **40in** |\n| L | 42in |", "M — *40in*\nL — 42in", ["markdown_bold", "table"]],
    ["<b>Open</b> <i>today</i> <s>Sunday</s><br>till <strong>6</strong><BR/>bye", "*Open* _today_ ~Sunday~\ntill *6*\nbye", ["html"]],
  ];
  for (const [text, want, fixed] of cases) {
    assert.deepEqual(fitText("whatsapp", text), { text: want, fixed }, text);
    assert.deepEqual(fitText("whatsapp", want), { text: want, fixed: [] }, `${want} is fixed already`);
  }
});

test("on WhatsApp its own marks, quotes, lists, code and URLs go as written; other formattings are never touched", () => {
  const alone = [
    "*bold* _italic_ ~struck~",
    "> they said\n- one\n* two\n1. three",
    "Run `**not bold**` and `a | b`",
    "```\n## not a heading\n| a | b |\n|---|---|\n**x** [t](https://x.example)\n```",
    "https://x.example/a__b__c?q=**1**&r=~~2~~",
    "#hashtag, 2 | 3, and *5* x *3*",
  ];
  for (const text of alone) assert.deepEqual(fitText("whatsapp", text), { text, fixed: [] }, text);
  const markdown = "## Sizes\n**M** is [here](https://x.example)\n| a | b |\n|---|---|";
  for (const formatting of ["markdown", "plain", undefined] as const) assert.deepEqual(fitText(formatting, markdown), { text: markdown, fixed: [] });
});

test("buttons or a list on a platform with neither (iMessage, SMS) become numbered options in the text; elsewhere, and on Telegram and iMessage's Markdown, the message goes as it was", () => {
  const buttons = { type: "message" as const, text: "Table for two at 8?", buttons: ["Yes", { id: "no", label: "Another time" }] };
  const list = { type: "message" as const, text: "", list: { button: "Sizes", rows: [{ id: "m", title: "M", description: "40in" }, { id: "l", title: "L" }] } };
  for (const info of [IMESSAGE, SMS_INFO]) {
    assert.deepEqual(fitOutbound(info, buttons), { outbound: { type: "message", text: "Table for two at 8?\n\n1. Yes\n2. Another time" }, fixed: ["options_as_text"] });
    assert.deepEqual(fitOutbound(info, list), { outbound: { type: "message", text: "1. M — 40in\n2. L" }, fixed: ["options_as_text"] });
  }
  const markdown = { type: "message" as const, text: "## Sizes\n**M** is [here](https://x.example)\n| a | b |\n|---|---|", buttons: ["Yes"] };
  for (const info of [TELEGRAM, WHATSAPP_INFO, customUI("app", { sendMessage: async () => {} }).info]) {
    const plain = { ...markdown, text: "Pick one" };
    assert.equal(fitOutbound(info, plain).outbound, plain, "a channel with buttons, or a custom UI, gets them");
  }
  for (const info of [TELEGRAM, IMESSAGE]) {
    const { buttons: _b, ...text } = markdown;
    assert.deepEqual(fitOutbound(info, text), { outbound: text, fixed: [] }, `${info.platform} renders the Markdown itself`);
  }
  const template = { type: "template" as const, name: "order_update", body: ["**42**"] };
  assert.deepEqual(fitOutbound(WHATSAPP_INFO, template), { outbound: template, fixed: [] }, "a template goes as declared");
});
