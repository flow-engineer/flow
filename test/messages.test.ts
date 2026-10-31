// covers: src/conversation.ts src/talk.ts src/agent.ts src/store.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { defaultHistoryTokens } from "../src/agent.ts";
import { tool } from "../src/index.ts";
import { SMS, WEB, WHATSAPP, call, harness, last, multi, respond, say, users } from "./helpers.ts";

test("the person's messages carry ids the agent can react to", async () => {
  const h = harness();
  const id = h.send("c1", "order 1042");
  assert.equal(id, "m1");
  const first = await h.nextCall(0);
  assert.equal(users(first.request.messages).at(-1), "[m1] order 1042");
  first.answer(respond(call("react", { message_id: "m1", emoji: "👍" })));
  await h.agent.conversation("c1")!.whenIdle();
  assert.deepEqual(h.out.filter((o) => o.type === "reaction"), [{ type: "reaction", emoji: "👍", messageId: "m1" }]);
});

test("a message that waits for their reply ends the turn: it goes once, with no extra step to send it again", async () => {
  const h = harness([], 50, WHATSAPP, "manual");
  h.send("w1", "hi");
  const first = await h.nextCall(0);
  const send = first.request.tools.find((t) => t.name === "send_chat")!.parameters as { required: string[] };
  assert.ok(send.required.includes("next"), "the model is asked to say what it does next, every time");
  first.answer(respond(call("send_chat", { text: "Hi! What can I do for you?", buttons: ["Order", "Track", "Help"], next: "wait" })));
  await h.agent.conversation("w1")!.whenIdle();
  assert.deepEqual(h.out.filter((o) => o.type === "message"), [{ type: "message", text: "Hi! What can I do for you?", buttons: ["Order", "Track", "Help"] }]);
  assert.equal(h.calls.length, 1);
});

test("a send that does not say what comes next waits for their reply", async () => {
  const h = harness([], 50, WEB, "manual");
  h.send("c2", "hi");
  (await h.nextCall(0)).answer(respond(say("Hi! What can I do for you?")));
  await h.agent.conversation("c2")!.whenIdle();
  assert.deepEqual(h.sent(), ["Hi! What can I do for you?"]);
  assert.equal(h.calls.length, 1);
});

test("a message that says it acts next gets one more step: the tool runs and its result is sent", async () => {
  const plan = tool({ name: "get_plan", description: "", input: z.object({}), run: () => "DASH, sodium under 1,500 mg" });
  const h = harness([plan], 50, WEB, "manual");
  h.send("c4", "send me my plan");
  (await h.nextCall(0)).answer(respond(call("send_chat", { text: "Getting your plan.", next: "act" })));
  const step = await h.nextCall(1);
  const result = step.request.messages.findLast((m) => m.role === "tool") as { content: string };
  assert.deepEqual(JSON.parse(result.content), { delivered: true, channel: "chat", next: "You said you act next: call that tool now." }, "it is told its message went and that it said it acts next");
  step.answer(respond(call("get_plan")));
  (await h.nextCall(2)).answer(respond(say("Your plan: DASH, sodium under 1,500 mg.")));
  await h.agent.conversation("c4")!.whenIdle();
  assert.deepEqual(h.sent(), ["Getting your plan.", "Your plan: DASH, sodium under 1,500 mg."]);
  assert.equal(h.calls.length, 3);
});

test("saying it acts next twice with no tool between ends the turn", async () => {
  const h = harness([], 50, WEB, "manual");
  h.send("c5", "send me my plan");
  (await h.nextCall(0)).answer(respond(call("send_chat", { text: "Getting your plan.", next: "act" })));
  (await h.nextCall(1)).answer(respond(call("send_chat", { text: "One moment.", next: "act" })));
  await h.agent.conversation("c5")!.whenIdle();
  assert.deepEqual(h.sent(), ["Getting your plan.", "One moment."]);
  assert.equal(h.calls.length, 2);
});

test("a message that fails to arrive comes back to the agent", async () => {
  const h = harness();
  h.send("c9", "hello");
  h.failNext("the number opted out");
  (await h.nextCall(0)).answer(respond(say("Hi there!")));
  const second = await h.nextCall(1);
  assert.match(last(second.request.messages).content, /\[Not delivered\] "Hi there!": the number opted out/);
  second.answer(respond());
  // They still have heard nothing, so the agent is reminded once; then the turn ends.
  const third = await h.nextCall(2);
  assert.match(last(third.request.messages).content, /Reply with send_chat/);
  third.answer(respond());
  await h.agent.conversation("c9")!.whenIdle();
  assert.equal(h.calls.length, 3);
});

test("a message the channel refuses goes back to the agent to fix", async () => {
  const h = harness([], 50, WHATSAPP);
  h.send("w2", "which day?");
  (await h.nextCall(0)).answer(respond(call("send_chat", { text: "Pick one", buttons: ["Mon", "Tue", "Wed", "Thu"] })));
  const second = await h.nextCall(1);
  assert.match(last(second.request.messages).content, /Not sent, fix and send again/);
  second.answer(respond(call("send_chat", { text: "Pick one", buttons: ["Mon", "Tue", "Wed"] })));
  await h.agent.conversation("w2")!.whenIdle();
  const sent = h.out.filter((o) => o.type === "message");
  assert.deepEqual(sent, [{ type: "message", text: "Pick one", buttons: ["Mon", "Tue", "Wed"] }]);
});

