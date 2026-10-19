// covers: src/agent.ts src/store.ts src/conversation.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { sqlite, tool, type Database, type Outbound } from "../src/index.ts";
import { Store } from "../src/store.ts";
import { WEB_APP, WHATSAPP, call, multi, respond, users } from "./helpers.ts";

const SAM = { name: "Sam", phone: "+15555550101" };
const NOON_NY = Date.UTC(2026, 9, 12, 16);

/** An agent with WhatsApp (a phone channel) and an app, Sam as its test person, and the playground attached. */
function playground(database: Database = sqlite()) {
  const clock = { now: NOON_NY };
  const h = multi({ channels: { whatsapp: { info: WHATSAPP, phone: true }, app: { info: WEB_APP } }, testPeople: [SAM], database, now: () => clock.now, timeZone: "America/New_York" });
  const played: Array<{ channel: string; outbound: Outbound }> = [];
  h.agent.attachPlayground(({ person, channel, outbound }) => {
    assert.equal(person.phone, SAM.phone);
    played.push({ channel, outbound });
  });
  const shown = (channel?: string) => played.flatMap((p) => (p.outbound.type === "message" && (!channel || p.channel === channel) ? [p.outbound.text] : []));
  return { ...h, clock, played, shown, store: new Store(database, "default") };
}

