// covers: src/business-events/engine.ts src/business-events/signature.ts src/business-events/quiet.ts src/business-events/phrasing.ts src/business-events/testlist.ts src/agent.ts src/store.ts
// Business events: a made-up shop's backend posts signed events; flowEvents answers each request,
// sends by delivery level (quiet hours, one a day, collapse, cancel, expiry), lets the agent phrase
// it inside the window (values and link checked), raises what people watch, caps nudges, keeps the
// business's own copies as context, and keeps staging sends to the test list. Most tests use a fake
// sender (no model); the last ones mount it on a real agent, one across a restart.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAgent,
  eventTestList,
  flowEvents,
  quietHoursEnd,
  signEvent,
  sqlite,
  verifyEventSignature,
  whatsapp,
  type BusinessEvent,
  type EventCatalog,
  type EventMessage,
  type FlowEventsOptions,
  type NudgeInput,
  type NudgeResult,
  type Outbound,
  type PendingSend,
} from "../src/index.ts";
import { call, respond, scriptedModel } from "./helpers.ts";

const SECRET = "whsec_test_events";
const AMA = "+15550000101";
const BEN = "+15550000102";
const DAY = 24 * 3_600_000;
const NOON = Date.UTC(2026, 9, 20, 12); // quiet hours are 22:00 to 08:00 UTC by default
const NIGHT = Date.UTC(2026, 9, 20, 23);
const MORNING = Date.UTC(2026, 9, 21, 8);

const msg = (name: string, text: string, values: string[], url = "https://shop.example/o/1"): EventMessage => ({ template: { name, body: values }, text, values, link: { label: "Open", url } });

const catalog: EventCatalog = {
  "order.shipped": {
    level: "critical",
    topic: (e) => `order:${e.data.order}`,
    message: (e) => (typeof e.data.order === "string" ? msg("order_shipped", `Order ${e.data.order} has shipped.`, [e.data.order]) : { missing: "data.order" }),
  },
  "order.delayed": {
    level: "standard",
    liveOnly: true,
    topic: (e) => `order:${e.data.order}`,
    message: (e) => (typeof e.data.order === "string" ? msg("order_delayed", `Order ${e.data.order} is running late.`, [e.data.order]) : { missing: "data.order" }),
  },
  restock: {
    level: "optional",
    topic: (e) => `product:${e.data.product}`,
    title: (e) => e.data.productName,
    message: (e) => (typeof e.data.productName === "string" ? msg("restock", `${e.data.productName} is back in stock.`, [e.data.productName], "https://shop.example/p/1") : { missing: "data.productName" }),
  },
  "price.drop": {
    level: "standard",
    topic: (e) => `product:${e.data.product}`,
    message: (e) => msg("price_drop", `${e.data.productName} is now ${e.data.price}.`, [String(e.data.productName), String(e.data.price)], "https://shop.example/p/1"),
  },
  "store.note": {
    kind: "event",
    validate: (e) => (typeof e.data.note === "string" ? null : { field: "data.note", error: "required string" }),
  },
};

let serial = 0;
function envelope(type: string, data: Record<string, unknown> = {}, extra: Partial<BusinessEvent> = {}, at = NOON): BusinessEvent {
  return {
    id: `evt_${++serial}`,
    type,
    occurredAt: new Date(at).toISOString(),
    subject: "user:1",
    data: { user: { phone: AMA }, consent: { whatsappUpdates: true }, order: "A-1", product: "p1", productName: "Blue mug", price: "$9", ...data },
    ...extra,
  };
}

/** What a sent nudge was: its template's name, "phrased" for the agent's own words, or "text". */
const kindOf = (n: NudgeInput) => (n.template ? `template:${n.template.name}` : n.prompt ? "phrased" : "text");

/**
 * flowEvents on a fake sender: a template goes as asked; a prompt is phrased the way the agent
 * would (by default the message and its link, through `phrasing.check`); a text goes.
 */
