// covers: simulators/src/server.ts simulators/src/platforms.ts cli/src/run.ts cli/src/commands.ts cli/src/auth.ts cli/src/terminal.ts src/agent.ts src/conversation.ts src/channels.ts src/http.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { mcpServer } from "../../mcp/src/index.ts";
import { createAgent, sqlite, tool, WHATSAPP_CAROUSELS, type ChannelInfo, type ChannelSummary, type Deliver, type Incoming, type Model, type TemplateDefinition } from "../../src/index.ts";
import { WHATSAPP, call, gate, multi, respond } from "../../test/helpers.ts";
import { IMESSAGE, TELEGRAM } from "../../flow-messaging/src/index.ts";
import { simulators, type AgentConnection, type Line } from "../src/index.ts";

/** An agent that answers nothing by itself: the test delivers through the last `deliver` it got. */
function fakeAgent(channels?: ChannelSummary[]) {
  const fake = {
    deliver: null as Deliver | null,
    conversationIds: [] as string[],
    reactions: [] as { conversationId: string; emoji: string; toText: string }[],
    count: 0,
    options: [] as Array<{ channel: ChannelInfo; channelName?: string }>,
    incomings: [] as Incoming[],
  };
  const connection: AgentConnection = {
    receive: (conversationId, incoming, deliver, options) => {
      fake.deliver = deliver;
      fake.incomings.push(incoming);
      fake.conversationIds.push(conversationId);
      fake.options.push(options);
      return `m${++fake.count}`;
    },
    ...(channels ? { channels: () => channels } : {}),
    reacted: (conversationId, emoji, toText) => void fake.reactions.push({ conversationId, emoji, toText }),
    status: () => ({ busy: false, idleForMs: 0, backgroundTasks: 0, conversations: 0 }),
  };
  return { fake, connection };
}

