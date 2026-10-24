// The agent's own records: small JSON documents in named collections, kept in Flow Framework's store
// beside its own state, so they survive restarts and deploys and go wherever the agent's store goes
// (the playground's, a self-hosted agent's SQLite or Postgres, Flow's hosting). They are the agent's
// working memory across days and people (a question waiting for a seller's answer), and kept small:
// read by id, or queried by equality on a few declared top-level fields, oldest first. No ranges,
// sorting, joins, search or transactions across records. If anything other than the agent reads
// it, it belongs in your own database.
//
// Each collection declares which of its fields hold a person, so forgetting a person deletes the
// records that name them. The store checks every value again, since it may be a service that takes
// calls from elsewhere; here they are checked first, so a refusal says what to change.

import type { StoreApi } from "./store.ts";

export const RECORD_LIMITS = {
  /** One record's value, as JSON (UTF-8 bytes). */
  documentBytes: 65_536,
  /**
   * Records one agent keeps in one environment, across its collections. The count takes no lock,
   * so new records put at the same moment may pass it by up to as many as are put at once.
   */
  perAgent: 10_000,
  /** The most a query returns at once (`limit`). */
  page: 100,
  /** What a query returns when it sets no `limit`. */
  defaultPage: 50,
  /** Collections one agent declares. */
  collections: 20,
  /** Fields one collection declares (`people` and `fields` together). */
  fields: 8,
  /** A record id's length. */
  idChars: 128,
  /** A declared field's text, when it is a string. */
  valueChars: 256,
};

/** A collection in `createAgent({ records })`. Only declared fields can be queried. */
export interface RecordCollection {
  /**
   * Top-level fields that hold a person: queried like `fields`, and a record naming the person in
   * any of them is deleted when that person is forgotten. Each holds a string: the person's
   * `context.person` (`phone:+15550100100`, `key:<your id>`, `<channel>:<address>`).
   */
  people?: string[];
  /** Other top-level fields to query by (`status`, `listing`): a string, number, boolean or null each. */
  fields?: string[];
}

/** A record's value as it comes back: a plain JSON object (no Dates, Maps or class instances; times as milliseconds or ISO text). */
export type RecordValue = Record<string, unknown>;

/** What a declared field is compared with: equality only. */
export type RecordScalar = string | number | boolean;

export interface RecordEntry<T = RecordValue> {
  id: string;
  value: T;
  /** When it was first put (ms); a put to the same id keeps it. */
  createdAt: number;
  /** When it was last put (ms). */
  updatedAt: number;
}

export interface ExportedRecord<T = RecordValue> extends RecordEntry<T> {
  collection: string;
}

/** Where a page ends: the last entry of the page before (its id and createdAt are all that is read). */
export type RecordCursor = Pick<RecordEntry, "id" | "createdAt">;

/** The agent's records: `context.records` in a tool, `agent.records` everywhere else. */
export interface Records {
  /** The declared collections' names (`createAgent({ records })`), in the order declared. */
  readonly collections: string[];
  /** Keeps `value` under `id` in a declared collection, replacing what was there. */
  put(collection: string, id: string, value: object): Promise<void>;
  /** The value under `id`, or null. */
  get<T = RecordValue>(collection: string, id: string): Promise<T | null>;
  /**
   * The records whose declared fields equal every value in `where` (none: all of the collection),
   * oldest first (by when each was first put), at most `limit` (default 50, at most 100). For the
   * next page, pass the last entry as `after`.
   */
  query<T = RecordValue>(collection: string, where?: Record<string, RecordScalar>, options?: { limit?: number; after?: RecordCursor }): Promise<Array<RecordEntry<T>>>;
  /** Deletes the record; false when there was none. */
  delete(collection: string, id: string): Promise<boolean>;
  /**
   * Deletes every record that names `person` in a person field, in any collection; resolves to how
   * many. For someone who never wrote to the agent: `agent.forgetPerson` already does this for a
   * person with a conversation.
   */
  forgetPerson(person: string): Promise<number>;
  /** Every record of this agent, in every collection, oldest first: what moving to another store takes along. */
  export(): AsyncIterable<ExportedRecord>;
}

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const EXPORT_PAGE = 100;

function refuse(why: string): never {
  throw new Error(`flow: records: ${why}`);
}

/** Checks `createAgent({ records })`; returns each collection's declared fields. */
export function declareCollections(collections: Record<string, RecordCollection> = {}): Map<string, { fields: string[]; people: string[] }> {
  const names = Object.keys(collections);
  if (names.length > RECORD_LIMITS.collections) refuse(`an agent declares at most ${RECORD_LIMITS.collections} collections, not ${names.length}`);
  const declared = new Map<string, { fields: string[]; people: string[] }>();
  for (const name of names) {
    checkCollection(name);
    const { fields = [], people = [] } = collections[name] ?? {};
    checkFields(name, fields, people);
    declared.set(name, { fields: [...fields], people: [...people] });
  }
  return declared;
}