function setup(options: Partial<FlowEventsOptions> & { reply?: (prompt: string) => { text: string; link?: { label: string; url: string } } | null; template?: NudgeResult["status"]; window?: "open" | "closed" } = {}) {
  const clock = { now: options.now ? options.now() : NOON };
  const logs: Array<Record<string, unknown>> = [];
  const sent: NudgeInput[] = [];
  const reached: string[] = [];
  const delivered: NudgeInput[] = [];
  const events = flowEvents({ secret: SECRET, catalog, now: () => clock.now, log: (f) => logs.push(f), sentBy: "shop-backend", ...options });
  const defaultReply = (prompt: string) => {
    const text = /^message: (.*)$/m.exec(prompt)?.[1] ?? "";
    const link = /^link: (.*) -> (.*)$/m.exec(prompt);
    return { text, ...(link ? { link: { label: link[1]!, url: link[2]! } } : {}) };
  };
  const reply = options.reply ?? defaultReply;
  let id = 0;
  events.attach({
    async nudge(input) {
      sent.push(input);
      const r = (status: NudgeResult["status"]) => ({ id: `n${++id}`, status });
      if (input.template) {
        const status = options.template ?? "sent";
        if (status === "sent") delivered.push(input);
        return r(status);
      }
      if (options.window === "closed") return r("refused");
      if (input.prompt) {
        const said = reply(input.prompt);
        if (!said) return r("silent");
        const why = events.phrasing.check(input.to.address, { type: "message", text: said.text, ...(said.link ? { link: said.link } : {}) } as Outbound);
        if (why) return r("failed");
        delivered.push({ ...input, text: said.text });
        return r("sent");
      }
      delivered.push(input);
      return r("sent");
    },
    async reach(to) {
      reached.push(to.address);
      return { conversationId: `conv:${to.address}` };
    },
  });
  const post = async (body: unknown, init: { secret?: string; signature?: string | null; method?: string; at?: number; headers?: Record<string, string> } = {}) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json", ...init.headers };
    const signature = init.signature === undefined ? signEvent(init.secret ?? SECRET, raw, init.at ?? clock.now) : init.signature;
    if (signature !== null) headers["flow-signature"] = signature;
    const response = await events.handler(new Request("http://agent.test/v1/events", { method: init.method ?? "POST", headers, ...(init.method && init.method !== "POST" ? {} : { body: raw }) }));
    const answer = { status: response.status, body: await response.json() };
    await events.idle();
    return answer;
  };
  const tick = async (at: number) => {
    clock.now = at;
    await events.tick();
  };
  const kinds = () => delivered.map(kindOf);
  const reasons = (event: string) => logs.filter((l) => l.event === event && l.outcome === "not sent").map((l) => l.reason);
  const nudgeSend = (topic: string, extra: Partial<PendingSend> = {}): PendingSend => ({
    eventId: `nudge_${++serial}`,
    address: AMA,
    delivery: "nudge",
    nudge: "watched",
    topic,
    notBefore: clock.now,
    exact: false,
    message: msg("watched_update", `News on ${topic}.`, [topic]),
    ...extra,
  });
  return { events, clock, logs, sent, delivered, reached, post, tick, kinds, reasons, nudgeSend };
}

// --- The signature

test("Flow-Signature: a good one passes; a wrong secret, a missing header or one more than 5 minutes off fails; a rotated list passes on any v1", () => {
  const body = JSON.stringify({ id: "x" });
  const good = signEvent(SECRET, body, NOON);
  assert.match(good, /^t=\d+,v1=[0-9a-f]{64}$/);
  assert.ok(verifyEventSignature(SECRET, good, body, NOON));
  assert.ok(verifyEventSignature(SECRET, good, body, NOON + 4 * 60_000));
  assert.ok(!verifyEventSignature("whsec_other", good, body, NOON));
  assert.ok(!verifyEventSignature(SECRET, good, body + " ", NOON), "another body");
  assert.ok(!verifyEventSignature(SECRET, null, body, NOON));
  assert.ok(!verifyEventSignature(SECRET, "", body, NOON));
  assert.ok(!verifyEventSignature(SECRET, good, body, NOON + 6 * 60_000), "too late");
  assert.ok(!verifyEventSignature(SECRET, good, body, NOON - 6 * 60_000), "too early");
  const [t, v1] = good.split(",");
  const old = signEvent("whsec_old", body, NOON).split(",")[1];
  assert.ok(verifyEventSignature(SECRET, `${t},${old},${v1}`, body, NOON), "the new secret among several v1");
  assert.ok(!verifyEventSignature(SECRET, `${t},${old}`, body, NOON), "only the old one");
});

// --- The answers

test("the route answers 405 to anything but POST, 503 without a secret, and 401 to a bad or missing signature", async () => {
  const h = setup();
  assert.equal((await h.post(envelope("order.shipped"), { method: "GET" })).status, 405);
  assert.deepEqual(await h.post(envelope("order.shipped"), { secret: "whsec_wrong" }), { status: 401, body: { error: "bad or missing Flow-Signature" } });
  assert.equal((await h.post(envelope("order.shipped"), { signature: null })).status, 401);
  assert.equal((await h.post(envelope("order.shipped"), { at: NOON - 10 * 60_000 })).status, 401);
  assert.equal(h.sent.length, 0);
  const unset = setup({ secret: undefined });
  assert.deepEqual(await unset.post(envelope("order.shipped")), { status: 503, body: { error: "events are not configured" } });
});

