// Web chat: the agent in a chat box on the business's own site, served by the agent itself over
// plain HTTP (long-polling, so it works through every proxy and CDN, and through hosts that buffer a
// response). Mount its routes beside the agent's other channels:
//
//   const web = webChat({ secret: process.env.FLOW_WEB_CHAT_SECRET, origins: ["https://shop.example"] });
//   const agent = createAgent({ ..., channels: [whatsapp(provider), web], routes: web.routes });
//   web.attach(agent);
//
// The contract, under `base` (default /v1/web-chat), each but `session` with `Authorization: Bearer <session>`:
//   POST {base}/session   { token? }                       → 200 { session, expires_at, signed_in }
//   GET  {base}/history                                    → 200 { messages, cursor }
//   GET  {base}/events?after=<cursor>&wait=<seconds ≤ 25>  → 200 { events, cursor } | { reset: true }
//   POST {base}/messages  { id, text, choice?, page?, attachments? } → 202 { id }
//   POST {base}/files     the file's bytes (Content-Type, X-File-Name?) → 201 { file } (needs createAgent's `media`)
//   GET  {base}/file?id&exp&sig                            → the file's bytes, by the signed `src` events carry
// `token` is the business's own sign-in token (an HS256 JWT signed with `secret`: { sub, aud:
// "flow-web-chat", exp }); without it the visitor is anonymous. Accepted, for `send()`, means the
// visitor's mailbox kept the message; the browser reads it from there (docs/guarantees.md).

import { createHmac, randomUUID } from "node:crypto";
import type { Agent } from "./agent.ts";
import { sniff, type MediaKind } from "./media.ts";
import { replyButton, type Channel } from "./channels.ts";
import { requireToken, sameSecret, withoutTrailingSlashes } from "./http.ts";
import type { Attachment, CarouselCard, ChannelInfo, ListRow, Outbound, Photo, SendReceipt } from "./types.ts";

/** A file a visitor sent, as their browser is shown it: `src` (on the way out) is where its bytes are, signed for an hour. */
export interface WebChatFile {
  id: string;
  kind: MediaKind;
  mime: string;
  size: number;
  name?: string;
  src?: string;
}

/** What the web chat box can show (decided for Flow Framework's own client; narrow it with `info` for yours). */
export const WEB_CHAT: ChannelInfo = {
  reactions: true,
  status: true,
  formatting: "markdown",
  maxLength: 8000,
  replies: true,
  buttons: { max: 10, labelMax: 40 },
  buttonIds: true,
  lists: { maxRows: 10, titleMax: 72, buttonMax: 40 },
  linkButton: { labelMax: 40 },
  images: { captionMax: 4096 },
  carousels: { maxCards: 10, textMax: 4096, cardTextMax: 300, buttons: 3, labelMax: 40 },
  readReceipts: true,
  templates: false,
  typing: true,
};

/** One thing the visitor's browser is told, as the mailbox keeps it. */
export type WebChatEventBody =
  | { type: "message"; from: "agent"; text: string; replyTo?: string; buttons?: Array<{ id: string; label: string }>; list?: { button: string; rows: ListRow[] }; link?: { label: string; url: string }; image?: Photo; fields?: Record<string, unknown> }
  | { type: "message"; from: "person"; id: string; text: string; choice?: { id?: string; title: string }; attachments?: WebChatFile[] }
  | { type: "carousel"; text: string; cards: CarouselCard[]; replyTo?: string }
  | { type: "typing"; on: boolean }
  | { type: "status"; text: string | null }
  | { type: "read"; messageIds: string[] }
  | { type: "reaction"; messageId: string; emoji: string };

/** An event with its place in the visitor's mailbox: poll `after` its cursor for what came next. */
export type WebChatEvent = WebChatEventBody & { cursor: string; at: number };

/**
 * Where each visitor's events wait for their browser. The default keeps them in this process
 * (`memoryMailbox()`); give one backed by a shared store when several runners serve the agent, so a
 * reply one runner writes reaches a browser polling another.
 */
