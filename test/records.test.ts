// covers: src/records.ts src/store.ts src/agent.ts src/conversation.ts src/tools.ts testing/src/records.ts testing/src/cli.ts
// The agent's records behave the same on every store: SQLite in memory and in a file, Postgres (when
// FLOW_TEST_POSTGRES_URL names a throwaway database and the `pg` package is installed), and a store
// reached over JSON, as Flow's hosting forwards each Store call to its store service. Each test
// runs once per store, on agent ids of its own, so a shared database needs no cleanup.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { z } from "zod";
import { createAgent, postgres, RECORD_LIMITS, sqlite, Store, tool, type Agent, type Database, type ExportedRecord, type PostgresPool, type StoreApi } from "../src/index.ts";
import { call, gate, respond, say, scriptedModel, SMS, WHATSAPP } from "./helpers.ts";

const COLLECTIONS = {
  questions: { people: ["buyer", "seller"], fields: ["listing", "status"] },
  notes: { people: ["about"] },
};
const noModel = { complete: () => Promise.reject(new Error("no model in these tests")) };

interface Backend {
  name: string;
  /** Makes the store of agent `id` (one environment of one agent). */
  store(id: string): StoreApi;
  db: Database;
}

/** Forwards every call as hosting's remote store does: arguments and results through JSON, errors without their message. */
function overJson(store: Store): StoreApi {
  return new Proxy({} as StoreApi, {
    get(_target, method) {
      if (method === "durable") return true;
      if (typeof method !== "string" || method === "then") return undefined;
      return async (...args: unknown[]) => {
        while (args.length && args.at(-1) === undefined) args.pop();
        const run = (store as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];
        let result: unknown;
        try {
          result = await run.apply(store, JSON.parse(JSON.stringify(args)));
        } catch {
          throw new Error(`store service: ${method}: the store failed`);
        }
        return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
      };
    },
  });
}

const backends: Backend[] = [];
{
  const memory = sqlite();
  backends.push({ name: "sqlite in memory", db: memory, store: (id) => new Store(memory, id) });
  const file = sqlite(join(mkdtempSync(join(tmpdir(), "flow-records-")), "flow.db"));
  backends.push({ name: "sqlite file", db: file, store: (id) => new Store(file, id) });
  const forwarded = sqlite();
  backends.push({ name: "over JSON", db: forwarded, store: (id) => overJson(new Store(forwarded, id)) });
}
const pgUrl = process.env.FLOW_TEST_POSTGRES_URL;
if (pgUrl) {
  // No Postgres dependency: the package is loaded only when a database is named.
  const pg = (await import("pg" as string)).default as { Pool: new (options: { connectionString: string }) => PostgresPool & { end(): Promise<void> } };
  const pool = new pg.Pool({ connectionString: pgUrl });
  after(() => pool.end());
  const db = postgres(pool);
  backends.push({ name: "postgres", db, store: (id) => new Store(db, id) });
}

/** An agent of its own (a fresh id) on the backend, or on `id` when given. */
function agentOn(backend: Backend, id = `agt_${randomUUID().slice(0, 8)}/production`): Agent & { id: string } {
  const agent = createAgent({ files: { "AGENTS.md": "Test." }, model: noModel, records: COLLECTIONS, scheduleCheckMs: 0, store: backend.store(id) });
  return Object.assign(agent, { id });
}

/** `count` records in `collection` for agent `id`, written straight into the table (the cap test needs 10,000). */
async function seed(db: Database, id: string, collection: string, count: number): Promise<void> {
  await new Store(db, id).migrate();
  for (let from = 0; from < count; from += 500) {
    const rows = Array.from({ length: Math.min(500, count - from) }, (_, k) => from + k);
    await db.run(`INSERT INTO records (agent_id, collection, id, doc, created_at, updated_at) VALUES ${rows.map(() => "(?, ?, ?, '{}', 1, 1)").join(", ")}`, rows.flatMap((n) => [id, collection, `seed-${n}`]));
  }
}

const question = (n: number, fields: Record<string, unknown> = {}) => ({ listing: `L${n}`, buyer: "phone:+15550100001", seller: "phone:+15550100002", status: "waiting", askedAt: 1_700_000_000_000 + n, ...fields });

