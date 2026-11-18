// The counts `flow test compare` shows for each variant, computed by code from the events the agent emitted
// during a test session (src/events.ts), never by a model. One conversation is one run's agent side; its
// turns are read from turn.start to turn.end. Each number is kept as a numerator and a denominator per
// conversation, so variant-stats.ts can say how far to trust a total.

import type { FlowEvent } from "../../src/index.ts";

/** The send tools and the other things an agent does to talk (react, share_updates, edit, unsend); every other tool call is work. */
const TALK = /^(send_.+|react|share_updates|edit_message|unsend_message)$/;
const SEND = /^send_/;

/** One conversation's numbers. `turns` is the denominator of every per-turn count. */
export interface ConversationCounts {
  conversationId: string;
  turns: number;
  /** Turns with a first reply, the denominator of replyMs. */
  repliedTurns: number;
  messages: number;
  /** Turns with more than one message sent. */
  multiMessageTurns: number;
  modelCalls: number;
  modelMs: number;
  /** From the person's message to the agent's first message of the turn, in ms, over repliedTurns. */
  replyMs: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** null when no call of this conversation reported a cost (the provider does not say). */
  costUsd: number | null;
  /** Turns where a message went out in the same response as a second or later round of tool calls. */
  textBesideLaterTools: number;
  /** Turns where a model call that wrote text and no tool call was followed by another model call in the turn:
   * the answer was written as plain text, which never reaches the person, so the framework asked again. */
  extraCallToSend: number;
  /** Turns that failed because the model call failed (a model.error event), whatever the reason. */
  modelErrors: number;
  /** Of those, the provider's limits and outages (HTTP 429 or 5xx, or a rate-limit code): they say nothing about the variant, so the run is not counted. */
  capacityErrors: number;
}

interface Turn {
  triggerAt: number;
  firstOutAt?: number;
  messages: number;
  calls: Array<{ tools: string[]; ms: number }>;
  toolCalls: number;
}

/** The numbers of each conversation in `events`, in the order they first appear. */
export function conversationCounts(events: FlowEvent[]): ConversationCounts[] {
  const byConversation = new Map<string, Array<{ event: FlowEvent; index: number }>>();
  events.forEach((event, index) => {
    const list = byConversation.get(event.conversationId) ?? [];
    list.push({ event, index });
    byConversation.set(event.conversationId, list);
  });
  const out: ConversationCounts[] = [];
  for (const [conversationId, list] of byConversation) {
    list.sort((a, b) => a.event.at - b.event.at || a.index - b.index);
    out.push(countConversation(conversationId, list.map((l) => l.event)));
  }
  return out;
}

function countConversation(conversationId: string, events: FlowEvent[]): ConversationCounts {
  const c: ConversationCounts = { conversationId, turns: 0, repliedTurns: 0, messages: 0, multiMessageTurns: 0, modelCalls: 0, modelMs: 0, replyMs: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: null, textBesideLaterTools: 0, extraCallToSend: 0, modelErrors: 0, capacityErrors: 0 };
  let pendingIn: number | undefined;
  let turn: Turn | undefined;
  const close = () => {
    if (!turn) return;
    c.turns++;
    c.messages += turn.messages;
    if (turn.messages > 1) c.multiMessageTurns++;
    if (turn.firstOutAt !== undefined) { c.repliedTurns++; c.replyMs += turn.firstOutAt - turn.triggerAt; }
    c.toolCalls += turn.toolCalls;
    let workRounds = 0;
    let beside = false;
    turn.calls.forEach((call) => {
      const work = call.tools.some((t) => !TALK.test(t));
      if (work) workRounds++;
      if (work && workRounds >= 2 && call.tools.some((t) => SEND.test(t))) beside = true;
    });
    if (beside) c.textBesideLaterTools++;
    const lastIndex = turn.calls.length - 1;
    if (turn.calls.some((call, i) => call.tools.length === 0 && i < lastIndex)) c.extraCallToSend++;
    turn = undefined;
  };
  for (const e of events) {
    if (e.type === "message.in") {
      if (!e.answered && pendingIn === undefined) pendingIn = e.at;
    } else if (e.type === "turn.start") {
      close();
      turn = { triggerAt: pendingIn ?? e.at, messages: 0, calls: [], toolCalls: 0 };
      pendingIn = undefined;
    } else if (e.type === "turn.end") {
      close();
      pendingIn = undefined;
    } else if (turn && e.type === "model.call") {
      const tools = Array.isArray(e.toolCalls) ? (e.toolCalls as string[]) : [];
      const ms = typeof e.ms === "number" ? e.ms : 0;
      turn.calls.push({ tools, ms });
      c.modelCalls++;
      c.modelMs += ms;
      const usage = e.usage as { inputTokens?: number; outputTokens?: number; costUsd?: number; cacheReadTokens?: number } | undefined;
      c.inputTokens += usage?.inputTokens ?? 0;
      c.outputTokens += usage?.outputTokens ?? 0;
      c.cachedTokens += usage?.cacheReadTokens ?? 0;
      if (typeof usage?.costUsd === "number") c.costUsd = (c.costUsd ?? 0) + usage.costUsd;
    } else if (e.type === "model.error") {
      c.modelErrors++;
      if (typeof e.status === "number" ? e.status === 429 || e.status >= 500 : e.code === "rate_limit_exceeded") c.capacityErrors++;
    } else if (turn && e.type === "tool.start") {
      turn.toolCalls++;
    } else if (turn && e.type === "message.out" && !e.authentication) {
      turn.messages++;
      turn.firstOutAt ??= e.at;
    }
  }
  close();
  return c;
}

/** Where a cloud's conversation id comes from: `<channel>:<session>.<scenario>.<channel>.<run>` and, for a second play of a failed run, `.rerun`. */
export function conversationRun(conversationId: string): { scenario: string; channel: string; run: number; rerun: boolean } | null {
  const m = /^[^:]+:[^.]+\.(.+)\.([^.]+)\.(\d+)((?:\.[a-z]+\d*)*)$/.exec(conversationId);
  return m ? { scenario: m[1]!, channel: m[2]!, run: Number(m[3]), rerun: m[4]!.split(".").includes("rerun") } : null;
}