export function checkCollection(collection: unknown): asserts collection is string {
  if (typeof collection !== "string" || !NAME.test(collection)) refuse(`a collection's name is a letter, then letters, digits, - or _ (at most 64), not ${JSON.stringify(collection)}`);
}

export function checkId(id: unknown): asserts id is string {
  // Control characters are refused, so an id prints and exports as it is.
  if (typeof id !== "string" || !id.length || id.length > RECORD_LIMITS.idChars || /[\u0000-\u001f\u007f]/.test(id)) {
    refuse(`a record's id is text of 1 to ${RECORD_LIMITS.idChars} characters with no control characters, not ${JSON.stringify(id)}`);
  }
}

export function checkFields(collection: string, fields: unknown, people: unknown): asserts fields is string[] {
  if (!Array.isArray(fields) || !Array.isArray(people)) refuse(`${collection}: fields and people are lists of field names`);
  const all = [...(people as unknown[]), ...(fields as unknown[])];
  if (all.length > RECORD_LIMITS.fields) refuse(`${collection} declares ${all.length} fields; a collection declares at most ${RECORD_LIMITS.fields} (people and fields together)`);
  for (const field of all) if (typeof field !== "string" || !FIELD.test(field)) refuse(`${collection}: a declared field is a top-level name (letters, digits and _), not ${JSON.stringify(field)}`);
  if (new Set(all).size !== all.length) refuse(`${collection} declares a field twice`);
}

/**
 * The value as stored: a plain JSON object, with keys whose value is undefined left out. Anything
 * JSON would change (a Date, NaN, a Map, undefined in a list) is refused, naming where it is.
 */
