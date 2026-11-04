// Observability: everything the agent does is an event. Sinks send them anywhere (a log, a
// dashboard, a test); they must never throw into the conversation.

import { appendFileSync } from "node:fs";
import { format } from "node:util";

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
    | "message.edited"
    | "message.unsent"
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
        log("WARNING", "flow: an event sink failed:", error);
      }
    }
  };
}

export type Emit = ReturnType<typeof emitter>;

/** How much one of Flow Framework's own log lines matters, in Cloud Logging's names. */
export type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

const CONSOLE = { DEBUG: "debug", INFO: "info", WARNING: "warn", ERROR: "error" } as const;

/**
 * One of Flow Framework's own log lines (never the agent's), written with console's method for its
 * severity, as `console.warn(...)` takes its arguments. On Cloud Run (Flow's hosting included:
 * K_SERVICE, or CLOUD_RUN_JOB for a job) it is one JSON line Cloud Logging reads: `severity`,
 * `message` (an Error's stack inside it, so a stack is one entry) and `fields`. Elsewhere it is the
 * text console prints, as before; with no text, `fields` as JSON.
 */
export function log(severity: Severity, ...args: unknown[]): void {
  logFields(severity, {}, ...args);
}

/** {@link log} with fields of its own: ids, counts and kinds, never a message's text. */
export function logFields(severity: Severity, fields: Record<string, unknown>, ...args: unknown[]): void {
  const method = CONSOLE[severity];
  if (!process.env.K_SERVICE && !process.env.CLOUD_RUN_JOB) return void console[method](...(args.length ? args : [JSON.stringify(fields)]));
  console[method](JSON.stringify({ severity, ...(args.length ? { message: format(...args) } : {}), ...fields }));
}
