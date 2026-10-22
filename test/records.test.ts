// covers: src/records.ts src/channels.ts src/talk.ts src/conversation.ts src/store.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { createAgent, records, recordsMessages, recordsPage, RECORDS_MORE, SMS, sqlite, tool, WHATSAPP, type ChannelInfo, type Outbound, type RecordsOutbound } from "../src/index.ts";
import { IMESSAGE, TELEGRAM } from "../flow-messaging/src/index.ts";
import { call, harness, respond, scriptedModel, users } from "./helpers.ts";

type Order = { id: string; number: number; status: string; total: string; photo?: string };
const orders = records<Order>({ kind: "orders", id: (o) => o.id, title: (o) => `#${o.number} · ${o.status}`, detail: (o) => `${o.total} · 2 items`, image: (o) => o.photo, pick: "View order" });
const some = (n: number, photo = false): Order[] => Array.from({ length: n }, (_, i) => ({ id: `ORD-${i + 1}`, number: 100 + i, status: i % 2 ? "shipped" : "pending", total: `$${10 + i}.00`, ...(photo ? { photo: `https://example.com/${i}.jpg` } : {}) }));
const outbound = (n: number, extra: Partial<RecordsOutbound> = {}): RecordsOutbound => {
  const r = orders.of(some(n, extra.rows !== undefined));
  return { type: "records", text: "Your orders", kind: r.kind, rows: r.rows, pick: { label: "View order" }, handle: "r1", ...extra };
};

