// covers: src/schedules.ts src/time.ts src/store.ts src/db.ts src/postgres.ts src/conversation.ts src/agent.ts src/tools.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { z } from "zod";
import { postgres, sqlite, tool, WAKE_UP_LIMITS, type Database, type PostgresPool, type TemplateDefinition, type ToolContext } from "../src/index.ts";
import { Store } from "../src/store.ts";
import { claimDue, scheduleTools, wakeUpTools } from "../src/schedules.ts";
import { SMS, WHATSAPP, call, last, multi, respond } from "./helpers.ts";
import { unavailableRecords } from "../src/records.ts";

const CHANNELS = { sms: { info: SMS, phone: true } };
const NOON_NY = Date.UTC(2026, 9, 12, 16);
const SAM = "+15550100100";

/** Sam has written once and been answered; the clock is the test's. */
async function withSam(db: Database = sqlite(), tools: ReturnType<typeof tool>[] = []) {
  const clock = { now: NOON_NY };
  const h = multi({ channels: CHANNELS, database: db, now: () => clock.now, timeZone: "America/New_York", tools });
  await h.agent.resume();
  const a = await h.message("sms", SAM, "hi");
  (await h.nextCall(0)).answer(respond(call("send_sms", { text: "Hi!" })));
  const conversation = h.agent.conversation(a!.conversationId)!;
  await conversation.whenIdle();
  return { ...h, db, clock, conversationId: a!.conversationId, conversation, store: new Store(db, "default") };
}

const runRows = async (db: Database) => (await db.query("SELECT outcome, reason FROM schedule_runs")).map((r) => ({ ...r }));

test("a schedule that comes due becomes a turn, and its message goes out", async () => {
  const h = await withSam();
  await h.message("sms", SAM, "remind me in an hour to pick up my order");
  (await h.nextCall(1)).answer(respond(call("send_sms", { text: "Will do." }), call("schedule_message", { message: "remind them their order is ready", repeat: "once", in_minutes: 60 })));
  const result = await h.nextCall(2);
  assert.match(last(result.request.messages).content, /"summary":"once, Mon 12 Oct 2026 13:00 \(New York time\)"/);
  result.answer(respond());
  await h.conversation.whenIdle();

  h.clock.now += 61 * 60_000;
  assert.equal(await h.agent.runDue(), 1);
  const turn = await h.nextCall(3);
  assert.match(last(turn.request.messages).content, /^\[Scheduled message, not from the person: .* Do it now: remind them their order is ready\]/);
  turn.answer(respond(call("send_sms", { text: "Your order is ready!" })));
  await h.conversation.whenIdle();
  assert.deepEqual(h.texts("sms").at(-1), "Your order is ready!");
  assert.deepEqual(await runRows(h.db), [{ outcome: "sent", reason: null }]);
  assert.equal(await h.agent.runDue(), 0, "a once is done");
});

test("two runners claim a due run only once", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "flow-db-")), "flow.db");
  const h = await withSam(sqlite(path));
  await h.store.addSchedule({ id: "s1", conversationId: h.conversationId, channel: "sms", instruction: "check in", fixedText: false, mode: "message", rule: { repeat: "daily", time: "11:00" }, timeZone: "America/New_York", nextRunAt: NOON_NY - 60_000, maxRuns: null, endsOn: null, origin: "person" });
  const other = multi({ channels: CHANNELS, database: sqlite(path), now: () => h.clock.now, dir: h.dir });
  await other.agent.resume();
  const claimed = await Promise.all([h.agent.runDue(), other.agent.runDue()]);
  assert.equal(claimed[0] + claimed[1], 1);
  assert.equal((await runRows(h.db)).length, 1);
});