export interface WebChatMailbox {
  /**
   * Keeps one event for a visitor; resolves with it once it is kept (that is the platform accepting
   * it), rejects when it cannot. With `idempotencyKey` (a message the business started), an event
   * already kept with that key is not kept again: it resolves with that one.
   */
  append(address: string, event: WebChatEventBody, idempotencyKey?: string): Promise<WebChatEvent>;
  /**
   * The visitor's events after `after`, waiting up to `waitMs` for the first when there are none
   * (or until `signal` aborts). `reset` when `after` is not a cursor it can continue from (another
   * process's, or older than what it still holds): the browser then reads the history again.
   */
  read(address: string, after: string, waitMs: number, signal?: AbortSignal): Promise<{ events: WebChatEvent[]; cursor: string } | { reset: true }>;
  /** Where what it holds for a visitor begins: the cursor before its oldest event, and that event's time (now when it holds none). */
  start(address: string): Promise<{ cursor: string; since: number }>;
}

/**
 * Visitors' events in this process's memory: the last `keep` per visitor (default 200), at most
 * `visitors` visitors (default 10,000, the least recently used go first), a visitor idle `idleMs`
 * (default a day) forgotten. A restart forgets them all; browsers then read the history from the store.
 */
export function memoryMailbox(options: { keep?: number; visitors?: number; idleMs?: number; now?: () => number } = {}): WebChatMailbox {
  const keep = options.keep ?? 200;
  const most = options.visitors ?? 10_000;
  const idleMs = options.idleMs ?? 24 * 3_600_000;
  const now = options.now ?? Date.now;
  const epoch = randomUUID().slice(0, 8);
  type Held = WebChatEvent & { seq: number; key?: string };
  type Box = { events: Held[]; seq: number; used: number; waiters: Set<() => void> };
  const boxes = new Map<string, Box>();

  function box(address: string): Box {
    let b = boxes.get(address);
    if (b) boxes.delete(address);
    else b = { events: [], seq: 0, used: 0, waiters: new Set() };
    b.used = now();
    boxes.set(address, b);
    // The least recently used come first in the map: forget the idle ones, and any past the cap.
    for (const [key, other] of boxes) {
      if (boxes.size <= most && other.used > now() - idleMs) break;
      if (key === address || other.waiters.size) continue;
      boxes.delete(key);
    }
    return b;
  }
  const cursorOf = (seq: number) => `${epoch}:${seq}`;
  const bare = ({ seq: _seq, key: _key, ...event }: Held) => event as WebChatEvent;

  return {
    async append(address, event, idempotencyKey) {
      const b = box(address);
      const earlier = idempotencyKey ? b.events.find((e) => e.key === idempotencyKey) : undefined;
      if (earlier) return bare(earlier);
      const kept = { ...event, seq: ++b.seq, cursor: cursorOf(b.seq), at: now(), ...(idempotencyKey ? { key: idempotencyKey } : {}) } as Held;
      b.events.push(kept);
      if (b.events.length > keep) b.events.splice(0, b.events.length - keep);
      for (const wake of b.waiters) wake();
      return bare(kept);
    },
    async read(address, after, waitMs, signal) {
      const [from, n] = after.split(":");
      const seq = Number(n);
      if (from !== epoch || !Number.isInteger(seq) || seq < 0) return { reset: true };
      const b = box(address);
      if (seq > b.seq || (b.events.length && b.events[0].seq > seq + 1) || (!b.events.length && seq < b.seq)) return { reset: true };
      const newer = () => b.events.filter((e) => e.seq > seq);
      if (!newer().length && waitMs > 0 && !signal?.aborted) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            b.waiters.delete(done);
            signal?.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, waitMs);
          b.waiters.add(done);
          signal?.addEventListener("abort", done);
        });
      }
      const events = newer().map(bare);
      return { events, cursor: events.at(-1)?.cursor ?? after };
    },
    async start(address) {
      const b = box(address);
      const first = b.events[0];
      return first ? { cursor: cursorOf(first.seq - 1), since: first.at } : { cursor: cursorOf(b.seq), since: now() };
    },
  };
}

