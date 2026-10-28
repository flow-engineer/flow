// covers: src/channels.ts src/talk.ts src/conversation.ts src/agent.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { contentRefusal, createAgent, customUI, sms, whatsapp, z, type AgentOptions, type Channel, type FlowEvent, type Outbound, type WhatsAppProvider } from "../src/index.ts";
import { call, last, respond, scriptedModel } from "./helpers.ts";

function agentWith(channels: Channel[], options: Partial<AgentOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "flow-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  const events: FlowEvent[] = [];
  const agent = createAgent({ dir, model: scripted.model, debounceMs: 0, channels, scheduleCheckMs: 0, events: [(e) => void events.push(e)], ...options });
  return { agent, events, ...scripted };
}

const props = (tool: { parameters: unknown }) => Object.keys((tool.parameters as { properties: object }).properties);

/** A WhatsApp provider that records what Flow Framework asked it to do. */
function recorder(extra: Partial<WhatsAppProvider> = {}) {
  const calls: unknown[][] = [];
  const provider: WhatsAppProvider = {
    sendMessage: async (to, message) => void calls.push(["sendMessage", to, message]),
    ...extra,
  };
  return { provider, calls };
}

test("WhatsApp offers the agent only what its provider can do; a link it cannot send goes as its URL in the text", async () => {
  const r = recorder({ features: { buttons: false, links: false } });
  const bare = agentWith([whatsapp(r.provider)]);
  const a = await bare.agent.message({ channel: "whatsapp", from: "+15550100100", message: "hi" });
  const first = await bare.nextCall(0);
  assert.deepEqual(props(first.request.tools.find((t) => t.name === "send_whatsapp")!), ["text", "reply_to", "list", "link", "image"]);
  assert.ok(!first.request.tools.some((t) => t.name === "react"), "no react method, no react tool");
  first.answer(respond(call("send_whatsapp", { text: "Here it is", link: { label: "Open in app", url: "https://example.com/l/7" } })));
  await bare.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(r.calls, [["sendMessage", "+15550100100", { text: "Here it is\nhttps://example.com/l/7" }]]);

  const full = recorder({ react: async () => {} });
  const switchedOff = agentWith([whatsapp(full.provider, { disable: ["reactions", "lists", "images"] })]);
  await switchedOff.agent.message({ channel: "whatsapp", from: "+15550100100", message: "hi" });
  const second = await switchedOff.nextCall(0);
  assert.deepEqual(props(second.request.tools.find((t) => t.name === "send_whatsapp")!), ["text", "reply_to", "buttons", "link"]);
  assert.ok(!second.request.tools.some((t) => t.name === "react"), "switched off though the provider has it");
});

test("one send call reaches the provider's sendMessage with everything; reactions, typing and reads go to theirs", async () => {
  const typing: boolean[] = [];
  const r = recorder({
    react: async (to, messageId, emoji) => void r.calls.push(["react", to, messageId, emoji]),
    typing: async (_to, on) => void typing.push(on),
    markRead: async (to, ids) => void r.calls.push(["markRead", to, ids]),
  });
  const h = agentWith([whatsapp(r.provider)]);
  const a = await h.agent.message({ channel: "whatsapp", from: "+15550100100", message: "which day works?" });
  const photo = { url: "https://example.com/flat.jpg" };
  (await h.nextCall(0)).answer(
    respond(
      call("react", { message_id: "m1", emoji: "👍" }),
      call("send_whatsapp", { text: "Pick one", buttons: ["Mon", "Tue"], reply_to: "m1", image: photo }),
      call("send_whatsapp", { text: "2 BHK, Indiranagar", image: photo, link: { label: "Open in app", url: "https://example.com/l/7" } }),
    ),
  );
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(r.calls, [
    ["markRead", "+15550100100", ["m1"]],
    ["react", "+15550100100", "m1", "👍"],
    ["sendMessage", "+15550100100", { text: "Pick one", replyTo: "m1", buttons: ["Mon", "Tue"], image: photo }],
    ["sendMessage", "+15550100100", { text: "2 BHK, Indiranagar", link: { label: "Open in app", url: "https://example.com/l/7" }, image: photo }],
  ]);
  assert.deepEqual(typing, [true, false]);
});

