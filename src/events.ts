// Observability: everything the agent does is an event. Sinks send them anywhere (a log, a
// dashboard, a test); they must never throw into the conversation.

import { appendFileSync } from "node:fs";

export interface FlowEvent {
  type:
    | "message.in"
    | "message.arrived"
    | "message.out"
    | "turn.start"
    | "turn.context"
    | "turn.end"
    | "model.call"
    | "model.restarted"
    | "model.error"
    | "tool.start"
    | "tool.end"
    | "tool.detached"
    | "tool.repeated"
    | "task.done"
    | "skill.loaded"
    | "text.hidden"
    | "ack.required"
    | "auth.required"
    | "reaction"
    | "status"
    | "message.undelivered"
    | "message.refused"
    | "message.slow"
    | "send.resumed"
    | "reaction.in"
    | "attachment.failed"
    | "keyword"
    | "message.duplicate"
    | "history.trimmed"
    | "history.reset"
    | "template.missing";
  conversationId: string;
  at: number;
  /** The runner (process) the event happened in, as createAgent's `runner`. */
  runner?: string;
  [detail: string]: unknown;
}

/** @deprecated Renamed {@link FlowEvent} with the package (formerly chinwag). */
export type ChinwagEvent = FlowEvent;

/** A place events go. `context` asks for `turn.context`; without it the person's record is not sent. */
export interface EventSink {
  (event: FlowEvent): void;
  context?: boolean;
}

/** One JSON line per event, to a file. */
export function jsonlSink(path: string): EventSink {
  return (event) => appendFileSync(path, JSON.stringify(event) + "\n");
}

/** Events of one runner (createAgent's `runner`): each names it, so two runners' lines tell apart. */
export function emitter(sinks: EventSink[], runner?: string) {
  return (conversationId: string, type: FlowEvent["type"], detail: Record<string, unknown> = {}) => {
    const event: FlowEvent = { type, conversationId, at: Date.now(), ...(runner ? { runner } : {}), ...detail };
    for (const sink of sinks) {
      try {
        sink(event);
      } catch (error) {
        console.warn("flow: an event sink failed:", error);
      }
    }
  };
}

export type Emit = ReturnType<typeof emitter>;