test("a malformed event is a 400 naming the field, and nothing is sent", async () => {
  const h = setup();
  const field = async (body: unknown) => {
    const r = await h.post(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    return (r.body as { field: string }).field;
  };
  const e = envelope("order.shipped");
  assert.equal(await field("{not json"), "(body)");
  assert.equal(await field([]), "(body)");
  assert.equal(await field({ ...e, id: undefined }), "id");
  assert.equal(await field({ ...e, occurredAt: "yesterday" }), "occurredAt");
  assert.equal(await field({ ...e, type: "order.lost" }), "type");
  assert.equal(await field({ ...e, delivery: "urgent" }), "delivery");
  assert.equal(await field({ ...e, data: { ...e.data, user: {} } }), "data.user.phone");
  assert.equal(await field({ ...e, data: { ...e.data, user: { phone: "5550000101" } } }), "data.user.phone");
  assert.equal(await field({ ...e, data: { ...e.data, order: undefined } }), "data.order");
  assert.equal(await field({ ...e, sentBy: "someone-else" }), "sentBy");
  assert.equal(await field({ ...e, data: { ...e.data, sentBy: "someone-else" } }), "data.sentBy");
  assert.equal(await field({ ...e, expiresAt: "never" }), "expiresAt");
  assert.equal(await field({ ...e, collapseKey: 5 }), "collapseKey");
  assert.equal(await field(envelope("store.note", { note: "x" }, { sentBy: "shop-backend" })), "sentBy", "sentBy on an app event");
  assert.equal(await field(envelope("store.note", { note: 1 })), "data.note", "the app type's own validate");
  assert.equal(await field(envelope("notification.cancelled")), "data.cancels");
  assert.deepEqual((await h.post({ ...e, sentBy: "someone-else" })).body, { field: "sentBy", error: 'only "shop-backend", or leave it out' });
  assert.deepEqual((await setup({ sentBy: undefined }).post({ ...e, sentBy: "shop-backend" })).body, { field: "sentBy", error: "not accepted here" });
  assert.equal(h.sent.length, 0);
});

test("the same id is processed once: the second is 202 duplicate, as is a repeated Idempotency-Key", async () => {
  const h = setup();
  const e = envelope("order.shipped");
  assert.deepEqual(await h.post(e), { status: 202, body: { status: "accepted" } });
  assert.deepEqual(await h.post(e), { status: 202, body: { status: "duplicate" } });
  assert.deepEqual(await h.post(envelope("order.shipped", {}, {}), { headers: { "idempotency-key": "retry-1" } }), { status: 202, body: { status: "accepted" } });
  assert.deepEqual(await h.post(envelope("order.shipped", { order: "A-2" }), { headers: { "idempotency-key": "retry-1" } }), { status: 202, body: { status: "duplicate" } });
  assert.equal(h.delivered.length, 2);
});

// --- Delivery levels

test("critical goes at once, even in quiet hours", async () => {
  const h = setup();
  h.clock.now = NIGHT;
  await h.post(envelope("order.shipped"));
  assert.deepEqual(h.kinds(), ["phrased"]);
  assert.equal(h.sent[0]!.respectQuietHours, false);
  assert.equal(h.events.state.outbox.length, 0);
});

test("standard in quiet hours is held and sent by tick() when they end", async () => {
  const h = setup();
  h.clock.now = NIGHT;
  await h.post(envelope("order.delayed"));
  assert.equal(h.sent.length, 0);
  assert.equal(h.events.state.outbox[0]!.notBefore, MORNING);
  assert.equal(quietHoursEnd({ from: "22:00", to: "08:00" }, "UTC", NIGHT), MORNING);
  assert.equal(quietHoursEnd({ from: "22:00", to: "08:00" }, "UTC", NOON), null);
  await h.tick(MORNING - 60_000);
  assert.equal(h.sent.length, 0);
  await h.tick(MORNING);
  assert.deepEqual(h.kinds(), ["phrased"]);
  assert.equal(h.events.state.outbox.length, 0);
});

test("quiet hours follow the zone named, and none at all with quietHours: null", async () => {
  const zoned = setup({ timezone: "America/New_York" });
  zoned.clock.now = NIGHT; // 19:00 in New York
  await zoned.post(envelope("order.delayed"));
  assert.equal(zoned.delivered.length, 1);
  const none = setup({ quietHours: null });
  none.clock.now = NIGHT;
  await none.post(envelope("order.delayed"));
  assert.equal(none.delivered.length, 1);
});

test("optional goes one a day per collapseKey", async () => {
  const h = setup();
  const one = envelope("restock", {}, { collapseKey: "restock:p1" });
  await h.post(one);
  const two = envelope("restock", {}, { collapseKey: "restock:p1" });
  await h.post(two);
  await h.post(envelope("restock", { product: "p2", productName: "Red mug" }, { collapseKey: "restock:p2" }));
  assert.equal(h.delivered.length, 2);
  assert.deepEqual(h.reasons(two.id), ["optional: one a day per collapse key"]);
  h.clock.now += DAY;
  await h.post(envelope("restock", {}, { collapseKey: "restock:p1" }));
  assert.equal(h.delivered.length, 3);
});

test("a newer event with the same collapseKey replaces one still held (also read from data.collapseKey)", async () => {
  const h = setup();
  h.clock.now = NIGHT;
  await h.post(envelope("price.drop", { price: "$9" }, { collapseKey: "price:p1" }));
  await h.post(envelope("price.drop", { price: "$7", collapseKey: "price:p1" }));
  assert.equal(h.events.state.outbox.length, 1);
  await h.tick(MORNING);
  assert.deepEqual(h.delivered.map((d) => d.text), ["Blue mug is now $7."]);
});

test("notification.cancelled drops a held one, and one cancelled before it comes is never sent", async () => {
  const h = setup();
  h.clock.now = NIGHT;
  const held = envelope("order.delayed");
  await h.post(held);
  assert.equal((await h.post(envelope("notification.cancelled", { cancels: held.id }))).status, 202);
  assert.equal(h.events.state.outbox.length, 0);
  await h.post(envelope("notification.cancelled", { cancels: "evt_later" }));
  await h.post({ ...envelope("order.shipped"), id: "evt_later" });
  await h.tick(MORNING);
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.reasons("evt_later"), ["cancelled"]);
});