for (const backend of backends) {
  test(`${backend.name}: a record is put, read, replaced and deleted, and comes back as JSON would carry it`, async () => {
    const { records } = agentOn(backend);
    const value = { listing: "L1", buyer: "phone:+15550100001", status: "waiting", note: undefined, text: "Is it still available? 🚲 «oui»", price: 12.5, count: 0, sold: false, tags: ["blue", null], offer: { amount: 300, currency: "EUR" }, gone: null };
    await records.put("questions", "q1", value);
    assert.deepEqual(await records.get("questions", "q1"), JSON.parse(JSON.stringify(value)), "undefined keys are left out, everything else as it was");
    assert.equal(await records.get("questions", "nope"), null);
    const [first] = await records.query("questions");
    await records.put("questions", "q1", { ...value, status: "answered" });
    const [second] = await records.query("questions");
    assert.equal((second.value as { status: string }).status, "answered", "a put replaces the value");
    assert.equal(second.createdAt, first.createdAt, "and keeps when it was first put");
    assert.ok(second.updatedAt >= first.updatedAt);
    assert.equal(await records.delete("questions", "q1"), true);
    assert.equal(await records.delete("questions", "q1"), false, "nothing left to delete");
    assert.equal(await records.get("questions", "q1"), null);
    assert.deepEqual(await records.query("questions"), []);
  });

  test(`${backend.name}: a query matches every given field by equality, oldest first, page by page`, async () => {
    const { records } = agentOn(backend);
    for (let n = 1; n <= 5; n++) await records.put("questions", `q${n}`, question(n, { status: n % 2 ? "waiting" : "answered" }));
    await records.put("questions", "q6", question(6, { seller: "phone:+15550100009" }));
    await records.put("questions", "q7", question(7, { listing: 7 }));
    const ids = (entries: Array<{ id: string }>) => entries.map((e) => e.id);
    assert.deepEqual(ids(await records.query("questions", { seller: "phone:+15550100002", status: "waiting" })), ["q1", "q3", "q5", "q7"]);
    assert.deepEqual(ids(await records.query("questions", { listing: 7 })), ["q7"], "7 matches the number");
    assert.deepEqual(ids(await records.query("questions", { listing: "7" })), [], "not the text 7");
    await records.put("questions", "q3", question(3, { status: "answered" }));
    assert.deepEqual(ids(await records.query("questions", { status: "waiting" })), ["q1", "q5", "q6", "q7"], "a put moves the record between queries, keeping its place");
    const page1 = await records.query("questions", {}, { limit: 3 });
    assert.deepEqual(ids(page1), ["q1", "q2", "q3"]);
    await records.delete("questions", "q3"); // the page's last entry, gone before the next page is read
    assert.deepEqual(ids(await records.query("questions", {}, { limit: 3, after: page1.at(-1) })), ["q4", "q5", "q6"]);
    await assert.rejects(records.query("questions", { askedAt: 1 }), /questions cannot be queried by askedAt: declare it/);
    await assert.rejects(records.query("questions", {}, { limit: RECORD_LIMITS.page + 1 }), /limit is a whole number from 1 to 100/);
  });

  test(`${backend.name}: what does not fit is refused with what to change`, async () => {
    const { records, id } = agentOn(backend);
    const refused = (work: Promise<unknown>, why: RegExp) => assert.rejects(work, (error: Error) => why.test(error.message) && error.message.startsWith("flow: records:"));
    await refused(records.put("orders", "o1", {}), /no collection named orders: declare it in createAgent/);
    await refused(records.put("questions", "", {}), /a record's id is text of 1 to 128 characters/);
    await refused(records.put("questions", "q1", { askedAt: new Date() }), /value\.askedAt is a Date; keep a time as milliseconds/);
    await refused(records.put("questions", "q1", { tags: [1, undefined] }), /value\.tags\[1\] is undefined/);
    // eslint-disable-next-line no-sparse-arrays
    await refused(records.put("questions", "q1", { tags: [1, , 3] }), /value\.tags\[1\] is undefined/);
    await refused(records.put("questions", "q1", { price: Number.NaN }), /value\.price is NaN/);
    await refused(records.put("questions", "q1", { seller: { phone: "+15550100002" } }), /questions\.seller holds a person, so it is a string/);
    await refused(records.put("questions", "q1", { status: ["waiting"] }), /questions\.status is declared, so it is a string, number, boolean or null/);
    await refused(records.put("questions", "q1", { text: "x".repeat(RECORD_LIMITS.documentBytes) }), /a record is at most 64 KB as JSON, and this one is 65 KB/);
    for (const createdAt of [1.5, Number.NaN]) await refused(records.query("questions", {}, { after: { id: "q1", createdAt } }), /after is the last entry of the page before/);
    assert.throws(() => createAgent({ files: { "AGENTS.md": "Test." }, model: noModel, records: { a: { people: ["x"], fields: ["x"] } } }), /a declares a field twice/);
    assert.throws(() => createAgent({ files: { "AGENTS.md": "Test." }, model: noModel, records: { a: { fields: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] } } }), /at most 8/);

    await seed(backend.db, id, "notes", RECORD_LIMITS.perAgent - 1);
    await records.put("questions", "q1", question(1)); // the 10,000th
    await refused(records.put("questions", "q2", question(2)), /this agent keeps 10000 records already, the most it may: delete ones/);
    await records.put("questions", "q1", question(1, { status: "answered" })); // replacing one is not a new one
    assert.equal(await records.delete("notes", "seed-0"), true);
    await records.put("questions", "q2", question(2)); // room again
  });

  test(`${backend.name}: forgetting a person deletes the records that name them in a person field, and no other`, async () => {
    const agent = agentOn(backend);
    const store = backend.store(agent.id);
    await store.migrate();
    await store.createConversation("p_buyer", "phone:+15550100001");
    await store.addIdentity("p_buyer", "whatsapp", "+15550100001", "channel");
    await store.addIdentity("p_buyer", "telegram", "8812", "channel");
    await agent.records.put("questions", "by-key", question(1));
    await agent.records.put("questions", "by-number", question(2, { buyer: "+15550100001" }));
    await agent.records.put("questions", "by-identity", question(3, { buyer: "telegram:8812" }));
    await agent.records.put("notes", "by-conversation", { about: "p_buyer" });
    await agent.records.put("questions", "someone-else", question(4, { buyer: "phone:+15550100003" }));
    await agent.records.put("notes", "only-in-text", { about: "phone:+15550100003", text: "phone:+15550100001 asked twice" });
    await agent.records.put("questions", "bare-address", question(5, { buyer: "8812" }));
    await agent.forgetPerson("p_buyer");
    const left: string[] = [];
    for await (const r of agent.records.export()) left.push(r.id);
    assert.deepEqual(left.sort(), ["bare-address", "only-in-text", "someone-else"], "a bare chat id is not theirs: another channel may use it");

    // A seller who never wrote has no conversation: they are forgotten by the value the records hold.
    assert.equal(await agent.records.forgetPerson("phone:+15550100002"), 2, "every record naming the seller");
    assert.deepEqual(await agent.records.query("questions", { seller: "phone:+15550100002" }), []);
  });

  test(`${backend.name}: a put, a delete and a forgetting of one record at the same time all finish, leaving no index row without its record`, async () => {
    const { records, id } = agentOn(backend);
    for (let n = 0; n < 20; n++) {
      await records.put("questions", "q1", question(n));
      const results = await Promise.allSettled([records.put("questions", "q1", question(n, { status: "answered" })), records.delete("questions", "q1"), records.forgetPerson("phone:+15550100001")]);
      assert.deepEqual(results.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : [])), [], `round ${n}`);
    }
    const [{ n }] = await backend.db.query("SELECT count(*) AS n FROM record_index i WHERE i.agent_id = ? AND NOT EXISTS (SELECT 1 FROM records r WHERE r.agent_id = i.agent_id AND r.collection = i.collection AND r.id = i.id)", [id]);
    assert.equal(Number(n), 0);
  });

  test(`${backend.name}: a field added to a collection's people is indexed at the next start for the records already kept, so query finds them and forgetting deletes them`, async () => {
    const id = `agt_${randomUUID().slice(0, 8)}/production`;
    const build = (records: Record<string, { people?: string[]; fields?: string[] }>) => createAgent({ files: { "AGENTS.md": "Test." }, model: noModel, records, scheduleCheckMs: 0, store: backend.store(id) });
    const before = build({ notes: { fields: ["status"] } });
    for (let n = 0; n < 120; n++) await before.records.put("notes", `n${String(n).padStart(3, "0")}`, { about: "phone:+15550100001", status: "open", n }); // past one page
    await before.records.put("notes", "a-number", { about: 7, status: "open" });
    const after = build({ notes: { people: ["about"], fields: ["status"] } });
    assert.equal((await after.records.query("notes", { about: "phone:+15550100001" }, { limit: 100 })).length, 100);
    assert.equal(await after.records.forgetPerson("phone:+15550100001"), 120);
    assert.deepEqual((await after.records.query("notes")).map((e) => e.id), ["a-number"], "a value the new declaration refuses is kept, left out of the index");
  });

  test(`${backend.name}: an agent started with an older declaration on the same store keeps a newer one's person fields indexed, in what it puts too`, async () => {
    const id = `agt_${randomUUID().slice(0, 8)}/production`;
    const build = (records: Record<string, { people?: string[]; fields?: string[] }>) => createAgent({ files: { "AGENTS.md": "Test." }, model: noModel, records, scheduleCheckMs: 0, store: backend.store(id) });
    const newer = build({ notes: { people: ["about"], fields: ["status"] } });
    await newer.records.put("notes", "n1", { about: "phone:+15550100001", status: "open" });
    const older = build({ notes: { fields: ["status"] } }); // a deploy's old revision, a stale checkout
    await older.records.put("notes", "n2", { about: "phone:+15550100001", status: "open" });
    await older.records.put("notes", "n1", { about: "phone:+15550100001", status: "answered" });
    assert.deepEqual((await newer.records.query("notes", { about: "phone:+15550100001" })).map((e) => e.id), ["n1", "n2"]);
    assert.equal(await build({ notes: { people: ["about"], fields: ["status"] } }).records.forgetPerson("phone:+15550100001"), 2, "after starting again");
  });

  test(`${backend.name}: a field moved from people to fields and back is a person field again for the records put meanwhile`, async () => {
    const id = `agt_${randomUUID().slice(0, 8)}/production`;
    const build = (records: Record<string, { people?: string[]; fields?: string[] }>) => createAgent({ files: { "AGENTS.md": "Test." }, model: noModel, records, scheduleCheckMs: 0, store: backend.store(id) });
    await build({ notes: { people: ["about"] } }).records.get("notes", "n0");
    await build({ notes: { fields: ["about"] } }).records.put("notes", "n1", { about: "phone:+15550100001" });
    assert.equal(await build({ notes: { people: ["about"] } }).records.forgetPerson("phone:+15550100001"), 1);
  });

  // Postgres only: SQLite runs one write transaction at a time, so a put cannot be under way there.
  if (backend.name === "postgres") {
    test(`${backend.name}: a put under way by an agent declaring no fields is indexed by a newer start that declares one`, async () => {
      const id = `agt_${randomUUID().slice(0, 8)}/production`;
      const read = gate();
      const release = gate();
      let hold = false;
      // The older agent's put holds its transaction once it has read the collection's declaration.
      const held: Database = {
        ...backend.db,
        transaction: (work) => backend.db.transaction((tx) => work({
          ...tx,
          query: async (sql, params) => {
            const rows = await tx.query(sql, params);
            if (hold && sql.startsWith("SELECT declaration FROM record_collections")) {
              hold = false;
              read.open();
              await release.promise;
            }
            return rows;
          },
        })),
      };
      const scanned = gate();
      const watched: Database = { ...backend.db, query: async (sql, params) => { const rows = await backend.db.query(sql, params); if (sql.startsWith("SELECT id FROM records")) scanned.open(); return rows; } };
      const build = (records: Record<string, { people?: string[] }>, db: Database) => createAgent({ files: { "AGENTS.md": "Test." }, model: noModel, records, scheduleCheckMs: 0, store: new Store(db, id) });
      const older = build({ notes: {} }, held);
      await older.records.get("notes", "n0"); // started
      hold = true;
      const putting = older.records.put("notes", "n1", { about: "phone:+15550100001" });
      await read.promise;
      const newer = build({ notes: { people: ["about"] } }, watched);
      const starting = newer.records.get("notes", "n0");
      // The put goes on once the newer start waits for it (a lock) or has read its records past it.
      let watching = true;
      const waits = (async () => {
        while (watching) {
          const [{ n }] = await backend.db.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
          if (Number(n) > 0) return;
        }
      })();
      await Promise.race([scanned.promise, waits]);
      watching = false;
      release.open();
      await Promise.all([putting, starting, waits]);
      assert.equal(await newer.records.forgetPerson("phone:+15550100001"), 1);
    });
  }

  test(`${backend.name}: export returns every record of every collection, oldest first, past one page`, async () => {
    const { records } = agentOn(backend);
    for (let n = 0; n < 130; n++) await records.put(n % 2 ? "notes" : "questions", `r${String(n).padStart(3, "0")}`, n % 2 ? { about: "key:7", n } : question(n));
    const exported: ExportedRecord[] = [];
    for await (const r of records.export()) exported.push(r);
    assert.equal(exported.length, 130);
    assert.deepEqual(new Set(exported.map((r) => `${r.collection}/${r.id}`)).size, 130, "each once");
    assert.ok(exported.every((r, i) => i === 0 || r.createdAt >= exported[i - 1].createdAt), "oldest first");
    const r7 = exported.find((r) => r.id === "r007")!;
    assert.deepEqual([r7.collection, r7.value], ["notes", { about: "key:7", n: 7 }]);
  });

  test(`${backend.name}: each agent and environment keeps its own records`, async () => {
    const production = agentOn(backend, "agt_iso/production");
    const staging = agentOn(backend, "agt_iso/staging");
    const other = agentOn(backend, `agt_${randomUUID().slice(0, 8)}/production`);
    await production.records.put("questions", "q1", question(1));
    await staging.records.put("questions", "q1", question(1, { status: "staging" }));
    assert.equal((await production.records.get<{ status: string }>("questions", "q1"))!.status, "waiting");
    assert.deepEqual((await other.records.query("questions")).length, 0);
    assert.equal(await other.records.forgetPerson("phone:+15550100002"), 0, "another agent's forgetting deletes nothing here");
    assert.equal(await staging.records.forgetPerson("phone:+15550100002"), 1);
    assert.ok(await production.records.get("questions", "q1"), "production keeps its own");
    await production.records.delete("questions", "q1");
  });
}

