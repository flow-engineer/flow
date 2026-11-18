// covers: testing/src/variant-counts.ts
// The counts `flow test compare` shows are computed from the agent's events: this fixture is one conversation of three turns shaped as
// recorded runs are (an acknowledgement with the first tool call, text beside a second round, a plain-text answer that needed a re-send).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlowEvent } from "../src/index.ts";
import { conversationCounts, conversationRun } from "../testing/src/variant-counts.ts";

const C = "whatsapp:tse_X.order.whatsapp.1";
let at = 0;
const ev = (type: FlowEvent["type"], detail: Record<string, unknown> = {}, id = C): FlowEvent => ({ type, conversationId: id, at: (at += 100), ...detail });
const usage = (i: number, o: number, cached: number, costUsd: number) => ({ inputTokens: i, outputTokens: o, cacheReadTokens: cached, costUsd });

test("per-turn counts, the second-round text rule and the extra call to send are read from the events", () => {
  at = 0;
  const events: FlowEvent[] = [
    // Turn 1: acknowledgement beside the first tool call, then the answer: 2 messages, 2 model calls, 1 tool.
    ev("message.in", { text: "a latte" }),
    ev("turn.start", { turn: 1 }),
    ev("model.call", { ms: 1000, toolCalls: ["send_whatsapp", "get_menu"], usage: usage(100, 10, 80, 0.001) }),
    ev("message.out", { text: "On it" }),
    ev("tool.start", { tool: "get_menu" }),
    ev("model.call", { ms: 800, toolCalls: ["send_whatsapp"], usage: usage(120, 20, 100, 0.001) }),
    ev("message.out", { text: "Oat or whole?" }),
    ev("turn.end", { turn: 1 }),
    // Turn 2: two tool rounds, the second one with a message beside it; the answer is one message.
    ev("message.in", { text: "oat" }),
    ev("turn.start", { turn: 2 }),
    ev("model.call", { ms: 500, toolCalls: ["add_item"], usage: usage(100, 5, 0, 0.002) }),
    ev("tool.start", { tool: "add_item" }),
    ev("model.call", { ms: 600, toolCalls: ["send_whatsapp", "place_order"], usage: usage(100, 5, 0, 0.002) }),
    ev("message.out", { text: "Placing it" }),
    ev("tool.start", { tool: "place_order" }),
    ev("model.call", { ms: 400, toolCalls: ["send_whatsapp"], usage: usage(100, 5, 0, 0.002) }),
    ev("message.out", { text: "Done" }),
    ev("turn.end", { turn: 2 }),
    // Turn 3: the model wrote its answer as plain text (no tool call), was asked again, then sent it.
    ev("message.in", { text: "thanks" }),
    ev("turn.start", { turn: 3 }),
    ev("model.call", { ms: 300, toolCalls: [], usage: usage(100, 5, 0, 0.001) }),
    ev("text.hidden", { text: "You're welcome" }),
    ev("model.call", { ms: 300, toolCalls: ["send_whatsapp"], usage: usage(100, 5, 0, 0.001) }),
    ev("message.out", { text: "You're welcome" }),
    ev("turn.end", { turn: 3 }),
  ];
  const [c] = conversationCounts(events);
  assert.ok(c);
  assert.equal(c.turns, 3);
  assert.equal(c.messages, 5);
  assert.equal(c.multiMessageTurns, 2);
  assert.equal(c.modelCalls, 7);
  assert.equal(c.modelMs, 3900);
  assert.equal(c.toolCalls, 3);
  assert.equal(c.textBesideLaterTools, 1, "turn 2 only: its second round of work tools carried a message; turn 1's first round does not count");
  assert.equal(c.extraCallToSend, 1, "turn 3 only");
  assert.deepEqual([c.inputTokens, c.outputTokens, c.cachedTokens], [720, 55, 180]);
  assert.ok(Math.abs(c.costUsd! - 0.01) < 1e-9);
  // Time to first reply: from the person's message to the turn's first message (events are 100 ms apart): 300 + 500 + 500.
  assert.equal(c.repliedTurns, 3);
  assert.equal(c.replyMs, 1300);
});

test("conversations are kept apart, a cost the provider did not report stays unknown, and a cloud's conversation id names its run", () => {
  at = 0;
  const other = "sms:tse_X.order.sms.2.rerun";
  const [a, b] = conversationCounts([
    ev("turn.start", {}, C), ev("model.call", { ms: 10, toolCalls: ["send_whatsapp"] }, C), ev("message.out", {}, C), ev("turn.end", {}, C),
    ev("turn.start", {}, other), ev("model.call", { ms: 10, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }, other), ev("turn.end", {}, other),
  ]);
  assert.deepEqual([a!.conversationId, a!.turns, a!.messages, a!.costUsd], [C, 1, 1, null]);
  assert.deepEqual([b!.conversationId, b!.turns, b!.messages, b!.extraCallToSend], [other, 1, 0, 0], "a plain-text call that is the last of its turn needed no re-send");
  assert.deepEqual(conversationRun(C), { scenario: "order", channel: "whatsapp", run: 1, rerun: false });
  assert.deepEqual(conversationRun(other), { scenario: "order", channel: "sms", run: 2, rerun: true });
  assert.equal(conversationRun("not-a-cloud-id"), null);
});
