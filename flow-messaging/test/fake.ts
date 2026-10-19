// A fake Flow Messaging for the tests: answers the calls the channels make as the spec shapes them
// (files by their bytes),
// records every request, and signs events the way Flow does before posting them to a webhook. Its
// /v1/stream is a minimal WebSocket server (text and close frames) the tests drive frame by frame.

import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, type Database, type FlowEvent } from "../../src/index.ts";
import { scriptedModel } from "./helpers.ts";
import { flowMessaging } from "../src/index.ts";

export const SECRET = "whsec_test";
export const SENDERS = { whatsapp: "snd_WA", telegram: "snd_TG", sms: "snd_SMS" };

export interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

export function sign(body: string, secret = SECRET, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`t.${t}.${body}`).digest("hex")}`;
}

export async function fakeFlow() {
  const requests: Recorded[] = [];
  const waiters: Array<() => void> = [];
  /** Answers for the next matching requests, used once each, before the defaults. */
  const queued: Array<{ match: (r: Recorded) => boolean; status: number; body: unknown }> = [];
  const contacts: Record<string, unknown> = {};
  const messages: Record<string, unknown> = {};
  const templates: unknown[] = [];
  const files: Record<string, Buffer> = {};
  let sent = 0;

  function defaults(r: Recorded): { status: number; body: unknown } {
    const id = r.path.split("/")[3]?.split("?")[0];
    if (r.method === "GET" && r.path.startsWith("/v1/contacts/")) return contacts[id] ? { status: 200, body: contacts[id] } : notFound();
    if (r.method === "GET" && r.path.startsWith("/v1/messages/")) return messages[id] ? { status: 200, body: messages[id] } : notFound();
    if (r.method === "GET" && r.path.startsWith("/v1/templates")) return { status: 200, body: { data: templates, has_more: false } };
    const into = r.path.match(/^\/v1\/conversations\/([^/]+)\/messages$/)?.[1];
    if (r.method === "POST" && (into || r.path === "/v1/messages")) {
      return { status: 202, body: { id: `msg_out${++sent}`, conversation: into ?? "conv_started", direction: "out", status: "queued", content: r.body.content } };
    }
    if (r.method === "POST" && /\/(typing|read)$/.test(r.path)) return { status: 202, body: { conversation: r.path.split("/")[3], action: "read" } };
    return notFound();
  }
  const notFound = () => ({ status: 404, body: { error: { type: "not_found", message: "No such object.", hint: "", doc_url: "" } } });

  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const r: Recorded = { method: req.method!, path: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    requests.push(r);
    const file = r.method === "GET" && r.path.match(/^\/v1\/files\/([^/]+)$/)?.[1];
    if (file && files[file]) return void res.writeHead(200, { "content-type": "application/octet-stream" }).end(files[file]);
    const i = queued.findIndex((q) => q.match(r));
    const answer = i >= 0 ? queued.splice(i, 1)[0] : defaults(r);
    res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
    waiters.splice(0).forEach((w) => w());
  });
  const streams: FakeStream[] = [];
  const streamWaiters: Array<() => void> = [];
  server.on("upgrade", (req, socket: Socket) => {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: flow\r\n\r\n`);
    const ended = gateOf();
    socket.on("data", (data: Buffer) => {
      if ((data[0]! & 0x0f) === 0x8) socket.end(); // the client's close frame (or its answer to ours)
    });
    socket.on("close", () => ended.open());
    socket.on("error", () => {}); // a client gone mid-write; "close" follows
    const frame = (opcode: number, payload: Buffer) => {
      const head = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff]);
      socket.write(Buffer.concat([head, payload]));
    };
    streams.push({
      url: new URL(req.url!, "http://x"),
      protocols: offered,
      authorization: req.headers.authorization,
      send: (value) => frame(0x1, Buffer.from(JSON.stringify(value))),
      close: (code, reason = "") => frame(0x8, Buffer.concat([Buffer.from([code >> 8, code & 0xff]), Buffer.from(reason)])),
      drop: () => socket.destroy(),
      ended: ended.promise,
    });
    streamWaiters.splice(0).forEach((w) => w());
  });
  /** The n-th stream opened (from 0), now or once it opens. */
  async function stream(n: number): Promise<FakeStream> {
    while (streams.length <= n) await new Promise<void>((resolve) => streamWaiters.push(resolve));
    return streams[n]!;
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** The first recorded request (now or later) that `test` accepts. */
  async function request(test: (r: Recorded) => boolean): Promise<Recorded> {
    for (;;) {
      const found = requests.find(test);
      if (found) return found;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  }
  const sends = (path: string) => requests.filter((r) => r.method === "POST" && r.path === path);

  return { url, requests, queued, contacts, messages, templates, files, request, sends, streams, stream, close: () => server.close() };
}

/** One client on the fake /v1/stream. */
export interface FakeStream {
  url: URL;
  protocols: string[];
  authorization: string | undefined;
  /** Sends one JSON frame. */
  send(frame: unknown): void;
  /** Sends a close frame with this code. */
  close(code: number, reason?: string): void;
  /** Cuts the connection with no close frame. */
  drop(): void;
  /** Resolves when the connection is gone. */
  ended: Promise<void>;
}

function gateOf() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/** An agent on the three Flow channels, with its webhook served, driven by a scripted model. */
export async function liveAgent(flow: { url: string }, options: { database?: Database } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "flow-fm-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  const events: FlowEvent[] = [];
  const fm = flowMessaging({ apiKey: "fk_test_key", webhookSecret: SECRET, baseUrl: flow.url });
  const agent = createAgent({
    dir,
    model: scripted.model,
    channels: [fm.whatsapp({ sender: SENDERS.whatsapp }), fm.telegram({ sender: SENDERS.telegram }), fm.sms({ sender: SENDERS.sms })],
    database: options.database,
    debounceMs: 0,
    deadlineMs: 50,
    scheduleCheckMs: 0,
    events: [(e) => events.push(e)],
  });
  if (options.database) await agent.resume();
  const server = createServer(fm.webhook(agent));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const hook = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** Posts one event to the webhook as Flow does; `signature` replaces the right one. */
  async function deliver(event: object, signature?: string): Promise<{ status: number; body: string }> {
    const body = JSON.stringify(event);
    const response = await fetch(hook, { method: "POST", headers: { "content-type": "application/json", "flow-signature": signature ?? sign(body) }, body });
    return { status: response.status, body: await response.text() };
  }
  return { agent, events, deliver, close: () => server.close(), ...scripted };
}

let events = 0;
/** A Flow event in a conversation with one contact. */
export function event(type: string, conversation: { id: string; channel: "whatsapp" | "telegram" | "sms"; contact: string }, data: object) {
  return { id: `evt_${++events}`, type, created_at: new Date().toISOString(), app: "app_test", livemode: false, conversation: { ...conversation, sender: SENDERS[conversation.channel] }, timing: { received_at: new Date().toISOString(), stored_at: new Date().toISOString() }, data };
}

/** message.received with this content. */
export function received(conversation: Parameters<typeof event>[1], id: string, content: object, extra: object = {}) {
  return event("message.received", conversation, { message: { id, conversation: conversation.id, direction: "in", status: "received", content, livemode: false, created_at: new Date().toISOString(), ...extra } });
}