test("records survive a restart: an agent started again on the same file reads them", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "flow-records-")), "flow.db");
  const before = createAgent({ files: { "AGENTS.md": "Test." }, model: noModel, records: COLLECTIONS, scheduleCheckMs: 0, database: sqlite(path) });
  await before.records.put("questions", "q1", question(1));
  const after = createAgent({ files: { "AGENTS.md": "Test." }, model: noModel, records: COLLECTIONS, scheduleCheckMs: 0, database: sqlite(path) });
  assert.deepEqual(await after.records.get("questions", "q1"), question(1));
});

test("a tool's context.records is the agent's records", async () => {
  const ask = tool({
    name: "ask_seller",
    description: "Relay a buyer's question to the seller.",
    input: z.object({ listing: z.string() }),
    run: async ({ listing }, context) => {
      await context.records.put("questions", `${listing}:${context.person}`, { listing, buyer: context.person, seller: "phone:+15550100002", status: "waiting" });
      return { relayed: true };
    },
  });
  const h = scriptedModel();
  const agent = createAgent({ files: { "AGENTS.md": "Test." }, model: h.model, tools: [ask], records: COLLECTIONS, scheduleCheckMs: 0, debounceMs: 0 });
  agent.receive("c1", "is the bike still for sale?", () => {});
  (await h.nextCall(0)).answer(respond(say("I'll ask the seller."), call("ask_seller", { listing: "L9" })));
  (await h.nextCall(1)).answer(respond(say("Asked.")));
  await agent.conversation("c1")!.whenIdle();
  const [entry] = await agent.records.query("questions", { seller: "phone:+15550100002", status: "waiting" });
  assert.deepEqual(entry.value, { listing: "L9", buyer: "chat:c1", seller: "phone:+15550100002", status: "waiting" });
});

