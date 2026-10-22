// covers: src/store.ts src/db.ts src/conversation.ts src/agent.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { createAgent, sqlite, SMS_KEYWORDS, Store, tool, type ChannelInfo, type Database, type Outbound } from "../src/index.ts";
import { LEASE_MS, RESEND_WITHIN_MS } from "../src/conversation.ts";
import { STORE_RETRY_MS } from "../src/store.ts";
import { SMS, WHATSAPP, call, gate, last, multi, respond, scriptedModel, users } from "./helpers.ts";

const CHANNELS = { sms: { info: SMS, phone: true } };
const file = () => join(mkdtempSync(join(tmpdir(), "flow-db-")), "chinwag.db");
/** The clock of a process started after one that died mid-turn, once the dead one's lease ran out. */
const leaseOver = () => Date.now() + LEASE_MS;

/** A database that dies at the first write to `table`: that write and every statement after it fail, as when the process is killed there. */
function diesAt(table: string, db: Database): Database {
  let dead = false;
  const guard = (sql: string) => {
    if (dead || sql.startsWith(`INSERT INTO ${table} `)) {
      dead = true;
      throw new Error("the process died");
    }
  };
  const on = (inner: Omit<Database, "transaction">): Omit<Database, "transaction"> => ({
    durable: inner.durable,
    dialect: inner.dialect,
    query: async (sql, params) => (guard(sql), inner.query(sql, params)),
    run: async (sql, params) => (guard(sql), inner.run(sql, params)),
  });
  return { ...on(db), transaction: (work) => db.transaction((tx) => work(on(tx))) };
}

/** A database that stops answering when `kill()` is called, as a process that died: it neither renews nor lets go of what it held. */
function killable(db: Database): Database & { kill(): void } {
  let dead = false;
  const guard = () => {
    if (dead) throw new Error("the process died");
  };
  const on = (inner: Omit<Database, "transaction">): Omit<Database, "transaction"> => ({
    durable: inner.durable,
    dialect: inner.dialect,
    query: async (sql, params) => (guard(), inner.query(sql, params)),
    run: async (sql, params) => (guard(), inner.run(sql, params)),
  });
  return { ...on(db), transaction: (work) => (guard(), db.transaction((tx) => work(on(tx)))), kill: () => (dead = true) };
}

test("while a deploy runs the old and new runner side by side, each message is answered once, and the new runner carries on the conversation", async () => {
  const path = file();
  const old = multi({ channels: CHANNELS, database: sqlite(path) });
  await old.agent.resume();
  const sms = (text: string, messageId: string) => ({ channel: "sms", from: "+15550100100", message: text, messageId });
  const a = await old.agent.message(sms("when is my session?", "SM1"));
  const id = a!.conversationId;
  const first = await old.nextCall(0); // the old runner's turn is running when the new one starts

  const next = multi({ channels: CHANNELS, database: sqlite(path), dir: old.dir });
  await next.agent.resume();
  await next.agent.conversation(id)?.stored(); // it looked at the open turn, and left it to the old runner
  // A message both runners are sent (each reads the event stream): it reaches the new one first.
  await next.agent.message(sms("and where?", "SM2"));
  first.answer(respond(call("send_sms", { text: "Thursday at 10." })));
  const second = await old.nextCall(1); // the old runner takes the message the new one stored
  assert.deepEqual(users(second.request.messages), ["[SM1] when is my session?", "[SM2] and where?"]);
  await old.agent.message(sms("and where?", "SM2")); // its own copy of the event, later
  second.answer(respond(call("send_sms", { text: "At the studio." })));
  await old.agent.conversation(id)!.whenIdle();

  // The old runner stops; the new one has the conversation as the old one left it.
  await next.agent.message(sms("thanks!", "SM3"));
  const third = await next.nextCall(0);
  assert.deepEqual(users(third.request.messages), ["[SM1] when is my session?", "[SM2] and where?", "[SM3] thanks!"]);
  third.answer(respond(call("send_sms", { text: "Any time." })));
  await next.agent.conversation(id)!.whenIdle();
  assert.deepEqual([old.calls.length, next.calls.length], [2, 1], "no turn ran twice");
  assert.deepEqual([...old.texts("sms"), ...next.texts("sms")], ["Thursday at 10.", "At the studio.", "Any time."]);
});