/** The test cloud's simulators: any person, any platform. */
async function start(helpReply?: string, channels?: ChannelSummary[]) {
  const { fake, connection } = fakeAgent(channels);
  const server = await simulators({ sms: { helpReply }, testCloud: true }).listen(connection, 0);
  const post = (path: string, body: unknown) =>
    fetch(server.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const send = async (platform: string, text: string) => assert.equal((await post("/api/messages", { platform, person: "p", text })).status, 202);
  const lines = async (platform: string): Promise<Line[]> => (await (await fetch(`${server.url}/api/transcript?platform=${platform}&person=p`)).json()).lines;
  return { fake, server, post, send, lines };
}

test("SMS: after STOP the carrier answers and blocks the agent; START lets it through; HELP is the configured reply", async () => {
  const { fake, server, send, lines } = await start("Pip: reply STOP to opt out.");
  try {
    await send("sms", "stop");
    const stopped = (await lines("sms")).at(-1);
    assert.ok(stopped?.kind === "out" && stopped.carrier && stopped.text.startsWith("You have successfully been unsubscribed"));
    assert.throws(() => fake.deliver!({ type: "message", text: "Still there?" }), /STOP/);

    await send("sms", "START");
    fake.deliver!({ type: "message", text: "Welcome back" });
    const after = await lines("sms");
    assert.ok(after.some((l) => l.kind === "out" && l.carrier && l.text.startsWith("You have successfully been re-subscribed")));
    const last = after.at(-1);
    assert.ok(last?.kind === "out" && !last.carrier);
    assert.equal(last.text, "Welcome back");

    await send("sms", "HELP");
    const help = (await lines("sms")).at(-1);
    assert.ok(help?.kind === "out" && help.carrier);
    assert.equal(help.text, "Pip: reply STOP to opt out.");
  } finally {
    await server.close();
  }
});

test("a person can react to an agent message on WhatsApp, not on SMS", async () => {
  const { fake, server, post, send } = await start();
  try {
    for (const platform of ["whatsapp", "sms"]) {
      await send(platform, "hi");
      fake.deliver!({ type: "message", text: `hello on ${platform}` });
    }
    const react = (platform: string) => post("/api/reactions", { platform, person: "p", messageId: "a1", emoji: "👍" });
    assert.equal((await react("sms")).status, 400);
    assert.equal(fake.reactions.length, 0);
    assert.equal((await react("whatsapp")).status, 202);
    assert.deepEqual(fake.reactions, [{ conversationId: "whatsapp:p", emoji: "👍", toText: "hello on whatsapp" }]);
  } finally {
    await server.close();
  }
});

test("WhatsApp and web show a link button and a photo the agent sends; SMS offers neither", async () => {
  const { fake, server, send, lines } = await start();
  try {
    const link = { label: "Open in app", url: "https://example.com/l/7" };
    const image = { url: "https://example.com/flat.jpg" };
    for (const platform of ["whatsapp", "web"]) {
      await send(platform, "show me flats");
      assert.ok(fake.options.at(-1)!.channel.linkButton && fake.options.at(-1)!.channel.images);
      await fake.deliver!({ type: "message", text: "2 BHK, Indiranagar", link, image });
      const out = (await lines(platform)).at(-1);
      assert.ok(out?.kind === "out");
      assert.deepEqual([out.link, out.image], [link, image]);
    }
    await send("sms", "show me flats");
    assert.ok(!fake.options.at(-1)!.channel.linkButton && !fake.options.at(-1)!.channel.images);
  } finally {
    await server.close();
  }
});

test("a carousel shows as its text, then each card as a message, in order", async () => {
  const { fake, server, send, lines } = await start();
  try {
    await send("whatsapp", "what rooms?");
    await fake.deliver!({
      type: "carousel",
      text: "Two rooms",
      cards: [
        { image: { url: "https://example.com/sea.jpg" }, text: "Sea view", buttons: ["Book sea"] },
        { image: { fileId: "file_9" }, text: "Garden", buttons: ["Book garden"] },
      ],
    });
    const out = (await lines("whatsapp")).filter((l) => l.kind === "out");
    assert.deepEqual(
      out.map((l) => l.kind === "out" && [l.text, l.image, l.buttons]),
      [["Two rooms", undefined, undefined], ["Sea view", { url: "https://example.com/sea.jpg" }, ["Book sea"]], ["Garden", { fileId: "file_9" }, ["Book garden"]]],
    );
  } finally {
    await server.close();
  }
});

test("a simulator refuses what its platform refuses, with Flow Messaging's error, whoever sent it; a WebP photo shows", async () => {
  const { fake, server, send, lines } = await start();
  try {
    await send("whatsapp", "what rooms?");
    const photo = { url: "https://example.com/garden.webp" };
    await assert.rejects(
      async () => fake.deliver!({ type: "carousel", text: "Two rooms", cards: [{ image: photo, text: "a\nb\nc\nd", buttons: ["Book sea"] }, { image: photo, buttons: ["Book garden"] }] }),
      /content\.cards\[0\]\.text has more than 2 line breaks\. \(invalid_request, content\.cards\[0\]\.text\)/,
    );
    await fake.deliver!({ type: "message", text: "The garden room", image: photo, buttons: ["Book it"] });
    assert.deepEqual(
      (await lines("whatsapp")).filter((l) => l.kind !== "in").map((l) => l.kind === "out" ? [l.kind, l.text, l.image] : [l.kind, l.kind === "undelivered" && l.reason]),
      [["undelivered", "content.cards[0].text has more than 2 line breaks. (invalid_request, content.cards[0].text)"], ["out", "The garden room", photo]],
    );
  } finally {
    await server.close();
  }
});

test("the web simulator plays the agent's own custom UI, and shows the params it sent", async () => {
  const app: ChannelSummary = { name: "app", kind: "custom", info: { reactions: false, status: true, formatting: "markdown" } };
  const { fake, server, send, lines } = await start(undefined, [app]);
  try {
    await send("web", "show my progress");
    assert.deepEqual(fake.options.at(-1), { channel: app.info, channelName: "app" });
    await fake.deliver!({ type: "message", text: "Here it is.", fields: { app_link: { url: "https://app.example/progress", screen: "progress" } } });
    const out = (await lines("web")).at(-1);
    assert.ok(out?.kind === "out");
    assert.deepEqual(out.fields, { app_link: { url: "https://app.example/progress", screen: "progress" } });

    await send("sms", "hi");
    assert.equal(fake.options.at(-1)!.channelName, undefined, "SMS is not one of this agent's channels: the platform's own rules");
  } finally {
    await server.close();
  }
});

const SAM = { name: "Sam", phone: "+15555550101" };

// Existing tests cover operator access and declared people, but never a person's real sign-in.
test("visitors chat signed out, join verified account history after login, and isolate browser/channel identities", async () => {
  const h = multi({ channels: { whatsapp: { info: WHATSAPP, phone: true }, web: { info: WHATSAPP } }, testPeople: [SAM], resolve: ({ phone }) => phone === SAM.phone ? "account-1" : null, database: sqlite() });
  await h.agent.resume();
  const signedIn = new Map<string, string>();
  const seen: string[] = [];
  const play = simulators({ authentication: async ({ channel, visitor }) => {
    seen.push(visitor);
    return { key: signedIn.get(visitor), label: `Account on ${channel.name}`, signInUrl: "https://login.example/sign-in" };
  } });
  const server = await play.listen(h.agent, 0);
  const query = "?person=visitor&channel=web";
  const api = (path: string, cookie = "", method = "GET", body: object = {}) => fetch(`${server.url}/api/${path}${query}`, {
    method, headers: { cookie, "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  try {
    const status = await api("auth");
    assert.equal((await status.json()).signedIn, false);
    const cookie = status.headers.get("set-cookie")!.split(";")[0];
    assert.match(status.headers.get("set-cookie")!, /HttpOnly; SameSite=Lax/);
    const visitor = seen.at(-1)!;
    assert.deepEqual((await (await api("transcript", cookie)).json()).lines, [], "signed-out history contains no account data");
    assert.equal((await api("messages", cookie, "POST", { text: "hello", signedIn: true, key: "account-1", visitor })).status, 202);
    (await h.nextCall(0)).answer(respond(call("send_web", { text: "Hello" })));
    const anonymous = (await h.agent.visitorConversation(null, { channel: "web", address: visitor }))!;
    await h.agent.conversation(anonymous)!.whenIdle();
    assert.equal(await h.agent.visitorConversation("account-1"), null, "body claims cannot authenticate the visitor");
    signedIn.set(visitor, "account-1"); // Verified OAuth callback supplied the real account identity.
    assert.equal((await (await api("auth", cookie)).json()).signedIn, true);
    assert.equal((await api("transcript", cookie)).status, 200);
    assert.deepEqual((await (await api("transcript")).json()).lines, [], "another browser has no account history");
    assert.equal((await (await fetch(`${server.url}/api/auth?person=visitor&channel=whatsapp`, { headers: { cookie } })).json()).signedIn, false, "another channel needs its own connection");
    assert.equal((await api("messages", cookie, "POST", { text: "a latte" })).status, 202);
    (await h.nextCall(1)).answer(respond(call("send_web", { text: "Hello again" })));
    const id = (await h.agent.visitorConversation("account-1"))!;
    assert.equal(id, await h.agent.testConversation(SAM.phone), "OAuth and a verified phone reach the same account conversation");
    await h.agent.conversation(id)!.whenIdle();
    assert.equal(h.out.length, 0, "visitor replies never call a real channel provider");
    const history = await (await api("transcript", cookie)).json();
    assert.ok(history.lines.some((line: Line) => line.kind === "out" && line.text === "Hello again"));
    const reset = await api("auth/reset", cookie, "POST");
    assert.equal((await reset.json()).signedIn, false);
    const freshCookie = reset.headers.get("set-cookie")!.split(";")[0];
    assert.notEqual(freshCookie, cookie);
    assert.deepEqual((await (await api("transcript", freshCookie)).json()).lines, []);
    assert.ok((await h.agent.transcript(id)).length, "starting signed out keeps account history");
    assert.equal((await fetch(`${server.url}/api/transcript?person=${encodeURIComponent(SAM.phone)}&channel=web`)).status, 200, "existing declared people stay unchanged");
    const fresh = seen.at(-1)!;
    signedIn.set(fresh, "account-2");
    assert.deepEqual((await (await api("transcript", freshCookie)).json()).lines, [], "a different login cannot inherit the previous account's history");
    // Auth/reset deliberately preserves history; it cannot protect the separate Clear history action.
    assert.equal((await api("messages", freshCookie, "POST", { text: "a different account" })).status, 202);
    (await h.nextCall(2)).answer(respond(call("send_web", { text: "Other account" })));
    const other = (await h.agent.visitorConversation("account-2"))!;
    await h.agent.conversation(other)!.whenIdle();
    assert.equal((await api("clear", cookie, "POST", { key: "account-2" })).status, 200);
    assert.deepEqual((await (await api("transcript", cookie)).json()).lines, [], "Clear history resets the selected signed-in account");
    assert.equal((await (await api("auth", cookie)).json()).signedIn, true, "clearing history keeps its OAuth connection");
    assert.ok((await h.agent.transcript(other)).length, "another account's history is not cleared");
    signedIn.delete(visitor);
    assert.ok((await (await api("transcript", cookie)).json()).lines.length, "this browser's anonymous history is separate");
    assert.equal((await api("clear", cookie, "POST")).status, 200);
    assert.deepEqual((await (await api("transcript", cookie)).json()).lines, [], "Clear history also works while signed out");
    assert.ok((await h.agent.transcript(other)).length);
  } finally { await server.close(); }
});

/** Pip-like agent with one WhatsApp channel and Sam as its test person, on `database`. */
function agentOn(database: ReturnType<typeof sqlite>, dir?: string) {
  return multi({ channels: { whatsapp: { info: WHATSAPP, phone: true } }, testPeople: [SAM], database, dir });
}

test("a deployed playground lets in only its token, from its own pages, then only the agent's test people", async () => {
  const h = agentOn(sqlite());
  const play = simulators();
  assert.throws(() => play.handler(h.agent, { token: undefined as unknown as string }), /token/);
  assert.throws(() => play.handler(h.agent, { token: "too-short" }), /32 characters/);
  const token = "t".repeat(40);
  const server = createServer(play.handler(h.agent, { token, base: "/play" }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/play`;
  try {
    assert.equal((await fetch(`${url}/`)).status, 401);
    assert.equal((await fetch(`${url}/api/platforms`, { headers: { authorization: "Bearer wrong" } })).status, 401);

    const opened = await fetch(`${url}/?token=${token}&channel=whatsapp`, { redirect: "manual" });
    assert.equal(opened.status, 303);
    assert.equal(opened.headers.get("location"), "/play/?channel=whatsapp", "the token leaves the URL");
    const cookie = opened.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/, "the browser sends access on a top-level return from sign-in");
    assert.doesNotMatch(cookie, new RegExp(token), "the cookie does not hold the token");
    const returned = await fetch(`${url}/`, { headers: { cookie: cookie.split(";")[0], "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } });
    assert.equal(returned.status, 200, "sign-in can return to the page from another site");
    assert.match(returned.headers.get("set-cookie")!, /SameSite=Lax/, "page visits renew older Strict cookies before the next sign-in");
    const browser = { cookie: cookie.split(";")[0], "sec-fetch-site": "cross-site" };
    assert.equal((await raw(`${url}/api/platforms`, { headers: browser })).status, 403, "another site's API reads stay refused even with a cookie");
    assert.equal((await raw(`${url}/api/messages`, { method: "POST", headers: { ...browser, "content-type": "application/json" }, body: JSON.stringify({ channel: "whatsapp", person: SAM.phone, text: "hi" }) })).status, 403, "another site's API writes stay refused even with a cookie");
    assert.equal((await fetch(`${url}/api/platforms`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
    const deployed = { host: "agent.example.com", authorization: `Bearer ${token}` };
    assert.equal((await raw(`${url}/api/platforms`, { headers: { ...deployed, "sec-fetch-site": "same-origin" } })).status, 200, "deployed, the Host is the agent's own");
    const crossSite = await raw(`${url}/api/messages`, { method: "POST", headers: { ...deployed, "sec-fetch-site": "cross-site", "content-type": "application/json" }, body: JSON.stringify({ channel: "whatsapp", person: SAM.phone, text: "hi" }) });
    assert.equal(crossSite.status, 403);

    const stranger = await fetch(`${url}/api/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: "whatsapp", person: "+15555550199", text: "hi" }),
    });
    assert.equal(stranger.status, 403);
    assert.equal(h.calls.length, 0);

    for (let i = 0; i < 9; i++) await fetch(`${url}/api/status`, { headers: { authorization: "Bearer wrong" } });
    assert.equal((await fetch(`${url}/api/status`, { headers: { authorization: `Bearer ${token}` } })).status, 429, "too many wrong tokens: even the right one waits");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// Browsers share cookies between localhost ports; the single-server gate test cannot catch collisions.
test("independent local playgrounds keep separate operator cookies", async () => {
  const h = agentOn(sqlite());
  const tokens = ["a".repeat(40), "b".repeat(40)];
  const servers = tokens.map((token) => createServer(simulators().handler(h.agent, { token, base: "/play" })));
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))));
  const urls = servers.map((server) => `http://127.0.0.1:${(server.address() as { port: number }).port}/play`);
  try {
    const cookies = await Promise.all(urls.map(async (url, i) => (await fetch(`${url}/?token=${tokens[i]}`, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]));
    assert.notEqual(cookies[0].split("=")[0], cookies[1].split("=")[0]);
    for (const url of urls) assert.equal((await fetch(`${url}/api/platforms`, { headers: { cookie: cookies.join("; ") } })).status, 200);
    assert.equal((await fetch(`${urls[0]}/api/platforms`, { headers: { cookie: cookies[1] } })).status, 401);
  } finally { await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); }
});