test("a tool still running when its person is forgotten keeps no record", async () => {
  const started = gate();
  const release = gate();
  const finished = gate<string>();
  const ask = tool({
    name: "ask_seller",
    description: "Relay a buyer's question to the seller.",
    input: z.object({ listing: z.string() }),
    run: async ({ listing }, context) => {
      started.open();
      await release.promise;
      try {
        await context.records.put("questions", listing, { listing, buyer: context.person, status: "waiting" });
        finished.open("kept");
      } catch (error) {
        finished.open((error as Error).message);
      }
      return {};
    },
  });
  const h = scriptedModel();
  const agent = createAgent({ files: { "AGENTS.md": "Test." }, model: h.model, tools: [ask], records: COLLECTIONS, scheduleCheckMs: 0, debounceMs: 0 });
  agent.receive("c1", "is the bike still for sale?", () => {});
  (await h.nextCall(0)).answer(respond(say("I'll ask the seller."), call("ask_seller", { listing: "L9" })));
  await started.promise;
  await agent.forgetPerson("c1");
  release.open();
  assert.match(await finished.promise, /^flow: records: not kept: the person was forgotten/);
  assert.deepEqual(await agent.records.query("questions"), []);
});

test("forgetting a person waits for a record put under way and deletes what it wrote", async () => {
  const real = new Store(sqlite(), "default");
  const inPut = gate();
  const releasePut = gate();
  // The store as the agent reaches it, with putRecord held at a gate.
  const store = new Proxy(real, {
    get(target, name) {
      const v = (target as unknown as Record<string | symbol, unknown>)[name];
      if (name === "putRecord") return async (...args: Parameters<Store["putRecord"]>) => (inPut.open(), await releasePut.promise, target.putRecord(...args));
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const ask = tool({ name: "ask_seller", description: "Relay a question.", input: z.object({}), run: async (_input, context) => (await context.records.put("questions", "q1", { buyer: context.person }), {}) });
  const h = scriptedModel();
  const agent = createAgent({ files: { "AGENTS.md": "Test." }, model: h.model, tools: [ask], records: COLLECTIONS, scheduleCheckMs: 0, debounceMs: 0, store });
  agent.receive("c1", "is the bike still for sale?", () => {});
  (await h.nextCall(0)).answer(respond(say("I'll ask the seller."), call("ask_seller", {})));
  await inPut.promise;
  let forgotten = false;
  const forgetting = agent.forgetPerson("c1").then(() => { forgotten = true; });
  await new Promise((resolve) => setImmediate(resolve)); // not a wait for time: forgetting cannot end while the put is held
  assert.equal(forgotten, false, "forgetting waits for the put");
  releasePut.open();
  await forgetting;
  assert.deepEqual(await agent.records.query("questions"), []);
});

test("forgetting a person signed in with a key deletes the records naming their number on a phone channel", async () => {
  const store = new Store(sqlite(), "default");
  const channels = [{ name: "whatsapp", kind: "whatsapp" as const, info: WHATSAPP, phone: true, send: () => {} }, { name: "sms", kind: "sms" as const, info: SMS, phone: true, send: () => {} }];
  const agent = createAgent({ files: { "AGENTS.md": "Test." }, model: noModel, records: COLLECTIONS, scheduleCheckMs: 0, store, channels, defaultCountryCode: "+44" });
  await store.migrate();
  await store.createConversation("p_k", "key:cust-7");
  await store.addIdentity("p_k", "whatsapp", "15550100002", "resolver"); // WhatsApp's digits, international
  await store.addIdentity("p_k", "sms", "07700900123", "resolver"); // national, in the agent's country
  await agent.records.put("questions", "prefixed", question(1, { seller: "phone:+15550100002" }));
  await agent.records.put("questions", "bare", question(2, { seller: "+15550100002" }));
  await agent.records.put("notes", "sms", { about: "phone:+447700900123" });
  await agent.records.put("notes", "someone-else", { about: "phone:+15550100003" });
  await agent.forgetPerson("p_k");
  const left: string[] = [];
  for await (const r of agent.records.export()) left.push(r.id);
  assert.deepEqual(left, ["someone-else"]);
});

test("flow records export prints every record of the agent in the folder as JSON Lines, with no model key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-records-cli-"));
  mkdirSync(join(dir, "src"));
  const path = join(dir, "agent.db");
  const framework = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  writeFileSync(join(dir, "src", "agent.ts"), `
import { createAgent, sqlite } from ${JSON.stringify(framework)};
export function buildAgent({ model, events = [] } = {}) {
  return createAgent({ files: { "AGENTS.md": "Test." }, model, events, database: sqlite(${JSON.stringify(path)}), records: ${JSON.stringify(COLLECTIONS)} });
}
`);
  const agent = createAgent({ files: { "AGENTS.md": "Test." }, model: noModel, records: COLLECTIONS, scheduleCheckMs: 0, database: sqlite(path) });
  await agent.records.put("questions", "q1", question(1));
  await agent.records.put("notes", "n1", { about: "key:7", text: "prefers mornings" });
  const child = spawn(process.execPath, [fileURLToPath(new URL("../testing/src/cli.ts", import.meta.url)), "records", "export"], { cwd: dir, env: { PATH: process.env.PATH } });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { err += c; });
  const code = await new Promise((done) => child.on("close", done));
  assert.equal(code, 0, err);
  const lines = out.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((r) => [r.collection, r.id, r.value]).sort(), [["notes", "n1", { about: "key:7", text: "prefers mornings" }], ["questions", "q1", question(1)]]);
  assert.match(err, /Exported 2 records\./);
});