test("a runner that dies mid-turn leaves the turn to another once its lease runs out, and it runs there once", async () => {
  const path = file();
  const database = killable(sqlite(path));
  const dying = multi({ channels: CHANNELS, database });
  await dying.agent.resume();
  const a = await dying.agent.message({ channel: "sms", from: "+15550100100", message: "when is my session?", messageId: "SM1" });
  await dying.nextCall(0);
  await dying.agent.conversation(a!.conversationId)!.stored();
  database.kill();

  const clock = { now: Date.now() };
  const other = multi({ channels: CHANNELS, database: sqlite(path), dir: dying.dir, now: () => clock.now });
  await other.agent.resume();
  await other.agent.conversation(a!.conversationId)?.stored();
  await other.agent.runDue();
  assert.equal(other.calls.length, 0, "not while the lease may still be the dying runner's");

  clock.now += LEASE_MS;
  await other.agent.runDue();
  const turn = await other.nextCall(0);
  assert.deepEqual(users(turn.request.messages), ["[SM1] when is my session?"]);
  turn.answer(respond(call("send_sms", { text: "Thursday at 10." })));
  await other.agent.conversation(a!.conversationId)!.whenIdle();
  await other.agent.runDue();
  assert.equal(other.calls.length, 1, "it ran once");
  assert.deepEqual(other.texts("sms"), ["Thursday at 10."]);
});

test("an agent started again on the same database carries on the conversation", async () => {
  const path = file();
  const before = multi({ channels: CHANNELS, database: sqlite(path) });
  await before.agent.resume();
  const a = await before.message("sms", "+15550100100", "hi, I'm Sam");
  (await before.nextCall(0)).answer(respond(call("send_sms", { text: "Hi Sam!" })));
  await before.agent.conversation(a!.conversationId)!.whenIdle();

  const after = multi({ channels: CHANNELS, database: sqlite(path), dir: before.dir });
  await after.agent.resume();
  const b = await after.message("sms", "+15550100100", "what's my name?");
  assert.equal(b!.conversationId, a!.conversationId);
  assert.equal(b!.messageId, "m2", "message ids carry on");
  const first = await after.nextCall(0);
  assert.deepEqual(users(first.request.messages), ["[m1] hi, I'm Sam", "[m2] what's my name?"]);
  first.answer(respond(call("send_sms", { text: "Sam." })));
  await after.agent.conversation(b!.conversationId)!.whenIdle();
});

test("a turn cut off by a restart runs again, and its answer goes out", async () => {
  const path = file();
  const before = multi({ channels: CHANNELS, database: sqlite(path) });
  await before.agent.resume();
  const a = await before.message("sms", "+15550100100", "when is my session?");
  await before.nextCall(0); // the model is thinking when the process dies
  await before.agent.conversation(a!.conversationId)!.stored();

  const after = multi({ channels: CHANNELS, database: sqlite(path), dir: before.dir, now: leaseOver });
  await after.agent.resume();
  const first = await after.nextCall(0);
  assert.deepEqual(users(first.request.messages), ["[m1] when is my session?"]);
  first.answer(respond(call("send_sms", { text: "Thursday at 10." })));
  await after.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(after.texts("sms"), ["Thursday at 10."]);
});

test("a background tool cut off by a restart is reported to the agent, never run again", async () => {
  const path = file();
  let runs = 0;
  const never = gate<string>();
  const book = tool({ name: "book", description: "", input: z.object({}), run: () => (runs++, never.promise) });
  const before = multi({ channels: CHANNELS, database: sqlite(path), tools: [book] });
  await before.agent.resume();
  const a = await before.message("sms", "+15550100100", "book Friday");
  (await before.nextCall(0)).answer(respond(call("send_sms", { text: "Booking Friday." }), call("book")));
  (await before.nextCall(1)).answer(respond());
  await before.agent.conversation(a!.conversationId)!.stored();
  assert.equal(runs, 1);

  const after = multi({ channels: CHANNELS, database: sqlite(path), dir: before.dir, tools: [book], now: leaseOver });
  await after.agent.resume();
  const first = await after.nextCall(0);
  assert.match(users(first.request.messages).at(-1)!, /book \(task_1\) was still running in the background when the agent restarted/);
  first.answer(respond(call("send_sms", { text: "Let me check whether Friday went through." })));
  await after.agent.conversation(a!.conversationId)!.whenIdle();
  assert.equal(runs, 1, "the tool was not called again");
});

test("receive() keeps a one-channel conversation across a restart too", async () => {
  const path = file();
  const dir = multi({ channels: CHANNELS }).dir;
  const start = () => {
    const scripted = scriptedModel();
    const agent = createAgent({ dir, model: scripted.model, debounceMs: 0, database: sqlite(path), scheduleCheckMs: 0 });
    return { agent, ...scripted };
  };
  const out: Outbound[] = [];
  const before = start();
  await before.agent.resume();
  before.agent.receive("chat-1", "hi, I'm Sam", (o) => void out.push(o));
  (await before.nextCall(0)).answer(respond(call("send_chat", { text: "Hi Sam!" })));
  await before.agent.conversation("chat-1")!.whenIdle();

  const after = start();
  await after.agent.resume();
  assert.equal(after.agent.receive("chat-1", "what's my name?", (o) => void out.push(o)), "m2");
  const first = await after.nextCall(0);
  assert.deepEqual(users(first.request.messages), ["[m1] hi, I'm Sam", "[m2] what's my name?"]);
  first.answer(respond(call("send_chat", { text: "Sam." })));
  await after.agent.conversation("chat-1")!.whenIdle();
});