test("expiresAt (top level or data.expiresAt) drops one past it, held or arriving", async () => {
  const h = setup();
  h.clock.now = NIGHT;
  const top = envelope("order.delayed", {}, { expiresAt: new Date(NIGHT + 3_600_000).toISOString() });
  const inData = envelope("price.drop", { expiresAt: new Date(NIGHT + 3_600_000).toISOString() });
  const late = envelope("order.shipped", {}, { expiresAt: new Date(NIGHT - 60_000).toISOString() });
  await h.post(top);
  await h.post(inData);
  await h.post(late);
  assert.deepEqual(h.reasons(late.id), ["expired"]);
  await h.tick(MORNING);
  assert.equal(h.sent.length, 0);
  assert.deepEqual([h.reasons(top.id), h.reasons(inData.id)], [["expired"], ["expired"]]);
});

test("without consent nothing is sent", async () => {
  const h = setup();
  const e = envelope("order.shipped", { consent: { whatsappUpdates: false } });
  assert.equal((await h.post(e)).status, 202);
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.reasons(e.id), ["no WhatsApp consent"]);
});

// --- Wording

test("inside the window the agent phrases it, checked: values and link kept, it goes once", async () => {
  const h = setup();
  await h.post(envelope("order.shipped"));
  assert.deepEqual(h.sent.map(kindOf), ["phrased"]);
  const prompt = h.sent[0]!.prompt!;
  assert.match(prompt, /^A notification for this person/);
  assert.match(prompt, /^values: A-1$/m);
  assert.match(prompt, /^link: Open -> https:\/\/shop\.example\/o\/1$/m);
  assert.match(h.sent[0]!.idempotencyKey!, /^evt_\d+:phrased$/);
});

test("a phrasing that drops a value or changes the link is refused, and the template goes instead", async () => {
  const dropped = setup({ reply: () => ({ text: "Your order shipped!", link: { label: "Open", url: "https://shop.example/o/1" } }) });
  await dropped.post(envelope("order.shipped"));
  assert.deepEqual(dropped.sent.map(kindOf), ["phrased", "template:order_shipped"]);
  assert.deepEqual(dropped.kinds(), ["template:order_shipped"]);
  const relinked = setup({ reply: () => ({ text: "Order A-1 shipped", link: { label: "Open", url: "https://elsewhere.example" } }) });
  await relinked.post(envelope("order.shipped"));
  assert.deepEqual(relinked.kinds(), ["template:order_shipped"]);
  assert.equal(relinked.events.phrasing.check(AMA, { type: "message", text: "anything" } as Outbound), null, "no check once the turn is over");
});

test("outside the window the template goes; when the template fails, its text with a link button (or the link in the text)", async () => {
  const closed = setup({ window: "closed" });
  await closed.post(envelope("order.shipped"));
  assert.deepEqual(closed.sent.map(kindOf), ["phrased", "template:order_shipped"]);
  const failing = setup({ template: "failed", reply: () => ({ text: "no values" }) });
  await failing.post(envelope("order.shipped"));
  assert.deepEqual(failing.sent.map(kindOf), ["phrased", "template:order_shipped", "text"]);
  const text = failing.sent[2]!;
  assert.equal(text.text, "Order A-1 has shipped.");
  assert.deepEqual(text.link, { label: "Open", url: "https://shop.example/o/1" });
  const inText = setup({ template: "failed", reply: () => null, wording: { linkInText: true } });
  await inText.post(envelope("order.shipped"));
  const last = inText.sent.at(-1)!;
  assert.equal(last.text, "Order A-1 has shipped.\n\nOpen: https://shop.example/o/1");
  assert.equal(last.link, undefined);
});

test("data.wording exact sends the template, never the agent's words", async () => {
  const h = setup();
  await h.post(envelope("order.shipped", { wording: "exact" }));
  assert.deepEqual(h.sent.map(kindOf), ["template:order_shipped"]);
  assert.equal(h.sent[0]!.idempotencyKey!.endsWith(":template"), true);
});

// --- Watches

test("a watch raises optional to standard: held in quiet hours, never dropped when its topic closes; an unwatched one is dropped", async () => {
  const h = setup();
  h.events.watch({ address: AMA, topic: "product:p1", title: "Blue mug" });
  h.clock.now = NIGHT;
  const watched = envelope("restock");
  const other = envelope("restock", { user: { phone: BEN } });
  await h.post(watched);
  await h.post(other);
  const held = h.events.state.outbox.find((p) => p.eventId === watched.id)!;
  assert.deepEqual([held.delivery, held.raised], ["standard", "watch"]);
  assert.equal(h.events.close("product:p1"), 1, "only the unwatched one");
  await h.tick(MORNING);
  assert.deepEqual(h.delivered.map((d) => d.to.address), [AMA]);
  assert.ok(h.logs.some((l) => l.event === watched.id && l.outcome === "raised" && l.to === "kept"));
});