test("WhatsApp's rules for links and images go back to the agent to fix: no link with buttons, no image with a list, a caption's length, https only", async () => {
  const h = harness([], 50, { ...WHATSAPP, linkButton: { labelMax: 20 }, images: { captionMax: 1024 } });
  h.send("w3", "show me flats");
  const link = { label: "Open in app", url: "https://example.com/l/7" };
  const photo = { url: "https://example.com/flat.jpg" };
  const rows = [{ id: "r1", title: "2 BHK" }];
  (await h.nextCall(0)).answer(
    respond(
      call("send_chat", { text: "Pick one", link, buttons: ["Yes"] }),
      call("send_chat", { text: "Pick one", image: photo, list: { button: "Flats", rows } }),
      call("send_chat", { text: "x".repeat(1025), image: photo }),
      call("send_chat", { text: "Here", image: { url: "http://example.com/flat.jpg" } }),
    ),
  );
  const second = await h.nextCall(1);
  const results = second.request.messages.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
  assert.equal(results.length, 4);
  assert.match(results[0], /link cannot also have buttons or a list/);
  assert.match(results[1], /image cannot also have a list/);
  assert.match(results[2], /caption, at most 1024 characters/);
  assert.match(results[3], /Not sent, fix and send again/);
  second.answer(respond(call("send_chat", { text: "2 BHK, Indiranagar", image: photo, link })));
  await h.agent.conversation("w3")!.whenIdle();
  assert.deepEqual(h.out.filter((o) => o.type === "message"), [{ type: "message", text: "2 BHK, Indiranagar", image: photo, link }]);
});

test("a reaction from the person is noted for the next turn without starting one", async () => {
  const h = harness([], 50, WHATSAPP);
  h.send("w4", "thanks");
  (await h.nextCall(0)).answer(respond(say("Anytime!")));
  await h.agent.conversation("w4")!.whenIdle();
  h.agent.reacted("w4", "❤️", "Anytime!");
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, 1, "no turn for a reaction alone");
  h.send("w4", "one more thing");
  const second = await h.nextCall(1);
  assert.deepEqual(users(second.request.messages).slice(-2), ['[They reacted ❤️ to your message: "Anytime!"]', "[m2] one more thing"]);
  second.answer(respond(say("Sure, go ahead.")));
  await h.agent.conversation("w4")!.whenIdle();
});