test("records render per channel: WhatsApp a list, Telegram buttons, iMessage and SMS numbered text, read-only rows as text", () => {
  const [wa] = recordsMessages(WHATSAPP, outbound(12));
  assert.equal(wa.type, "message");
  if (wa.type !== "message") return;
  assert.equal(wa.text, "Your orders");
  assert.equal(wa.list?.button, "View order");
  assert.deepEqual(wa.list?.rows.map((r) => r.id), [...some(9).map((o) => o.id), RECORDS_MORE], "9 rows and More when there are more");
  assert.equal(wa.list?.rows[0].description, "$10.00 · 2 items");

  // Flow Messaging's WhatsApp shows no row descriptions: the details go in the text, numbered.
  const [fm] = recordsMessages({ ...WHATSAPP, lists: { ...WHATSAPP.lists!, titleMax: 20, descriptions: false } }, outbound(3));
  assert.ok(fm.type === "message" && fm.list && !fm.list.rows[0].description);
  assert.match(fm.text, /^Your orders\n\n1\. \*#100 · pending\*\n\$10\.00 · 2 items\n2\./);

  const [tg] = recordsMessages(TELEGRAM, outbound(3));
  assert.ok(tg.type === "message");
  assert.deepEqual(tg.buttons, [{ id: "ORD-1", label: "1. #100 · pending" }, { id: "ORD-2", label: "2. #101 · shipped" }, { id: "ORD-3", label: "3. #102 · pending" }]);
  assert.match(tg.text, /1\. \*\*#100 · pending\*\*/);

  const [im] = recordsMessages(IMESSAGE, outbound(12));
  assert.ok(im.type === "message" && !im.buttons && !im.list);
  assert.match(im.text, /10\. #109 · shipped\n\$19\.00 · 2 items\n\nReply with a number to pick one\. Reply MORE for the next 2\.$/);

  const sms = recordsMessages(SMS, outbound(12));
  assert.match(sms[0].text, /5\. #104/);
  assert.doesNotMatch(sms[0].text, /6\. /, "5 a page on SMS");

  const [readOnly] = recordsMessages(WHATSAPP, { ...outbound(2), pick: undefined });
  assert.ok(readOnly.type === "message" && !readOnly.list, "rows nobody picks never need a tap");
});

test("rows with photos become cards where the channel has carousels; a page is fitted to the platform's limits", () => {
  const r = orders.of(some(3, true));
  const [cards] = recordsMessages(TELEGRAM, { type: "records", text: "Your orders", kind: "orders", rows: r.rows, pick: { label: "View order" } });
  assert.ok(cards.type === "carousel");
  assert.deepEqual(cards.cards[0].buttons, [{ id: "ORD-1", label: "View order" }]);

  const long = orders.of(some(10).map((o) => ({ ...o, total: "x".repeat(200) })));
  const [fm] = recordsMessages({ ...WHATSAPP, lists: { ...WHATSAPP.lists!, descriptions: false } }, { type: "records", text: "Your orders", kind: "orders", rows: long.rows, pick: { label: "View" } });
  assert.ok([...fm.text].length <= 1024, "WhatsApp's 1,024 with a list: details trimmed or left out");
  assert.match(fm.text, /…/);
});

test("pages: the second page continues the numbers; a custom UI that takes records gets the rows and where the page is", () => {
  const [p2] = recordsMessages(IMESSAGE, outbound(12, { page: { number: 2 } }));
  assert.match(p2.text, /11\. #110[\s\S]*12\. #111/);
  assert.doesNotMatch(p2.text, /MORE/);
  const ui: ChannelInfo = { reactions: false, status: false, formatting: "markdown", records: { maxRows: 5 } };
  const page = recordsPage(ui, outbound(12, { page: { number: 3 } }));
  assert.deepEqual([page.page, page.pages, page.total, page.rows.map((r) => r.number)], [3, 3, 12, [11, 12]]);
});

test("records() refuses ids a pick could not carry, and keeps at most 100 rows, saying how many there were", () => {
  assert.throws(() => orders.of([{ ...some(1)[0], id: "" }]), /an id is 1 to 64 bytes/);
  assert.throws(() => orders.of([some(1)[0], some(1)[0]]), /on two rows/);
  const many = orders.of(some(140));
  assert.equal(many.rows.length, 100);
  assert.equal(many.total, 140);
  assert.equal(JSON.stringify(many).startsWith('[{"id":"ORD-1"'), true, "serialized, it is the rows as the tool returned them");
});

const WA: ChannelInfo = { ...WHATSAPP };
const listOrders = (n: number) => tool({ name: "list_orders", description: "", input: z.object({}), run: () => orders.of(some(n), { total: n }) });

test("the agent shows a tool's records by handle; the channel gets them rendered, and ids the tool did not return are refused", async () => {
  const h = harness([listOrders(3)], 50, WA);
  h.send("c1", "my orders");
  (await h.nextCall(0)).answer(respond(call("send_chat", { text: "Looking." }), call("list_orders")));
  const second = await h.nextCall(1);
  const result = second.request.messages.filter((m) => m.role === "tool").at(-1) as { content: string };
  assert.match(result.content, /\[Chinwag\] records r1: 3 orders, ids ORD-1, ORD-2, ORD-3\. To show them, send with show: \{ records: "r1" \}/);
  second.answer(respond(call("send_chat", { text: "Pending ones:", show: { records: "r1", ids: ["ORD-9"] } }), call("send_chat", { text: "Here", show: { records: "r1" }, buttons: ["a"] })));
  const third = await h.nextCall(2);
  const results = third.request.messages.filter((m) => m.role === "tool").slice(-2).map((m) => (m as { content: string }).content);
  assert.match(results[0], /Not sent: ORD-9 is not in r1/);
  assert.match(results[1], /records go alone/);
  third.answer(respond(call("send_chat", { text: "Pending ones:", show: { records: "r1", ids: ["ORD-3", "ORD-1"] } })));
  await h.agent.conversation("c1")!.whenIdle();
  const sent = h.out.filter((o): o is Extract<Outbound, { type: "message" }> => o.type === "message");
  assert.deepEqual(sent.at(-1)?.list?.rows.map((r) => r.id), ["ORD-3", "ORD-1"]);
  const out = h.events.filter((e) => e.type === "message.out").at(-1) as unknown as { records: Record<string, unknown> };
  const { rows, ...shown } = out.records as { rows: Array<{ id: string; number: number }> };
  assert.deepEqual(shown, { kind: "orders", handle: "r1", count: 2, shown: ["ORD-3", "ORD-1"], page: 1, pages: 1, deliveredAs: "list" });
  assert.deepEqual(rows.map((r) => [r.number, r.id]), [[1, "ORD-3"], [2, "ORD-1"]], "the page's rows with their numbers, for tests and the playground");
});

test("a tap on a row or its number typed is a pick with the row's data; MORE sends the next page with no model call", async () => {
  const h = harness([listOrders(12)], 50, WA);
  h.send("c2", "my orders");
  (await h.nextCall(0)).answer(respond(call("send_chat", { text: "Looking." }), call("list_orders")));
  (await h.nextCall(1)).answer(respond(call("send_chat", { text: "Your orders", show: { records: "r1" } })));
  await h.agent.conversation("c2")!.whenIdle();

  h.send("c2", "more");
  await h.agent.conversation("c2")!.whenIdle();
  assert.equal(h.calls.length, 2, "no model call for More");
  const page2 = h.out.filter((o) => o.type === "message").at(-1) as Extract<Outbound, { type: "message" }>;
  assert.deepEqual(page2.list?.rows.map((r) => r.id), ["ORD-10", "ORD-11", "ORD-12"]);
  assert.equal(page2.text, "10–12 / 12");

  h.send("c2", "#11");
  const pick = await h.nextCall(2);
  const said = users(pick.request.messages).at(-1)!;
  assert.match(said, /tapped\] #110 · pending \(ORD-11\)\n\[Chinwag\] They picked ORD-11 from orders r1: \{"id":"ORD-11","number":110/);
  assert.match(users(pick.request.messages).join("\n"), /Chinwag sent them page 2 of r1 for this/);
  pick.answer(respond(call("send_chat", { text: "Order #110 is pending." })));
  await h.agent.conversation("c2")!.whenIdle();

  h.send("c2", "2");
  const plain = await h.nextCall(3);
  assert.equal(users(plain.request.messages).at(-1), "[m4] 2", "after another message, a number is just what they typed");
  plain.answer(respond(call("send_chat", { text: "Which one?" })));
  await h.agent.conversation("c2")!.whenIdle();
});

test("records handles survive a restart: a pick after it still finds its row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const path = join(dir, "db.sqlite");
  const start = () => {
    const scripted = scriptedModel();
    const agent = createAgent({ dir, model: scripted.model, tools: [listOrders(3)], debounceMs: 0, database: sqlite(path), scheduleCheckMs: 0 });
    return { agent, ...scripted };
  };
  const out: Outbound[] = [];
  const before = start();
  await before.agent.resume();
  before.agent.receive("c3", "my orders", (o) => void out.push(o), { channel: WA });
  (await before.nextCall(0)).answer(respond(call("send_chat", { text: "Looking." }), call("list_orders")));
  (await before.nextCall(1)).answer(respond(call("send_chat", { text: "Your orders", show: { records: "r1" } })));
  await before.agent.conversation("c3")!.whenIdle();

  const after = start();
  await after.agent.resume();
  after.agent.receive("c3", { text: "#101 · shipped", choice: { id: "ORD-2", title: "#101 · shipped" } }, (o) => void out.push(o), { channel: WA });
  const pick = await after.nextCall(0);
  assert.match(users(pick.request.messages).at(-1)!, /They picked ORD-2 from orders r1: \{"id":"ORD-2"/);
  pick.answer(respond(call("send_chat", { text: "Shipped." })));
  await after.agent.conversation("c3")!.whenIdle();
});