test("a watch found by the topic's name raises a standard one too", async () => {
  const h = setup();
  h.events.watch({ address: AMA, topic: "product:p1", title: "blue  MUG" });
  assert.equal(h.events.watchFor(AMA, undefined, "Blue mug")?.topic, "product:p1");
  h.events.setTitles((topic) => (topic === "product:p1" ? "Blue mug" : undefined));
  assert.equal(h.events.watchFor(AMA, undefined, "blue mug")?.topic, "product:p1");
  h.clock.now = NIGHT;
  await h.post(envelope("price.drop"));
  assert.equal(h.events.state.outbox[0]!.raised, "watch");
});

test("an urgent watch makes it critical: sent at once at night", async () => {
  const h = setup();
  h.events.watch({ address: AMA, topic: "product:p1", urgent: true });
  h.clock.now = NIGHT;
  await h.post(envelope("restock"));
  assert.equal(h.delivered.length, 1);
  assert.ok(h.logs.some((l) => l.outcome === "raised" && l.to === "critical"));
});

test("watches end after watchDays, and a day after their topic closes", async () => {
  const h = setup({ watchDays: 2 });
  const saved = h.events.watch({ address: AMA, topic: "product:p1" });
  assert.equal(saved.outcome, "saved");
  assert.equal(h.events.watch({ address: AMA, topic: "product:p1", urgent: true }).outcome, "already watching");
  assert.equal(h.events.state.watches.length, 1);
  assert.equal(h.events.state.watches[0]!.urgent, true);
  h.clock.now += 2 * DAY;
  assert.equal(h.events.watchFor(AMA, "product:p1"), undefined);
  h.events.watch({ address: AMA, topic: "product:p1" }); // refreshed: two more days
  assert.ok(h.events.watchFor(AMA, "product:p1"));
  h.events.close("product:p1");
  h.clock.now += DAY - 60_000;
  assert.ok(h.events.watchFor(AMA, "product:p1"), "within a day of the close");
  h.clock.now += 60_000;
  assert.equal(h.events.watchFor(AMA, "product:p1"), undefined);
  const late = envelope("restock");
  await h.post(late);
  assert.deepEqual(h.reasons(late.id), ["topic closed"]);
});

// --- Nudges

test("nudges are capped per day, per topic per day and per week; raised ones skip the caps", async () => {
  const h = setup();
  await h.events.schedule(h.nudgeSend("product:p1"));
  const sameTopic = h.nudgeSend("product:p1");
  await h.events.schedule(sameTopic);
  await h.events.schedule(h.nudgeSend("product:p2"));
  const third = h.nudgeSend("product:p3");
  await h.events.schedule(third);
  assert.equal(h.delivered.length, 2);
  assert.deepEqual(h.reasons(sameTopic.eventId), ["cap: 1 per topic a day"]);
  assert.deepEqual(h.reasons(third.eventId), ["cap: 2 nudges a day"]);
  await h.events.schedule(h.nudgeSend("product:p3", { raised: "watch" }));
  assert.equal(h.delivered.length, 3, "a raised nudge skips the caps");
  assert.equal(h.events.state.nudges.length, 2, "and does not use them up");
  for (let d = 1; d <= 3; d++) {
    h.clock.now = NOON + d * DAY;
    await h.events.schedule(h.nudgeSend(`product:d${d}`));
  }
  assert.equal(h.events.state.nudges.length, 5);
  h.clock.now = NOON + 4 * DAY;
  const weekly = h.nudgeSend("product:d4");
  await h.events.schedule(weekly);
  assert.deepEqual(h.reasons(weekly.eventId), ["cap: 5 nudges a week"]);
});

test("a nudge goes as its template, and when that fails as the agent's words with the stop line", async () => {
  const h = setup({ template: "failed", reply: () => null });
  await h.events.schedule(h.nudgeSend("product:p1"));
  assert.deepEqual(h.sent.map(kindOf), ["template:watched_update", "phrased", "text"]);
  assert.match(h.sent[1]!.prompt!, /end it with this line as written: Reply \*not interested\* to stop these\./);
  assert.equal(h.sent[2]!.text, "News on product:p1.\n\nReply *not interested* to stop these.");
});

test("not interested mutes the last nudged topic and ends its watch; mute and STOP stop nudges", async () => {
  const h = setup({ caps: { perDay: 10, perKeyPerDay: 10, perWeek: 10 } });
  assert.equal(h.events.notInterested(AMA), null);
  h.events.watch({ address: AMA, topic: "product:p1" });
  await h.events.schedule(h.nudgeSend("product:p1"));
  assert.equal(h.events.notInterested(AMA), "product:p1");
  assert.equal(h.events.state.watches.length, 0);
  const after = h.nudgeSend("product:p1", { raised: "watch" });
  await h.events.schedule(after);
  assert.match(String(h.reasons(after.eventId)[0]), /^muted/);
  h.events.mute(AMA, "product:p2");
  const muted = h.nudgeSend("product:p2");
  await h.events.schedule(muted);
  assert.match(String(h.reasons(muted.eventId)[0]), /^muted/);

  h.events.watch({ address: AMA, topic: "product:p3" });
  h.clock.now = NIGHT;
  await h.events.schedule(h.nudgeSend("product:p3"));
  assert.equal(h.events.state.outbox.length, 1);
  h.events.stopped(AMA);
  assert.deepEqual([h.events.state.outbox.length, h.events.state.watches.length], [0, 0]);
  assert.equal(h.delivered.length, 1);
});