test("a carousel is offered only with the provider's sendCarousel, checked for the same buttons on every card, and sent to it; photos by file id go as fileId", async () => {
  const r = recorder({ sendCarousel: async (to, carousel) => void r.calls.push(["sendCarousel", to, carousel]) });
  const h = agentWith([whatsapp(r.provider)]);
  const a = await h.agent.message({ channel: "whatsapp", from: "+15550100100", message: "what rooms?" });
  const first = await h.nextCall(0);
  assert.ok(props(first.request.tools.find((t) => t.name === "send_whatsapp")!).includes("carousel"));
  const sea = { image: { url: "https://example.com/sea.jpg" }, text: "Sea view", buttons: ["Book sea"] };
  first.answer(respond(call("send_whatsapp", { text: "Two rooms", carousel: [sea, { image: { file_id: "file_9" }, buttons: ["Book", "More"] }] })));
  const second = await h.nextCall(1);
  assert.match(last(second.request.messages).content, /same kind and number of buttons/);
  second.answer(
    respond(
      call("send_whatsapp", { text: "Two rooms", carousel: [sea, { image: { file_id: "file_9" }, buttons: ["Book garden"] }] }),
      call("send_whatsapp", { text: "The garden room", image: { file_id: "file_9" }, buttons: ["Book it"] }),
    ),
  );
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(r.calls, [
    ["sendCarousel", "+15550100100", { text: "Two rooms", cards: [sea, { image: { fileId: "file_9" }, buttons: ["Book garden"] }] }],
    ["sendMessage", "+15550100100", { text: "The garden room", buttons: ["Book it"], image: { fileId: "file_9" } }],
  ]);
});

test("a channel that cannot show a carousel gets its text, then each card as a message, in order, each after the last went", async () => {
  const sent: unknown[] = [];
  const gates: Array<() => void> = [];
  let arrived = () => {};
  let called = new Promise<void>((resolve) => (arrived = resolve));
  const channel = whatsapp({
    sendMessage: (_to, message) => {
      sent.push(message);
      arrived();
      return new Promise<void>((resolve) => gates.push(resolve));
    },
  });
  assert.equal(channel.info.carousels, undefined, "no sendCarousel, no carousels offered");
  const done = channel.send("+15550100100", {
    type: "carousel",
    text: "Two rooms",
    idempotencyKey: "k",
    cards: [
      { image: { url: "https://example.com/sea.jpg" }, text: "Sea view", buttons: ["Book sea"] },
      { image: { fileId: "file_9" }, link: { label: "Book", url: "https://example.com/book" } },
    ],
  });
  for (let i = 0; i < 3; i++) {
    await called;
    called = new Promise<void>((resolve) => (arrived = resolve));
    assert.equal(sent.length, i + 1, "the next card waits for the last send");
    gates[i]();
  }
  await done;
  assert.deepEqual(sent, [
    { text: "Two rooms", idempotencyKey: "k" },
    { text: "Sea view", image: { url: "https://example.com/sea.jpg" }, buttons: ["Book sea"], idempotencyKey: "k:1" },
    { text: "", image: { fileId: "file_9" }, link: { label: "Book", url: "https://example.com/book" }, idempotencyKey: "k:2" },
  ]);
});