test("a database that survives restarts must be resumed before the first message", async () => {
  const h = multi({ channels: CHANNELS, database: sqlite(file()) });
  await assert.rejects(h.message("sms", "+15550100100", "hi"), /call await agent.resume\(\)/);
});

test("phone keys stored before E.164 are upgraded, so the number's next channel joins them; two already apart (in any two forms) stay apart", async () => {
  const database = sqlite(file());
  const store = new Store(database, "default");
  await store.migrate();
  await store.createConversation("p_wa", "phone:15550100100");
  await store.createConversation("p_both_wa", "phone:15550100200");
  await store.createConversation("p_both_sms", "phone:+15550100200");
  await store.createConversation("p_old_wa", "phone:15550100300");
  await store.createConversation("p_old_00", "phone:0015550100300");
  // As if the upgrade had not run yet on this database.
  await database.run("DELETE FROM parley_migrations WHERE version = 4");
  const h = multi({ channels: { sms: { info: SMS, phone: true } }, database });
  await h.agent.resume();
  const a = await h.message("sms", "+15550100100", "hi");
  assert.equal(a!.conversationId, "p_wa");
  assert.deepEqual((await store.allConversations()).map((c) => c.personKey).sort(), ["phone:+15550100100", "phone:+15550100200", "phone:0015550100300", "phone:15550100200", "phone:15550100300"]);
});

test("a tool gets its call id and a signal, and an idempotency key that is the same when its turn runs again after a restart", async () => {
  const path = file();
  const seen: Array<{ callId: string; idempotencyKey: string; signal: AbortSignal }> = [];
  const never = gate<string>();
  let answer: Promise<string> = never.promise;
  const book = tool({ name: "book", description: "", input: z.object({ slot: z.string() }), deadlineMs: 60_000, run: (_input, context) => (seen.push(context), answer) });
  const before = multi({ channels: CHANNELS, database: sqlite(path), tools: [book] });
  await before.agent.resume();
  const a = await before.message("sms", "+15550100100", "book Friday 10am");
  const booking = call("book", { slot: "fri-10" });
  (await before.nextCall(0)).answer(respond(call("send_sms", { text: "Booking it." }), booking));
  while (!seen.length) await new Promise((resolve) => setImmediate(resolve));
  await before.agent.conversation(a!.conversationId)!.stored(); // the process dies while the booking runs

  answer = Promise.resolve("booked");
  const after = multi({ channels: CHANNELS, database: sqlite(path), dir: before.dir, tools: [book], now: leaseOver });
  await after.agent.resume();
  const again = await after.nextCall(0);
  assert.match(last(again.request.messages).content, /Cut off by a restart/);
  again.answer(respond(call("book", { slot: "fri-10" })));
  (await after.nextCall(1)).answer(respond(call("send_sms", { text: "Booked for Friday at 10." })));
  await after.agent.conversation(a!.conversationId)!.whenIdle();
  assert.equal(seen.length, 2);
  assert.equal(seen[0].callId, booking.id);
  assert.notEqual(seen[1].callId, seen[0].callId);
  assert.equal(seen[1].idempotencyKey, seen[0].idempotencyKey, "the backend can tell it is the same booking");

  await before.agent.forgetPerson(a!.conversationId);
  assert.equal(seen[0].signal.aborted, true, "a forgotten person's tools are told to stop");
});