// --- Closing a topic

test("close() drops held non-critical, non-raised sends about it and every live-only one, keeps critical and raised", async () => {
  const h = setup();
  h.events.watch({ address: AMA, topic: "order:A-1" });
  h.clock.now = NIGHT;
  await h.post(envelope("price.drop", { product: "A-1", user: { phone: BEN } }, {})); // standard, product:A-1: another topic
  await h.post(envelope("order.delayed")); // live-only and raised: still dropped
  await h.post(envelope("order.delayed", { user: { phone: BEN } })); // live-only
  const raisedOptional = envelope("restock", { product: "x" }); // another topic, kept
  await h.post(raisedOptional);
  assert.equal(h.events.state.outbox.length, 4);
  assert.equal(h.events.close("order:A-1"), 2);
  assert.deepEqual(h.events.state.outbox.map((p) => p.type).sort(), ["price.drop", "restock"]);
  await h.post(envelope("order.shipped"));
  assert.equal(h.delivered.length, 1, "critical still goes about a closed topic");
  const live = envelope("order.delayed");
  h.clock.now = NOON + DAY;
  await h.post(live);
  assert.deepEqual(h.reasons(live.id), ["topic closed"]);
});

// --- Copies

test("a copy (sentBy) is never sent: it is the agent's context, reach() opens the conversation, and it counts as told", async () => {
  const h = setup();
  h.clock.now = NIGHT;
  const heldSame = envelope("price.drop", {}, { collapseKey: "price:p1" });
  await h.post(heldSame);
  const copy = envelope("price.drop", { price: "$5" }, { sentBy: "shop-backend", collapseKey: "price:p1" }, NIGHT);
  const copyShipped = envelope("order.shipped", { sentBy: "shop-backend" }, {}, NIGHT);
  assert.equal((await h.post(copy)).status, 202);
  await h.post(copyShipped);
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.reached, [AMA, AMA]);
  assert.equal(h.events.state.outbox.length, 0, "the held one with its collapseKey counts as told");
  assert.ok(h.logs.some((l) => l.event === copy.id && l.outcome === "recorded" && l.droppedHeld === 1));
  const note = h.events.context(`conv:${AMA}`);
  assert.match(note, /^The business sent this person these messages itself/);
  assert.match(note, /20 Oct, 23:00 UTC \(price\.drop\): "Blue mug is now \$5\."/);
  assert.match(note, /button: Open -> https:\/\/shop\.example\/o\/1/);
  assert.equal(h.events.context("conv:unknown"), "");
  assert.match(h.events.context("conv:unknown", AMA), /Order A-1 has shipped/);
  const again = envelope("order.shipped");
  await h.post(again);
  assert.deepEqual(h.reasons(again.id), ["already told: shop-backend sent it"]);
  h.clock.now = NIGHT + 8 * DAY;
  assert.equal(h.events.context(`conv:${AMA}`), "", "copies older than a week are not shown");
});

test("rules.copy may count more held sends as told", async () => {
  const h = setup({ rules: { copy: () => (held) => held.type === "order.delayed" } });
  h.clock.now = NIGHT;
  await h.post(envelope("order.delayed"));
  await h.post(envelope("order.shipped", { order: "A-9" }, { sentBy: "shop-backend" }));
  assert.equal(h.events.state.outbox.length, 0);
});

// --- The test list

test("eventTestList: production sends to everyone; elsewhere only the listed numbers (fail closed), plus made-up ones in a test run", () => {
  assert.ok(eventTestList({ env: { FLOW_ENVIRONMENT: "production" } }).allows(BEN));
  const staging = eventTestList({ env: { FLOW_TEST_NUMBERS: ` ${AMA}, nope ,+1 555 000 0199` } });
  assert.ok(staging.enforced);
  assert.ok(staging.allows(AMA));
  assert.ok(staging.allows("+15550000199"));
  assert.ok(!staging.allows(BEN));
  assert.ok(!eventTestList({ env: {} }).allows(AMA), "none listed: nothing");
  assert.ok(eventTestList({ env: {}, numbers: [BEN] }).allows(BEN));
  const run = eventTestList({ env: {}, testing: true, madeUp: /^\+1555000/ });
  assert.ok(run.allows(BEN));
  assert.ok(!eventTestList({ env: {}, madeUp: /^\+1555000/ }).allows(BEN), "made-up numbers only in a test run");
});

test("off production a send to an unlisted number is stopped (onUnlisted), and a held one is checked again when it comes due", async () => {
  const allowed = new Set([AMA, BEN]);
  const unlisted: Array<{ event: string; type: string; address: string }> = [];
  const h = setup({ testList: { allows: (a) => allowed.has(a) }, onUnlisted: (s) => unlisted.push(s) });
  const stranger = envelope("order.shipped", { user: { phone: "+15550000999" } });
  await h.post(stranger);
  assert.deepEqual(unlisted, [{ event: stranger.id, type: "order.shipped", address: "+15550000999" }]);
  h.clock.now = NIGHT;
  const held = envelope("order.delayed", { user: { phone: BEN } });
  await h.post(held);
  assert.equal(h.events.state.outbox.length, 1);
  allowed.delete(BEN);
  await h.tick(MORNING);
  assert.equal(h.sent.length, 0);
  assert.deepEqual(unlisted.map((u) => u.event), [stranger.id, held.id]);
  const logged = setup({ testList: { allows: () => false } });
  const e = envelope("order.shipped");
  await logged.post(e);
  assert.deepEqual(logged.reasons(e.id), ["not on the test list"]);
});