test("a run found more than 30 minutes late is missed, not sent, and the schedule moves on", async () => {
  const h = await withSam();
  await h.store.addSchedule({ id: "s1", conversationId: h.conversationId, channel: "sms", instruction: "check in", fixedText: false, mode: "message", rule: { repeat: "daily", time: "10:00" }, timeZone: "America/New_York", nextRunAt: NOON_NY - 2 * 3_600_000, maxRuns: null, endsOn: null, origin: "person" });
  assert.equal(await h.agent.runDue(), 0);
  assert.deepEqual((await runRows(h.db)).map((r) => r.outcome), ["missed"]);
  const [s] = await h.store.schedules(h.conversationId);
  assert.equal(s.nextRunAt, Date.UTC(2026, 9, 13, 14), "tomorrow at 10:00 New York time");
  assert.equal(h.calls.length, 1, "no turn for a missed run");
});

test("list and cancel see only this person's schedules", async () => {
  const h = await withSam();
  const other = await h.message("sms", "+15550100200", "hi");
  (await h.nextCall(1)).answer(respond(call("send_sms", { text: "Hi!" })));
  await h.agent.conversation(other!.conversationId)!.whenIdle();
  const base = { channel: "sms", fixedText: false, mode: "message" as const, rule: { repeat: "daily", time: "09:00" }, timeZone: "America/New_York", nextRunAt: NOON_NY + 86_400_000, maxRuns: null, endsOn: null, origin: "person" as const };
  await h.store.addSchedule({ ...base, id: "s_sam", conversationId: h.conversationId, instruction: "sam's" });
  await h.store.addSchedule({ ...base, id: "s_other", conversationId: other!.conversationId, instruction: "theirs" });

  await h.message("sms", SAM, "what have I got scheduled? and cancel s_other");
  (await h.nextCall(2)).answer(respond(call("send_sms", { text: "Checking." }), call("list_scheduled"), call("cancel_scheduled", { id: "s_other" })));
  const results = (await h.nextCall(3)).request.messages.filter((m) => m.role === "tool").slice(-2).map((m) => (m as { content: string }).content);
  assert.match(results[0], /s_sam/);
  assert.doesNotMatch(results[0], /s_other/);
  assert.equal(results[1], '{"cancelled":false}');
  assert.equal((await h.store.schedules(other!.conversationId)).length, 1);
});