test("only the agent's test people can be simulated", async () => {
  const h = playground();
  await assert.rejects(h.agent.simulate({ person: "+15555550199", channel: "whatsapp", message: "hi" }), /only the agent's testPeople/);
  assert.equal(h.calls.length, 0);
  await h.agent.resume();
  assert.equal((await h.store.allConversations()).length, 0, "nothing was made for them");
});

// Declared-person tests never exercise the verified-key visitor path or an account switch mid-turn.
test("a visitor needs no declared phone and cannot rebind another account's channel identity", async () => {
  const h = multi({ channels: { app: { info: WEB_APP } } });
  const shown: Array<{ key?: string; text: string }> = [];
  h.agent.attachPlayground(({ person, outbound }) => { if (outbound.type === "message") shown.push({ key: person.key, text: outbound.text }); });
  const taken = await h.agent.simulateVisitor({ channel: "app", key: "account-a", address: "browser-a", message: "hello" });
  const reply = await h.nextCall(0);
  await assert.rejects(h.agent.simulateVisitor({ channel: "app", key: "account-b", address: "browser-a", message: "claim their history" }), /belongs to a different person/);
  reply.answer(respond(call("send_app", { text: "Hello" })));
  await h.agent.conversation(taken!.conversationId)!.whenIdle();
  assert.equal(await h.agent.visitorConversation("account-a"), taken!.conversationId);
  assert.equal(await h.agent.visitorConversation("account-b"), null);
  assert.deepEqual(shown, [{ key: "account-a", text: "Hello" }], "a refused rebind cannot redirect the original reply");
  assert.deepEqual(h.out, [], "no real provider is called");
});

// Earlier visitor tests keep the conversation resident; they cannot catch restoration replacing new proof with an older address.
test("a fresh authenticated browser keeps its address when account history is restored", async () => {
  const database = sqlite();
  const h = multi({ channels: { app: { info: WEB_APP } }, database });
  h.agent.attachPlayground(() => {});
  const old = await h.agent.simulateVisitor({ channel: "app", key: "account-a", address: "old-browser", message: "old session" });
  (await h.nextCall(0)).answer(respond(call("send_app", { text: "Hello" })));
  await h.agent.conversation(old!.conversationId)!.whenIdle();
  await h.agent.conversation(old!.conversationId)!.stored();
  h.agent.conversation(old!.conversationId)!.close();
  const seen: string[] = [];
  const next = multi({ channels: { app: { info: WEB_APP } }, database, auth: { verify: ctx => { seen.push(ctx.address); return ctx.address === "new-browser"; }, signIn: () => ({ message: "Unexpected login challenge" }) }, tools: [tool({ name: "private", description: "Account.", input: z.object({}), run: () => "ok" })] });
  next.agent.attachPlayground(() => {});
  await next.agent.resume();
  const fresh = await next.agent.simulateVisitor({ channel: "app", key: "account-a", address: "new-browser", message: "new session" });
  assert.equal(fresh!.conversationId, old!.conversationId);
  (await next.nextCall(0)).answer(respond(call("send_app", { text: "Checking" }), call("private")));
  (await next.nextCall(1)).answer(respond(call("send_app", { text: "Done" })));
  await next.agent.conversation(fresh!.conversationId)!.whenIdle();
  assert.deepEqual(seen, ["new-browser"]);
});

// Visitor-message tests never finish a login before the next inbound message, or send a callback acknowledgment.
test("a verified login links the original channel and sends one confirmation without a model turn", async () => {
  const database = sqlite();
  const h = multi({ channels: { whatsapp: { info: WHATSAPP, phone: true, keywords: { stop: ["STOP"], start: ["START"], help: [] } }, imessage: { info: WEB_APP, phone: true } }, database });
  const original = await h.message("whatsapp", SAM.phone, "let me sign in");
  (await h.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Please sign in" })));
  await h.agent.conversation(original!.conversationId)!.whenIdle();
  const connected = await h.agent.linkIdentity({ channel: "whatsapp", address: SAM.phone, key: "account-a" });
  assert.notEqual(connected.conversationId, original!.conversationId, "anonymous history is not merged into account history");
  const confirmation = { to: { channel: "whatsapp", address: SAM.phone }, text: "You're signed in—continue here.", idempotencyKey: "login:completion-1", respectQuietHours: false };
  const results = await Promise.all([h.agent.nudge(confirmation), h.agent.nudge(confirmation)]);
  assert.ok(results.every(r => r.status === "sent"));
  assert.deepEqual(h.texts("whatsapp"), ["Please sign in", confirmation.text]);
  assert.equal(h.calls.length, 1, "confirmation needs no model call");
  const same = await h.agent.linkIdentity({ channel: "imessage", address: SAM.phone, key: "account-a" });
  assert.equal(same.conversationId, connected.conversationId);
  await h.agent.nudge({ ...confirmation, to: { channel: "imessage", address: SAM.phone }, idempotencyKey: "login:completion-2" });
  assert.deepEqual(h.texts("imessage"), [confirmation.text], "a new connection confirms on its own originating channel");
  await assert.rejects(h.agent.linkIdentity({ channel: "whatsapp", address: SAM.phone, key: "account-b" }), /belongs to a different person/);
  assert.ok((await h.agent.transcript(connected.conversationId)).some(e => e.kind === "out" && e.text === confirmation.text));
  const store = new Store(database, "default");
  assert.equal((await store.identity("whatsapp", SAM.phone))!.conversationId, connected.conversationId);
  assert.ok((await store.identity("whatsapp", SAM.phone))!.lastMessageAt, "login preserves the channel's inbound window");
  const stopped = "+15555550103";
  await h.message("whatsapp", stopped, "STOP");
  await h.agent.linkIdentity({ channel: "whatsapp", address: stopped, key: "account-stopped" });
  assert.equal((await h.agent.nudge({ ...confirmation, to: { channel: "whatsapp", address: stopped }, idempotencyKey: "login:completion-3" })).status, "dropped", "signing in preserves a sender's no-contact rules");
});

// A single address cannot catch sending a login result to another session on the same channel.
test("a playground login confirmation targets its original address and survives a restart without duplication", async () => {
  const database = sqlite();
  const h = multi({ channels: { app: { info: WEB_APP } }, database });
  await h.agent.linkIdentity({ channel: "app", address: "browser-a", key: "account-a", via: "playground" });
  await h.agent.linkIdentity({ channel: "app", address: "browser-b", key: "account-a", via: "provider" });
  const shown: Array<{ key?: string; text: string }> = [];
  h.agent.attachPlayground(({ person, outbound }) => { if (outbound.type === "message") shown.push({ key: person.key, text: outbound.text }); });
  const input = { to: { channel: "app", address: "browser-a" }, text: "You're signed in—continue here.", idempotencyKey: "login:completion-1", respectQuietHours: false };
  assert.equal((await h.agent.nudge(input)).status, "sent");
  assert.deepEqual(shown, [{ key: "account-a", text: input.text }]);
  assert.deepEqual(h.out.filter(o => o.outbound.type === "message"), [], "the confirmation never goes to the other session through its provider");
  const next = multi({ channels: { app: { info: WEB_APP } }, database });
  next.agent.attachPlayground(() => assert.fail("completed acknowledgment must not be delivered again"));
  await next.agent.resume();
  assert.equal((await next.agent.nudge(input)).status, "sent");
  assert.deepEqual(next.out, []);
});

// Fixed confirmation tests never wake the model or carry a sign-in-blocked request into the verified account.
test("sign-in completion wakes the verified agent with its blocked request once, without a canned chat reply", async () => {
  let writes = 0;
  const seen: Array<{ key: string | null; channel: string; address?: string }> = [];
  const create = tool({ name: "create_site", description: "Create a site.", input: z.object({ brief: z.string() }), run: (_i, ctx) => { writes++; seen.push({ key: ctx.key, channel: ctx.channel, address: ctx.address }); return { preview: "https://preview.example/gym" }; } });
  const h = multi({ channels: { app: { info: WEB_APP }, whatsapp: { info: WHATSAPP } }, tools: [create], auth: { verify: ctx => ctx.key === "account-a" && ctx.address === "browser-a", signIn: () => ({ message: "Please sign in first.", url: "https://brand.example/login" }) } });
  const shown: string[] = [];
  h.agent.attachPlayground(({ outbound }) => { if (outbound.type === "message") shown.push(outbound.text); });
  const original = await h.agent.simulateVisitor({ channel: "app", address: "browser-a", message: "Create a gym website with mock details" });
  (await h.nextCall(0)).answer(respond(call("send_app", { text: "Let me check." }), call("create_site", { brief: "A gym website" })));
  await h.agent.conversation(original!.conversationId)!.whenIdle();
  assert.equal(writes, 0);
  assert.deepEqual(shown, ["Let me check.", "Please sign in first.\nhttps://brand.example/login"]);
  // Another interface/session already exists for this account. It must not receive this continuation.
  await h.agent.linkIdentity({ channel: "whatsapp", address: "other-channel", key: "account-a" });
  await h.agent.linkIdentity({ channel: "app", address: "browser-b", key: "account-a" });
  const completion = { channel: "app", address: "browser-a", key: "account-a", conversationId: original!.conversationId, via: "playground" as const, idempotencyKey: "login:resume-1" };
  await h.agent.linkIdentity(completion); // Recover even if linking committed before a previous queue attempt failed.
  const queued = await h.agent.signInCompleted(completion);
  assert.equal(queued.status, "queued");
  const resumed = await h.nextCall(1);
  const internal = users(resumed.request.messages).find(text => text.includes("Internal authentication event"));
  assert.match(internal!, /gym website with mock details/);
  assert.match(internal!, /Do not replay operations that already ran or retry unrelated failures/);
  assert.deepEqual(shown, ["Let me check.", "Please sign in first.\nhttps://brand.example/login"], "the completion itself emits no user-facing message");
  resumed.answer(respond(call("send_app", { text: "You're connected. I'm creating your gym website now." }), call("create_site", { brief: "A gym website" })));
  (await h.nextCall(2)).answer(respond(call("send_app", { text: "Your first version is ready: https://preview.example/gym" })));
  const account = (await h.agent.visitorConversation("account-a"))!;
  await h.agent.conversation(account)!.whenIdle();
  assert.equal(writes, 1);
  assert.deepEqual(seen, [{ key: "account-a", channel: "app", address: "browser-a" }]);
  assert.equal(shown.at(-1), "Your first version is ready: https://preview.example/gym");
  assert.deepEqual(h.out.filter(o => o.outbound.type === "message"), [], "continuation stays on the originating playground address");
  const transcript = await h.agent.transcript(account);
  assert.ok(!transcript.some(e => e.kind === "in"), "internal completion is not a fabricated user message");
  assert.ok(!transcript.some(e => e.kind === "out" && e.text.includes("Internal authentication event")));
  await h.agent.signInCompleted(completion);
  await h.agent.conversation(account)!.whenIdle();
  assert.equal(h.calls.length, 3, "a retried callback does not wake another turn");
  await h.agent.conversation(account)!.stored();
  const restarted = multi({ channels: { app: { info: WEB_APP }, whatsapp: { info: WHATSAPP } }, database: h.database });
  await restarted.agent.resume();
  await restarted.agent.signInCompleted(completion);
  assert.equal(restarted.calls.length, 0, "a completed internal event is not replayed after restart");
  await assert.rejects(h.agent.signInCompleted({ ...completion, idempotencyKey: "login:other", conversationId: "someone-elses-chat" }), /does not belong/);
});

// A billing failure is an executed tool result, not a request that sign-in can unblock.
test("sign-in events do not automatically retry a previous payment failure or invent a pending request", async () => {
  let attempts = 0;
  const create = tool({ name: "create_site", description: "Create.", input: z.object({}), run: () => { attempts++; return { error: "payment_required", status: 402 }; } });
  const h = multi({ channels: { app: { info: WEB_APP } }, tools: [create] });
  h.agent.attachPlayground(() => {});
  const original = await h.agent.simulateVisitor({ channel: "app", address: "browser-a", message: "Create the website" });
  (await h.nextCall(0)).answer(respond(call("send_app", { text: "Starting" }), call("create_site")));
  (await h.nextCall(1)).answer(respond(call("send_app", { text: "Your plan needs attention before this can build." })));
  await h.agent.conversation(original!.conversationId)!.whenIdle();
  await h.agent.signInCompleted({ channel: "app", address: "browser-a", key: "account-a", idempotencyKey: "login:billing", via: "playground" });
  const resumed = await h.nextCall(2);
  const internal = users(resumed.request.messages).find(text => text.includes("Internal authentication event"));
  assert.doesNotMatch(internal!, /The pending request/);
  assert.match(internal!, /Do not replay operations that already ran or retry unrelated failures/);
  assert.equal(attempts, 1, "the runtime never replays the write on sign-in");
  resumed.answer(respond(call("send_app", { text: "You're connected." })));
  await h.agent.conversation((await h.agent.visitorConversation("account-a"))!)!.whenIdle();
  assert.equal(attempts, 1);
});

test("a test person who switches channels resumes the same conversation", async () => {
  const h = playground();
  const a = await h.agent.simulate({ person: SAM.phone, channel: "whatsapp", message: "hi" });
  (await h.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Hi Sam!" })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  const b = await h.agent.simulate({ person: "+1 (555) 555-0101", channel: "app", message: "now in the app" });
  assert.equal(b!.conversationId, a!.conversationId);
  const second = await h.nextCall(1);
  assert.deepEqual(users(second.request.messages), ["[whatsapp · m1] hi", "[app · m2] now in the app"]);
  second.answer(respond(call("send_app", { text: "Here too." })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(h.shown(), ["Hi Sam!", "Here too."], "both replies reached the playground");
  assert.deepEqual(h.out, [], "the providers were never called");
  assert.deepEqual(
    (await h.store.identities(a!.conversationId)).map((i) => [i.channel, i.address]).sort(),
    [["app", "test:+15555550101"], ["whatsapp", "+15555550101"]],
  );
});

test("a scheduled message goes where the person last wrote from: the playground, then the provider", async () => {
  const h = playground();
  const a = await h.agent.simulate({ person: SAM.phone, channel: "whatsapp", message: "hi" });
  (await h.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Hi!" })));
  const conversation = h.agent.conversation(a!.conversationId)!;
  await conversation.whenIdle();
  const due = (id: string) =>
    h.store.addSchedule({ id, conversationId: a!.conversationId, channel: "whatsapp", instruction: "check in", fixedText: false, mode: "message", rule: { repeat: "once", at: h.clock.now + 60_000 }, timeZone: "America/New_York", nextRunAt: h.clock.now + 60_000, maxRuns: null, endsOn: null, origin: "person" });

  await due("s1");
  h.clock.now += 61_000;
  assert.equal(await h.agent.runDue(), 1);
  (await h.nextCall(1)).answer(respond(call("send_whatsapp", { text: "Checking in!" })));
  await conversation.whenIdle();
  assert.deepEqual(h.shown(), ["Hi!", "Checking in!"]);
  assert.deepEqual(h.out, []);

  // The same number writes from WhatsApp itself once the channel is live: a real message, not refused.
  await h.message("whatsapp", SAM.phone, "on my real phone now");
  (await h.nextCall(2)).answer(respond(call("send_whatsapp", { text: "Got it." })));
  await conversation.whenIdle();
  await due("s2");
  h.clock.now += 61_000;
  assert.equal(await h.agent.runDue(), 1);
  (await h.nextCall(3)).answer(respond(call("send_whatsapp", { text: "Checking in again!" })));
  await conversation.whenIdle();
  assert.deepEqual(h.texts("whatsapp"), ["Got it.", "Checking in again!"]);
  assert.deepEqual(h.shown(), ["Hi!", "Checking in!"], "nothing more went to the playground");
});

test("forgetting a person stops their turn, leaves nothing of them, and their next message starts fresh", async () => {
  const db = sqlite();
  const h = playground(db);
  const a = await h.agent.simulate({ person: SAM.phone, channel: "whatsapp", message: "remind me tomorrow at 9 to pick up the order" });
  const first = await h.nextCall(0);
  first.answer(respond(call("send_whatsapp", { text: "Will do." }), call("schedule_message", { message: "remind them to pick up the order", repeat: "once", time: "09:00" }), call("add_no_contact", { rule: "no promotions" })));
  (await h.nextCall(1)).answer(respond());
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  await h.agent.nudge({ to: { channel: "whatsapp", address: SAM.phone }, text: "Fresh scones today", at: h.clock.now + 3_600_000 });
  await h.agent.simulate({ person: SAM.phone, channel: "app", message: "also, one more thing" });
  const inFlight = await h.nextCall(2);

  await h.agent.forgetPerson(a!.conversationId);
  assert.ok(inFlight.request.signal.aborted, "the turn in progress was cut off");
  for (const table of ["conversations", "identities", "messages", "inbox", "background_tools", "schedules", "schedule_runs", "nudges", "no_contact"]) {
    assert.deepEqual(await db.query(`SELECT * FROM ${table}`), [], `${table} is empty`);
  }
  assert.equal(h.agent.conversation(a!.conversationId), undefined);

  const b = await h.agent.simulate({ person: SAM.phone, channel: "whatsapp", message: "hello?" });
  assert.notEqual(b!.conversationId, a!.conversationId);
  const fresh = await h.nextCall(3);
  assert.deepEqual(users(fresh.request.messages), ["[whatsapp · m1] hello?"]);
  assert.doesNotMatch(fresh.request.system, /no promotions/);
  fresh.answer(respond(call("send_whatsapp", { text: "Hi! How can I help?" })));
  await h.agent.conversation(b!.conversationId)!.whenIdle();
});

test("a test person's tools get the key resolve gives their real number, on any channel", async () => {
  const seen: Array<string | null> = [];
  const whoami = tool({ name: "whoami", description: "", input: z.object({}), run: (_input, context) => (seen.push(context.key), "ok") });
  const h = multi({
    channels: { whatsapp: { info: WHATSAPP, phone: true }, app: { info: WEB_APP } },
    testPeople: [SAM],
    tools: [whoami],
    resolve: ({ channel, address }) => (channel === "whatsapp" && address === SAM.phone ? "mbr_sam" : null),
  });
  h.agent.attachPlayground(() => {});
  const a = await h.agent.simulate({ person: SAM.phone, channel: "app", message: "who am I?" });
  (await h.nextCall(0)).answer(respond(call("send_app", { text: "Let me check." }), call("whoami")));
  (await h.nextCall(1)).answer(respond());
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  const b = await h.message("whatsapp", SAM.phone, "and from my phone?");
  assert.equal(b!.conversationId, a!.conversationId);
  (await h.nextCall(2)).answer(respond(call("send_whatsapp", { text: "Still you." }), call("whoami")));
  (await h.nextCall(3)).answer(respond());
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(seen, ["mbr_sam", "mbr_sam"]);
});