test("a file sent from a simulator reaches the agent with its bytes, the message box as its caption", async () => {
  const { fake, server, post, lines } = await start();
  try {
    const bytes = new Uint8Array(50_000).fill(7);
    const sent = await post("/api/messages", { platform: "whatsapp", person: "p", text: "", attachments: [{ kind: "document", mime: "application/pdf", name: "invoice.pdf", data: Buffer.from(bytes).toString("base64") }] });
    assert.equal(sent.status, 202);
    const [file] = fake.incomings[0].attachments ?? [];
    assert.deepEqual({ text: fake.incomings[0].text, kind: file.kind, mime: file.mime, name: file.name }, { text: "", kind: "document", mime: "application/pdf", name: "invoice.pdf" });
    assert.deepEqual(await file.data(), bytes);
    const [line] = await lines("whatsapp");
    assert.ok(line.kind === "in" && line.attachments);
    const [shown] = line.attachments;
    assert.deepEqual({ ...shown, url: undefined }, { kind: "document", name: "invoice.pdf", mime: "application/pdf", size: 50_000, url: undefined });
    // The simulator shows it again from its url: a document only ever as a download, never as a page of the playground.
    const again = await fetch(server.url + shown.url);
    assert.equal(again.headers.get("content-type"), "application/octet-stream");
    assert.match(again.headers.get("content-disposition") ?? "", /^attachment; filename\*=UTF-8''invoice\.pdf$/);
    assert.deepEqual(new Uint8Array(await again.arrayBuffer()), bytes);
  } finally {
    await server.close();
  }
});