export interface WebChatOptions {
  /** At least 32 characters, from a secret (FLOW_WEB_CHAT_SECRET): signs visitors' sessions, and is the key the business signs its sign-in tokens with. */
  secret: string;
  /** The sites the chat box may be embedded on (`https://shop.example`); a browser on any other is refused. Default: any (local development). */
  origins?: string[];
  /** The channel's name; its send tool is send_<name>. Default "web". */
  name?: string;
  /** The path its routes answer under. Default "/v1/web-chat". */
  base?: string;
  /** What the chat box can show, over WEB_CHAT: narrow it for a UI of your own that shows less. */
  info?: Partial<Omit<ChannelInfo, "platform" | "templates" | "replyWindowHours">>;
  /** Your own guidance for the agent while the person is on the web chat. */
  instructions?: string;
  /** Where visitors' events wait for their browser. Default memoryMailbox(). */
  mailbox?: WebChatMailbox;
  limits?: {
    /** Messages one visitor may send a minute. Default 20. */
    messagesPerMinute?: number;
    /** New sessions one network address may start a minute. Default 30. */
    sessionsPerMinute?: number;
    /** The longest message, in characters. Default 4,000. */
    messageChars?: number;
    /** The largest file a visitor may send, in bytes. Default 10 MB. */
    fileBytes?: number;
    /** Files one visitor may send a minute. Default 10. */
    filesPerMinute?: number;
  };
  /** The clock (tests move it). */
  now?: () => number;
}

/** What the routes need from the agent; Flow Framework's Agent is one. */
export type WebChatAgent = Pick<Agent, "message" | "transcript" | "conversationOf"> & Partial<Pick<Agent, "media">>;

/** The page a visitor wrote from, as their browser said. */
export interface WebChatPage {
  url: string;
  title?: string;
}

export interface WebChat extends Channel {
  /** For createAgent's `routes`. */
  routes: Record<string, (request: Request) => Promise<Response>>;
  /** Connects the routes to the agent the channel is on (call it once the agent is made). */
  attach(agent: WebChatAgent): void;
  /** The page the person last wrote from on the web chat, or null: add it to your `context` in your own words. */
  page(conversationId: string): WebChatPage | null;
}

const SIGN_IN_AUDIENCE = "flow-web-chat";
const SESSION_AUDIENCE = "flow-web-chat-session";
const VISITOR_SESSION_MS = 30 * 24 * 3_600_000;
const SIGNED_IN_SESSION_MS = 12 * 3_600_000;
/** A sign-in token may be valid at most this long ahead: it is a handoff, not a session. */
const SIGN_IN_TOKEN_MAX_MS = 24 * 3_600_000;
const MAX_BODY = 16_384;
const MAX_WAIT_SECONDS = 25;
const MAX_PAGES = 10_000;
const MAX_ATTACHMENTS = 3;
/** How long a file's signed `src` works. */
const FILE_LINK_MS = 3_600_000;