test("a check with nothing to report sends nothing and is recorded as quiet", async () => {
  const h = await withSam();
  await h.store.addSchedule({ id: "s1", conversationId: h.conversationId, channel: "sms", instruction: "tell them if a slot opens on Friday", fixedText: false, mode: "check", rule: { repeat: "daily", time: "12:00" }, timeZone: "America/New_York", nextRunAt: NOON_NY, maxRuns: null, endsOn: null, origin: "person" });
  assert.equal(await h.agent.runDue(), 1);
  const turn = await h.nextCall(1);
  assert.match(last(turn.request.messages).content, /^\[Scheduled check, not from the person/);
  turn.answer(respond());
  await h.conversation.whenIdle();
  assert.equal(h.calls.length, 2, "no reminder to reply after a quiet check");
  assert.deepEqual(h.texts("sms"), ["Hi!"]);
  assert.deepEqual(await runRows(h.db), [{ outcome: "quiet", reason: null }]);
});

test("saying nothing after a tool's result is left alone: silence may be the answer", async () => {
  const h = await withSam();
  await h.store.addSchedule({ id: "s1", conversationId: h.conversationId, channel: "sms", instruction: "tell them if a slot opens on Friday", fixedText: false, mode: "check", rule: { repeat: "daily", time: "12:00" }, timeZone: "America/New_York", nextRunAt: NOON_NY, maxRuns: null, endsOn: null, origin: "person" });
  const before = h.followUps.length;
  assert.equal(await h.agent.runDue(), 1);
  (await h.nextCall(1)).answer(respond(call("list_scheduled")));
  (await h.nextCall(2)).answer(respond());
  await h.conversation.whenIdle();
  assert.equal(h.followUps.length, before, "no reminder after the result");
  assert.deepEqual(await runRows(h.db), [{ outcome: "quiet", reason: null }]);
});

test("the scheduling tool refuses what would go wrong, with a reason the agent can act on", async () => {
  const store = new Store(sqlite(), "default");
  await store.migrate();
  let zone: string | null = null;
  const scope = { store, conversationId: "c1", channel: () => "sms", now: () => NOON_NY, personZone: () => zone, setPersonZone: async (z: string) => void (zone = z), agentZone: "America/New_York" };
  const [schedule] = scheduleTools(scope);
  const run = (input: Record<string, unknown>) => Promise.resolve(schedule.run(schedule.input.parse(input), { conversationId: "c1", person: "p", key: null, channel: "sms", callId: "c1", idempotencyKey: "k1", signal: new AbortController().signal, records: unavailableRecords("a test") })) as Promise<Record<string, any>>;
  const daily = { message: "check in", repeat: "daily", time: "09:00" };

  assert.match((await run(daily)).error, /^timezone_needed/, "no zone known: ask their city, never take the business's");
  assert.ok((await run({ message: "call mum", repeat: "once", in_minutes: 30 })).scheduled, "in 30 minutes is the same in every zone");
  assert.match((await run({ ...daily, timezone: "UTC" })).error, /^timezone_needed/, "a bare UTC says nothing about where they are");
  assert.match((await run({ ...daily, timezone: "Mars/Olympus" })).error, /not a time zone/);
  zone = "America/New_York";
  assert.match((await run({ message: "x", repeat: "once", time: "11:00", date: "2026-10-12" })).error, /already past/);
  assert.match((await run({ ...daily, until: "2026-10-01" })).error, /until is before the first run/);
  assert.ok((await run(daily)).scheduled);
  assert.match((await run({ ...daily, message: "Check  IN" })).error, /^already_scheduled/, "the same message at about the same time");
  for (let i = 0; i < 9; i++) await run({ ...daily, message: `reminder ${i}` });
  assert.match((await run({ ...daily, message: "one too many" })).error, /already have 10/);
});

test("a repeat ends after its number of runs, or at its until date", async () => {
  const store = new Store(sqlite(), "default");
  await store.migrate();
  const base = { conversationId: "c1", channel: "sms", instruction: "check in", fixedText: false, mode: "message" as const, rule: { repeat: "daily", time: "09:00" }, timeZone: "America/New_York", endsOn: null, origin: "person" as const };
  const nineNY = Date.UTC(2026, 9, 13, 13);
  await store.addSchedule({ ...base, id: "twice", nextRunAt: nineNY, maxRuns: 2 });
  await store.addSchedule({ ...base, id: "until", nextRunAt: nineNY, maxRuns: null, endsOn: "2026-10-14" });
  for (const day of [0, 1, 2]) await claimDue(store, nineNY + day * 86_400_000, async () => null, async () => null);
  const left = await store.db.query("SELECT id, status, run_count FROM schedules ORDER BY id");
  assert.deepEqual(left.map((r) => ({ ...r })), [
    { id: "twice", status: "done", run_count: 2 },
    { id: "until", status: "done", run_count: 2 },
  ]);
});

test("the agent is told the time each turn: theirs once the business sets their zone, else the business's, saying theirs is unknown", async () => {
  const h = await withSam();
  assert.match(h.calls[0].request.system, /It is now Mon 12 Oct 2026 12:00 \(New York time\), the business's time\. Their time zone is not known/);
  assert.deepEqual(await h.agent.setTimeZone({ to: { channel: "sms", address: SAM }, timeZone: "Asia/Kolkata" }), { status: "set" });
  assert.deepEqual(await h.agent.setTimeZone({ to: { channel: "sms", address: "+15550100999" }, timeZone: "Asia/Kolkata" }), { status: "refused", reason: "unknown_person" });
  await assert.rejects(h.agent.setTimeZone({ to: { channel: "sms", address: SAM }, timeZone: "Mars/Olympus" }), /not a time zone/);
  await h.message("sms", SAM, "remind me at 9 tomorrow");
  const next = await h.nextCall(1);
  assert.match(next.request.system, /It is now Mon 12 Oct 2026 21:30 \(Kolkata time\), their time\./);
  next.answer(respond(call("send_sms", { text: "Sure." }), call("schedule_message", { message: "remind", repeat: "once", time: "09:00" })));
  (await h.nextCall(2)).answer(respond());
  await h.conversation.whenIdle();
  const [row] = await h.store.schedules(h.conversationId);
  assert.equal(row.timeZone, "Asia/Kolkata", "a schedule uses the zone the business set");
});


// --- The agent's own wake-ups ---

const HOUR = 3_600_000;

test("the agent wakes itself up: wake_me_up keeps its note, shown to it each turn, and at its time it gets a turn with the note; nothing is sent by itself", async () => {
  const h = await withSam();
  await h.message("sms", SAM, "the seller still hasn't answered my question");
  (await h.nextCall(1)).answer(respond(call("send_sms", { text: "I'll check tomorrow." }), call("wake_me_up", { note: "check whether the seller answered question Q7", in_minutes: 1440 })));
  const set = await h.nextCall(2);
  assert.match(last(set.request.messages).content, /^\{"wake_up":\{"id":"w_[0-9a-f]{8}","at":"Tue 13 Oct 2026 12:00 \(New York time\)","note":"check whether the seller answered question Q7"\}\}$/);
  set.answer(respond());
  await h.conversation.whenIdle();

  await h.message("sms", SAM, "thanks");
  const next = await h.nextCall(3);
  assert.match(next.request.system, /## Wake-ups you set here\n- \[w_[0-9a-f]{8}\] Tue 13 Oct 2026 12:00 \(New York time\): check whether the seller answered question Q7/);
  next.answer(respond(call("send_sms", { text: "Anytime." })));
  await h.conversation.whenIdle();

  h.clock.now += 24 * HOUR;
  assert.equal(await h.agent.runDue(), 1);
  const woke = await h.nextCall(4);
  assert.match(last(woke.request.messages).content, /^\[Wake-up you set for yourself, not from the person: check whether the seller answered question Q7\] Decide now what to do: check what you need, message them, or nothing\. Nothing is sent unless you send it\.$/);
  assert.doesNotMatch(woke.request.system, /Wake-ups you set/, "it is no longer to come");
  woke.answer(respond());
  await h.conversation.whenIdle();
  assert.deepEqual(h.texts("sms"), ["Hi!", "I'll check tomorrow.", "Anytime."], "a wake-up sends nothing by itself");
  assert.equal(h.calls.length, 5, "and the agent is not pushed to message them");
  assert.deepEqual(await runRows(h.db), [{ outcome: "silent", reason: null }]);
});

test("code sets wake-ups by key and cancels them by key in any conversation; the same key again is the same wake-up; forgetting the person removes theirs", async () => {
  const SELLER = "+15550100200";
  const answered = tool({
    name: "save_answer",
    description: "The seller answered question Q7.",
    input: z.object({}),
    run: async (_input, context: ToolContext) => ({ cancelled: await context.wakeUps!.cancel("remind:Q7"), theirs: (await context.wakeUps!.list()).length }),
  });
  const h = await withSam(sqlite(), [answered]);
  const seller = await h.message("sms", SELLER, "hi");
  (await h.nextCall(1)).answer(respond(call("send_sms", { text: "Hi!" })));
  await h.agent.conversation(seller!.conversationId)!.whenIdle();

  const buyer = { channel: "sms", address: SAM };
  const first = await h.agent.wakeUp({ to: buyer, inMs: 24 * HOUR, note: "remind the seller about Q7 if it still waits", key: "remind:Q7" });
  assert.equal(first.status, "scheduled");
  const again = await h.agent.wakeUp({ to: { channel: "sms", address: "+1 (555) 010-0100" }, inMs: 48 * HOUR, note: "something else", key: "remind:Q7" });
  assert.deepEqual(again, { status: "exists", wakeUp: first.status === "scheduled" ? first.wakeUp : null }, "the same key in their conversation is the wake-up already set, unchanged");
  assert.equal((await h.agent.wakeUp({ to: { channel: "sms", address: SELLER }, inMs: HOUR, note: "ask the seller again", key: "remind:Q7" })).status, "scheduled", "a key is per conversation");
  assert.deepEqual(await h.agent.wakeUp({ to: { channel: "sms", address: "+15550100999" }, inMs: HOUR, note: "x" }), { status: "refused", reason: "unknown_person" });
  await assert.rejects(h.agent.wakeUp({ to: buyer, inMs: 1_000, note: "x" }), /less than a minute away/);

  // The seller answers: a tool in their conversation cancels by key, the buyer's wake-up too.
  await h.message("sms", SELLER, "yes, box and bill");
  (await h.nextCall(2)).answer(respond(call("send_sms", { text: "Thanks!" }), call("save_answer")));
  const result = await h.nextCall(3);
  assert.equal(last(result.request.messages).content, '{"cancelled":2,"theirs":0}');
  result.answer(respond());
  await h.agent.conversation(seller!.conversationId)!.whenIdle();
  h.clock.now += 49 * HOUR;
  assert.equal(await h.agent.runDue(), 0, "nothing comes due once cancelled");

  await h.agent.wakeUp({ to: buyer, inMs: HOUR, note: "check in", key: "remind:Q7" });
  assert.equal((await h.agent.listWakeUps(buyer)).length, 1, "a cancelled key is free again");
  await h.agent.forgetPerson(h.conversationId);
  assert.deepEqual(await h.agent.listWakeUps(buyer), []);
  assert.equal((await h.db.query("SELECT count(*) AS n FROM schedules WHERE conversation_id = ?", [h.conversationId]))[0].n, 0);
});

const WAITING: TemplateDefinition = { name: "message_waiting", language: "en", category: "utility", body: "You have a new message. Reply to see it." };
const SHIPPED: TemplateDefinition = { name: "order_shipped", language: "en", category: "utility", body: "Hi {{1}}, your order {{2}} has shipped." };

test("a wake-up past the WhatsApp window still gives the agent its turn, told only a template reaches them; nothing, not even the fallback, goes by itself", async () => {
  const clock = { now: NOON_NY };
  const h = multi({ channels: { whatsapp: { info: { ...WHATSAPP, replyWindowHours: 24 }, phone: true } }, now: () => clock.now, templates: [WAITING, SHIPPED], fallbackTemplate: { name: "message_waiting" } });
  const a = await h.message("whatsapp", SAM, "where is my order?");
  (await h.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Checking." })));
  const conversation = h.agent.conversation(a!.conversationId)!;
  await conversation.whenIdle();
  await h.agent.wakeUp({ to: { channel: "whatsapp", address: SAM }, inMs: 30 * HOUR, note: "check whether order 1042 shipped" });

  clock.now += 30 * HOUR;
  assert.equal(await h.agent.runDue(), 1, "a turn, not skipped as outside_window");
  const turn = await h.nextCall(1);
  assert.match(last(turn.request.messages).content, /check whether order 1042 shipped\][\s\S]*Their WhatsApp 24-hour window is closed: no ordinary message reaches them\. If one of the business's templates says what you have to tell them, send it with send_template/);
  turn.answer(respond());
  await conversation.whenIdle();
  assert.deepEqual(h.out.map((o) => o.outbound.type === "template" ? `template ${(o.outbound as { name: string }).name}` : o.outbound.type === "message" ? o.outbound.text : o.outbound.type).filter((o) => o !== "typing" && o !== "read"), ["Checking."]);
  assert.deepEqual((await h.database.query("SELECT outcome FROM schedule_runs")).map((r) => r.outcome), ["silent"]);
});

test("a wake-up found late still runs, saying when it was due: the agent's work is not dropped like a late message", async () => {
  const h = await withSam();
  await h.agent.wakeUp({ to: { channel: "sms", address: SAM }, inMs: HOUR, note: "close question Q7 if it still waits" });
  h.clock.now += 5 * HOUR;
  assert.equal(await h.agent.runDue(), 1);
  const turn = await h.nextCall(1);
  assert.match(last(turn.request.messages).content, /^\[Wake-up you set for yourself, not from the person: close question Q7 if it still waits\] It was due Mon 12 Oct 2026 13:00 \(New York time\) and comes late\./);
  turn.answer(respond());
  await h.conversation.whenIdle();
});

test("a wake-up keeps the person's rules: in their quiet hours it waits for them to end (unless told not to), after their STOP it does not run", async () => {
  const h = await withSam();
  const to = { channel: "sms", address: SAM };
  await h.agent.setTimeZone({ to, timeZone: "America/New_York" });
  const elevenPm = Date.UTC(2026, 9, 13, 3);
  await h.agent.wakeUp({ to, at: elevenPm, note: "tell them the seller answered" });
  await h.agent.wakeUp({ to, at: elevenPm, note: "close question Q7", respectQuietHours: false });
  h.clock.now = elevenPm;
  assert.equal(await h.agent.runDue(), 1, "only the one that does not wait");
  const turn = await h.nextCall(1);
  assert.match(last(turn.request.messages).content, /close question Q7/);
  turn.answer(respond());
  await h.conversation.whenIdle();
  assert.deepEqual((await h.agent.listWakeUps(to)).map((w) => [w.note, w.at]), [["tell them the seller answered", Date.UTC(2026, 9, 13, 11)]], "moved to 07:00, their time");

  await h.store.setStop(h.conversationId, { id: "nc_stop", rule: "they texted STOP" });
  h.clock.now = Date.UTC(2026, 9, 13, 11);
  assert.equal(await h.agent.runDue(), 0);
  assert.equal(h.calls.length, 2, "no turn after their STOP");
  assert.deepEqual((await runRows(h.db)).map((r) => `${r.outcome}: ${r.reason}`).sort(), ["held: their quiet hours: moved to Tue 13 Oct 2026 07:00 (New York time)", "silent: null", "skipped: no-contact rule nc_stop: they texted STOP"]);
});

test("the wake-up tools refuse what would go wrong, with a reason the agent can act on, and reach only this conversation", async () => {
  const db = sqlite();
  const store = new Store(db, "default");
  await store.migrate();
  const scope = (conversationId: string) => ({ store, conversationId, channel: () => "sms", now: () => NOON_NY, zone: () => "America/New_York" });
  const [wake, cancel] = wakeUpTools(scope("c1"));
  const context = { conversationId: "c1", person: "p", key: null, channel: "sms", callId: "c1", idempotencyKey: "k1", signal: new AbortController().signal, records: unavailableRecords("a test") };
  const run = (t: typeof wake, input: Record<string, unknown>) => Promise.resolve(t.run(t.input.parse(input), context)) as Promise<Record<string, any>>;
  const note = "check on Q7";

  assert.equal((await run(wake, { note })).error, "Give in_minutes or at.");
  assert.equal((await run(wake, { note, at: "tomorrow 9am" })).error, "at is YYYY-MM-DD HH:MM.");
  assert.equal((await run(wake, { note, at: "2026-10-12 11:00" })).error, "That is less than a minute away or already past.");
  assert.equal((await run(wake, { note, at: "2027-02-01 09:00" })).error, "That is more than 90 days ahead.");
  const set = await run(wake, { note, at: "2026-10-13 09:00" });
  assert.equal(set.wake_up.at, "Tue 13 Oct 2026 09:00 (New York time)", "at is read in the zone the agent is told the time in");
  assert.equal((await run(wake, { note: "Check on  q7", in_minutes: 21 * 60 - 20 })).already_set.id, set.wake_up.id, "the same note at about the same time");
  for (let i = 1; i < WAKE_UP_LIMITS.perPerson; i++) await run(wake, { note: `note ${i}`, in_minutes: 60 * i });
  assert.equal((await run(wake, { note: "one too many", in_minutes: 30 })).error, "You already have 10 wake-ups in this conversation. Cancel one first.");

  const [elsewhere] = wakeUpTools(scope("c2"));
  // Everyone else's, straight into the table, so the agent's active wake-ups reach WAKE_UP_LIMITS.perAgent.
  const others = Array.from({ length: WAKE_UP_LIMITS.perAgent - WAKE_UP_LIMITS.perPerson }, (_, n) => n + 3);
  for (let from = 0; from < others.length; from += 500) {
    const page = others.slice(from, from + 500);
    await db.run(`INSERT INTO schedules (agent_id, id, conversation_id, channel, instruction, mode, rule, time_zone, next_run_at, status, origin, created_at) VALUES ${page.map(() => "('default', ?, ?, 'sms', 'x', 'wake', '{}', 'UTC', ?, 'active', 'agent', 0)").join(", ")}`, page.flatMap((n) => [`seed${n}`, `c${n}`, NOON_NY + HOUR]));
  }
  assert.equal((await run(elsewhere, { note, in_minutes: 30 })).error, "The agent has too many wake-ups set right now. Do this without one.", `${WAKE_UP_LIMITS.perAgent} across everyone`);

  await store.addSchedule({ id: "s_theirs", conversationId: "c1", channel: "sms", instruction: "their reminder", fixedText: false, mode: "message", rule: { repeat: "daily", time: "09:00" }, timeZone: "UTC", nextRunAt: NOON_NY + HOUR, maxRuns: null, endsOn: null, origin: "person" });
  assert.deepEqual(await run(cancel, { id: "s_theirs" }), { cancelled: false }, "not their own reminders");
  assert.deepEqual(await run(cancel, { id: "seed3" }), { cancelled: false }, "not another person's");
  assert.deepEqual(await run(cancel, { id: set.wake_up.id }), { cancelled: true });
});

// The store's wake-up keys on every engine: SQLite, and Postgres when FLOW_TEST_POSTGRES_URL names a
// throwaway database (and the `pg` package is installed), on an agent id of each test's own.
const engines: Array<{ name: string; db: Database }> = [{ name: "sqlite", db: sqlite() }];
if (process.env.FLOW_TEST_POSTGRES_URL) {
  const pg = (await import("pg" as string)).default as { Pool: new (options: { connectionString: string }) => PostgresPool & { end(): Promise<void> } };
  const pool = new pg.Pool({ connectionString: process.env.FLOW_TEST_POSTGRES_URL });
  after(() => pool.end());
  engines.push({ name: "postgres", db: postgres(pool) });
}

for (const { name, db } of engines) {
  test(`${name}: a wake-up's key is held once per conversation while it is active, also by two adds at once, and freed once it is done or cancelled`, async () => {
    const store = new Store(db, `agt_${Math.random().toString(36).slice(2, 10)}`);
    await store.migrate();
    const row = (id: string, conversationId: string, at = NOON_NY + HOUR) => ({ id, conversationId, channel: "sms", instruction: "check", fixedText: false, mode: "wake" as const, rule: { repeat: "once", at }, timeZone: "UTC", nextRunAt: at, maxRuns: null, endsOn: null, origin: "agent" as const, wakeKey: "remind:Q7" });
    const limits = { perPerson: 10, perAgent: 100 };
    const both = await Promise.all([store.addWakeUp(row("w1", "c1"), limits), store.addWakeUp(row("w2", "c1"), limits)]);
    assert.deepEqual(both.map((r) => ("added" in r ? "added" : "exists" in r ? `exists ${r.exists.id}` : "full")).sort(), ["added", `exists ${"added" in both[0] ? "w1" : "w2"}`]);
    assert.ok("added" in (await store.addWakeUp(row("w3", "c2"), limits)), "another conversation has its own");
    await claimDue(store, NOON_NY + HOUR, async () => null, async () => null);
    assert.ok("added" in (await store.addWakeUp(row("w4", "c1", NOON_NY + 2 * HOUR), limits)), "done: the key is free again");
    assert.equal(await store.cancelWakeUps("remind:Q7"), 1, "every conversation's active one (c2's came due too)");
    assert.ok("added" in (await store.addWakeUp(row("w5", "c1", NOON_NY + 2 * HOUR), limits)), "cancelled: free again");
    assert.equal(await store.cancelWakeUps("remind:Q7", "c2"), 0, "one conversation's only");
    assert.deepEqual((await store.schedules("c1")).map((s) => [s.id, s.wakeKey]), [["w5", "remind:Q7"]]);
  });
}