test("the playground shows the person's conversation from the agent's store, also after a restart", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "flow-play-")), "flow.db");
  const first = agentOn(sqlite(path));
  await first.agent.resume();
  const play = simulators();
  const server = await play.listen(first.agent, 0);
  const send = await fetch(`${server.url}/api/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "whatsapp", person: SAM.phone, text: "a latte please" }),
  });
  assert.equal(send.status, 202);
  // This WhatsApp has no link button: the link's URL went after the text, and shows so again after a restart.
  const menu = { label: "Menu", url: "https://example.com/menu" };
  (await first.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Which size?", buttons: ["Small", "Large"] }), call("send_whatsapp", { text: "Our menu", link: menu })));
  const id = (await first.agent.testConversation(SAM.phone))!;
  await first.agent.conversation(id)!.whenIdle();
  await server.close();

  const again = agentOn(sqlite(path), first.dir);
  await again.agent.resume();
  const restarted = await simulators().listen(again.agent, 0);
  try {
    const { lines } = (await (await fetch(`${restarted.url}/api/transcript?channel=whatsapp&person=${encodeURIComponent(SAM.phone)}`)).json()) as { lines: Line[] };
    const said = lines.flatMap((l) => (l.kind === "in" || l.kind === "out" ? [[l.kind, l.text, l.kind === "out" ? l.buttons : undefined]] : []));
    assert.deepEqual(said, [["in", "a latte please", undefined], ["out", "Which size?", ["Small", "Large"]], ["out", "Our menu\nhttps://example.com/menu", undefined]]);
  } finally {
    await restarted.close();
  }
});

test("a carousel shows as one message to swipe through; a tap on card 2's button, labelled like card 1's, reaches the agent with card 2's id", async () => {
  const h = multi({ channels: { whatsapp: { info: { ...WHATSAPP, carousels: WHATSAPP_CAROUSELS }, phone: true } }, testPeople: [SAM] });
  const server = await simulators().listen(h.agent, 0);
  const post = (body: unknown) => fetch(`${server.url}/api/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "whatsapp", person: SAM.phone, ...(body as object) }) });
  try {
    assert.equal((await post({ text: "any flats?" })).status, 202);
    const card = (id: string) => ({ image: { url: `https://example.com/${id}.jpg` }, text: `Listing ${id}`, buttons: [{ id: `details:${id}`, label: "Details" }] });
    (await h.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Two listings", carousel: [card("a"), card("b")] })));
    const id = (await h.agent.testConversation(SAM.phone))!;
    await h.agent.conversation(id)!.whenIdle();
    const { lines } = (await (await fetch(`${server.url}/api/transcript?channel=whatsapp&person=${encodeURIComponent(SAM.phone)}`)).json()) as { lines: Line[] };
    const shown = lines.filter((l) => l.kind === "out");
    assert.equal(shown.length, 1, "one message, not one per card");
    const carousel = shown[0];
    assert.ok(carousel.kind === "out" && carousel.text === "Two listings" && carousel.carousel?.length === 2);
    assert.deepEqual(carousel.carousel[1].buttons, [{ id: "details:b", label: "Details" }], "the page gets the label to show and the id to send back");
    // What the page sends on a tap of card 2's button.
    const tapped = carousel.carousel[1].buttons![0] as { id: string; label: string };
    assert.equal((await post({ text: tapped.label, choice: { id: tapped.id, title: tapped.label }, replyTo: carousel.id })).status, 202);
    const next = await h.nextCall(1);
    assert.match(String(next.request.messages.at(-1)?.content), /tapped\] Details \(details:b\)$/);
    assert.deepEqual(h.events.filter((e) => e.type === "message.in").at(-1)?.choice, { id: "details:b", title: "Details" });
    next.answer(respond(call("send_whatsapp", { text: "Listing b: two rooms." })));
    await h.agent.conversation(id)!.whenIdle();
    const tap = (await h.agent.transcript(id)).find((e) => e.kind === "in" && e.choice);
    assert.ok(tap?.kind === "in" && tap.choiceId === "details:b", "the transcript keeps which button it was");
  } finally {
    await server.close();
  }
});

