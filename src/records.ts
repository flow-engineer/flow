// Records: rows a tool returns (orders, bookings) that the agent shows the person exactly as the
// backend gave them. The developer says once how a row reads; a tool returns `orders.of(rows)`; the
// model gets the rows and a handle (r1) and shows them with its send tool's `show`, and Flow
// Framework renders them on each channel (talk.ts, channels.ts `recordsMessages`), pages them and
// maps picks back, so no id, price or date is ever retyped by the model.

import type { Photo, RecordRow } from "./types.ts";

/** At most this many rows are kept from one result; the model is told how many there were. */
export const MAX_RECORDS = 100;
/** A handle's rows as the tool returned them are kept up to this size (JSON); larger, only id, title and detail. */
export const MAX_HANDLE_BYTES = 64 * 1024;

const BRAND = Symbol.for("chinwag.records");

/** How one kind of record reads, defined once. */
export interface RecordsDefinition<T> {
  /** What the rows are (orders, bookings): shown to the model, in events and in tests. */
  kind: string;
  /** The row's id, 1 to 64 bytes, unique in one result: a pick comes back with it. */
  id: (row: T) => string;
  title: (row: T) => string;
  detail?: (row: T) => string | null | undefined;
  /** A photo by https URL (or a Photo); used only where every shown row has one and the channel has carousels. */
  image?: (row: T) => string | Photo | null | undefined;
  /** The label of the button that picks one ("View order"); without it the rows are read-only. */
  pick?: string;
}

/** A tool's result made with `records(...).of(rows)`. Serialized (MCP, HTTP), it is the rows as given. */
export interface RecordsResult<T = unknown> {
  readonly kind: string;
  readonly rows: RecordRow[];
  /** The rows as the tool returned them, after the cap. */
  readonly data: T[];
  /** How many there are in all (the tool's `total`, else how many it returned). */
  readonly total: number;
  readonly pick?: string;
  toJSON(): T[];
}

export interface Records<T> {
  readonly kind: string;
  /** A tool's result: these rows, of `total` in all when the tool fetched only some. */
  of(rows: readonly T[], options?: { total?: number }): RecordsResult<T>;
}

/** Defines a kind of record; its `of(rows)` is what a tool returns to let the agent show them. */
export function records<T>(definition: RecordsDefinition<T>): Records<T> {
  if (!definition.kind?.trim()) throw new Error("flow: records() needs a kind");
  return {
    kind: definition.kind,
    of(given, options = {}) {
      const data = given.slice(0, MAX_RECORDS);
      const seen = new Set<string>();
      const rows = data.map((row, i): RecordRow => {
        const id = String(definition.id(row) ?? "");
        const bytes = new TextEncoder().encode(id).length;
        if (bytes < 1 || bytes > 64) throw new Error(`flow: records "${definition.kind}" row ${i}: an id is 1 to 64 bytes, got ${bytes}`);
        if (seen.has(id)) throw new Error(`flow: records "${definition.kind}": the id ${id} is on two rows`);
        seen.add(id);
        const detail = definition.detail?.(row);
        const image = definition.image?.(row);
        return {
          id,
          title: String(definition.title(row) ?? "") || id,
          ...(detail ? { detail: String(detail) } : {}),
          ...(image ? { image: typeof image === "string" ? { url: image } : image } : {}),
        };
      });
      const result = {
        kind: definition.kind,
        rows,
        data,
        total: Math.max(options.total ?? given.length, given.length),
        ...(definition.pick ? { pick: definition.pick } : {}),
        toJSON: () => data,
      };
      Object.defineProperty(result, BRAND, { value: true });
      return result;
    },
  };
}

/** Whether a tool's output is a records() result. */
export function isRecords(output: unknown): output is RecordsResult {
  return typeof output === "object" && output !== null && (output as Record<symbol, unknown>)[BRAND] === true;
}

/** Records a conversation keeps under a handle (r1), so the agent can show them and a pick finds its row. */
export interface RecordsHandle {
  handle: string;
  kind: string;
  rows: RecordRow[];
  /** The rows as the tool returned them, when they fit MAX_HANDLE_BYTES. */
  data?: unknown[];
  pick?: string;
  total: number;
  at: number;
}

/** What a conversation keeps of a records() result under a handle. */
export function handleOf(handle: string, result: RecordsResult, at: number): RecordsHandle {
  const data = JSON.stringify(result.data);
  return {
    handle,
    kind: result.kind,
    rows: result.rows,
    ...(data.length <= MAX_HANDLE_BYTES ? { data: result.data } : {}),
    ...(result.pick ? { pick: result.pick } : {}),
    total: result.total,
    at,
  };
}
