// covers: src/conversation.ts src/talk.ts src/channels.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { SMS_KEYWORDS, US_CARRIER_KEYWORDS, customUI, keywordOf, sms, whatsapp } from "../src/channels.ts";
import { talkInstructions } from "../src/talk.ts";
import { createAgent, tool, type Tool } from "../src/index.ts";
import { z } from "zod";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelInfo } from "../src/types.ts";
import { IMESSAGE, TELEGRAM } from "../flow-messaging/src/index.ts";
import { channelOf, platform } from "../simulators/src/platforms.ts";
import { SMS, WHATSAPP, call, harness, respond, say, scriptedModel, users } from "./helpers.ts";

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

// On a chat app the person sees nothing while tools run, so the agent acknowledges first; a web app that draws
// every tool call (ChannelInfo.showsTools) needs no such message, and gets none, nor progress updates. Off by
// default: every channel without the flag gets exactly the prompt it had.
test("only a channel that shows its tool calls drops the acknowledgement and progress; every other prompt is unchanged", () => {
  const ack = /After they write, the first thing you do must reach them/;
  const quiet = /They see each tool call as it runs, so send nothing before or while tools run/;
  const web = channelOf(platform("web"));
  const shows = { ...web, showsTools: true };
  for (const info of [whatsapp({ sendMessage: async () => {} }).info, web]) {
    const text = talkInstructions([{ name: "c", info }], { shareUpdates: true });
    assert.match(text, ack);
    assert.doesNotMatch(text, quiet);
    assert.equal(talkInstructions([{ name: "c", info: { ...info, showsTools: false } }], { shareUpdates: true }), text, "the flag off changes nothing");
  }
  const app = talkInstructions([{ name: "app", info: shows }], { shareUpdates: true });
  assert.match(app, quiet);
  assert.doesNotMatch(app, ack);
  assert.doesNotMatch(app, /share_updates|I'm booking that now/);
  const both = talkInstructions([{ name: "whatsapp", info: whatsapp({ sendMessage: async () => {} }).info }, { name: "app", info: shows }], { shareUpdates: true });
  assert.match(both, /on every channel they are waiting on: your answer, or, if you need tools first, an acknowledgement/);
  assert.match(both, /Except on app: there they see each tool call as it runs/);
});

// A UI's own tools (the web app's views) belong to that UI: offered only while the person is on its
// channel, read every turn so the list can grow, and run there; another channel never sees them.
test("a channel's own tools are offered only on that channel, read every turn, and run there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  let ran = 0;
  const catalog: Tool[] = [tool({ name: "ui_one", description: "Shows one thing.", input: z.object({ title: z.string() }), signIn: "none", run: () => (ran++, { shown: true }) })];
  const app = customUI("app", { sendMessage: async () => {}, info: { showsTools: true }, tools: () => catalog });
  const other = customUI("other", { sendMessage: async () => {} });
  const agent = createAgent({ dir, model: scripted.model, channels: [app, other], debounceMs: 0 });
  const names = (n: number) => scripted.nextCall(n).then((c) => c.request.tools.map((t) => t.name));
  void agent.request({ channel: "app", guest: "guest-app-0000000000", text: "show it" });
  assert.ok((await names(0)).includes("ui_one"));
  (await scripted.nextCall(0)).answer(respond(call("ui_one", { title: "x" })));
  (await scripted.nextCall(1)).answer(respond(call("send_app", { text: "Here it is." })));
  assert.equal(ran, 1, "the channel's tool ran");
  catalog.push(tool({ name: "ui_two", description: "Shows another.", input: z.object({}), signIn: "none", run: () => ({}) }));
  void agent.request({ channel: "other", guest: "guest-other-00000000", text: "show it" });
  const otherTools = await names(2);
  assert.ok(!otherTools.includes("ui_one") && !otherTools.includes("ui_two"), "another channel never sees them");
  (await scripted.nextCall(2)).answer(respond(call("send_other", { text: "Hi." })));
  void agent.request({ channel: "app", guest: "guest-app-0000000000", text: "and the other" });
  assert.ok((await names(3)).includes("ui_two"), "read afresh every turn");
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