/** One request with headers fetch would not let a test set (Host), → status and body. */
function raw(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method ?? "GET", headers: options.headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

test("the local playground runs turns only for its own page: another site and a rebound DNS name are refused", async () => {
  const h = agentOn(sqlite());
  await h.agent.resume();
  const server = await simulators().listen(h.agent, 0);
  const own = new URL(server.url).host;
  const where = `channel=whatsapp&person=${encodeURIComponent(SAM.phone)}`;
  const message = JSON.stringify({ channel: "whatsapp", person: SAM.phone, text: "a latte please" });
  const post = (headers: Record<string, string>) => raw(`${server.url}/api/messages`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: message });
  try {
    assert.equal((await post({ "sec-fetch-site": "cross-site", origin: "https://evil.example" })).status, 403);
    assert.equal((await post({ "sec-fetch-site": "same-site", origin: "http://localhost:3000" })).status, 403, "another port on this machine is another origin");
    assert.equal((await post({ origin: "https://evil.example" })).status, 403, "an older browser: the Origin alone");
    assert.equal((await raw(`${server.url}/api/poll?${where}&after=0`, { headers: { "sec-fetch-site": "cross-site" } })).status, 403, "nor can it read the conversation");
    assert.equal((await post({ host: `evil.example:${new URL(server.url).port}`, "sec-fetch-site": "same-origin" })).status, 403, "a DNS name rebound to 127.0.0.1");
    assert.equal((await raw(`${server.url}/`, { headers: { host: "evil.example" } })).status, 403);
    assert.equal(h.calls.length, 0);

    const { seq } = JSON.parse((await raw(`${server.url}/api/transcript?${where}`, { headers: { "sec-fetch-site": "same-origin" } })).body);
    assert.equal((await post({ "sec-fetch-site": "same-origin", origin: server.url })).status, 202);
    (await h.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Which size?" })));
    await h.agent.conversation((await h.agent.testConversation(SAM.phone))!)!.whenIdle();
    const polled = await raw(`${server.url}/api/poll?${where}&after=${seq}`, { headers: { host: own.replace("127.0.0.1", "localhost"), "sec-fetch-site": "same-origin" } });
    assert.equal(polled.status, 200, "the polling fallback, also on localhost");
    assert.ok((JSON.parse(polled.body).events as Array<{ line?: Line }>).some((e) => e.line?.kind === "out" && e.line.text === "Which size?"));
  } finally {
    await server.close();
  }
});

test("a page the live stream can't reach gets the same events by polling, each once and in order", async () => {
  const h = agentOn(sqlite());
  await h.agent.resume();
  const token = "t".repeat(40);
  const server = createServer(simulators().handler(h.agent, { token, base: "/play" }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/play`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const where = `channel=whatsapp&person=${encodeURIComponent(SAM.phone)}`;
  type Event = { type: string; seq: number; line?: Line };
  type Polled = { seq: number; events: Event[] };
  const get = async (path: string, after?: number) => (await fetch(`${url}${path}?${where}${after === undefined ? "" : `&after=${after}`}`, { headers })).json();
  const send = async (text: string) =>
    assert.equal((await fetch(`${url}/api/messages`, { method: "POST", headers, body: JSON.stringify({ channel: "whatsapp", person: SAM.phone, text }) })).status, 202);
  const said = (events: Event[]) => events.flatMap((e) => (e.line && (e.line.kind === "in" || e.line.kind === "out") ? [e.line.text] : []));
  const idle = async () => h.agent.conversation((await h.agent.testConversation(SAM.phone))!)!.whenIdle();
  try {
    const { seq: start } = await get("/api/transcript");
    await send("a latte please");
    (await h.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Which size?" })));
    await idle();

    const first = (await get("/api/poll", start)) as Polled;
    assert.deepEqual(said(first.events), ["a latte please", "Which size?"]);

    // Nothing newer yet: this poll waits, and answers with the next message only.
    const waiting = get("/api/poll", first.seq);
    await send("large");
    const second = (await waiting) as Polled;
    assert.deepEqual(said(second.events), ["large"]);
    assert.ok(second.events.every((e) => e.seq > first.seq));

    (await h.nextCall(1)).answer(respond(call("send_whatsapp", { text: "Coming up" })));
    await idle();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("WhatsApp shows a declared template as WhatsApp would, and one not declared by its name and values, also after a reload", async () => {
  const ready: TemplateDefinition = {
    name: "order_ready",
    language: "en",
    category: "utility",
    header: { kind: "text", text: "Order {{1}}" },
    body: "Hi {{1}}, your {{2}} is ready.",
    footer: "Reply STOP to opt out",
    buttons: [{ type: "quick_reply", text: "On my way" }, { type: "url", text: "Track", url: "https://example.com/o/{{1}}" }, { type: "phone", text: "Call us", phone: "+15555550100" }],
  };
  const h = multi({ channels: { whatsapp: { info: WHATSAPP, phone: true, kind: "whatsapp" } }, testPeople: [SAM], database: sqlite(), templates: [ready] });
  await h.agent.resume();
  const server = await simulators().listen(h.agent, 0);
  const where = `channel=whatsapp&person=${encodeURIComponent(SAM.phone)}`;
  const transcript = async () => (await (await fetch(`${server.url}/api/transcript?${where}`)).json()) as { seq: number; lines: Line[] };
  try {
    await fetch(`${server.url}/api/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "whatsapp", person: SAM.phone, text: "hi" }) });
    (await h.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Hi Sam!" })));
    await h.agent.conversation((await h.agent.testConversation(SAM.phone))!)!.whenIdle();
    const { seq } = await transcript();

    const to = { channel: "whatsapp", address: SAM.phone };
    await h.agent.nudge({ to, template: { name: "order_ready", header: { kind: "text", text: "1042" }, body: ["Sam", "latte"], buttons: [{ index: 0, value: "omw_1042" }, { index: 1, value: "1042" }] } });
    await h.agent.nudge({ to, template: { name: "loyalty", body: ["Sam", "120"] } });
    const polled = (await (await fetch(`${server.url}/api/poll?${where}&after=${seq}`)).json()) as { events: Array<{ line?: Line }> };
    const [declared, other] = polled.events.flatMap((e) => (e.line?.kind === "out" ? [e.line] : []));
    assert.deepEqual([declared.text, declared.template], [
      "Hi Sam, your latte is ready.",
      {
        name: "order_ready",
        header: { kind: "text", text: "Order 1042" },
        footer: "Reply STOP to opt out",
        buttons: [{ type: "quick_reply", text: "On my way", payload: "omw_1042" }, { type: "url", text: "Track", url: "https://example.com/o/1042" }, { type: "phone", text: "Call us", phone: "+15555550100" }],
      },
    ]);
    assert.deepEqual([other.text, other.template], ["Sam\n120", { name: "loyalty" }]);

    // From the store, after a reload: the body as it read, the rest as declared.
    const reloaded = (await transcript()).lines.flatMap((l) => (l.kind === "out" && l.template ? [[l.text, l.template.name, l.template.footer]] : []));
    assert.deepEqual(reloaded, [["Hi Sam, your latte is ready.", "order_ready", "Reply STOP to opt out"], ["", "loyalty", undefined]]);
  } finally {
    await server.close();
  }
});