test("with the provider's own message ids, the transcript keeps the person's side, and replies and reactions work after a restart", async () => {
  const path = file();
  const channels = { whatsapp: { info: WHATSAPP, phone: true } };
  const before = multi({ channels, database: sqlite(path) });
  await before.agent.resume();
  const a = await before.agent.message({ channel: "whatsapp", from: "15550100100", message: "is the 10am free?", messageId: "wamid.HBgL1" });
  (await before.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Let me look." })));
  await before.agent.conversation(a!.conversationId)!.whenIdle();

  const after = multi({ channels, database: sqlite(path), dir: before.dir });
  await after.agent.resume();
  await after.agent.message({ channel: "whatsapp", from: "15550100100", message: "?", messageId: "wamid.HBgL2" });
  (await after.nextCall(0)).answer(respond(call("react", { message_id: "wamid.HBgL1", emoji: "👍" }), call("send_whatsapp", { text: "Yes, it's free.", reply_to: "wamid.HBgL1" })));
  await after.agent.conversation(a!.conversationId)!.whenIdle();
  // Without the idempotency key every send written ahead carries (covered below).
  const unkeyed = (o: Outbound) => (o.type === "message" ? (({ idempotencyKey: _, ...rest }) => rest)(o) : o);
  assert.deepEqual(after.out.map((o) => unkeyed(o.outbound)).filter((o) => o.type === "reaction" || o.type === "message"), [
    { type: "reaction", emoji: "👍", messageId: "wamid.HBgL1" },
    { type: "message", text: "Yes, it's free.", replyTo: "wamid.HBgL1" },
  ]);
  const transcript = await after.agent.transcript(a!.conversationId);
  assert.deepEqual(transcript.filter((l) => l.kind === "in").map((l) => l.kind === "in" && [l.id, l.text]), [["wamid.HBgL1", "is the 10am free?"], ["wamid.HBgL2", "?"]]);
});

test("a delivery failure or a reaction reported after a restart reaches the agent", async () => {
  const path = file();
  const before = multi({ channels: CHANNELS, database: sqlite(path) });
  await before.agent.resume();
  const a = await before.message("sms", "+15550100100", "hi");
  (await before.nextCall(0)).answer(respond(call("send_sms", { text: "Hi Sam!" })));
  await before.agent.conversation(a!.conversationId)!.whenIdle();

  const after = multi({ channels: CHANNELS, database: sqlite(path), dir: before.dir });
  await after.agent.resume();
  assert.equal(after.agent.conversation(a!.conversationId), undefined, "not in memory");
  after.agent.reacted(a!.conversationId, "👍", "Hi Sam!");
  after.agent.undelivered(a!.conversationId, "Hi Sam!", "carrier rejected it");
  const told = await after.nextCall(0);
  assert.deepEqual(users(told.request.messages).slice(-2), ['[They reacted 👍 to your message: "Hi Sam!"]', '[Not delivered] "Hi Sam!": carrier rejected it']);
  told.answer(respond());
  await after.agent.conversation(a!.conversationId)!.whenIdle();
});

test("a provider's message id is kept with what its message stored, so a crash between them loses neither and the retry is taken", async () => {
  const channels = { sms: { info: SMS, phone: true, kind: "sms" as const, keywords: SMS_KEYWORDS } };
  for (const [table, text] of [["inbox", "book me in for 10"], ["no_contact", "STOP"]] as const) {
    const path = file();
    const before = multi({ channels, database: diesAt(table, sqlite(path)) });
    await before.agent.resume();
    const sent = { channel: "sms", from: "+15550100100", message: text, messageId: "SM1" };
    const a = await before.agent.message(sent);
    if (a) await before.agent.conversation(a.conversationId)!.stored();

    const after = multi({ channels, database: sqlite(path), dir: before.dir, now: leaseOver });
    await after.agent.resume();
    await after.agent.message(sent);
    assert.ok(!after.events.some((e) => e.type === "message.duplicate"), `the retry is taken (crash at ${table})`);
    if (table === "inbox") {
      const turn = await after.nextCall(0);
      assert.equal(users(turn.request.messages).at(-1), "[SM1] book me in for 10");
      turn.answer(respond(call("send_sms", { text: "Booked." })));
      await after.agent.conversation(a!.conversationId)!.whenIdle();
    } else {
      assert.equal((await after.agent.nudge({ to: { channel: "sms", address: "+15550100100" }, text: "Sale today!" })).status, "dropped", "their STOP is kept");
    }
  }
});

test("a message intercept answered is answered once when the provider sends it again, also after a restart, and the agent still reads it", async () => {
  const path = file();
  const intercept = (_id: string, text: string) => (/chest pain/i.test(text) ? "Call 911 now." : null);
  const before = multi({ channels: CHANNELS, database: sqlite(path), intercept });
  await before.agent.resume();
  const sent = { channel: "sms", from: "+15550100100", message: "I have chest pain", messageId: "SM1" };
  assert.equal(await before.agent.message(sent), null);
  await before.agent.message(sent);
  assert.deepEqual(before.texts(), ["Call 911 now."]);
  const id = before.events.find((e) => e.type === "message.in")!.conversationId;
  await before.agent.conversation(id)!.whenIdle();

  const after = multi({ channels: CHANNELS, database: sqlite(path), dir: before.dir, intercept });
  await after.agent.resume();
  await after.agent.message(sent);
  assert.deepEqual(after.texts(), [], "not answered again");
  assert.deepEqual([...before.events, ...after.events].filter((e) => e.type === "message.in" || e.type === "message.duplicate").map((e) => e.type), ["message.in", "message.duplicate", "message.duplicate"]);
  await after.agent.message({ ...sent, message: "it's better now", messageId: "SM2" });
  const next = await after.nextCall(0);
  assert.deepEqual(users(next.request.messages), ["[SM1] I have chest pain\n[Chinwag] The business's own rules answered this for you on sms, as written:", "[SM2] it's better now"]);
  next.answer(respond(call("send_sms", { text: "Glad to hear it." })));
  await after.agent.conversation(id)!.whenIdle();
  assert.deepEqual((await after.agent.transcript(id)).map((l) => (l.kind === "in" || l.kind === "out") && l.text), ["I have chest pain", "Call 911 now.", "it's better now", "Glad to hear it."]);
});

test("provider message ids are deleted once older than 7 days, in batches, by one of two runners, at most hourly", async () => {
  const path = file();
  let deletes = [0, 0];
  const counted = (i: number): Database => {
    const db = sqlite(path);
    return { ...db, run: (sql, params) => (sql.startsWith("DELETE FROM inbound") && deletes[i]++, db.run(sql, params)) };
  };
  const start = Date.now();
  const clock = { now: start };
  const runners: Array<ReturnType<typeof multi>> = [];
  for (const i of [0, 1]) {
    runners.push(multi({ channels: CHANNELS, database: counted(i), now: () => clock.now }));
    await runners[i].agent.resume();
  }
  const db = sqlite(path);
  const ids = async () => (await db.query("SELECT message_id FROM inbound")).map((r) => String(r.message_id));
  await db.run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2001)
     INSERT INTO inbound (agent_id, conversation_id, channel, message_id, at) SELECT 'default', 'p_1', 'sms', 'old' || i, ? FROM n`,
    [start],
  );
  await db.run("INSERT INTO inbound (agent_id, conversation_id, channel, message_id, at) VALUES ('default', 'p_1', 'sms', 'recent', ?)", [start + 6 * 86_400_000]);
  const pass = async (at: number) => {
    clock.now = start + at;
    deletes = [0, 0];
    await Promise.all(runners.map((r) => r.agent.runDue()));
    return [...deletes].sort();
  };
  const minutes = (m: number) => m * 60_000;

  assert.deepEqual(await pass(7 * 86_400_000 - minutes(30)), [0, 1], "one runner looks");
  assert.equal((await ids()).length, 2002, "nothing is 7 days old yet");
  assert.deepEqual(await pass(7 * 86_400_000 + minutes(10)), [0, 0], "the next look is an hour after the last");
  assert.equal((await ids()).length, 2002);
  assert.deepEqual(await pass(7 * 86_400_000 + minutes(30)), [0, 3], "one runner deletes them, 1,000 at a time");
  assert.deepEqual(await ids(), ["recent"]);
});

/** A store that drops appendHistory's doneInbox, as a broken remote store did: rows a turn or a send handled stay open. */
class Forgetful extends Store {
  override appendHistory(conversationId: string, seq: number, entries: Parameters<Store["appendHistory"]>[2]): Promise<void> {
    return super.appendHistory(conversationId, seq, entries);
  }
}

test("after a restart, a message already answered and a nudge already sent are neither answered nor sent again, even when the store left their inbox rows open", async () => {
  const path = file();
  const sam = { channel: "sms", address: "+15550100100" };
  const before = multi({ channels: CHANNELS, store: new Forgetful(sqlite(path), "default") });
  await before.agent.resume();
  const a = await before.message("sms", sam.address, "hi");
  (await before.nextCall(0)).answer(respond(call("send_sms", { text: "Hi!" })));
  await before.agent.conversation(a!.conversationId)!.whenIdle();
  assert.equal((await before.agent.nudge({ to: sam, text: "Your order is ready." })).status, "sent");
  await before.agent.conversation(a!.conversationId)!.whenIdle();
  const store = new Store(sqlite(path), "default");
  assert.deepEqual(await store.unfinished(), [a!.conversationId], "their inbox rows were left open");

  const after = multi({ channels: CHANNELS, store: new Forgetful(sqlite(path), "default"), dir: before.dir });
  await after.agent.resume();
  const c = after.agent.conversation(a!.conversationId);
  await c?.stored();
  await c?.whenIdle();
  assert.deepEqual(after.out, [], "nothing sent again");
  assert.equal(after.calls.length, 0, "no model call");
  assert.deepEqual(await store.unfinished(), [], "both rows are marked done");
});

test("a reply and a text nudge leave nothing unfinished in the store", async () => {
  const h = multi({ channels: CHANNELS });
  const a = await h.message("sms", "+15550100100", "hi");
  (await h.nextCall(0)).answer(respond(call("send_sms", { text: "Hi!" })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.equal((await h.agent.nudge({ to: { channel: "sms", address: "+15550100100" }, text: "Your order is ready." })).status, "sent");
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(await new Store(h.database, "default").unfinished(), []);
});

/**
 * A database that stops dead, as a frozen process: once frozen, every statement waits forever and
 * nothing it holds is locked. `freezeAtNextTransaction` freezes it as the next transaction starts;
 * `frozen` resolves once it is frozen and a statement waits.
 */
function freezable(db: Database) {
  let mode: "live" | "armed" | "frozen" = "live";
  const reached = gate();
  const stop = () => ((mode = "frozen"), reached.open(), new Promise<never>(() => {}));
  const on = (inner: Omit<Database, "transaction">): Omit<Database, "transaction"> => ({
    durable: inner.durable,
    dialect: inner.dialect,
    query: (sql, params) => (mode === "frozen" ? stop() : inner.query(sql, params)),
    run: (sql, params) => (mode === "frozen" ? stop() : inner.run(sql, params)),
  });
  return {
    ...on(db),
    transaction: <T>(work: (tx: Omit<Database, "transaction">) => Promise<T>): Promise<T> => (mode !== "live" ? stop() : db.transaction((tx) => work(on(tx)))),
    freeze: () => ((mode = "frozen"), reached.open()),
    freezeAtNextTransaction: () => void (mode = "armed"),
    frozen: reached.promise,
  };
}

/** Flow Messaging as a channel sees it: a message whose idempotency key it already has does not reach the person again. */
function deduping() {
  const keys: Array<string | undefined> = [];
  const delivered: string[] = [];
  const send = (o: Outbound) => {
    if (o.type !== "message") return;
    if (!o.idempotencyKey || !keys.includes(o.idempotencyKey)) delivered.push(o.text);
    keys.push(o.idempotencyKey);
  };
  return { keys, delivered, send };
}

const DEDUPING_SMS: ChannelInfo = { ...SMS, idempotentSends: true };

/**
 * A runner that stops dead just after its message reached the channel: before the send was settled
 * ("settle"), or settled but before its result joined the history ("result").
 */
async function diesAfterSend(info: ChannelInfo, at: "settle" | "result") {
  const path = file();
  const database = freezable(sqlite(path));
  const channel = deduping();
  const send = (_: string, o: Outbound) => {
    channel.send(o);
    if (o.type !== "message") return;
    if (at === "result") return database.freezeAtNextTransaction();
    database.freeze();
    return new Promise<never>(() => {});
  };
  const dying = multi({ channels: { sms: { info, phone: true, send } }, database });
  await dying.agent.resume();
  const a = await dying.message("sms", "+15550100100", "when is my session?");
  const sent = call("send_sms", { text: "Thursday at 10." });
  (await dying.nextCall(0)).answer(respond(sent));
  await database.frozen;
  const id = a!.conversationId;
  return { path, channel, dir: dying.dir, id, callId: sent.id, key: `send:${id}:1:${sent.id}` };
}

const toolResult = (messages: Array<{ role: string; toolCallId?: string; content?: unknown }>, callId: string) => messages.find((m) => m.role === "tool" && m.toolCallId === callId)?.content as string | undefined;

test("a runner stopped while it writes a step down sent nothing of it: after a restart the step runs again and its message goes once", async () => {
  const path = file();
  const database = freezable(sqlite(path));
  const dying = multi({ channels: { sms: { info: DEDUPING_SMS, phone: true } }, database });
  await dying.agent.resume();
  const a = await dying.message("sms", "+15550100100", "when is my session?");
  const first = await dying.nextCall(0);
  await dying.agent.conversation(a!.conversationId)!.stored();
  database.freezeAtNextTransaction();
  first.answer(respond(call("send_sms", { text: "Thursday at 10." })));
  await database.frozen;

  const after = multi({ channels: { sms: { info: DEDUPING_SMS, phone: true } }, database: sqlite(path), dir: dying.dir, now: leaseOver });
  await after.agent.resume();
  const again = await after.nextCall(0);
  assert.deepEqual(users(again.request.messages), ["[m1] when is my session?"]);
  assert.ok(!again.request.messages.some((m) => m.role === "assistant"), "the step was not stored");
  again.answer(respond(call("send_sms", { text: "Thursday at 10." })));
  await after.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(dying.texts("sms"), [], "nothing went before its step was stored");
  assert.deepEqual(after.texts("sms"), ["Thursday at 10."]);
});

test("a send that reached a deduping channel before the runner stopped goes again with its key after a restart, before the turn carries on, and reaches the person once", async () => {
  const run = await diesAfterSend(DEDUPING_SMS, "settle");
  const after = multi({ channels: { sms: { info: DEDUPING_SMS, phone: true, send: (_, o) => run.channel.send(o) } }, database: sqlite(run.path), dir: run.dir, now: leaseOver });
  await after.agent.resume();
  await after.agent.conversation(run.id)!.stored();
  await after.agent.conversation(run.id)!.whenIdle();
  assert.deepEqual(run.channel.keys, [run.key, run.key], "sent again with the same key");
  assert.deepEqual(run.channel.delivered, ["Thursday at 10."]);
  const types = after.events.map((e) => e.type);
  assert.ok(types.indexOf("send.resumed") < types.indexOf("turn.start"), "the send went again before the turn carried on");
  assert.equal(after.events.find((e) => e.type === "send.resumed")?.outcome, "sent");
  assert.match(toolResult(after.followUps[0].messages, run.callId) ?? "", /^\{"delivered":true/, "the model is told it was delivered");

  await after.message("sms", "+15550100100", "thanks");
  (await after.nextCall(0)).answer(respond(call("send_sms", { text: "You're welcome." })));
  await after.agent.conversation(run.id)!.whenIdle();
  assert.deepEqual(run.channel.delivered, ["Thursday at 10.", "You're welcome."]);
});

test("a pending send is not sent again on a channel that does not dedupe, nor past a day: the model is told it may not have gone", async () => {
  for (const [info, now] of [[SMS, leaseOver], [DEDUPING_SMS, () => Date.now() + RESEND_WITHIN_MS]] as const) {
    const run = await diesAfterSend(info, "settle");
    const after = multi({ channels: { sms: { info, phone: true, send: (_, o) => run.channel.send(o) } }, database: sqlite(run.path), dir: run.dir, now });
    await after.agent.resume();
    const turn = await after.nextCall(0);
    assert.match(toolResult(turn.request.messages, run.callId) ?? "", /may or may not have happened/);
    assert.deepEqual(run.channel.keys, [run.key], "not sent again");
  }
});

test("a send settled before the runner stopped gives the model its result after a restart, and a day later it is deleted", async () => {
  const run = await diesAfterSend(SMS, "result");
  const clock = { now: leaseOver() };
  const after = multi({ channels: { sms: { info: SMS, phone: true, send: (_, o) => run.channel.send(o) } }, database: sqlite(run.path), dir: run.dir, now: () => clock.now });
  await after.agent.resume();
  await after.agent.conversation(run.id)!.stored();
  await after.agent.conversation(run.id)!.whenIdle();
  assert.equal(toolResult(after.followUps[0].messages, run.callId), '{"delivered":true,"channel":"sms"}');
  assert.deepEqual(run.channel.keys, [run.key], "not sent again");

  const sends = async () => Number((await sqlite(run.path).query("SELECT count(*) AS n FROM sends"))[0].n);
  assert.equal(await sends(), 1);
  clock.now += RESEND_WITHIN_MS;
  await after.agent.runDue();
  assert.equal(await sends(), 0);
});

test("a conversation's writes are fenced by the lease: once another runner took it, the stalled runner's writes are refused and change nothing; unfenced writes work as before", async () => {
  const store = new Store(sqlite(), "agent");
  await store.migrate();
  await store.createConversation("c1", "sms:+15550100100");
  const now = Date.now();
  assert.equal(await store.claimConversation("c1", "old", now, now + LEASE_MS), 1);
  assert.equal(await store.claimConversation("c1", "new", now + LEASE_MS, now + 2 * LEASE_MS), 2);
  const stale = { runner: "old", epoch: 1 };
  await assert.rejects(store.updateConversation("c1", { turns: 5 }, stale), { name: "StaleRunner" });
  await assert.rejects(store.appendHistory("c1", 0, [{ role: "user", content: "late" }], [], stale), { name: "StaleRunner" });
  await assert.rejects(store.beginSends("c1", 0, [{ role: "user", content: "late" }], [{ key: "k", callId: "c", channel: "sms" }], now, stale), { name: "StaleRunner" });
  await assert.rejects(store.addTask("c1", "t1", "c", "tool", now, stale), { name: "StaleRunner" });
  const row = await store.addInbox("c1", "note", { text: "x" });
  await assert.rejects(store.doneInbox([row], "c1", stale), { name: "StaleRunner" });
  assert.deepEqual([(await store.conversation("c1"))!.turns, (await store.history("c1")).length, (await store.sendsFor("c1", ["c"])).length, (await store.tasks("c1")).length, (await store.openInbox("c1")).length], [0, 0, 0, 0, 1], "nothing was written");

  await store.updateConversation("c1", { turns: 5 }, { runner: "new", epoch: 2 });
  await store.updateConversation("c1", { messageCount: 3 });
  assert.deepEqual([(await store.conversation("c1"))!.turns, (await store.conversation("c1"))!.messageCount], [5, 3]);
});

test("a runner that stalled past its lease sends nothing once another runner took the conversation, and stops working on it", async () => {
  const path = file();
  const stalled = multi({ channels: CHANNELS, database: sqlite(path) });
  await stalled.agent.resume();
  const a = await stalled.message("sms", "+15550100100", "when is my session?");
  const id = a!.conversationId;
  const late = await stalled.nextCall(0); // its model call hangs past the lease
  const copy = stalled.agent.conversation(id)!;
  await copy.stored();

  const other = multi({ channels: CHANNELS, database: sqlite(path), dir: stalled.dir, now: leaseOver });
  await other.agent.resume();
  (await other.nextCall(0)).answer(respond(call("send_sms", { text: "Thursday at 10." })));
  await other.agent.conversation(id)!.whenIdle();

  late.answer(respond(call("send_sms", { text: "Thursday at 10!" })));
  await copy.whenIdle();
  assert.deepEqual(stalled.texts("sms"), [], "the stalled runner's send never went");
  assert.equal(stalled.agent.conversation(id), undefined, "it dropped its copy");
  assert.deepEqual(other.texts("sms"), ["Thursday at 10."]);
  const entries = await new Store(sqlite(path), "default").history(id);
  assert.equal(entries.filter((e) => e.role === "assistant").length, 1, "only the runner holding it wrote the step");
});

/** A database whose writes fail as a busy database's do, while `failing()` says so (asked once a write). */
function busyAt(db: Database, failing: () => boolean): Database {
  const guard = (sql: string) => {
    if (/^(INSERT|UPDATE|DELETE)/.test(sql) && failing()) throw Object.assign(new Error("database is locked"), { errcode: 5 });
  };
  const on = (inner: Omit<Database, "transaction">): Omit<Database, "transaction"> => ({
    durable: inner.durable,
    dialect: inner.dialect,
    query: async (sql, params) => (guard(sql), inner.query(sql, params)),
    run: async (sql, params) => (guard(sql), inner.run(sql, params)),
  });
  return { ...on(db), transaction: (work) => db.transaction((tx) => work(on(tx))) };
}

test("a store write that fails for a passing reason is tried again in order; one that keeps failing is a store.write_failed event and status().store says failing, and the chat still replies", async () => {
  const delays = STORE_RETRY_MS.splice(0, STORE_RETRY_MS.length, 0, 0, 0);
  try {
    const path = file();
    let failures = 0;
    const h = multi({ channels: CHANNELS, database: busyAt(sqlite(path), () => failures-- > 0) });
    await h.agent.resume();
    failures = 2;
    const a = await h.message("sms", "+15550100100", "when is my session?");
    (await h.nextCall(0)).answer(respond(call("send_sms", { text: "Thursday at 10." })));
    await h.agent.conversation(a!.conversationId)!.whenIdle();
    assert.equal(h.events.filter((e) => e.type === "store.write_failed").length, 0, "tried again until it was stored");
    assert.equal(h.agent.status().store, "ok");
    const stored = await new Store(sqlite(path), "default").history(a!.conversationId);
    assert.deepEqual(stored.map((e) => e.role), ["user", "assistant", "tool", "assistant"], "nothing was lost");

    failures = Number.POSITIVE_INFINITY;
    await h.message("sms", "+15550100100", "and where?");
    (await h.nextCall(1)).answer(respond(call("send_sms", { text: "At the studio." })));
    await h.agent.conversation(a!.conversationId)!.whenIdle();
    assert.deepEqual(h.texts("sms"), ["Thursday at 10.", "At the studio."], "the reply still went");
    assert.ok(h.events.some((e) => e.type === "store.write_failed" && e.error === "Error"));
    assert.equal(h.agent.status().store, "failing");

    failures = 0;
    await h.message("sms", "+15550100100", "thanks");
    (await h.nextCall(2)).answer(respond(call("send_sms", { text: "Any time." })));
    await h.agent.conversation(a!.conversationId)!.whenIdle();
    assert.equal(h.agent.status().store, "ok", "ok again once a write is stored");
  } finally {
    STORE_RETRY_MS.splice(0, STORE_RETRY_MS.length, ...delays);
  }
});

test("a tool keeps values per person: read live (also what the business set), kept across a restart, capped, never shown to the model on their own, and forgotten with the person", async () => {
  const path = file();
  const seen: unknown[] = [];
  const step = tool({
    name: "next_step",
    description: "Move their onboarding on",
    input: z.object({}),
    run: async (_input, ctx) => {
      const at = (await ctx.values!.get<number>("onboarding.step")) ?? 0;
      await ctx.values!.set("onboarding.step", at + 1);
      seen.push(await ctx.values!.all());
      return { step: at + 1 };
    },
  });
  const person = { channel: "sms", address: "+15550100100" };
  const before = multi({ channels: CHANNELS, database: sqlite(path), tools: [step] });
  await before.agent.resume();
  assert.equal(await before.agent.values(person), null, "no one by that address yet");
  const a = await before.message("sms", "+15550100100", "hi");
  (await before.nextCall(0)).answer(respond(call("send_sms", { text: "On it." }), call("next_step", {})));
  (await before.nextCall(1)).answer(respond());
  await before.agent.conversation(a!.conversationId)!.whenIdle();
  await before.agent.setValue(person, "plan", "pro");

  const after = multi({ channels: CHANNELS, database: sqlite(path), dir: before.dir, tools: [step] });
  await after.agent.resume();
  await after.message("sms", "+15550100100", "next");
  const turn = await after.nextCall(0);
  assert.doesNotMatch(JSON.stringify(turn.request), /"pro"|onboarding\.step/, "the model is not shown them");
  turn.answer(respond(call("send_sms", { text: "On it." }), call("next_step", {})));
  (await after.nextCall(1)).answer(respond());
  await after.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(seen, [{ "onboarding.step": 1 }, { "onboarding.step": 2, plan: "pro" }]);

  await assert.rejects(after.agent.setValue(person, "Plan", 1), /not a value name/);
  await assert.rejects(after.agent.setValue(person, "note", "x".repeat(4096)), /over 4096 bytes/);
  for (let i = 0; i < 62; i++) await after.agent.setValue(person, `v${i}`, i);
  await assert.rejects(after.agent.setValue(person, "one.more", true), /already has 64 values/);
  await after.agent.setValue(person, "plan", null);
  await after.agent.setValue(person, "one.more", true);
  assert.equal(Object.keys((await after.agent.values(person))!).length, 64);

  await after.agent.forgetPerson(a!.conversationId);
  assert.equal(await after.agent.values(person), null);
  assert.equal(Number((await sqlite(path).query("SELECT count(*) AS n FROM person_values"))[0].n), 0);
});