// --- The app's own rules and hooks

test("rules.notification returning handled stops it; onEvent and onTick run in order with the rest", async () => {
  const order: string[] = [];
  const h = setup({
    rules: {
      notification: (e, send) => {
        order.push(`rule:${e.type}`);
        return send.type === "price.drop" ? "handled" : "send";
      },
    },
    onEvent: (e) => void order.push(`event:${e.data.note}`),
    onTick: (now) => void order.push(`tick:${now === MORNING}:${h.delivered.length}`),
  });
  h.clock.now = NIGHT;
  await h.post(envelope("store.note", { note: "first" }));
  await h.post(envelope("price.drop"));
  await h.post(envelope("order.delayed"));
  await h.post(envelope("store.note", { note: "second" }));
  assert.equal(h.sent.length, 0);
  await h.tick(MORNING);
  assert.deepEqual(order, ["event:first", "rule:price.drop", "rule:order.delayed", "event:second", "tick:true:1"]);
  assert.deepEqual(h.kinds(), ["phrased"], "the handled one never went");
});

test("the default log line masks numbers and never carries the message text", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => void lines.push(line);
  try {
    const h = setup({ log: undefined });
    await h.post(envelope("order.shipped", { consent: {} }));
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]!);
  assert.deepEqual([line.msg, line.outcome, line.reason], ["flow event", "not sent", "no WhatsApp consent"]);
  assert.ok(!lines[0]!.includes(AMA) && !lines[0]!.includes("shipped."));
});

// --- Mounted on a real agent

const PERSON = "+15550000201";