test("a turn's model error is printed on the terminal and reaches the playground's trace with its text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const play = simulators();
  // The model fails only once the message is taken, so the playground knows whose conversation it is.
  const asked = gate();
  const model: Model = { complete: async () => { await asked.promise; throw new Error("401 Incorrect API key"); } };
  const channels = [{ name: "whatsapp", kind: "custom" as const, info: WHATSAPP, phone: true, send: () => {} }];
  const agent = createAgent({ dir, model, debounceMs: 0, events: [play.events], channels, database: sqlite(), testPeople: [SAM], scheduleCheckMs: 0 });
  await agent.resume();
  const printed = gate<string>();
  const error = console.error;
  console.error = (...args: unknown[]) => { if (String(args[0]).includes("model error")) printed.open(args.map(String).join(" ")); };
  const server = await play.listen(agent, 0);
  const where = `channel=whatsapp&person=${encodeURIComponent(SAM.phone)}`;
  try {
    const { seq } = await (await fetch(`${server.url}/api/transcript?${where}`)).json();
    const sent = await fetch(`${server.url}/api/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "whatsapp", person: SAM.phone, text: "hi" }) });
    assert.equal(sent.status, 202);
    asked.open();
    assert.equal(await printed.promise, "flow: model error (Sam): Error: 401 Incorrect API key");
    await agent.conversation((await agent.testConversation(SAM.phone))!)!.whenIdle();
    const polled = (await (await fetch(`${server.url}/api/poll?${where}&after=${seq}`)).json()) as { events: Array<{ type: string; event?: { type: string; error?: string } }> };
    const traced = polled.events.flatMap((e) => (e.type === "trace" && e.event?.type === "model.error" ? [e.event.error] : []));
    assert.deepEqual(traced, ["Error: 401 Incorrect API key"]);
  } finally {
    console.error = error;
    await server.close();
  }
});


// Channel simulators do not exercise argv, interactive CLI input, OAuth files or local-only access.
test("the local runner uses the real CLI with isolated browser sign-in, prompts and chat", async (t) => {
  let origin = "", writes = 0;
  const chatRequests: any[] = [];
  let mcp: ReturnType<typeof mcpServer>;
  const backend = createServer(async (req, res) => {
    const url = new URL(req.url!, origin);
    const json = (value: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (url.pathname === "/.well-known/oauth-authorization-server") return json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    if (["/register", "/token", "/agent/terminal"].includes(url.pathname)) {
      let text = ""; for await (const chunk of req) text += chunk;
      if (url.pathname === "/register") return json({ ...JSON.parse(text), client_id: "local-cli" }, 201);
      if (url.pathname === "/token") return json({ access_token: "local-cli-token", token_type: "Bearer", expires_in: 3600 });
      assert.equal(req.headers.authorization, "Bearer local-cli-token");
      const input = JSON.parse(text); chatRequests.push(input);
      return json({ conversationId: "own-chat", replies: [{ type: "message", text: `Reply: ${input.text}` }] });
    }
    if (url.pathname === "/authorize") {
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", "test-code"); back.searchParams.set("state", url.searchParams.get("state")!); back.searchParams.set("iss", origin);
      return res.writeHead(302, { location: back.href }).end();
    }
    await mcp.node(req, res);
  });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;
  mcp = mcpServer({ name: "runner", version: "1", auth: { issuer: origin, verify: token => token === "local-cli-token" ? { key: "account-1" } : null }, tools: [
    tool({ name: "echo", description: "Echo literal input", input: z.object({ text: z.string() }), hints: { readOnly: true }, run: (input, ctx) => ({ ...input, key: ctx.key }) }),
    tool({ name: "change", description: "A test write", input: z.object({}), run: () => ({ writes: ++writes }) }),
  ] });
  const h = multi({ channels: { terminal: { info: WHATSAPP } }, testPeople: [SAM] });
  const server = await simulators().listen(h.agent, 0, { localCli: { channel: "terminal", config: { name: "runner", server: `${origin}/mcp` } } });
  const api = (cookie: string, path: string, body?: object) => fetch(`${server.url}/api/cli${path}`, { method: body ? "POST" : "GET", headers: { cookie, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const until = async (cookie: string, predicate: (state: any) => boolean) => {
    for (;;) { t.signal.throwIfAborted(); const state = await (await api(cookie, "")).json(); if (predicate(state)) return state; }
  };
  const run = async (cookie: string, text: string) => {
    const before = await (await api(cookie, "")).json();
    assert.equal((await api(cookie, "/input", { text })).status, 202);
    const state = await until(cookie, s => !s.running && s.seq > before.seq);
    return state.events.filter((e: any) => e.seq > before.seq);
  };
  const output = (events: any[]) => events.filter(e => e.stream === "stdout" || e.stream === "stderr").map(e => e.text).join("");
  const hostToken = process.env.RUNNER_TOKEN;
  process.env.RUNNER_TOKEN = "inherited-token-must-not-be-used";
  try {
    assert.deepEqual((await (await fetch(`${server.url}/api/platforms`)).json()).localCli, { channel: "terminal", name: "runner" });
    const first = (await api("", "")).headers.get("set-cookie")!.split(";")[0];
    const second = (await api("", "")).headers.get("set-cookie")!.split(";")[0];
    assert.notEqual(first, second);
    assert.match(output(await run(first, "runner --help")), /USAGE/);
    assert.match(output(await run(first, "auth status")), /not signed in/);
    assert.equal((await run(first, "echo --text hello")).at(-1).text, "3");
    assert.equal((await api(first, "/input", { text: "echo --text 'unfinished" })).status, 400);
    assert.equal((await api(first, "/input", { text: "--server https://other.example echo" })).status, 400);
    assert.equal((await api(first, "/input", { text: "auth login" })).status, 202);
    const login = await until(first, s => s.events.some((e: any) => e.stream === "login"));
    await fetch(login.events.find((e: any) => e.stream === "login").text);
    await until(first, s => !s.running);
    assert.match(output(await run(first, 'echo --text "hello world; $(never-a-shell)" --json')), /hello world; \$\(never-a-shell\)/);
    assert.match(output(await run(second, "auth status")), /not signed in/, "another browser never inherits credentials");
    assert.equal((await run(second, "echo --text nope")).at(-1).text, "3");
    assert.equal((await api(first, "/input", { text: "change" })).status, 202);
    await until(first, s => s.waiting);
    assert.equal(writes, 0);
    assert.equal((await api(first, "/input", { text: "n" })).status, 202);
    await until(first, s => !s.running);
    assert.equal(writes, 0, "the actual CliIO.confirm receives the browser's answer");
    assert.equal((await api(first, "/input", { text: "chat" })).status, 202);
    await until(first, s => s.waiting);
    assert.equal((await api(first, "/input", { text: "hello" })).status, 202);
    await until(first, s => s.waiting && output(s.events).includes("Reply: hello"));
    assert.equal((await api(first, "/input", { text: "again" })).status, 202);
    await until(first, s => s.waiting && output(s.events).includes("Reply: again"));
    assert.deepEqual(chatRequests, [{ text: "hello" }, { text: "again", conversationId: "own-chat" }]);
    assert.ok((await (await api(first, "?after=0")).json()).waiting, "reload reconnects to the same CLI");
    const reset = await api(first, "/reset", {});
    const fresh = reset.headers.get("set-cookie")!.split(";")[0];
    assert.match(output(await run(fresh, "auth status")), /not signed in/, "reset cancels chat and discards credentials");
    const discarded = await api(first, "");
    assert.ok(discarded.headers.get("set-cookie"), "the old cookie receives a fresh isolated session");
    assert.deepEqual((await discarded.json()).events, []);
    assert.equal((await api(fresh, "/input", { text: "auth login" })).status, 202);
    const pending = await until(fresh, s => s.events.some((e: any) => e.stream === "login"));
    const callback = new URL(pending.events.find((e: any) => e.stream === "login").text).searchParams.get("redirect_uri")!;
    await api(fresh, "/reset", {});
    await assert.rejects(fetch(callback), "ending a pending sign-in closes its callback listener");
    assert.equal((await raw(`${server.url}/api/cli`, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await raw(`${server.url}/api/cli`, { headers: { "x-forwarded-for": "203.0.113.1" } })).status, 403);
  } finally {
    if (hostToken === undefined) delete process.env.RUNNER_TOKEN; else process.env.RUNNER_TOKEN = hostToken;
    await server.close();
    await new Promise<void>(resolve => backend.close(() => resolve()));
  }
});

test("ordinary and hosted playgrounds expose no local CLI runner", async () => {
  const h = multi({ channels: { terminal: { info: WHATSAPP } }, testPeople: [SAM] });
  const ordinary = await simulators().listen(h.agent, 0);
  const token = "local-runner-test-operator-token-00000000";
  const hosted = createServer(simulators().handler(h.agent, { token, localCli: { channel: "terminal", config: { name: "runner" } } }));
  await new Promise<void>(resolve => hosted.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(hosted.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(`${ordinary.url}/api/cli`)).status, 404);
    assert.equal((await (await fetch(`${ordinary.url}/api/platforms`)).json()).localCli, undefined);
    const headers = { host: "hosted.example.com", authorization: `Bearer ${token}`, "sec-fetch-site": "same-origin" };
    assert.equal((await raw(`${url}/api/cli`, { headers })).status, 403);
    assert.equal(JSON.parse((await raw(`${url}/api/platforms`, { headers })).body).localCli, undefined);
    assert.equal((await fetch(`${url}/api/cli`)).status, 401, "loopback still requires operator access");
  } finally {
    await ordinary.close();
    await new Promise<void>(resolve => hosted.close(() => resolve()));
  }
});

test("a business run: the agent's sends reach a person's thread before they have written", async () => {
  const { connection } = fakeAgent();
  const sims = simulators({ testCloud: true });
  const server = await sims.listen(connection, 0);
  try {
    await sims.deliverer("whatsapp", "p")({ type: "template", name: "outbid", body: ["PS5"] });
    const lines: Line[] = (await (await fetch(`${server.url}/api/transcript?platform=whatsapp&person=p`)).json()).lines;
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.kind, "out");
  } finally {
    await server.close();
  }
});

test("Telegram and iMessage channels (custom ones, as Flow Messaging's are) play in their own simulators; a tap on an inline button arrives as Telegram's callback query", async () => {
  const h = multi({ channels: { telegram: { info: TELEGRAM }, imessage: { info: IMESSAGE } }, testPeople: [SAM] });
  const server = await simulators().listen(h.agent, 0);
  const post = (body: unknown) => fetch(`${server.url}/api/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "telegram", person: SAM.phone, ...(body as object) }) });
  try {
    const { channels } = (await (await fetch(`${server.url}/api/platforms`)).json()) as { channels: Array<{ name: string; platform: { id: string; buttons?: unknown } }> };
    assert.deepEqual(channels.map((c) => [c.name, c.platform.id]), [["telegram", "telegram"], ["imessage", "imessage"]]);
    assert.deepEqual(channels[0].platform.buttons, TELEGRAM.buttons);

    assert.equal((await post({ text: "hot or iced?" })).status, 202);
    (await h.nextCall(0)).answer(respond(call("send_telegram", { text: "Which one?", buttons: [{ id: "hot", label: "Hot" }, { id: "iced", label: "Iced" }] })));
    const id = (await h.agent.testConversation(SAM.phone))!;
    await h.agent.conversation(id)!.whenIdle();
    const transcript = async () => ((await (await fetch(`${server.url}/api/transcript?channel=telegram&person=${encodeURIComponent(SAM.phone)}`)).json()) as { lines: Line[] }).lines;
    const asked = (await transcript()).find((l) => l.kind === "out");
    assert.ok(asked?.kind === "out" && asked.api);
    assert.equal(asked.api.api, "POST https://api.telegram.org/bot<token>/sendMessage");
    assert.deepEqual((asked.api.body as { reply_markup: unknown }).reply_markup, { inline_keyboard: [[{ text: "Hot", callback_data: "hot" }], [{ text: "Iced", callback_data: "iced" }]] });

    assert.equal((await post({ text: "Iced", choice: { id: "iced", title: "Iced" }, replyTo: asked.id })).status, 202);
    (await h.nextCall(1)).answer(respond(call("send_telegram", { text: "Iced it is." })));
    await h.agent.conversation(id)!.whenIdle();
    const tap = (await transcript()).find((l) => l.kind === "in" && l.choice);
    assert.ok(tap?.kind === "in" && tap.api);
    const update = tap.api.body as { callback_query?: { data: string; message: { text: string } } };
    assert.equal(update.callback_query?.data, "iced");
    assert.equal(update.callback_query?.message.text, "Which one?");
  } finally {
    await server.close();
  }
});

