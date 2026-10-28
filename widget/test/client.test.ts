// covers: widget/src/client.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient, fitMeta, type Update } from "../src/client.ts";

const ROOT = "https://agent.example/v1/web-chat";
type Call = { method: string; path: string; auth?: string; accept?: string; body?: Record<string, unknown> };
type Reply = Response | Promise<Response>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const agent = (seq: number, text = `reply ${seq}`) => ({ seq, at: seq, type: "message", from: "agent", id: `a${seq}`, text });

/** An SSE response the test writes frames into. */
function sse() {
  let control!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (control = c) });
  const send = (event: string, data: unknown, id?: number) =>
    control.enqueue(new TextEncoder().encode(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  return { response: new Response(body, { headers: { "content-type": "text/event-stream" } }), send, end: () => control.close() };
}

/** A fake agent: each route answers from the test's queue (else a default), and every call is recorded. */
function server(routes: Record<string, Array<(call: Call, signal?: AbortSignal) => Reply>>) {
  const calls: Call[] = [];
  let sessions = 0;
  const defaults: Record<string, (call: Call) => Reply> = {
    "POST /session": () => json({ session: `s${++sessions}`, expires_at: Date.now() + 3_600_000, signed_in: false, visitor: "v1", limits: { message_chars: 2000 } }),
    "GET /history": () => json({ messages: [], cursor: 0 }),
    // An unanswered call: it waits until the client aborts it.
    "GET /events": () => new Promise<Response>(() => {}),
    "POST /messages": (call) => json({ id: call.body?.id }, 202),
  };
  const fetch = async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = { method: init.method ?? "GET", path: u.pathname.replace("/v1/web-chat", "") + u.search, auth: headers.authorization, accept: headers.accept };
    if (typeof init.body === "string") call.body = JSON.parse(init.body);
    calls.push(call);
    const route = `${call.method} ${call.path.replace(/\?.*/, "")}`;
    const handler = routes[route]?.shift() ?? defaults[route];
    const signal = init.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      Promise.resolve(handler(call, signal)).then(resolve, reject);
    });
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

/** Timers the test controls: backoffs pass at once; the 3-second hello wait passes only when the test says. */
function timers() {
  const hello: Array<() => void> = [];
  let asked!: () => void;
  const helloAsked = new Promise<void>((resolve) => (asked = resolve));
  const sleep = (ms: number, signal?: AbortSignal) =>
    ms === 3000
      ? new Promise<void>((resolve) => {
          hello.push(resolve);
          signal?.addEventListener("abort", () => resolve(), { once: true });
          asked();
        })
      : Promise.resolve();
  return { sleep, helloAsked, passHello: () => hello.splice(0).forEach((go) => go()) };
}

/** Resolves with the first update `pick` accepts. */
function next<T extends Update>(client: ReturnType<typeof createClient>, pick: (u: Update) => u is T): Promise<T>;
function next(client: ReturnType<typeof createClient>, pick: (u: Update) => boolean): Promise<Update>;
function next(client: ReturnType<typeof createClient>, pick: (u: Update) => boolean) {
  return new Promise<Update>((resolve) => {
    const stop = client.on((u) => {
      if (pick(u)) {
        stop();
        resolve(u);
      }
    });
  });
}

function memory() {
  const kept = new Map<string, string>();
  return { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), kept };
}

test("the box reads the history, then streams events after its cursor over SSE with the session in the Authorization header", async () => {
  const stream = sse();
  const fake = server({
    "GET /history": [() => json({ messages: [agent(1)], cursor: 1 })],
    "GET /events": [() => stream.response],
  });
  const client = createClient({ root: ROOT, fetch: fake.fetch, storage: () => null, sleep: timers().sleep });
  const history = next(client, (u) => u.kind === "history");
  client.connect();
  assert.deepEqual(((await history) as Extract<Update, { kind: "history" }>).events.map((e) => e.seq), [1]);
  const event = next(client, (u) => u.kind === "event");
  stream.send("hello", { cursor: 1 });
  stream.send("message", agent(2), 2);
  assert.equal(((await event) as Extract<Update, { kind: "event" }>).event.seq, 2);
  const events = fake.calls.find((c) => c.path.startsWith("/events"))!;
  assert.equal(events.path, "/events?after=1");
  assert.equal(events.accept, "text/event-stream");
  assert.equal(events.auth, "Bearer s1");
  client.disconnect();
});

