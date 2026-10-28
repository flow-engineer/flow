// covers: src/web-chat.ts src/store.ts src/agent.ts src/conversation.ts src/talk.ts src/channels.ts
// The web chat over its HTTP contract, as a browser's chat box uses it: sessions and identity
// tokens, allowed sites, the outbox's numbering through a restart and a deploy's overlap, SSE and
// long-polling on one cursor, limits, turns at once, the page a visitor wrote from reaching the agent
// as data, and a signed-in visitor's WhatsApp conversation shown to their web chat's turns (and back)
// when their identity token carries the same verified number.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { after } from "node:test";
import { createAgent, postgres, sqlite, Store, tool, webChat, webChatIdentity, z, type Channel, type Database, type Outbound, type PostgresPool, type StoreApi, type WebChatOptions } from "../src/index.ts";
import { call, respond, scriptedModel, WHATSAPP } from "./helpers.ts";

const SESSION_KEY = "s".repeat(40);
const IDENTITY_KEY = "i".repeat(40);
const SITE = "https://shop.example";

function dirWith(): string {
  const dir = mkdtempSync(join(tmpdir(), "flow-web-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  return dir;
}

/** An agent with the web chat, and a browser's calls to it (from SITE unless told otherwise). */
async function webAgent(options: WebChatOptions = {}, more: { database?: Database; id?: string; dir?: string; resolve?: (i: { channel: string; address: string }) => string | null; tools?: ReturnType<typeof tool>[]; channels?: Channel[] } = {}) {
  const scripted = scriptedModel();
  const channel = webChat({ origins: [SITE], sessionKey: SESSION_KEY, identityKey: IDENTITY_KEY, trustProxy: 1, ...options });
  const agent = createAgent({ dir: more.dir ?? dirWith(), model: scripted.model, debounceMs: 0, channels: [...(more.channels ?? []), channel], scheduleCheckMs: 0, ...(more.database ? { database: more.database } : {}), ...(more.id ? { id: more.id } : {}), ...(more.resolve ? { resolve: more.resolve } : {}), ...(more.tools ? { tools: more.tools } : {}) });
  await agent.resume();
  const http = (path: string, init: RequestInit & { origin?: string | null; ip?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.origin !== null) headers.set("origin", init.origin ?? SITE);
    headers.set("x-forwarded-for", `9.9.9.9, ${init.ip ?? "1.2.3.4"}`);
    return agent.fetch(new Request(`https://agent.test/v1/web-chat${path}`, { ...init, headers }));
  };
  const session = async (body: Record<string, unknown> = {}, ip?: string) => {
    const answer = await http("/session", { method: "POST", body: JSON.stringify(body), ip });
    assert.equal(answer.status, 200, await answer.clone().text());
    return (await answer.json()) as { session: string; visitor?: string; signed_in: boolean; expires_at: number };
  };
  const as = (token: string) => ({
    send: (body: Record<string, unknown>, ip?: string) => http("/messages", { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${token}` }, ip }),
    poll: async (after: number, wait = 25) => (await http(`/events?after=${after}&wait=${wait}`, { headers: { authorization: `Bearer ${token}` } })).json() as Promise<any>,
    history: async () => (await http("/history", { headers: { authorization: `Bearer ${token}` } })).json() as Promise<any>,
    stream: (after: number, signal: AbortSignal) => http(`/events?after=${after}`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal }),
  });
  return { agent, channel, http, session, as, ...scripted };
}

/** The server-sent events of a response, one by one (comments skipped). */
async function* frames(response: Response): AsyncGenerator<{ event: string; data: any; id?: string }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const fields = Object.fromEntries(frame.split("\n").filter((l) => !l.startsWith(":")).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
        if (fields.event) yield { event: fields.event, data: JSON.parse(fields.data), ...(fields.id ? { id: fields.id } : {}) };
      }
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Reads server-sent events until `until` says stop. */
async function readEvents(response: Response, until: (events: Array<{ event: string; data: any; id?: string }>) => boolean) {
  const events: Array<{ event: string; data: any; id?: string }> = [];
  for await (const frame of frames(response)) {
    events.push(frame);
    if (until(events)) break;
  }
  return events;
}

test("a visitor's message reaches the agent once, however often it is sent, and the reply comes after it in order", async () => {
  const web = await webAgent();
  const { session, visitor } = await web.session();
  assert.ok(visitor);
  const box = web.as(session);
  for (let i = 0; i < 2; i++) assert.equal((await box.send({ id: "m1", text: "Is the PS5 in stock?" })).status, 202);
  const turn = await web.nextCall(0);
  turn.answer(respond(call("send_web", { text: "Yes, two left.", buttons: ["Reserve one"] })));
  let events: any[] = [];
  for (let after = 0; events.length < 2; ) {
    const got = await box.poll(after);
    events = [...events, ...got.events];
    after = got.cursor;
  }
  assert.deepEqual(events.map((e) => [e.seq, e.from, e.text]), [[1, "person", "Is the PS5 in stock?"], [2, "agent", "Yes, two left."]]);
  assert.deepEqual(events[1].buttons, [{ id: "Reserve one", label: "Reserve one" }]);
  assert.equal(events[0].id, "m1");
  assert.equal(web.calls.length, 1);
  const history = await box.history();
  assert.equal(history.cursor, 2);
  assert.deepEqual(history.messages.map((m: any) => m.text), ["Is the PS5 in stock?", "Yes, two left."]);
});

test("a box comes back after a restart and reads what came after its last number, and an unknown number resets it", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "flow-web-db-")), "agent.sqlite");
  const dir = dirWith();
  const first = await webAgent({}, { database: sqlite(file), dir });
  const { session } = await first.session();
  await first.as(session).send({ id: "m1", text: "hello" });
  (await first.nextCall(0)).answer(respond(call("send_web", { text: "one" }), call("send_web", { text: "two" })));
  while ((await first.as(session).poll(0, 0)).cursor < 3) await first.as(session).poll(1);
  // The agent restarts: a new process on the same store, the same session key.
  const second = await webAgent({}, { database: sqlite(file), dir });
  const box = second.as(session);
  const got = await box.poll(2, 0);
  assert.deepEqual(got.events.map((e: any) => [e.seq, e.text]), [[3, "two"]]);
  assert.deepEqual(await box.poll(9, 0), { reset: true });
});

test("a reply another runner keeps reaches a box waiting on this one (a deploy's overlap)", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "flow-web-db-")), "agent.sqlite");
  const dir = dirWith();
  const old = await webAgent({}, { database: sqlite(file), dir });
  const fresh = await webAgent({}, { database: sqlite(file), dir });
  const { session } = await fresh.session();
  const stop = new AbortController();
  const events = frames(await fresh.as(session).stream(0, stop.signal));
  // hello, then the live line: the stream has read the outbox and is waiting.
  assert.equal((await events.next()).value?.event, "hello");
  assert.equal((await events.next()).value?.event, "live");
  const address = JSON.parse(Buffer.from(session.split(".")[1], "base64url").toString()).sub;
  // The old revision sends; only the store tells the new one (its 2-second recheck).
  await old.channel.send(address, { type: "message", text: "from the old revision" });
  const next = await events.next();
  stop.abort();
  assert.deepEqual([next.value?.event, next.value?.data.text], ["message", "from the old revision"]);
});

test("the event stream says hello, sends each event with its number, and the live typing line", async () => {
  const web = await webAgent();
  const { session } = await web.session();
  const box = web.as(session);
  const stop = new AbortController();
  const response = await box.stream(0, stop.signal);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  await box.send({ id: "m1", text: "hi" });
  const turn = await web.nextCall(0);
  turn.answer(respond(call("send_web", { text: "hello there" })));
  const events = await readEvents(response, (es) => es.some((e) => e.event === "message" && e.data.from === "agent"));
  stop.abort();
  assert.deepEqual(events[0], { event: "hello", data: { cursor: 0 } });
  assert.deepEqual(events.filter((e) => e.event === "message").map((e) => [e.id, e.data.text]), [["1", "hi"], ["2", "hello there"]]);
  assert.ok(events.some((e) => e.event === "live" && e.data.typing === true));
});

test("an anonymous visitor stays themselves with their credential; a signed-in one is the person their key names", async () => {
  const web = await webAgent({}, { resolve: (i) => (i.channel === "whatsapp" ? "member-7" : null) });
  const first = await web.session();
  const again = await web.session({ visitor: first.visitor });
  const sub = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;
  assert.equal(sub(again.session), sub(first.session));
  assert.notEqual(sub((await web.session()).session), sub(first.session));
  const signedIn = await web.session({ identity: webChatIdentity({ sub: "member-7", key: IDENTITY_KEY }) });
  assert.equal(signedIn.signed_in, true);
  assert.equal(signedIn.visitor, undefined);
  await web.as(signedIn.session).send({ id: "k1", text: "hi" });
  const conversation = await web.agent.conversationOf({ channel: "web", address: "user:member-7" });
  assert.ok(conversation);
  assert.equal(conversation, await web.agent.visitorConversation("member-7"));
  // A token signed with another key, or valid for longer than 10 minutes, is refused.
  for (const identity of [webChatIdentity({ sub: "member-7", key: "x".repeat(40) }), signToken({ sub: "member-7", aud: "flow-web-chat", exp: Math.floor(Date.now() / 1000) + 3600 })]) {
    const answer = await web.http("/session", { method: "POST", body: JSON.stringify({ identity }) });
    assert.equal(answer.status, 401);
    assert.equal((await answer.json()).error, "identity_invalid");
  }
});

test("only the listed sites may use the chat, and a wildcard covers their subdomains", async () => {
  const web = await webAgent({ origins: ["https://*.vingo.example"] });
  assert.equal((await web.http("/session", { method: "POST", body: "{}", origin: "https://evil.example" })).status, 403);
  const preflight = await web.http("/messages", { method: "OPTIONS", origin: "https://www.vingo.example" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://www.vingo.example");
  assert.equal((await web.http("/session", { method: "POST", body: "{}", origin: "https://vingo.example" })).status, 403);
  assert.throws(() => webChat({ origins: ["http://shop.example"], sessionKey: SESSION_KEY }), /not a site/);
});

test("limits: a visitor's messages a minute, and new visitors per address", async () => {
  const web = await webAgent({ limits: { messagesPerMinute: 2, newVisitorsPerMinute: 2 } });
  await web.session({}, "5.5.5.5");
  await web.session({}, "5.5.5.5");
  const third = await web.http("/session", { method: "POST", body: "{}", ip: "5.5.5.5" });
  assert.equal(third.status, 429);
  assert.equal((await third.json()).error, "rate_limited");
  const { session } = await web.session();
  const box = web.as(session);
  assert.deepEqual(await (await box.send({ id: "a", text: "one" })).json(), { id: "a" });
  assert.deepEqual(await (await box.send({ id: "b", text: "two" })).json(), { id: "b" });
  const over = await box.send({ id: "c", text: "three" });
  assert.equal(over.status, 429);
  assert.equal((await over.json()).error, "rate_limited");
});

test("at most turnsAtOnce web turns run at once; the next waits for one to end", async () => {
  const web = await webAgent({ limits: { turnsAtOnce: 1 } });
  const one = web.as((await web.session()).session);
  const two = web.as((await web.session()).session);
  await one.send({ id: "x", text: "first" });
  await two.send({ id: "y", text: "second" });
  const first = await web.nextCall(0);
  // The second visitor's turn is waiting for the slot: no model call yet.
  assert.equal(web.calls.length, 1);
  first.answer(respond(call("send_web", { text: "done" })));
  const second = await web.nextCall(1);
  assert.match(JSON.stringify(second.request.messages), /second/);
});

test("the page a visitor writes from reaches the agent as one line of data, and its tools as context.page", async () => {
  let seen: unknown;
  const where = tool({ name: "where", description: "Where they are", input: z.object({}), run: (_input, context) => ((seen = context.page), "ok") });
  const web = await webAgent({}, { tools: [where] });
  const box = web.as((await web.session()).session);
  const page = { url: `${SITE}/listing/ps5`, title: "PS5 Disc" };
  await box.send({ id: "p1", text: "is this one new?", page, context: { listing: "ps5-disc" } });
  const turn = await web.nextCall(0);
  assert.match(turn.request.system, /"url":"https:\/\/shop\.example\/listing\/ps5","title":"PS5 Disc","context":\{"listing":"ps5-disc"\}/);
  turn.answer(respond(call("send_web", { text: "Let me check." }), call("where")));
  await web.nextCall(1);
  assert.deepEqual(seen, { ...page, context: { listing: "ps5-disc" } });
  // A page on another site is refused.
  assert.equal((await box.send({ id: "p2", text: "x", page: { url: "https://evil.example/" } })).status, 400);
});

test("the agent serves the chat box: the loader and the panel's modules as JavaScript any site may load, gzipped when the browser takes it", async () => {
  const web = await webAgent();
  const loader = await web.http("/widget.js", { origin: null });
  assert.equal(loader.status, 200);
  assert.equal(loader.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(loader.headers.get("access-control-allow-origin"), "*");
  assert.match(await loader.text(), /FlowChat/);
  const panel = await web.http("/widget/panel.js", { origin: "https://elsewhere.example", headers: { "accept-encoding": "gzip, br" } });
  assert.equal(panel.headers.get("content-encoding"), "gzip");
  const { gunzipSync } = process.getBuiltinModule("node:zlib");
  assert.match(gunzipSync(Buffer.from(await panel.arrayBuffer())).toString(), /import/);
  assert.equal((await web.http("/widget/nope.js")).status, 404);
  assert.equal((await web.http("/widget/../src/agent.js")).status, 404);
});

function signToken(claims: Record<string, unknown>): string {
  const { createHmac } = process.getBuiltinModule("node:crypto");
  const head = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${head}.${createHmac("sha256", IDENTITY_KEY).update(head).digest("base64url")}`;
}

/** A WhatsApp channel (a phone channel: its addresses are verified numbers) whose sends land in `sent`. */
function whatsapp(sent: Array<{ address: string; outbound: Outbound }> = []): Channel {
  return { name: "whatsapp", kind: "whatsapp", phone: true, info: WHATSAPP, send: (address, outbound) => void sent.push({ address, outbound }) };
}

const NUMBER = "+919876543210";
const signedIn = (sub: string, phone?: string) => ({ identity: webChatIdentity({ sub, ...(phone ? { phone } : {}), key: IDENTITY_KEY }) });

/** They write on WhatsApp and the agent answers there: call `index` of the agent's model. */
async function onWhatsApp(web: Awaited<ReturnType<typeof webAgent>>, index: number) {
  const taken = await web.agent.message({ channel: "whatsapp", from: "919876543210", message: "Is my bid on the PS5 still the highest?", messageId: "w1" });
  (await web.nextCall(index)).answer(respond(call("send_whatsapp", { text: "Yes, your ₹30,000 bid leads." })));
  await web.agent.conversation(taken!.conversationId)!.whenIdle();
  return taken!.conversationId;
}

test("signed in on the web with their WhatsApp number, a person's turns are shown that chat (and WhatsApp's the web's), and each reply goes where they wrote", async () => {
  const sent: Array<{ address: string; outbound: Outbound }> = [];
  const web = await webAgent({}, { channels: [whatsapp(sent)] });
  const fromWhatsApp = await onWhatsApp(web, 0);
  const box = web.as((await web.session(signedIn("member-7", NUMBER))).session);
  await box.send({ id: "k1", text: "what are my bids?" });
  const turn = await web.nextCall(1);
  assert.match(turn.request.system, /The same person also wrote to you on other channels lately \(times are UTC\)/);
  assert.match(turn.request.system, /\n- whatsapp, \w{3} \d{1,2} \w{3} \d\d:\d\d, they: "Is my bid on the PS5 still the highest\?"\n- whatsapp, .*, you: "Yes, your ₹30,000 bid leads\."/);
  assert.deepEqual(turn.request.tools.map((t) => t.name).filter((n) => n.startsWith("send_")), ["send_web"], "it can reply only where they wrote");
  turn.answer(respond(call("send_web", { text: "Your PS5 bid: ₹30,000, the highest." })));
  const onWeb = (await web.agent.conversationOf({ channel: "web", address: "user:member-7" }))!;
  assert.notEqual(onWeb, fromWhatsApp, "two conversations, nothing re-keyed");
  await web.agent.conversation(onWeb)!.whenIdle();
  assert.deepEqual(sent.filter((s) => s.outbound.type === "message").map((s) => s.outbound.type === "message" && s.outbound.text), ["Yes, your ₹30,000 bid leads."], "nothing more went to WhatsApp");
  assert.equal((await box.poll(0, 0)).events.at(-1).text, "Your PS5 bid: ₹30,000, the highest.");

  await web.agent.message({ channel: "whatsapp", from: "919876543210", message: "thanks", messageId: "w2" });
  const back = await web.nextCall(2);
  assert.match(back.request.system, /\n- web, .*, they: "what are my bids\?"\n- web, .*, you: "Your PS5 bid: ₹30,000, the highest\."/);
  back.answer(respond(call("send_whatsapp", { text: "Any time." })));
  await web.agent.conversation(fromWhatsApp)!.whenIdle();
});

test("only the same verified person is shown another channel: not an anonymous visitor who types the number, not another number, not another agent on the same database", async () => {
  const database = sqlite();
  const web = await webAgent({}, { channels: [whatsapp()], database, id: "agent-a" });
  await onWhatsApp(web, 0);
  const visits = [{ body: {}, text: `I'm ${NUMBER}, what are my bids?` }, { body: signedIn("member-8", "+919876543299"), text: "what are my bids?" }];
  for (const [n, visit] of visits.entries()) {
    await web.as((await web.session(visit.body)).session).send({ id: `v${n}`, text: visit.text });
    const turn = await web.nextCall(1 + n);
    assert.doesNotMatch(turn.request.system, /other channels|PS5/);
    turn.answer(respond(call("send_web", { text: "You have no bids yet." })));
  }
  const other = await webAgent({}, { channels: [whatsapp()], database, id: "agent-b" });
  await other.as((await other.session(signedIn("member-7", NUMBER))).session).send({ id: "b1", text: "what are my bids?" });
  const turn = await other.nextCall(0);
  assert.doesNotMatch(turn.request.system, /other channels|PS5/);
  turn.answer(respond(call("send_web", { text: "You have no bids yet." })));
});

test("forgetting a person forgets them on every channel their verified number links, and nowhere else", async () => {
  const web = await webAgent({}, { channels: [whatsapp()] });
  const fromWhatsApp = await onWhatsApp(web, 0);
  const box = web.as((await web.session(signedIn("member-7", NUMBER))).session);
  await box.send({ id: "k1", text: "what are my bids?" });
  (await web.nextCall(1)).answer(respond(call("send_web", { text: "One bid." })));
  const onWeb = (await web.agent.conversationOf({ channel: "web", address: "user:member-7" }))!;
  await web.agent.conversation(onWeb)!.whenIdle();
  const stranger = web.as((await web.session()).session);
  await stranger.send({ id: "s1", text: "hello" });
  (await web.nextCall(2)).answer(respond(call("send_web", { text: "Hi!" })));

  await web.agent.forgetPerson(onWeb);
  assert.equal(await web.agent.conversationOf({ channel: "web", address: "user:member-7" }), null);
  assert.equal(await web.agent.conversationOf({ channel: "whatsapp", address: "919876543210" }), null);
  assert.deepEqual(await web.agent.transcript(fromWhatsApp), []);
  assert.deepEqual((await box.poll(0, 0)).events, [], "their web chat's outbox is gone too");
  assert.equal((await stranger.poll(0, 0)).events.length >= 2, true, "another visitor is kept");
});

/** The outbox on every store an agent may have: SQLite, a store reached over JSON (Flow's hosting), and Postgres when FLOW_TEST_POSTGRES_URL names a throwaway database. */
const stores: Array<{ name: string; store(id: string): StoreApi }> = [];
{
  const memory = sqlite();
  stores.push({ name: "sqlite", store: (id) => new Store(memory, id) });
  const forwarded = sqlite();
  stores.push({ name: "over JSON", store: (id) => overJson(new Store(forwarded, id)) });
  const pgUrl = process.env.FLOW_TEST_POSTGRES_URL;
  if (pgUrl) {
    const pg = (await import("pg" as string)).default as { Pool: new (options: { connectionString: string }) => PostgresPool & { end(): Promise<void> } };
    const pool = new pg.Pool({ connectionString: pgUrl });
    after(() => pool.end());
    const db = postgres(pool);
    stores.push({ name: "postgres", store: (id) => new Store(db, id) });
  }
}

for (const backend of stores) {
  test(`${backend.name}: the outbox numbers each visitor's events, keeps a keyed one once, keeps numbering past pruning, and forgets with the person`, async () => {
    const store = backend.store(`agt_${Math.random().toString(36).slice(2, 10)}`);
    await store.migrate();
    const a = await store.appendWebEvent("web", "visitor:a", { type: "message", text: "one" }, null, 1_000);
    const b = await store.appendWebEvent("web", "visitor:a", { type: "message", text: "two" }, "nudge:1", 2_000);
    const again = await store.appendWebEvent("web", "visitor:a", { type: "message", text: "two, again" }, "nudge:1", 3_000);
    await store.appendWebEvent("web", "visitor:b", { type: "message", text: "other" }, null, 1_000);
    assert.deepEqual([a.seq, b.seq, again.seq, again.event.text], [1, 2, 2, "two"]);
    assert.deepEqual(await store.webEvents("web", "visitor:a", 1, 10), { events: [{ seq: 2, at: 2_000, event: { type: "message", text: "two" } }], first: 1, last: 2 });
    assert.deepEqual(await store.webHeads("web", ["visitor:a", "visitor:b", "visitor:c"]), { "visitor:a": 2, "visitor:b": 1, "visitor:c": 0 });
    assert.equal(await store.pruneWebEvents(1_500, 100) >= 1, true);
    assert.equal((await store.appendWebEvent("web", "visitor:a", { type: "message", text: "three" }, null, 4_000)).seq, 3);
    assert.deepEqual((await store.webEvents("web", "visitor:a", 0, 10)).first, 2);
    await store.createConversation("p_web", "web:visitor:a");
    await store.addIdentity("p_web", "web", "visitor:a", "channel");
    await store.forgetPerson("p_web");
    assert.deepEqual(await store.webEvents("web", "visitor:a", 0, 10), { events: [], first: null, last: 0 });
    assert.equal((await store.webEvents("web", "visitor:b", 0, 10)).last, 1);
    // At once, as two runners would: distinct numbers, and a keyed event kept once.
    const many = await Promise.all([1, 2, 3, 4].map((n) => store.appendWebEvent("web", "visitor:c", { n }, null, n)));
    const keyed = await Promise.all([1, 2, 3].map(() => store.appendWebEvent("web", "visitor:c", { keyed: true }, "run:9", 9)));
    assert.deepEqual(many.map((r) => r.seq).sort(), [1, 2, 3, 4]);
    assert.deepEqual(keyed.map((r) => r.seq), [5, 5, 5]);
  });
}

for (const backend of stores) {
  test(`${backend.name}: conversations are linked by a verified number they share, only within one agent, and their recent history is read bounded`, async () => {
    const agentId = `agt_${Math.random().toString(36).slice(2, 10)}`;
    const store = backend.store(agentId);
    await store.migrate();
    await store.createConversation("p_wa", "phone:+15550100100");
    await store.addIdentity("p_wa", "whatsapp", "15550100100", "phone", "+15550100100");
    await store.createConversation("p_web", "key:m7");
    await store.addIdentity("p_web", "web", "user:m7", "resolver", "+15550100100");
    await store.createConversation("p_anon", "web:visitor:x");
    await store.addIdentity("p_anon", "web", "visitor:x", "channel");
    await store.createConversation("p_other", "phone:+15550100200");
    assert.deepEqual([await store.linkedConversations("p_web"), await store.linkedConversations("p_wa"), await store.linkedConversations("p_anon"), await store.linkedConversations("p_other")], [["p_wa"], ["p_web"], [], []]);
    // A signed-in visitor's new number moves the link; adding the identity again with none keeps it.
    await store.addIdentity("p_web", "web", "user:m7", "resolver", "+15550100200");
    await store.addIdentity("p_web", "web", "user:m7", "resolver");
    assert.deepEqual([await store.linkedConversations("p_web"), await store.linkedConversations("p_wa")], [["p_other"], []]);
    assert.equal((await store.identity("web", "user:m7"))?.phone, "+15550100200");
    // Another agent on the same database, with the same number: never linked.
    const other = backend.store(`${agentId}_b`);
    await other.createConversation("p_b", "phone:+15550100200");
    assert.deepEqual(await other.linkedConversations("p_b"), []);

    await store.appendHistory("p_wa", 0, [1, 2, 3].map((n) => ({ role: "user" as const, content: `m${n}` })));
    assert.deepEqual((await store.recentHistory("p_wa", 0, 2)).map((h) => h.entry.content), ["m2", "m3"]);
    assert.deepEqual(await store.recentHistory("p_wa", Date.now() + 60_000, 10), []);
  });
}

/** Forwards every call as Flow's hosting does: arguments and results through JSON. */
function overJson(store: Store): StoreApi {
  return new Proxy({} as StoreApi, {
    get(_target, method) {
      if (method === "durable") return true;
      if (typeof method !== "string" || method === "then") return undefined;
      return async (...args: unknown[]) => {
        while (args.length && args.at(-1) === undefined) args.pop();
        const run = (store as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];
        const result = await run.apply(store, JSON.parse(JSON.stringify(args)));
        return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
      };
    },
  });
}