test("each message carries what the platform's API carried: WhatsApp's Graph request and webhook, an SMS provider's fields", async () => {
  const { fake, server, post, send, lines } = await start();
  try {
    await send("whatsapp", "a table for two?");
    fake.deliver!({ type: "message", text: "Which time?", replyTo: "m1", buttons: [{ id: "t7", label: "7 pm" }, "8 pm"] });
    const asked = (await lines("whatsapp")).at(-1);
    assert.ok(asked?.kind === "out" && asked.api);
    assert.equal(asked.api.api, "POST https://graph.facebook.com/v21.0/PHONE_NUMBER_ID/messages");
    const request = asked.api.body as { context: { message_id: string }; interactive: { type: string; action: { buttons: unknown[] } } };
    assert.equal(request.interactive.type, "button");
    assert.deepEqual(request.interactive.action.buttons, [{ type: "reply", reply: { id: "t7", title: "7 pm" } }, { type: "reply", reply: { id: "8 pm", title: "8 pm" } }]);

    assert.equal((await post("/api/messages", { platform: "whatsapp", person: "p", text: "7 pm", choice: { id: "t7", title: "7 pm" }, replyTo: asked.id })).status, 202);
    const tap = (await lines("whatsapp")).at(-1);
    assert.ok(tap?.kind === "in" && tap.api);
    const [message] = (tap.api.body as { entry: Array<{ changes: Array<{ value: { messages: Array<{ type: string; context: { id: string }; interactive: unknown }> } }> }> }).entry[0].changes[0].value.messages;
    assert.equal(message.type, "interactive");
    assert.deepEqual(message.interactive, { type: "button_reply", button_reply: { id: "t7", title: "7 pm" } });
    assert.ok(message.context.id.startsWith("wamid."), "the tap names the message its button was on");

    await send("sms", "hello");
    const text = (await lines("sms")).at(-1);
    assert.ok(text?.kind === "in" && text.api);
    assert.deepEqual({ Body: (text.api.body as { Body: string }).Body, NumSegments: (text.api.body as { NumSegments: string }).NumSegments }, { Body: "hello", NumSegments: "1" });
  } finally {
    await server.close();
  }
});