test("each seq is shown once: an event at or below the last shown is ignored", async () => {
  const stream = sse();
  const fake = server({ "GET /history": [() => json({ messages: [agent(1), agent(2)], cursor: 2 })], "GET /events": [() => stream.response] });
  const client = createClient({ root: ROOT, fetch: fake.fetch, storage: () => null, sleep: timers().sleep });
  const shown: number[] = [];
  client.on((u) => void (u.kind === "event" && shown.push(u.event.seq)));
  const four = next(client, (u) => u.kind === "event" && u.event.seq === 4);
  client.connect();
  await next(client, (u) => u.kind === "history");
  stream.send("hello", { cursor: 2 });
  for (const seq of [2, 3, 3, 1, 4]) stream.send("message", agent(seq), seq);
  await four;
  assert.deepEqual(shown, [3, 4]);
  client.disconnect();
});

test("with no hello within 3 s the box long-polls the same endpoint from the same cursor", async () => {
  const time = timers();
  let polled!: (call: Call) => void;
  const poll = new Promise<Call>((resolve) => (polled = resolve));
  const fake = server({
    "GET /history": [() => json({ messages: [], cursor: 5 })],
    // A proxy that buffers: the stream's response never shows.
    "GET /events": [
      () => new Promise<Response>(() => {}),
      (call) => {
        polled(call);
        return json({ events: [agent(6)], cursor: 6, live: { typing: false, status: null } });
      },
    ],
  });
  const client = createClient({ root: ROOT, fetch: fake.fetch, storage: () => null, sleep: time.sleep });
  const six = next(client, (u) => u.kind === "event" && u.event.seq === 6);
  client.connect();
  await time.helloAsked;
  time.passHello();
  const call = await poll;
  assert.equal(call.path, "/events?after=5");
  assert.notEqual(call.accept, "text/event-stream");
  await six;
  client.disconnect();
});

test("a reset reads the history again", async () => {
  const stream = sse();
  let resumed!: (call: Call) => void;
  const resume = new Promise<Call>((resolve) => (resumed = resolve));
  const fake = server({
    "GET /history": [() => json({ messages: [agent(1)], cursor: 1 }), () => json({ messages: [agent(9)], cursor: 9 })],
    "GET /events": [
      () => stream.response,
      (call) => {
        resumed(call);
        return new Promise<Response>(() => {});
      },
    ],
  });
  const client = createClient({ root: ROOT, fetch: fake.fetch, storage: () => null, sleep: timers().sleep });
  client.connect();
  await next(client, (u) => u.kind === "history");
  const again = next(client, (u) => u.kind === "history");
  stream.send("hello", { cursor: 1 });
  stream.send("reset", {});
  stream.end();
  const history = (await again) as Extract<Update, { kind: "history" }>;
  assert.deepEqual(history.events.map((e) => e.seq), [9]);
  assert.equal((await resume).path, "/events?after=9");
  client.disconnect();
});

test("a message is retried after a 5xx or a network failure under the same id, and taken", async () => {
  const fake = server({
    "POST /messages": [() => json({ error: "not_stored" }, 503), () => Promise.reject(new TypeError("offline"))],
  });
  const client = createClient({ root: ROOT, fetch: fake.fetch, storage: () => null, sleep: timers().sleep });
  const sent = next(client, (u) => u.kind === "sent" || u.kind === "failed");
  const id = client.send("Is it in stock?");
  assert.deepEqual(await sent, { kind: "sent", id });
  const posts = fake.calls.filter((c) => c.path === "/messages");
  assert.equal(posts.length, 3);
  assert.deepEqual(new Set(posts.map((p) => p.body!.id)), new Set([id]));
});

test("a 401 makes a new session for the same visitor and the call is tried once more", async () => {
  const storage = memory();
  const fake = server({ "GET /history": [() => json({ error: "session_invalid" }, 401)] });
  const client = createClient({ root: ROOT, fetch: fake.fetch, storage: () => storage, sleep: timers().sleep });
  client.connect();
  await next(client, (u) => u.kind === "history");
  client.disconnect();
  const sessions = fake.calls.filter((c) => c.path === "/session");
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[0].body, {});
  assert.deepEqual(sessions[1].body, { visitor: "v1" }); // the credential the first answer gave, from storage
  assert.equal(storage.kept.get(`flow-chat:${ROOT}`), "v1");
  assert.deepEqual(fake.calls.filter((c) => c.path === "/history").map((c) => c.auth), ["Bearer s1", "Bearer s2"]);
});

test("the page and context sent with a message fit in 1 KB: the title goes first, then the context", () => {
  const url = "https://shop.example/listing/ps5?ref=home";
  const context = { listing: "ps5-disc" };
  assert.deepEqual(fitMeta({ page: { url, title: "t".repeat(2000) }, context }), { page: { url }, context });
  assert.deepEqual(fitMeta({ page: { url, title: "PS5" }, context: { notes: "n".repeat(2000) } }), { page: { url, title: "PS5" } });
  assert.deepEqual(fitMeta({ page: { url: `${url}&q=${"x".repeat(2000)}` }, context }), { page: { url: "https://shop.example/listing/ps5" } });
});