/** A real agent on a simulated WhatsApp provider, flowEvents mounted the way an app does it: routes, onTick, context, the phrasing check in beforeSend, attach. */
async function mounted() {
  const clock = { now: NOON };
  const scripted = scriptedModel();
  const sent: Array<{ kind: string; text?: string; url?: string; name?: string }> = [];
  const refused: string[] = [];
  const events = flowEvents({ secret: SECRET, catalog, now: () => clock.now, log: () => {}, sentBy: "shop-backend" });
  const channel = whatsapp({
    sendMessage: async (_to, m) => void sent.push({ kind: "message", text: m.text, url: m.link?.url }),
    sendTemplate: async (_to, t) => void sent.push({ kind: "template", name: t.name }),
  });
  const agent = createAgent({
    files: { "AGENTS.md": "A shop's agent." },
    model: scripted.model,
    debounceMs: 0,
    deadlineMs: 50,
    now: () => clock.now,
    scheduleCheckMs: 0,
    channels: [channel],
    beforeSend: (outbound, { address }) => {
      const why = events.phrasing.check(address, outbound);
      if (!why) return;
      refused.push(why);
      return { refuse: why };
    },
    routes: events.routes,
    onTick: events.onTick,
    context: (conversationId) => events.context(conversationId),
  });
  events.attach(agent);
  const a = await agent.message({ channel: "whatsapp", from: PERSON, message: "hi" });
  (await scripted.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Hi! How can I help?" })));
  await agent.conversation(a!.conversationId)!.whenIdle();
  const post = async (e: BusinessEvent) => {
    const raw = JSON.stringify(e);
    const r = await agent.fetch(new Request("http://agent.test/v1/events", { method: "POST", headers: { "flow-signature": signEvent(SECRET, raw, clock.now) }, body: raw }));
    return r.status;
  };
  return { agent, events, clock, scripted, sent, refused, post, conversationId: a!.conversationId };
}

test("mounted on createAgent: agent.fetch reaches the route, the agent phrases the event in the chat, and the channel's check keeps its values and link", async () => {
  const h = await mounted();
  const e = envelope("order.shipped", { user: { phone: PERSON } });
  assert.equal(await h.post(e), 202);
  const turn = await h.scripted.nextCall(1);
  const note = turn.request.messages.at(-1)!.content as string;
  assert.match(note, /A notification for this person/);
  assert.match(note, /values: A-1/);
  turn.answer(respond(call("send_whatsapp", { text: "Good news: order A-1 is on its way!", link: { label: "Open", url: "https://shop.example/o/1" } })));
  await h.events.idle();
  assert.deepEqual(h.sent.at(-1), { kind: "message", text: "Good news: order A-1 is on its way!", url: "https://shop.example/o/1" });
  assert.deepEqual(h.refused, []);
  assert.equal(await h.post(e), 202, "a duplicate");
  await h.events.idle();
  assert.equal(h.sent.length, 2);
});

test("mounted on createAgent: a held exact send goes as the template on the agent's tick, and a copy is in the agent's context", async () => {
  const h = await mounted();
  h.clock.now = NIGHT;
  assert.equal(await h.post(envelope("order.delayed", { user: { phone: PERSON }, wording: "exact" })), 202);
  await h.events.idle();
  assert.equal(h.sent.length, 1, "held for quiet hours");
  h.clock.now = MORNING;
  await h.agent.runDue();
  await h.events.idle();
  assert.deepEqual(h.sent.at(-1), { kind: "template", name: "order_delayed" });

  assert.equal(await h.post(envelope("price.drop", { user: { phone: PERSON }, price: "$5" }, { sentBy: "shop-backend" })), 202);
  await h.events.idle();
  const before = h.sent.length;
  await h.agent.message({ channel: "whatsapp", from: PERSON, message: "what was that price?" });
  const turn = await h.scripted.nextCall(1);
  assert.match(turn.request.system + JSON.stringify(turn.request.messages), /Blue mug is now \$5\./);
  turn.answer(respond(call("send_whatsapp", { text: "It's $5 now." })));
  await h.agent.conversation(h.conversationId)!.whenIdle();
  assert.equal(h.sent.length, before + 1, "the copy itself was never sent");
});

/** An agent on a sqlite file with flowEvents mounted, as after each (re)start; `rules` for flowEvents. */
async function durable(path: string, clock: { now: number }, rules?: FlowEventsOptions["rules"]) {
  const sent: string[] = [];
  const scripted = scriptedModel();
  const events = flowEvents({ secret: SECRET, catalog, now: () => clock.now, log: () => {}, rules });
  const agent = createAgent({
    files: { "AGENTS.md": "A shop's agent." },
    model: scripted.model,
    debounceMs: 0,
    now: () => clock.now,
    scheduleCheckMs: 0,
    database: sqlite(path),
    channels: [whatsapp({ sendMessage: async (_to, m) => void sent.push(`text:${m.text}`), sendTemplate: async (_to, t) => void sent.push(`template:${t.name}`) })],
    routes: events.routes,
    onTick: events.onTick,
  });
  events.attach(agent);
  await agent.resume();
  /** Posts an event; the status once it is recorded (it is processed in the background). */
  const post = async (e: BusinessEvent) => {
    const raw = JSON.stringify(e);
    const r = await agent.fetch(new Request("http://agent.test/v1/events", { method: "POST", headers: { "flow-signature": signEvent(SECRET, raw, clock.now) }, body: raw }));
    return ((await r.json()) as { status: string }).status;
  };
  /** The person writes first (a nudge to someone who never wrote is refused). */
  const hello = async () => {
    const hi = await agent.message({ channel: "whatsapp", from: PERSON, message: "hi" });
    (await scripted.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Hi! How can I help?" })));
    await agent.conversation(hi!.conversationId)!.whenIdle();
    sent.length = 0;
  };
  return { agent, events, scripted, sent, post, hello };
}

test("mounted on an agent with a durable database: after a restart a taken event id is not processed again, a held send still goes, and an optional one still waits its day", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "flow-events-")), "agent.db");
  const clock = { now: NOON };
  const start = async () => {
    const h = await durable(path, clock);
    const post = async (e: BusinessEvent) => {
      const status = await h.post(e);
      await h.events.idle();
      return status;
    };
    return { ...h, post };
  };
  const exact = { user: { phone: PERSON }, wording: "exact" };
  const shipped = envelope("order.shipped", exact);

  const before = await start();
  await before.hello();
  assert.equal(await before.post(shipped), "accepted");
  assert.equal(await before.post(envelope("restock", { ...exact, collapseKey: "mug" })), "accepted");
  clock.now = NIGHT;
  assert.equal(await before.post(envelope("order.delayed", exact)), "accepted");
  assert.deepEqual(before.sent, ["template:order_shipped", "template:restock"], "the late one is held for quiet hours");

  const after = await start();
  assert.equal(await after.post(shipped), "duplicate");
  clock.now = MORNING;
  assert.equal(await after.post(envelope("restock", { ...exact, collapseKey: "mug" })), "accepted");
  await after.agent.runDue();
  await after.events.idle();
  assert.deepEqual(after.sent, ["template:order_delayed"], "the held send went; the second restock waits its day");
});

test("mounted on an agent with a durable database: an event answered accepted but not yet processed when the agent stopped is processed after the restart, once", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "flow-events-")), "agent.db");
  const clock = { now: NOON };
  const exact = { user: { phone: PERSON }, wording: "exact" };
  let reached!: () => void;
  const stuck = new Promise<void>((resolve) => (reached = resolve));
  // The first agent stops mid-work: its processing never gets past the app's rule.
  const before = await durable(path, clock, { notification: () => (reached(), new Promise<never>(() => {})) });
  await before.hello();
  const shipped = envelope("order.shipped", exact);
  assert.equal(await before.post(shipped), "accepted");
  await stuck;
  assert.deepEqual(before.sent, []);

  const after = await durable(path, clock);
  await after.events.idle();
  assert.deepEqual(after.sent, ["template:order_shipped"], "processed after the restart");
  assert.equal(await after.post(shipped), "duplicate");

  const again = await durable(path, clock);
  await again.events.idle();
  assert.deepEqual(again.sent, [], "processed once: done is saved");
});
