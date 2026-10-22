// covers: src/conversation.ts src/talk.ts src/channels.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { SMS_KEYWORDS, US_CARRIER_KEYWORDS, WHATSAPP as WHATSAPP_INFO, contentRefusal, fileDropped, fitMessage, keywordOf, sms } from "../src/channels.ts";
import type { ChannelInfo, OutboundFile } from "../src/types.ts";
import { SMS, WEB_APP, WHATSAPP, call, harness, respond, say, users } from "./helpers.ts";

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

test("a channel with files offers a file of its kinds on the send tool; it goes alone, its text the caption, and the transcript keeps it", async () => {
  const h = harness([], 50, { ...WEB_APP, files: { kinds: ["document", "audio"], captionMax: 40 } });
  h.send("f1", "the menu please");
  const first = await h.nextCall(0);
  const file = (first.request.tools.find((t) => t.name === "send_chat")!.parameters as { properties: { file: { anyOf: Array<{ properties: { kind: { enum: string[] } } }> } } }).properties.file;
  assert.deepEqual(file.anyOf.map((o) => o.properties.kind.enum), [["document", "audio"], ["document", "audio"]]);
  const menu = { kind: "document", url: "https://example.com/menu.pdf", name: "menu.pdf" };
  first.answer(respond(call("send_chat", { text: "Here", file: menu, buttons: ["Thanks"] })));
  const again = await h.nextCall(1);
  assert.match(again.request.messages.at(-1)!.content, /a file goes alone/);
  again.answer(respond(call("send_chat", { text: "Today's menu", file: menu })));
  await h.agent.conversation("f1")!.whenIdle();
  assert.deepEqual(h.out.filter((o) => o.type === "message"), [{ type: "message", text: "Today's menu", file: { kind: "document", name: "menu.pdf", url: "https://example.com/menu.pdf" } }]);
  const out = (await h.agent.transcript("f1")).filter((l) => l.kind === "out");
  assert.deepEqual(out.map((l) => l.kind === "out" && l.file), [{ kind: "document", name: "menu.pdf", url: "https://example.com/menu.pdf" }]);
});

test("fitMessage: a voice note goes as audio where only audio goes; elsewhere a file by URL goes as its URL after the text, one by id is left out and fileDropped says why", () => {
  const audioOnly: ChannelInfo = { reactions: false, status: false, files: { kinds: ["audio"], captionMax: 100 } };
  const none: ChannelInfo = { reactions: false, status: false };
  assert.deepEqual(fitMessage(audioOnly, { text: "Listen", file: { kind: "voice", fileId: "f1" } }), { text: "Listen", file: { kind: "audio", fileId: "f1" } });
  assert.deepEqual(fitMessage(none, { text: "Menu", file: { kind: "document", url: "https://example.com/m.pdf" } }), { text: "Menu\nhttps://example.com/m.pdf" });
  assert.deepEqual(fitMessage(none, { text: "Menu", file: { kind: "document", fileId: "f1" } }), { text: "Menu" });
  assert.equal(fileDropped(none, { kind: "document", fileId: "f1" }), "this channel sends no files");
  assert.equal(fileDropped(audioOnly, { kind: "video", fileId: "f1" }), "this channel sends no video files");
  assert.equal(fileDropped(audioOnly, { kind: "voice", fileId: "f1" }), null);
});

test("Flow Messaging's content rules for files: a document's caption is at most 1,024 characters, an audio file's text is a text of its own, and a URL must be https", () => {
  const long = "a".repeat(1100);
  const msg = (file: OutboundFile, text = "Here") => ({ type: "message" as const, text, file });
  assert.equal(contentRefusal(WHATSAPP_INFO, msg({ kind: "document", url: "https://example.com/a.pdf" }, long))?.param, "content.caption");
  assert.equal(contentRefusal(WHATSAPP_INFO, msg({ kind: "audio", fileId: "file_1" }, long)), null);
  assert.equal(contentRefusal(WHATSAPP_INFO, msg({ kind: "video", url: "http://example.com/v.mp4" }))?.param, "content.url");
});
