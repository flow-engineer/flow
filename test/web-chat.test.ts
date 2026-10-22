// covers: src/web-chat.ts src/web-chat-client.ts src/agent.ts
// The web chat over its HTTP contract, driven by its own client as a browser would: sessions and
// sign-in, the embedding sites, a round trip, a retry taken once, a restart, and the limits.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent, sms, sqlite, webChat, webChatSignIn, type Database, type FlowEvent, type WebChatOptions } from "../src/index.ts";
import { webChatClient, type WebChatClientEvent } from "../src/web-chat-client.ts";
import { call, respond, scriptedModel } from "./helpers.ts";

const SECRET = "s".repeat(40);
const URL_ = "https://agent.example";

function rig(options: Partial<WebChatOptions> & { database?: Database; dir?: string; resolve?: (i: { channel: string; address: string; phone?: string }) => string | null } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "flow-web-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  const events: FlowEvent[] = [];
  const web = webChat({ secret: SECRET, ...options });
  const phone = sms({ sendMessage: async () => {} });
  const agent = createAgent({ dir, model: scripted.model, channels: [web, phone], routes: web.routes, debounceMs: 0, scheduleCheckMs: 0, events: [(e) => events.push(e)], ...(options.database ? { database: options.database } : {}), ...(options.resolve ? { resolve: options.resolve } : {}) });
  web.attach(agent);
  const fetch = (input: RequestInfo | URL, init?: RequestInit) => agent.fetch(new Request(input, init));
  return { dir, agent, web, events, fetch, ...scripted };
}

/** A browser: the client, and every event it emitted, with a wait for the n-th. */
function browser(fetch: typeof globalThis.fetch, options: { signIn?: () => string | null; storage?: Map<string, string> } = {}) {
  const got: WebChatClientEvent[] = [];
  const waiters: Array<() => void> = [];
  const store = options.storage ?? new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const client = webChatClient({ url: URL_, fetch, storage, waitSeconds: 25, ...(options.signIn ? { signIn: options.signIn } : {}) });
  client.on((e) => {
    got.push(e);
    waiters.splice(0).forEach((w) => w());
  });
  async function until(check: (events: WebChatClientEvent[]) => boolean) {
    while (!check(got)) await new Promise<void>((r) => waiters.push(r));
  }
  const agentTexts = () => got.flatMap((e) => (e.type === "message" && e.from === "agent" ? [e.text] : []));
  return { client, got, until, agentTexts, store };
}

test("a visitor writes from the page, the agent's reply reaches their browser, and a reload shows each message once", async () => {
  const t = rig();
  const tab = browser(t.fetch as typeof fetch);
  await tab.client.start();
  await tab.client.send("Is the blue one in stock?", { page: { url: "https://shop.example/p/blue", title: "Blue mug" } });

  const first = await t.nextCall(0);
  assert.equal(first.request.tools.some((s) => s.name === "send_web"), true);
  first.answer(respond(call("send_web", { text: "It is.", buttons: ["Buy it"] })));
  await tab.until(() => tab.agentTexts().includes("It is."));
  const reply = tab.got.find((e) => e.type === "message" && e.from === "agent");
  assert.deepEqual(reply && reply.type === "message" && reply.from === "agent" ? reply.buttons : null, [{ id: "Buy it", label: "Buy it" }]);
  const conversationId = t.events.find((e) => e.type === "message.in")!.conversationId;
  assert.deepEqual(t.web.page(conversationId), { url: "https://shop.example/p/blue", title: "Blue mug" });
  await t.agent.conversation(conversationId)!.whenIdle();
  tab.client.close();

  // The same browser again: its session is kept, and what it was sent is there once.
  const again = browser(t.fetch as typeof fetch, { storage: tab.store });
  await again.client.start();
  await again.until((got) => got.filter((e) => e.type === "message").length >= 2);
  const shown = again.got.flatMap((e) => (e.type === "history" ? e.messages : e.type === "message" ? [e] : []));
  assert.deepEqual(shown.filter((m) => m.type === "message").map((m) => m.text), ["Is the blue one in stock?", "It is."]);
  again.client.close();
});

test("a message sent again with its id is taken once", async () => {
  const t = rig();
  const session = (await (await t.fetch(`${URL_}/v1/web-chat/session`, { method: "POST", body: "{}" })).json()).session as string;
  const post = () => t.fetch(`${URL_}/v1/web-chat/messages`, { method: "POST", headers: { authorization: `Bearer ${session}` }, body: JSON.stringify({ id: "m-1", text: "hello" }) });
  assert.equal((await post()).status, 202);
  assert.equal((await post()).status, 202);
  const first = await t.nextCall(0);
  first.answer(respond(call("send_web", { text: "Hi!" })));
  const id = t.events.find((e) => e.type === "message.in")!.conversationId;
  await t.agent.conversation(id)!.whenIdle();
  assert.equal(t.events.filter((e) => e.type === "message.in").length, 1);
  assert.equal(t.events.filter((e) => e.type === "message.duplicate").length, 1);
  assert.equal(t.calls.length, 1);
});