export function webChat(options: WebChatOptions): WebChat {
  requireToken(options?.secret, "flow web chat");
  const secret = options.secret;
  const name = options.name ?? "web";
  const base = withoutTrailingSlashes(options.base ?? "/v1/web-chat");
  const mailbox = options.mailbox ?? memoryMailbox();
  const now = options.now ?? Date.now;
  const origins = options.origins ? new Set(options.origins.map((o) => withoutTrailingSlashes(o))) : null;
  const limits = { messagesPerMinute: 20, sessionsPerMinute: 30, messageChars: 4000, fileBytes: 10 * 1_048_576, filesPerMinute: 10, ...options.limits };
  const info: ChannelInfo = { ...WEB_CHAT, ...options.info };
  const messages = counter(now);
  const sessions = counter(now);
  const uploads = counter(now);
  const mac = (text: string) => createHmac("sha256", secret).update(text).digest("base64url");
  /** A visitor's handle on a file they sent: its id, signed for them, so no one else can send it. */
  const refOf = (address: string, id: string) => `${id}.${mac(`ref:${address}:${id}`).slice(0, 32)}`;
  const idOfRef = (address: string, ref: string): string | null => {
    const at = ref.lastIndexOf(".");
    const id = ref.slice(0, at);
    return at > 0 && sameSecret(ref, refOf(address, id)) ? id : null;
  };
  /** Where a browser fetches a file the store keeps: no session in the URL, a signature valid an hour. */
  const srcOf = (id: string) => {
    const exp = Math.floor((now() + FILE_LINK_MS) / 1000);
    return `${base}/file?id=${encodeURIComponent(id)}&exp=${exp}&sig=${mac(`file:${id}:${exp}`)}`;
  };
  const showPhoto = (p: Photo) => ("fileId" in p ? { ...p, src: srcOf(p.fileId) } : p);
  /** An event as the browser gets it: files kept by the store get a signed `src`. */
  const present = <E extends WebChatEventBody>(event: E): E => {
    if (event.type === "message" && event.from === "person" && event.attachments) return { ...event, attachments: event.attachments.map((f) => ({ ...f, src: srcOf(f.id) })) };
    if (event.type === "message" && event.from === "agent" && event.image) return { ...event, image: showPhoto(event.image) };
    if (event.type === "carousel") return { ...event, cards: event.cards.map((c) => ({ ...c, image: showPhoto(c.image) })) };
    return event;
  };
  const pages = new Map<string, WebChatPage>();
  let agent: WebChatAgent | null = null;

  const put = async (address: string, event: WebChatEventBody, idempotencyKey?: string): Promise<SendReceipt> => {
    await mailbox.append(address, event, idempotencyKey);
    return { status: "sent" };
  };

  /** Sends and courtesies alike go to the visitor's mailbox; the conversation sends one at a time. */
  function send(address: string, outbound: Outbound): Promise<void | SendReceipt> | void {
    switch (outbound.type) {
      case "message":
        return put(address, {
          type: "message",
          from: "agent",
          text: outbound.text,
          ...(outbound.replyTo ? { replyTo: outbound.replyTo } : {}),
          ...(outbound.buttons?.length ? { buttons: outbound.buttons.map(replyButton) } : {}),
          ...(outbound.list ? { list: outbound.list } : {}),
          ...(outbound.link ? { link: outbound.link } : {}),
          ...(outbound.image ? { image: outbound.image } : {}),
          ...(outbound.fields && Object.keys(outbound.fields).length ? { fields: outbound.fields } : {}),
        }, outbound.idempotencyKey);
      case "carousel":
        return put(address, { type: "carousel", text: outbound.text, cards: outbound.cards, ...(outbound.replyTo ? { replyTo: outbound.replyTo } : {}) }, outbound.idempotencyKey);
      case "typing":
        return info.typing ? put(address, { type: "typing", on: outbound.on }).then(() => undefined) : undefined;
      case "status":
        return info.status ? put(address, { type: "status", text: outbound.text }).then(() => undefined) : undefined;
      case "read":
        return info.readReceipts ? put(address, { type: "read", messageIds: outbound.messageIds }).then(() => undefined) : undefined;
      case "reaction":
        return info.reactions ? put(address, { type: "reaction", messageId: outbound.messageId, emoji: outbound.emoji }).then(() => undefined) : undefined;
      case "template":
        throw new Error("the web chat has no templates");
    }
  }

  /** CORS headers for a browser on an allowed site; null when the site is not allowed. */
  function cors(request: Request): Record<string, string> | null {
    const origin = request.headers.get("origin");
    if (!origin) return {};
    if (origins && !origins.has(origin)) return null;
    return { "access-control-allow-origin": origin, vary: "origin" };
  }

  /** The visitor a request's session names, or null. */
  function visitorOf(request: Request): { address: string; key?: string } | null {
    const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const claims = bearer ? verify(bearer, secret, SESSION_AUDIENCE, now()) : null;
    if (!claims || typeof claims.sub !== "string") return null;
    return { address: claims.sub, ...(typeof claims.key === "string" ? { key: claims.key } : {}) };
  }

  async function session(request: Request, headers: Record<string, string>): Promise<Response> {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!sessions.take(ip, limits.sessionsPerMinute)) return json(429, { error: "too many new chats from this address; try again in a minute" }, headers);
    const body = await readJson(request);
    if (body === undefined || (body.token !== undefined && typeof body.token !== "string")) return json(400, { error: "the body is JSON: { token? }" }, headers);
    const at = now();
    if (typeof body.token === "string") {
      const claims = verify(body.token, secret, SIGN_IN_AUDIENCE, at);
      const sub = claims?.sub;
      if (!claims || typeof sub !== "string" || !sub || sub.length > 200) return json(401, { error: "the sign-in token is not valid: an HS256 JWT signed with the web chat's secret, { sub, aud: \"flow-web-chat\", exp }" }, headers);
      if (typeof claims.exp !== "number" || claims.exp * 1000 > at + SIGN_IN_TOKEN_MAX_MS) return json(401, { error: "the sign-in token must expire within 24 hours" }, headers);
      const expires = at + SIGNED_IN_SESSION_MS;
      return json(200, { session: sign({ aud: SESSION_AUDIENCE, sub: `user:${sub}`, key: sub, exp: Math.floor(expires / 1000) }, secret), expires_at: expires, signed_in: true }, headers);
    }
    const expires = at + VISITOR_SESSION_MS;
    return json(200, { session: sign({ aud: SESSION_AUDIENCE, sub: `visitor:${randomUUID()}`, exp: Math.floor(expires / 1000) }, secret), expires_at: expires, signed_in: false }, headers);
  }

  async function history(visitor: { address: string }, headers: Record<string, string>): Promise<Response> {
    // The mailbox from its oldest event on, the store's transcript before it: each message once.
    const { cursor, since } = await mailbox.start(visitor.address);
    const conversationId = await agent!.conversationOf({ channel: name, address: visitor.address });
    const entries = conversationId ? await agent!.transcript(conversationId) : [];
    const shown = entries.flatMap((e): Array<WebChatEventBody & { at: number }> => {
      if ((e.kind !== "in" && e.kind !== "out") || e.channel !== name || e.at >= since) return [];
      if (e.kind === "in") return [{ type: "message", from: "person", id: e.id, text: e.text, ...(e.choice ? { choice: { ...(e.choiceId ? { id: e.choiceId } : {}), title: e.text } } : {}), at: e.at }];
      if (e.carousel) return [{ type: "carousel", text: e.text, cards: e.carousel, at: e.at }];
      return [{ type: "message", from: "agent", text: e.text, ...(e.buttons?.length ? { buttons: e.buttons.map(replyButton) } : {}), ...(e.list ? { list: e.list } : {}), ...(e.link ? { link: e.link } : {}), ...(e.image ? { image: e.image } : {}), ...(e.fields ? { fields: e.fields } : {}), at: e.at }];
    });
    return json(200, { messages: shown.map(present), cursor }, headers);
  }

  async function events(request: Request, visitor: { address: string }, headers: Record<string, string>): Promise<Response> {
    const url = new URL(request.url);
    const after = url.searchParams.get("after");
    if (!after) return json(400, { error: "give after=<cursor>, from history or the last events" }, headers);
    const wait = Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(url.searchParams.get("wait") ?? MAX_WAIT_SECONDS) || 0));
    const got = await mailbox.read(visitor.address, after, wait * 1000, request.signal);
    return json(200, "reset" in got ? got : { ...got, events: got.events.map(present) }, headers);
  }

  async function message(request: Request, visitor: { address: string; key?: string }, headers: Record<string, string>): Promise<Response> {
    const body = await readJson(request);
    const problem = badMessage(body, limits.messageChars);
    if (problem) return json(400, { error: problem }, headers);
    const m = body as { id: string; text: string; choice?: { id?: string; title: string }; page?: WebChatPage; attachments?: Array<{ ref: string }> };
    // Each file is one this visitor sent (its ref is signed for them) and the store still keeps.
    const files: WebChatFile[] = [];
    const attachments: Attachment[] = [];
    for (const { ref } of m.attachments ?? []) {
      const id = idOfRef(visitor.address, ref);
      const kept = id && agent!.media ? await agent!.media.get(id) : null;
      if (!id || !kept || kept.owner !== `${name}:${visitor.address}`) return json(400, { error: "attachments: each { ref } is one POST " + base + "/files gave this visitor" }, headers);
      const kind = sniff(kept.data)?.kind ?? "document";
      files.push({ id, kind, mime: kept.mime, size: kept.size, ...(kept.name ? { name: kept.name } : {}) });
      const store = agent!.media!;
      attachments.push({ kind, mime: kept.mime, ...(kept.name ? { name: kept.name } : {}), data: async () => (await store.get(id))?.data ?? Promise.reject(new Error("the file is no longer kept")) });
    }
    if (!messages.take(visitor.address, limits.messagesPerMinute)) return json(429, { error: "too many messages; wait a moment" }, headers);
    const taken = await agent!.message({
      channel: name,
      from: visitor.address,
      messageId: m.id,
      message: { text: m.text, ...(m.choice ? { choice: m.choice } : {}), ...(attachments.length ? { attachments } : {}) },
      ...(visitor.key ? { key: visitor.key } : {}),
    });
    const conversationId = taken?.conversationId ?? (await agent!.conversationOf({ channel: name, address: visitor.address }));
    if (conversationId && m.page) {
      pages.delete(conversationId);
      pages.set(conversationId, { url: m.page.url, ...(m.page.title ? { title: m.page.title } : {}) });
      if (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value!);
    }
    // Echoed, so the visitor's other tabs and a reload show it; a retried id is shown once by the client.
    await mailbox.append(visitor.address, { type: "message", from: "person", id: m.id, text: m.text, ...(m.choice ? { choice: m.choice } : {}), ...(files.length ? { attachments: files } : {}) });
    return json(202, { id: m.id }, headers);
  }

  /** A file the visitor sends, kept in the agent's store before the message that carries it. */
  async function upload(request: Request, visitor: { address: string }, headers: Record<string, string>): Promise<Response> {
    const store = agent!.media;
    if (!store) return json(501, { error: "this agent keeps no files: give createAgent a media store" }, headers);
    if (Number(request.headers.get("content-length") ?? 0) > limits.fileBytes) return json(413, { error: `a file is at most ${limits.fileBytes} bytes` }, headers);
    if (!uploads.take(visitor.address, limits.filesPerMinute)) return json(429, { error: "too many files; wait a moment" }, headers);
    const data = new Uint8Array(await request.arrayBuffer());
    if (!data.length) return json(400, { error: "the body is the file's bytes" }, headers);
    if (data.length > limits.fileBytes) return json(413, { error: `a file is at most ${limits.fileBytes} bytes` }, headers);
    // The bytes say what it is; a browser's type that disagrees (a page called a photo) is refused.
    const real = sniff(data);
    const said = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const family = (mime: string) => (mime === "application/pdf" ? "document" : mime.split("/")[0]);
    if (!real || (said && said !== "application/octet-stream" && family(said) !== family(real.mime) && !(real.kind === "audio" && said.startsWith("video/")))) {
      return json(415, { error: "photos (JPEG, PNG, WebP, GIF), PDFs and voice notes (Ogg, WebM, MP3, MP4, WAV) only" }, headers);
    }
    let fileName: string | undefined;
    try {
      fileName = decodeURIComponent(request.headers.get("x-file-name") ?? "").replace(/[\u0000-\u001f\/\\]/g, "").slice(0, 200) || undefined;
    } catch {
      return json(400, { error: "X-File-Name is the file's name, URL-encoded" }, headers);
    }
    const kept = await store.put({ data, mime: real.mime, ...(fileName ? { name: fileName } : {}), owner: `${name}:${visitor.address}` });
    const file: WebChatFile = { id: kept.id, kind: real.kind, mime: kept.mime, size: kept.size, ...(kept.name ? { name: kept.name } : {}) };
    return json(201, { file: { ...file, ref: refOf(visitor.address, kept.id), src: srcOf(kept.id) } }, headers);
  }

  /** A file's bytes by its signed `src` (an <img> sends no session); only files the agent's store keeps. */
  async function file(request: Request, headers: Record<string, string>): Promise<Response> {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "";
    const exp = Number(url.searchParams.get("exp"));
    const sig = url.searchParams.get("sig") ?? "";
    if (!id || !Number.isInteger(exp) || exp * 1000 <= now() || !sameSecret(sig, mac(`file:${id}:${exp}`))) return json(403, { error: "this link is not valid, or it expired: read the history again for a fresh one" }, headers);
    const kept = agent?.media ? await agent.media.get(id) : null;
    if (!kept) return json(404, { error: "the file is no longer kept" }, headers);
    const inline = kept.mime.startsWith("image/") || kept.mime.startsWith("audio/");
    return new Response(kept.data as BodyInit, {
      status: 200,
      headers: { ...headers, "content-type": kept.mime, "x-content-type-options": "nosniff", "content-disposition": inline ? "inline" : "attachment", "cache-control": "private, max-age=3600" },
    });
  }

  function route(handle: (request: Request, visitor: { address: string; key?: string }, headers: Record<string, string>) => Promise<Response>, method: "GET" | "POST", open = false) {
    return async (request: Request): Promise<Response> => {
      const headers = cors(request);
      if (!headers) return json(403, { error: "this site may not embed the chat" });
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: { ...headers, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "authorization, content-type, x-file-name", "access-control-max-age": "600" } });
      }
      if (request.method !== method) return json(405, { error: `use ${method}` }, headers);
      try {
        if (open) return await handle(request, { address: "" }, headers);
        const visitor = visitorOf(request);
        if (!visitor) return json(401, { error: "start a session: POST " + base + "/session" }, headers);
        if (!agent) return json(503, { error: "the web chat is not attached to its agent yet" }, headers);
        return await handle(request, visitor, headers);
      } catch (error) {
        console.warn("flow web chat:", error);
        return json(500, { error: "that could not be done; try again" }, headers);
      }
    };
  }

  return {
    name,
    kind: "custom",
    traceChannel: "web",
    info,
    instructions: options.instructions,
    send,
    routes: {
      [`${base}/session`]: route((request, _visitor, headers) => session(request, headers), "POST", true),
      [`${base}/history`]: route((_request, visitor, headers) => history(visitor, headers), "GET"),
      [`${base}/events`]: route(events, "GET"),
      [`${base}/messages`]: route(message, "POST"),
      [`${base}/files`]: route(upload, "POST"),
      [`${base}/file`]: route((request, _visitor, headers) => file(request, headers), "GET", true),
    },
    attach(attached) {
      agent = attached;
    },
    page(conversationId) {
      return pages.get(conversationId) ?? null;
    },
  };
}