test("a message the provider sends again (a webhook retried) is taken once; the same id from someone else, or on another channel, is new", async () => {
  const h = multi({ channels: { sms: { info: SMS, phone: true }, whatsapp: { info: WHATSAPP, phone: true } } });
  const first = { channel: "sms", from: "+15550100100", message: "first", messageId: "SM9f2c" };
  const [a, b] = await Promise.all([h.agent.message(first), h.agent.message(first)]);
  assert.deepEqual(a, b);
  const turn = await h.nextCall(0);
  assert.deepEqual(users(turn.request.messages), ["[sms · SM9f2c] first"]);
  turn.answer(respond(call("send_sms", { text: "Got it." })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  await h.agent.message(first);
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.equal(h.calls.length, 1, "no turn for the repeat");
  assert.equal(h.events.filter((e) => e.type === "message.duplicate").length, 2);

  // Some providers number messages per chat, so the same id from someone else is a new message.
  const other = await h.agent.message({ ...first, from: "+15550100200" });
  assert.notEqual(other!.conversationId, a!.conversationId);
  assert.equal(h.events.filter((e) => e.type === "message.duplicate").length, 2, "not taken as a repeat");
  const theirs = await h.nextCall(1);
  assert.deepEqual(users(theirs.request.messages), ["[sms · SM9f2c] first"]);
  theirs.answer(respond(call("send_sms", { text: "Got it." })));
  await h.agent.conversation(other!.conversationId)!.whenIdle();

  const sameId = await h.agent.message({ channel: "whatsapp", from: "15550100100", message: "second", messageId: "SM9f2c" });
  assert.equal(sameId!.conversationId, a!.conversationId);
  assert.equal(h.events.filter((e) => e.type === "message.duplicate").length, 2, "not taken as a repeat");
  const next = await h.nextCall(2);
  assert.match(users(next.request.messages).at(-1)!, /^\[whatsapp · SM9f2c\] second$/);
  next.answer(respond(call("send_whatsapp", { text: "Got that too." })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
});

test("a long conversation sends the model only its latest messages that fit", async () => {
  const report = tool({ name: "report", description: "", input: z.object({}), run: () => "x".repeat(5_000) });
  const h = multi({ channels: { sms: { info: SMS, phone: true } }, tools: [report], history: { maxTokens: 5_000, toolResultChars: 1_000 } });
  const a = await h.message("sms", "+15550100100", "I'm Sam, allergic to nuts");
  (await h.nextCall(0)).answer(respond(call("send_sms", { text: "Noted, Sam." })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  for (let i = 0; i < 8; i++) {
    await h.message("sms", "+15550100100", `${i}: ${"a long story ".repeat(120)}`);
    (await h.nextCall(1 + i)).answer(respond(call("send_sms", { text: "Mm." })));
    await h.agent.conversation(a!.conversationId)!.whenIdle();
  }
  await h.message("sms", "+15550100100", "what can I eat?");
  const ask = await h.nextCall(9);
  const sent = ask.request.messages;
  assert.match(sent[0].role === "user" ? sent[0].content : "", /^\[Chinwag\] Older messages of this conversation are no longer shown to you\.$/);
  assert.equal(sent[1].role, "user", "it starts at the start of an entry, never at a tool result");
  assert.ok(!sent.some((m) => m.role === "user" && m.content.includes("allergic")), "the first message is left out");
  assert.match(users(sent).at(-1)!, /what can I eat\?$/);
  const chars = ask.request.system.length + JSON.stringify(ask.request.tools).length + sent.reduce((n, m) => n + (m.content?.length ?? 0) + (m.role === "assistant" ? JSON.stringify(m.toolCalls ?? []).length : 0), 0);
  assert.ok(chars / 3 <= 5_000, `within the budget (${Math.round(chars / 3)} tokens)`);
  assert.ok(h.events.some((e) => e.type === "history.trimmed"));

  ask.answer(respond(call("send_sms", { text: "Checking." }), call("report")));
  const result = await h.nextCall(10);
  assert.match(last(result.request.messages).content, /^x{1000}\n\[Chinwag\] Cut: the result was 5000 characters; only the first 1000 are shown\.$/);
  result.answer(respond(call("send_sms", { text: "Anything without nuts." })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
});

test("after resetHistory the model is sent only what comes after it, with the app's note; the transcript keeps everything", async () => {
  const h = multi({ channels: { sms: { info: SMS, phone: true } } });
  const to = { channel: "sms", address: "+15550100100" };
  assert.deepEqual(await h.agent.resetHistory({ to }), { status: "refused", reason: "unknown_person" });
  const a = await h.message("sms", to.address, "I'm Sam, order 1042 is late");
  (await h.nextCall(0)).answer(respond(call("send_sms", { text: "Sorry Sam, it ships today." })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();

  assert.deepEqual(await h.agent.resetHistory({ to, note: "Order 1042 was late; it shipped." }), { status: "reset" });
  assert.equal(h.calls.length, 1, "a reset starts no turn");
  await h.message("sms", to.address, "new order please");
  const next = await h.nextCall(1);
  assert.deepEqual(users(next.request.messages).map((u) => u.replace(/^\[m\d+\] /, "")), [
    "[Chinwag] The conversation starts again here: earlier messages are no longer shown to you.\nBefore this: Order 1042 was late; it shipped.",
    "new order please",
  ]);
  assert.ok(!next.request.messages.some((m) => m.role === "assistant" && JSON.stringify(m.toolCalls).includes("ships today")));
  assert.ok(h.events.some((e) => e.type === "history.reset"));
  next.answer(respond(call("send_sms", { text: "What would you like?" })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  const transcript = await h.agent.transcript(a!.conversationId);
  assert.deepEqual(transcript.filter((e) => e.kind === "in").map((e) => e.text), ["I'm Sam, order 1042 is late", "new order please"]);
});

test("a reset kept in the store holds after a restart, and the person's messages not yet answered stay", async () => {
  const h = multi({ channels: { sms: { info: SMS, phone: true } } });
  const to = { channel: "sms", address: "+15550100100" };
  const a = await h.message("sms", to.address, "my old booking");
  (await h.nextCall(0)).answer(respond(call("send_sms", { text: "Booked for Friday." })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  await h.message("sms", to.address, "can I change it?");
  (await h.nextCall(1)).answer(respond());
  (await h.nextCall(2)).answer(respond()); // asked once more, it still says nothing
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  await h.agent.conversation(a!.conversationId)!.stored();

  const restarted = multi({ channels: { sms: { info: SMS, phone: true } }, database: h.database });
  await restarted.agent.resume();
  assert.deepEqual(await restarted.agent.resetHistory({ to }), { status: "reset" });
  await restarted.message("sms", to.address, "hello?");
  const next = await restarted.nextCall(0);
  const shown = users(next.request.messages);
  assert.ok(!shown.some((u) => u.includes("old booking")), "what was answered before the reset is left out");
  assert.ok(shown.some((u) => u.includes("can I change it?")), "the unanswered message stays");
  assert.match(shown.at(-1)!, /hello\?$/);
  next.answer(respond(call("send_sms", { text: "Yes, to which day?" })));
  await restarted.agent.conversation(a!.conversationId)!.whenIdle();
});

test("the default history budget is 24,000 tokens, or 60% of the model's window when that is less", () => {
  assert.deepEqual([defaultHistoryTokens(), defaultHistoryTokens(200_000), defaultHistoryTokens(32_000)], [24_000, 24_000, 19_200]);
});