export function recordJson(collection: string, value: unknown): string {
  if (!isPlainObject(value)) refuse(`${collection}: a record's value is a plain object, such as { status: "waiting" }`);
  check(value, "value");
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > RECORD_LIMITS.documentBytes) refuse(`${collection}: a record is at most ${RECORD_LIMITS.documentBytes / 1024} KB as JSON, and this one is ${Math.ceil(bytes / 1024)} KB; keep large or shared data in your own database and the id here`);
  return text;

  function check(v: unknown, path: string): void {
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) refuse(`${collection}: ${path} is ${v}, which JSON cannot hold`);
      return;
    }
    if (Array.isArray(v)) {
      // An indexed loop, so a hole ([1, , 3]) is seen: forEach skips it.
      for (let i = 0; i < v.length; i++) {
        if (v[i] === undefined) refuse(`${collection}: ${path}[${i}] is undefined, which JSON turns into null; use null`);
        check(v[i], `${path}[${i}]`);
      }
      return;
    }
    if (v instanceof Date) refuse(`${collection}: ${path} is a Date; keep a time as milliseconds (Date.now()) or ISO text`);
    if (!isPlainObject(v)) refuse(`${collection}: ${path} is ${typeof v === "object" ? "an object that is not plain JSON" : `a ${typeof v}`}; a record holds only JSON values`);
    for (const [key, item] of Object.entries(v)) if (item !== undefined) check(item, `${path}.${key}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** A declared field's value as the store compares it: its JSON text (so 1 and "1" differ, on every engine). */
export function indexValue(collection: string, field: string, value: unknown, person: boolean): string | null {
  if (value === undefined || value === null) return null;
  if (person && typeof value !== "string") refuse(`${collection}.${field} holds a person, so it is a string (context.person), not ${JSON.stringify(value)}`);
  if (typeof value === "string") {
    if (value.length > RECORD_LIMITS.valueChars) refuse(`${collection}.${field} is declared, so it is at most ${RECORD_LIMITS.valueChars} characters`);
  } else if (typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value))) {
    refuse(`${collection}.${field} is declared, so it is a string, number, boolean or null, not ${Array.isArray(value) ? "a list" : typeof value}`);
  }
  return JSON.stringify(value);
}

/**
 * The declared fields of a value, as the store indexes them. `skipRefused`: a field whose value
 * the declaration refuses is left out instead (a record kept under an earlier declaration).
 */
export function recordIndex(collection: string, value: RecordValue, fields: string[], people: string[], skipRefused = false): Array<{ field: string; value: string; person: boolean }> {
  checkFields(collection, fields, people);
  const index: Array<{ field: string; value: string; person: boolean }> = [];
  for (const [list, person] of [[people, true], [fields, false]] as const) {
    for (const field of list) {
      let v: string | null;
      try {
        v = indexValue(collection, field, value[field], person);
      } catch (error) {
        if (!skipRefused) throw error;
        v = null;
      }
      if (v !== null) index.push({ field, value: v, person });
    }
  }
  return index;
}

/** A query's `where`, checked: equality on declared fields. */
export function checkWhere(collection: string, where: unknown, declared?: { fields: string[]; people: string[] }): Array<[string, string]> {
  if (where === undefined) return [];
  if (!isPlainObject(where)) refuse(`${collection}: where is an object of field: value`);
  return Object.entries(where).map(([field, value]) => {
    if (!FIELD.test(field)) refuse(`${collection}: ${JSON.stringify(field)} is not a field name`);
    const person = declared?.people.includes(field) ?? false;
    if (declared && !person && !declared.fields.includes(field)) refuse(`${collection} cannot be queried by ${field}: declare it in createAgent({ records: { ${collection}: { fields: [...] } } })`);
    if (value === null || value === undefined) refuse(`${collection}: where.${field} is a string, number or boolean; a query matches values, not missing ones`);
    return [field, indexValue(collection, field, value, person)!];
  });
}

export function checkPage(limit: unknown, after: unknown): { limit: number; after: RecordCursor | null } {
  const n = limit ?? RECORD_LIMITS.defaultPage;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > RECORD_LIMITS.page) refuse(`limit is a whole number from 1 to ${RECORD_LIMITS.page}, not ${JSON.stringify(limit)}`);
  if (after === undefined || after === null) return { limit: n as number, after: null };
  const a = after as Partial<RecordCursor>;
  if (typeof a !== "object" || typeof a.id !== "string" || !Number.isSafeInteger(a.createdAt)) refuse("after is the last entry of the page before (its id and createdAt)");
  return { limit: n as number, after: { id: a.id!, createdAt: a.createdAt! } };
}

/**
 * Indexes the records already kept again where a collection's declaration changed since they were
 * indexed (a field added to `people` or `fields`), so query finds them and forgetting a person
 * deletes them: what the agent's start waits for, once the store's tables exist.
 */
export async function indexDeclared(store: StoreApi, collections: Record<string, RecordCollection> | undefined): Promise<void> {
  for (const [name, { fields, people }] of declareCollections(collections)) {
    let after: string | null = null;
    do after = await store.reindexRecords(name, fields, people, after);
    while (after !== null);
  }
}

/**
 * The records as one conversation's tools have them: once `closed()` gives a reason (its person was
 * forgotten), a put is refused saying so; each put under way is in `running` until it ends, so
 * forgetting the person waits for it and deletes what it wrote.
 */
export function recordsUntil(records: Records, closed: () => string | null, running: Set<Promise<unknown>>): Records {
  return {
    ...records,
    put(collection, id, value) {
      const why = closed();
      if (why) return Promise.reject(new Error(`flow: records: not kept: ${why}`));
      const put = records.put(collection, id, value);
      const done = put.then(() => undefined, () => undefined);
      running.add(done);
      void done.then(() => running.delete(done));
      return put;
    },
  };
}

/** The agent's records over its store; `ready` resolves once the store's tables exist and are indexed as declared. */
export function recordsOf(store: StoreApi, collections: Record<string, RecordCollection> | undefined, ready: () => Promise<void>): Records {
  const declared = declareCollections(collections);
  const collection = (name: unknown) => {
    checkCollection(name);
    const found = declared.get(name);
    if (!found) refuse(`no collection named ${name}: declare it in createAgent({ records: { ${name}: { people: [...], fields: [...] } } })`);
    return found!;
  };
  return {
    collections: [...declared.keys()],
    async put(name, id, value) {
      const { fields, people } = collection(name);
      checkId(id);
      recordJson(name, value);
      recordIndex(name, value as RecordValue, fields, people);
      await ready();
      if (!(await store.putRecord(name, id, value as RecordValue, fields, people))) {
        refuse(`this agent keeps ${RECORD_LIMITS.perAgent} records already, the most it may: delete ones it no longer needs (agent.records.delete), or keep this data in your own database`);
      }
    },
    async get<T>(name: string, id: string) {
      collection(name);
      checkId(id);
      await ready();
      return ((await store.getRecord(name, id))?.value ?? null) as T | null;
    },
    async query<T>(name: string, where?: Record<string, RecordScalar>, options: { limit?: number; after?: RecordCursor } = {}) {
      checkWhere(name, where, collection(name));
      const page = checkPage(options.limit, options.after);
      await ready();
      return (await store.queryRecords(name, where ?? {}, page.limit, page.after ?? undefined)) as Array<RecordEntry<T>>;
    },
    async delete(name, id) {
      collection(name);
      checkId(id);
      await ready();
      return store.deleteRecord(name, id);
    },
    async forgetPerson(person) {
      if (typeof person !== "string" || !person) refuse("forgetPerson takes the person as a field holds them (context.person)");
      await ready();
      return store.forgetRecords([person]);
    },
    async *export() {
      await ready();
      let after: { createdAt: number; collection: string; id: string } | undefined;
      for (;;) {
        const page = await store.exportRecords(after ?? null, EXPORT_PAGE);
        yield* page;
        if (page.length < EXPORT_PAGE) return;
        const last = page.at(-1)!;
        after = { createdAt: last.createdAt, collection: last.collection, id: last.id };
      }
    },
  };
}

/** Records where there are none to reach (an MCP server not given `records`): every call says how to give them. */
export function unavailableRecords(how: string): Records {
  const no = async (): Promise<never> => refuse(`not available here: ${how}`);
  return { collections: [], put: no, get: no, query: no, delete: no, forgetPerson: no, export: () => ({ [Symbol.asyncIterator]: () => ({ next: no }) }) };
}