/** Why a message body is refused, or null. */
function badMessage(body: Record<string, unknown> | undefined, maxChars: number): string | null {
  if (!body) return `the body is JSON of at most ${MAX_BODY} bytes`;
  if (typeof body.id !== "string" || !/^[\w.:-]{1,64}$/.test(body.id)) return "id: your own id for the message, 1 to 64 letters, digits, _ . : or -, the same when you send it again";
  if (typeof body.text !== "string" || [...body.text].length > maxChars) return `text: a string of at most ${maxChars} characters`;
  const choice = body.choice as Record<string, unknown> | undefined;
  if (choice !== undefined && (typeof choice !== "object" || choice === null || typeof choice.title !== "string" || (choice.id !== undefined && typeof choice.id !== "string"))) return "choice: { id?, title }, what they tapped";
  const attachments = body.attachments as unknown;
  if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS || attachments.some((a) => typeof a?.ref !== "string"))) return `attachments: up to ${MAX_ATTACHMENTS} { ref }, from POST /files`;
  if (!body.text.trim() && !choice && !(attachments as unknown[] | undefined)?.length) return "text is empty";
  const page = body.page as Record<string, unknown> | undefined;
  if (page !== undefined && (typeof page !== "object" || page === null || typeof page.url !== "string" || page.url.length > 2000 || (page.title !== undefined && (typeof page.title !== "string" || page.title.length > 300)))) return "page: { url, title? }, the page they wrote from";
  return null;
}