test("a signed-in visitor is the person their key names on every channel; a token that is not the business's is refused", async () => {
  const t = rig({ resolve: ({ phone }) => (phone === "+15550100199" ? "member-7" : null) });
  await t.agent.message({ channel: "sms", from: "+15550100199", message: "hi from my phone" });
  (await t.nextCall(0)).answer(respond(call("send_sms", { text: "Hi!" })));
  const phoneConversation = (await t.agent.conversationOf({ channel: "sms", address: "+15550100199" }))!;
  await t.agent.conversation(phoneConversation)!.whenIdle();

  const tab = browser(t.fetch as typeof fetch, { signIn: () => webChatSignIn(SECRET, "member-7") });
  await tab.client.start();
  await tab.client.send("and now from the site");
  assert.equal(await t.agent.conversationOf({ channel: "web", address: "user:member-7" }), phoneConversation);
  (await t.nextCall(1)).answer(respond(call("send_web", { text: "Hello again." })));
  await t.agent.conversation(phoneConversation)!.whenIdle();
  tab.client.close();
  assert.equal(tab.store.size, 0, "a signed-in session is never kept in the browser's storage");

  const session = (token: string) => t.fetch(`${URL_}/v1/web-chat/session`, { method: "POST", body: JSON.stringify({ token }) }).then((r) => r.status);
  assert.equal(await session(webChatSignIn("x".repeat(40), "member-7")), 401, "signed with another secret");
  assert.equal(await session(webChatSignIn(SECRET, "member-7", -10)), 401, "expired");
  assert.equal(await session(webChatSignIn(SECRET, "member-7", 3 * 24 * 3600)), 401, "valid too long");
  const visitor = (await (await t.fetch(`${URL_}/v1/web-chat/session`, { method: "POST", body: "{}" })).json()).session as string;
  assert.equal(await session(visitor), 401, "a session is not a sign-in token");
  const history = await t.fetch(`${URL_}/v1/web-chat/history`, { headers: { authorization: `Bearer ${webChatSignIn(SECRET, "member-7")}` } });
  assert.equal(history.status, 401, "a sign-in token is not a session");
});

test("only the listed sites may embed the chat, with CORS for them", async () => {
  const t = rig({ origins: ["https://shop.example"] });
  const from = (origin: string, method = "POST") => t.fetch(`${URL_}/v1/web-chat/session`, { method, headers: { origin }, ...(method === "POST" ? { body: "{}" } : {}) });
  const allowed = await from("https://shop.example");
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://shop.example");
  const preflight = await from("https://shop.example", "OPTIONS");
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/);
  const other = await from("https://evil.example");
  assert.equal(other.status, 403);
  assert.equal(other.headers.get("access-control-allow-origin"), null);
});

test("after the agent restarts, a browser polling the old mailbox is reset and reads the history from the store", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "flow-web-")), "agent.db");
  const before = rig({ database: sqlite(path) });
  await before.agent.resume();
  const tab = browser(before.fetch as typeof fetch);
  await tab.client.start();
  await tab.client.send("book a table");
  (await before.nextCall(0)).answer(respond(call("send_web", { text: "For when?" })));
  await tab.until(() => tab.agentTexts().includes("For when?"));
  const id = before.events.find((e) => e.type === "message.in")!.conversationId;
  await before.agent.conversation(id)!.whenIdle();
  await before.agent.transcript(id); // waits for its writes to the store
  tab.client.close();

  const after = rig({ database: sqlite(path), dir: before.dir });
  await after.agent.resume();
  // The browser's session and its cursor from before: the new process's mailbox does not know it.
  const session = tab.store.values().next().value!;
  const cursor = [...tab.got].reverse().find((e) => e.type !== "history" && e.cursor)!;
  const polled = await after.fetch(`${URL_}/v1/web-chat/events?after=${encodeURIComponent((cursor as { cursor: string }).cursor)}&wait=0`, { headers: { authorization: `Bearer ${session}` } });
  assert.deepEqual(await polled.json(), { reset: true });
  const history = await (await after.fetch(`${URL_}/v1/web-chat/history`, { headers: { authorization: `Bearer ${session}` } })).json();
  assert.deepEqual(history.messages.map((m: { from: string; text: string }) => [m.from, m.text]), [["person", "book a table"], ["agent", "For when?"]]);
});

test("a visitor past the message limit is refused with 429, and a malformed message with 400", async () => {
  const t = rig({ limits: { messagesPerMinute: 1 } });
  const session = (await (await t.fetch(`${URL_}/v1/web-chat/session`, { method: "POST", body: "{}" })).json()).session as string;
  const post = (body: object) => t.fetch(`${URL_}/v1/web-chat/messages`, { method: "POST", headers: { authorization: `Bearer ${session}` }, body: JSON.stringify(body) });
  assert.equal((await post({ id: "a", text: "one" })).status, 202);
  assert.equal((await post({ id: "b", text: "two" })).status, 429);
  assert.equal((await post({ text: "no id" })).status, 400);
  assert.equal((await post({ id: "c", text: "photo", attachments: [] })).status, 400);
  (await t.nextCall(0)).answer(respond(call("send_web", { text: "One." })));
  await t.agent.conversation(t.events.find((e) => e.type === "message.in")!.conversationId)!.whenIdle();
});