test("a custom UI's params are on its send tool only, checked, handed to its provider, and left out when empty", async () => {
  const sent: unknown[] = [];
  const app = customUI("app", {
    params: { app_link: z.object({ url: z.string(), screen: z.string().optional() }).describe("Pass a tool result's app_link here.") },
    sendMessage: async (_to, message) => void sent.push(message),
  });
  const h = agentWith([app]);
  const a = await h.agent.message({ channel: "app", from: "session-1", message: "show my progress" });
  const first = await h.nextCall(0);
  assert.ok(props(first.request.tools.find((t) => t.name === "send_app")!).includes("app_link"));
  first.answer(respond(call("send_app", { text: "Here it is.", app_link: { screen: "progress" } })));
  const second = await h.nextCall(1);
  assert.match(last(second.request.messages).content, /Not sent, fix and send again/, "app_link without its url goes back to the agent");
  second.answer(respond(call("send_app", { text: "Here it is.", app_link: { url: "https://app.example/progress", screen: "progress" } })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(sent, [{ text: "Here it is.", app_link: { url: "https://app.example/progress", screen: "progress" } }]);

  // A param the model filled with nothing ("" or null) is not sent at all.
  await h.agent.message({ channel: "app", from: "session-1", message: "thanks" });
  (await h.nextCall(2)).answer(respond(call("send_app", { text: "Anytime.", app_link: "" })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(sent.at(-1), { text: "Anytime." });
});

test("a custom UI with editMessage and unsendMessage offers edits and unsends by the ids its sendMessage resolved with; WhatsApp and SMS have neither", async () => {
  const calls: unknown[][] = [];
  const app = customUI("app", {
    sendMessage: async (_to, message) => (calls.push(["sendMessage", message.text]), { status: "sent", messageId: `ui-${calls.length}` }),
    editMessage: async (to, messageId, text) => void calls.push(["editMessage", to, messageId, text]),
    unsendMessage: async (to, messageId) => void calls.push(["unsendMessage", to, messageId]),
  });
  assert.equal(app.info.edits, true);
  assert.equal(app.info.unsends, true);
  for (const plain of [whatsapp(recorder().provider), sms({ sendMessage: async () => {} })]) {
    assert.ok(!plain.info.edits && !plain.info.unsends, `${plain.name} offers neither`);
    await assert.rejects(Promise.resolve().then(() => plain.send("+15550100100", { type: "edit", messageId: "x", text: "y" })), /cannot be edited or unsent/);
  }
  const h = agentWith([app]);
  const a = await h.agent.message({ channel: "app", from: "session-1", message: "price?" });
  (await h.nextCall(0)).answer(respond(call("send_app", { text: "₹47,133" })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  await h.agent.message({ channel: "app", from: "session-1", message: "sure?" });
  (await h.nextCall(1)).answer(respond(call("edit_message", { message_id: "ui-1", text: "₹39,500" }), call("unsend_message", { message_id: "ui-1" }), call("send_app", { text: "Fixed." })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(calls, [["sendMessage", "₹47,133"], ["editMessage", "session-1", "ui-1", "₹39,500"], ["unsendMessage", "session-1", "ui-1"], ["sendMessage", "Fixed."]]);
});

test("receive() with one of the agent's channel names plays that channel, delivering where it is told", async () => {
  const app = customUI("app", { params: { app_link: z.object({ url: z.string() }) }, sendMessage: async () => assert.fail("the simulator delivers, not the provider") });
  const h = agentWith([app]);
  const out: Outbound[] = [];
  h.agent.receive("sim:1", "show my progress", (o) => void out.push(o), { channelName: "app" });
  const first = await h.nextCall(0);
  assert.ok(props(first.request.tools.find((t) => t.name === "send_app")!).includes("app_link"));
  first.answer(respond(call("send_app", { text: "Here.", app_link: { url: "https://app.example/progress" } })));
  await h.agent.conversation("sim:1")!.whenIdle();
  assert.deepEqual(out.find((o) => o.type === "message"), { type: "message", text: "Here.", fields: { app_link: { url: "https://app.example/progress" } } });
  assert.deepEqual(h.agent.channels(), [{ name: "app", kind: "custom", info: { formatting: "markdown", reactions: false, status: false, readReceipts: false } }]);
});

test("a channel's own instructions are in the prompt only while the person uses that channel", async () => {
  const rule = "Only fill app_link with a URL from a tool result.";
  const app = customUI("app", { params: { app_link: z.object({ url: z.string() }) }, instructions: rule, sendMessage: async () => {} });
  const h = agentWith([sms({ sendMessage: async () => {} }), app]);
  const a = await h.agent.message({ channel: "sms", from: "+15550100100", message: "hi" });
  const first = await h.nextCall(0);
  assert.doesNotMatch(first.request.system, /Only fill app_link/);
  first.answer(respond(call("send_sms", { text: "Hi!" })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();

  // Someone else, on the app.
  const b = await h.agent.message({ channel: "app", from: "session-1", message: "show my progress" });
  const second = await h.nextCall(1);
  assert.ok(second.request.system.includes(`- ${rule}`));
  second.answer(respond(call("send_app", { text: "Here." })));
  await h.agent.conversation(b!.conversationId)!.whenIdle();
});

test("`writing` replaces Flow Framework's guidance on how messages read, or leaves it out; a channel's instructions still follow", async () => {
  const ours = "Keep every reply to one short message. Offer our three plans as buttons whenever pricing comes up.";
  const app = () => customUI("app", { info: { buttons: { max: 3, labelMax: 20 } }, instructions: "Fill app_link only from a tool result.", sendMessage: async () => {} });
  const system = async (writing: AgentOptions["writing"]) => {
    const h = agentWith([app()], { writing });
    const started = await h.agent.message({ channel: "app", from: "session-1", message: "how much is it?" });
    const first = await h.nextCall(0);
    first.answer(respond(call("send_app", { text: "Here." })));
    await h.agent.conversation(started!.conversationId)!.whenIdle();
    return first.request.system;
  };
  const replaced = await system(ours);
  assert.ok(replaced.includes(`- ${ours}\n- Fill app_link only from a tool result.`), replaced);
  assert.doesNotMatch(replaced, /one idea per message|in plain words|only when their next step/);
  const off = await system(false);
  assert.doesNotMatch(off, /one idea per message|in plain words|only when their next step/);
  assert.match(off, /- Markdown works here\.\n- Fill app_link only from a tool result\./);
  assert.match(await system(undefined), /one idea per message[\s\S]*only when their next step[\s\S]*- Fill app_link only from a tool result\./, "the default, with the channel's own line after it");
});

test("contentRefusal refuses what Flow Messaging refuses, with its error type, field and message, and takes the rest (a WebP header too)", () => {
  const wa = whatsapp({ sendMessage: async () => {}, sendCarousel: async () => {} }).info;
  const photo = (name: string) => ({ url: `https://example.com/${name}` });
  const card = (text: string, label: string) => ({ image: photo("a.jpg"), text, buttons: [label] });
  const refusal = (info: typeof wa, outbound: Outbound) => {
    const r = contentRefusal(info, outbound);
    return r && [r.type, r.param, r.message];
  };
  const long = (n: number) => "a".repeat(n);
  assert.deepEqual(refusal(wa, { type: "carousel", text: "Rooms", cards: [card("Sea\nview\nfor two\nwith breakfast", "Book sea"), card("Garden", "Book garden")] }), [
    "invalid_request",
    "content.cards[0].text",
    "content.cards[0].text has more than 2 line breaks.",
  ]);
  assert.deepEqual(refusal(wa, { type: "carousel", text: "Rooms", cards: [card("Sea", "Book"), card("Garden", "Book")] }), [
    "invalid_request",
    "content.cards[1].buttons[0].id",
    "Reply button ids must be unique across the carousel.",
  ]);
  const details = (id: string) => ({ image: photo("a.jpg"), buttons: [{ id, label: "Details" }] });
  assert.equal(refusal(wa, { type: "carousel", text: "Listings", cards: [details("details:a"), details("details:b")] }), null, "labels repeat across cards; ids tell them apart");
  assert.deepEqual(refusal(wa, { type: "message", text: "Which?", buttons: [{ id: "pick", label: "This" }, { id: "pick", label: "That" }] }), ["invalid_request", "content.buttons[1].id", "Button ids must be unique within a message."]);
  assert.deepEqual(refusal(wa, { type: "message", text: "Which?", buttons: [{ id: "é".repeat(32) + "a", label: "This" }] }), [
    "invalid_request",
    "content.buttons[0]",
    "A reply button needs an id of 1 to 64 bytes and a label of 1 to 20.",
  ]);
  assert.deepEqual(refusal(wa, { type: "message", text: long(1025), buttons: ["Yes", "No"] }), ["invalid_request", "content.text", "text must be 1 to 1024 characters with buttons on WhatsApp."]);
  assert.deepEqual(refusal(wa, { type: "message", text: long(1025), image: photo("a.jpg") }), ["invalid_request", "content.caption", "caption must be at most 1024 characters."]);
  assert.deepEqual(refusal(wa, { type: "message", text: "" }), ["invalid_request", "content.text", "text is empty; give 1 to 4096 characters on WhatsApp."]);
  assert.deepEqual(refusal(sms({ sendMessage: async () => {} }).info, { type: "message", text: "✓".repeat(671) }), [
    "invalid_request",
    "content.text",
    "This text is 11 SMS segments as UCS-2 because it contains an emoji or a character outside GSM-7; SMS takes at most 10.",
  ]);
  assert.equal(refusal({ ...wa, platform: "telegram" }, { type: "message", text: long(1025), buttons: ["Yes"] }), null, "Telegram takes 4096 with buttons");
  assert.equal(refusal(wa, { type: "message", text: "The menu", image: photo("menu.webp"), buttons: ["Order"] }), null, "Flow converts WebP");
  assert.equal(refusal(wa, { type: "carousel", text: "Rooms", cards: [card("Sea\nview\nfor two", "Book sea"), card("Garden", "Book garden")] }), null);
  assert.equal(refusal({ reactions: true, status: true }, { type: "message", text: "" }), null, "no platform, no rules");
});

test("a send the platform refuses goes back to the agent with Flow Messaging's error and is never handed to the provider", async () => {
  const r = recorder({ sendCarousel: async (to, carousel) => void r.calls.push(["sendCarousel", to, carousel]) });
  const h = agentWith([whatsapp(r.provider)]);
  const a = await h.agent.message({ channel: "whatsapp", from: "+15550100100", message: "what rooms?" });
  const garden = { image: { url: "https://example.com/garden.webp" }, text: "Garden", buttons: ["Book garden"] };
  (await h.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Two rooms", carousel: [{ image: { url: "https://example.com/sea.jpg" }, text: "Sea\nview\nfor two\nbreakfast", buttons: ["Book sea"] }, garden] })));
  const second = await h.nextCall(1);
  assert.match(last(second.request.messages).content, /Not sent, WhatsApp refuses it: content\.cards\[0\]\.text has more than 2 line breaks\. \(cards\[0\] is card 1\.\)/);
  const refused = h.events.find((e) => e.type === "message.refused")!;
  assert.deepEqual([refused.by, refused.code, refused.param, refused.message, refused.origin], ["content", "invalid_request", "content.cards[0].text", "content.cards[0].text has more than 2 line breaks.", "agent"]);
  const fixed = { image: { url: "https://example.com/sea.jpg" }, text: "Sea view for two", buttons: ["Book sea"] };
  second.answer(respond(call("send_whatsapp", { text: "Two rooms", carousel: [fixed, garden] })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(r.calls, [["sendCarousel", "+15550100100", { text: "Two rooms", cards: [fixed, garden] }]]);
});

test("beforeSend's message is the one checked, sent and recorded: the provider, message.out, the history and the transcript", async () => {
  const r = recorder({ sendCarousel: async (to, carousel) => void r.calls.push(["sendCarousel", to, carousel]) });
  const seen: string[] = [];
  const h = agentWith([whatsapp(r.provider)], {
    // The owner's own rule: card text on one line. It runs before the platform's rules, so its fix is what they check.
    beforeSend: (message, context) => {
      seen.push(`${context.origin} ${context.channel} ${context.address}`);
      if (message.type !== "carousel") return;
      return { ...message, cards: message.cards.map((c) => ({ ...c, text: c.text?.replaceAll("\n", " ") })) };
    },
  });
  const a = await h.agent.message({ channel: "whatsapp", from: "+15550100100", message: "what rooms?" });
  const card = (text: string, label: string) => ({ image: { url: "https://example.com/r.jpg" }, text, buttons: [label] });
  (await h.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Two rooms", carousel: [card("Sea\nview\nfor two\nbreakfast", "Book sea"), card("Garden", "Book garden")] })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  const sentCards = [card("Sea view for two breakfast", "Book sea"), card("Garden", "Book garden")];
  const result = h.followUps[0].messages.find((m) => m.role === "tool") as { content: string };
  assert.deepEqual(JSON.parse(result.content).sent, { text: "Two rooms", carousel: sentCards }, "the agent's history says what went");
  assert.deepEqual(seen, ["agent whatsapp +15550100100"]);
  assert.deepEqual(r.calls, [["sendCarousel", "+15550100100", { text: "Two rooms", cards: sentCards }]]);
  const out = h.events.find((e) => e.type === "message.out")!;
  assert.deepEqual([out.carousel, out.rewritten], [sentCards, true]);
  const transcript = await h.agent.transcript(a!.conversationId);
  assert.deepEqual(transcript.find((l) => l.kind === "out"), { kind: "out", channel: "whatsapp", text: "Two rooms", at: (transcript.find((l) => l.kind === "out") as { at: number }).at, carousel: sentCards });
});

test("beforeSend's refusal sends nothing: the agent is told why to send again, and a message.refused event records it", async () => {
  const r = recorder();
  const h = agentWith([whatsapp(r.provider)], {
    beforeSend: (message) => (message.type === "message" && /guarantee/i.test(message.text) ? { refuse: "never promise a guarantee; say what the policy covers" } : undefined),
  });
  const a = await h.agent.message({ channel: "whatsapp", from: "+15550100100", message: "is it covered?" });
  (await h.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Yes, guaranteed!" })));
  const second = await h.nextCall(1);
  assert.match(last(second.request.messages).content, /^Not sent: never promise a guarantee; say what the policy covers$/);
  const refused = h.events.find((e) => e.type === "message.refused")!;
  assert.deepEqual([refused.by, refused.text, refused.reason], ["beforeSend", "Yes, guaranteed!", "Not sent: never promise a guarantee; say what the policy covers"]);
  second.answer(respond(call("send_whatsapp", { text: "Repairs for a year are covered." })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(r.calls, [["sendMessage", "+15550100100", { text: "Repairs for a year are covered." }]]);
  assert.ok(!h.events.some((e) => e.type === "message.out" && e.text === "Yes, guaranteed!"));
});

test("the test cloud's path, receive(..., deliver), goes through the same beforeSend, content rules and record as a channel's send", async () => {
  const delivered: Outbound[] = [];
  const h = agentWith([whatsapp({ sendMessage: async () => assert.fail("receive's deliver is used, not the provider"), sendCarousel: async () => {} })], {
    beforeSend: (message) => (message.type === "message" ? { ...message, text: message.text.replace("http://", "https://") } : undefined),
  });
  h.agent.receive("t1", "hi", (o) => void delivered.push(o), { channelName: "whatsapp" });
  const card = (text: string, label: string) => ({ image: { url: "https://example.com/r.jpg" }, text, buttons: [label] });
  (await h.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Rooms", carousel: [card("a\nb\nc\nd", "Book sea"), card("Garden", "Book garden")] })));
  const second = await h.nextCall(1);
  assert.match(last(second.request.messages).content, /content\.cards\[0\]\.text has more than 2 line breaks\./);
  second.answer(respond(call("send_whatsapp", { text: "See http://example.com/rooms" })));
  await h.agent.conversation("t1")!.whenIdle();
  assert.deepEqual(delivered.filter((o) => o.type === "message" || o.type === "carousel"), [{ type: "message", text: "See https://example.com/rooms" }]);
  const out = (await h.agent.transcript("t1")).filter((l) => l.kind === "out");
  assert.deepEqual(out.map((l) => l.kind === "out" && l.text), ["See https://example.com/rooms"]);
});

test("on WhatsApp the agent's Markdown goes in WhatsApp's own marks, after beforeSend and before the content rules: what is sent, recorded and told to the agent, with message.out naming the fixes", async () => {
  const r = recorder();
  const seen: string[] = [];
  const h = agentWith([whatsapp(r.provider)], { beforeSend: (message) => void (message.type === "message" && seen.push(message.text)) });
  const a = await h.agent.message({ channel: "whatsapp", from: "+15550100100", message: "sizes?" });
  const markdown = "## Sizes\nOur **best sellers**:\n| Size | Chest | Price |\n|---|---|---|\n| M | 40in | ₹1,499 |";
  const fixed = "*Sizes*\nOur *best sellers*:\nSize — Chest — Price\nM — 40in — ₹1,499";
  (await h.nextCall(0)).answer(respond(call("send_whatsapp", { text: markdown })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(seen, [markdown], "beforeSend gets what the agent wrote");
  assert.deepEqual(r.calls, [["sendMessage", "+15550100100", { text: fixed }]]);
  const out = h.events.find((e) => e.type === "message.out")!;
  assert.deepEqual([out.text, out.fixed], [fixed, ["markdown_bold", "header", "table"]]);
  const result = h.followUps[0].messages.find((m) => m.role === "tool") as { content: string };
  assert.equal(JSON.parse(result.content).sent.text, fixed, "the agent's history says what went");
  const transcript = await h.agent.transcript(a!.conversationId);
  assert.deepEqual(transcript.flatMap((l) => (l.kind === "out" ? [l.text] : [])), [fixed]);
});