/** Counts per key in one-minute windows. */
function counter(now: () => number) {
  const counts = new Map<string, { count: number; until: number }>();
  return {
    take(key: string, most: number): boolean {
      const at = now();
      if (counts.size > 50_000) for (const [k, v] of counts) if (v.until <= at) counts.delete(k);
      const entry = counts.get(key);
      if (!entry || entry.until <= at) {
        counts.set(key, { count: 1, until: at + 60_000 });
        return true;
      }
      return ++entry.count <= most;
    },
  };
}

const b64 = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/**
 * A sign-in token for the web chat, made by the business's own server once it has verified who the
 * visitor is: `key` is their key (the one `resolve` gives on other channels), valid `seconds` (default
 * 300). Any HS256 JWT library makes the same: { sub: key, aud: "flow-web-chat", exp }.
 */
export function webChatSignIn(secret: string, key: string, seconds = 300, now = Date.now()): string {
  return sign({ sub: key, aud: SIGN_IN_AUDIENCE, exp: Math.floor(now / 1000) + seconds }, secret);
}

function sign(claims: Record<string, unknown>, secret: string): string {
  const head = `${b64(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64(JSON.stringify(claims))}`;
  return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
}

/** The claims of an HS256 JWT signed with `secret`, for `audience`, not expired; else null. */
function verify(token: string, secret: string, audience: string, at: number): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, signature] = parts;
  if (!sameSecret(signature, createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url"))) return null;
  try {
    const header = JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (header?.alg !== "HS256" || typeof claims !== "object" || claims === null) return null;
    if (claims.aud !== audience || typeof claims.exp !== "number" || claims.exp * 1000 <= at) return null;
    return claims;
  } catch {
    return null;
  }
}

async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  const text = await request.text().catch(() => "");
  if (Buffer.byteLength(text) > MAX_BODY) return undefined;
  try {
    const value = JSON.parse(text || "{}");
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...headers, "content-type": "application/json", "cache-control": "no-store" } });
}
