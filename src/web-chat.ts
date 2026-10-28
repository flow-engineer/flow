// Web chat: the agent in a chat box on the business's own site, served by the agent itself. Add the
// channel and the agent serves its routes (through agent.fetch, beside its own `routes`):
//
//   createAgent({ ..., channels: [...flowChannels, webChat({ origins: ["https://shop.example"] })] });
//
// and the site adds one script tag: <script async src="https://<agent>/v1/web-chat/widget.js"></script>.
//
// The contract, under `base` (default /v1/web-chat); each call but `session` and the widget's files
// with `Authorization: Bearer <session>`:
//   POST {base}/session   { visitor?, identity? }   → 200 { session, expires_at, signed_in, visitor?, limits }
//   GET  {base}/history                              → 200 { messages, cursor }
//   GET  {base}/events?after=<seq>                   → SSE (Accept: text/event-stream), else a long-poll:
//                                                      200 { events, cursor, live } | { reset: true }
//   POST {base}/messages  { id, text, choice?, page?, context? } → 202 { id, busy? }
//   GET  {base}/widget.js, {base}/widget/<name>.js   the chat box (widget/)
//
// What the box shows waits in the visitor's outbox in the store, numbered per visitor: a box that
// comes back asks for what came after the last number it showed, so each message shows once and in
// order, through restarts and deploys. Accepted, for send(), means the outbox kept it
// (docs/guarantees.md). Typing and status lines are live only, never kept. Limits are held in this
// process's memory, but the daily cap, which is counted in the store. Logs carry ids and counts,
// never text, addresses or tokens.

import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { replyButton, type Channel, type ChannelAgent } from "./channels.ts";
import { sameSecret, withoutTrailingSlashes, wrongTries } from "./http.ts";
import type { CarouselCard, ChannelInfo, Outbound, PageContext, Photo, SendReceipt } from "./types.ts";
import type { TranscriptEntry } from "./conversation.ts";
import type { WebEventRow } from "./store.ts";

/** What Flow's chat box can show; narrow it with `info` for a box of your own that shows less. */
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
  readReceipts: false,
  templates: false,
  typing: true,
};

/** One thing the visitor's box shows, as the outbox keeps it and the box gets it (with its `seq` and `at`). */
export type WebChatEvent = { seq: number; at: number } & (
  | {
      type: "message";
      from: "agent";
      id: string;
      text: string;
      replyTo?: string;
      buttons?: Array<{ id: string; label: string }>;
      list?: { button: string; rows: Array<{ id: string; title: string; description?: string }> };
      link?: { label: string; url: string };
      image?: { url: string };
    }
  | { type: "message"; from: "person"; id: string; text: string; choice?: { id?: string; title: string } }
  | { type: "carousel"; id: string; text: string; replyTo?: string; cards: Array<{ image: { url: string }; text?: string; buttons?: Array<{ id: string; label: string }>; link?: { label: string; url: string } }> }
  | { type: "reaction"; messageId: string; emoji: string }
);

export interface WebChatLimits {
  /** New visitors one network address may start a minute, and a day. Default 20 and 300: many people share an address on mobile networks. */
  newVisitorsPerMinute?: number;
  newVisitorsPerDay?: number;
  /** Messages an anonymous visitor may send a minute, and a day. Default 8 and 60. */
  messagesPerMinute?: number;
  messagesPerDay?: number;
  /** Messages a signed-in visitor may send a minute, and a day. Default 15 and 300. */
  signedInMessagesPerMinute?: number;
  signedInMessagesPerDay?: number;
  /** Messages one network address may send a minute, all its visitors together. Default 60. */
  messagesPerAddressPerMinute?: number;
  /** The longest message, in characters. Default 2,000. */
  messageChars?: number;
  /** Web chat turns the agent runs at once; more wait in line, with typing shown. Default 20. */
  turnsAtOnce?: number;
  /** Web chat messages the agent takes a day (UTC); past it visitors get the `busy` reply. Default 5,000. */
  messagesPerAgentPerDay?: number;
}

export interface WebChatOptions {
  /**
   * The sites the chat box may be on: `https://www.example.com`, or `https://*.example.com` for any
   * subdomain; `http://` only for localhost. Joined with FLOW_WEB_CHAT_ORIGINS (comma-separated).
   * None at all: any site may embed the agent, fine for development only (Flow's hosting refuses it
   * in production). They stop other sites, not scripts: the limits stop those.
   */
  origins?: string[];
  /** Signs sessions and visitor ids, at least 32 characters. Default FLOW_WEB_CHAT_SESSION_KEY (Flow's hosting sets it); else a random key per process. */
  sessionKey?: string;
  /**
   * The key your backend signs signed-in visitors' identity tokens with (webChatIdentity), at least 32
   * characters; several while you rotate it. Default FLOW_WEB_CHAT_IDENTITY_KEY (comma-separated).
   * Without one, every visitor is anonymous.
   */
  identityKey?: string | string[];
  /** How many proxies in front of the agent append to X-Forwarded-For (1: the last entry is the client's). Default FLOW_TRUST_PROXY; without it, per-address limits are off. */
  trustProxy?: number;
  limits?: WebChatLimits;
  /** What a visitor gets once the daily cap is reached: your words, and a link (your WhatsApp: https://wa.me/...). */
  busy?: { text?: string; link?: { label: string; url: string } };
  /** The channel's name; its send tool is send_<name>. Default "web". */
  name?: string;
  /** The path its routes answer under. Default "/v1/web-chat". */
  base?: string;
  /** What the chat box can show, over WEB_CHAT: narrow it for a box of your own that shows less. */
  info?: Partial<Omit<ChannelInfo, "platform" | "templates" | "replyWindowHours">>;
  /** Your own guidance for the agent while the person is on the web chat. */
  instructions?: string;
  /** The clock (tests move it). */
  now?: () => number;
}

/** The web chat channel; `origins` (null: any site) and `base` are what Flow's hosting checks. */
export interface WebChat extends Channel {
  readonly origins: readonly string[] | null;
  readonly base: string;
}

const IDENTITY_AUDIENCE = "flow-web-chat";
const SESSION_AUDIENCE = "flow-web-chat-session";
const VISITOR_AUDIENCE = "flow-web-chat-visitor";
const SESSION_MS = 3_600_000;
const VISITOR_MS = 30 * 24 * 3_600_000;
/** An identity token is a handoff, not a session: valid at most this long ahead. */
const IDENTITY_MAX_MS = 10 * 60_000;
const MAX_BODY = 16_384;
const MAX_PAGE = 1_024;
const MAX_WAIT_SECONDS = 25;
const PING_MS = 15_000;
/** Cloud Run ends a request at 15 minutes: the stream asks the box to reconnect before. */
const STREAM_MS = 14 * 60_000;
/** How often a waiting request rechecks the store for what another runner (a deploy's other half) kept. */
const RECHECK_MS = 2_000;
/** Event requests one visitor may hold open at once (their tabs). */
const OPEN_PER_VISITOR = 6;
const HISTORY = 200;
const BUSY_TEXT = "We're busy right now and can't reply here. Please message us another way.";

const DEFAULT_LIMITS: Required<WebChatLimits> = {
  newVisitorsPerMinute: 20,
  newVisitorsPerDay: 300,
  messagesPerMinute: 8,
  messagesPerDay: 60,
  signedInMessagesPerMinute: 15,
  signedInMessagesPerDay: 300,
  messagesPerAddressPerMinute: 60,
  messageChars: 2000,
  turnsAtOnce: 20,
  messagesPerAgentPerDay: 5000,
};

/** A visitor, as their session names them: their address on the channel, and their key when signed in. */
interface Visitor {
  address: string;
  key?: string;
}

/** What one visitor's open requests wait on: news in their outbox, and the live line (typing, status). */
interface Box {
  waiters: Set<() => void>;
  live: { typing: boolean; status: string | null };
  /** The newest number this process knows was given them; the recheck wakes them past it. */
  head: number;
  open: number;
  /** Goes up with each piece of news, so a reader that read the store just before it still sees it. */
  version: number;
}

export function webChat(options: WebChatOptions = {}): WebChat {
  const env = process.env;
  const name = options.name ?? "web";
  const base = withoutTrailingSlashes(options.base ?? "/v1/web-chat");
  if (!base.startsWith("/")) throw new Error(`flow web chat: base is a path starting with /, not "${base}"`);
  const now = options.now ?? Date.now;
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const info: ChannelInfo = { ...WEB_CHAT, ...options.info };
  const listed = [...(options.origins ?? []), ...(env.FLOW_WEB_CHAT_ORIGINS ?? "").split(",")].map((o) => o.trim()).filter(Boolean);
  for (const origin of listed) if (!originPattern(origin)) throw new Error(`flow web chat: "${origin}" is not a site: give https://host, https://*.domain, or http://localhost:<port>`);
  const origins = listed.length ? [...new Set(listed.map((o) => withoutTrailingSlashes(o)))] : null;
  const patterns = origins?.map((o) => originPattern(o)!) ?? null;
  const sessionKey = options.sessionKey ?? env.FLOW_WEB_CHAT_SESSION_KEY ?? randomKey();
  if (sessionKey.length < 32) throw new Error("flow web chat: the session key needs at least 32 characters");
  const identityKeys = (Array.isArray(options.identityKey) ? options.identityKey : (options.identityKey ?? env.FLOW_WEB_CHAT_IDENTITY_KEY ?? "").split(",")).map((k) => k.trim()).filter(Boolean);
  if (identityKeys.some((k) => k.length < 32)) throw new Error("flow web chat: an identity key needs at least 32 characters");
  const proxies = options.trustProxy ?? (env.FLOW_TRUST_PROXY ? Number(env.FLOW_TRUST_PROXY) : 0);
  if (!Number.isInteger(proxies) || proxies < 0) throw new Error("flow web chat: trustProxy (FLOW_TRUST_PROXY) is how many proxies append to X-Forwarded-For: 0, 1, 2...");

  const perMinute = windows(60_000, now);
  const perDay = windows(24 * 3_600_000, now);
  const wrong = wrongTries();
  const boxes = new Map<string, Box>();
  const slots = turnSlots(limits.turnsAtOnce);
  let agent: ChannelAgent | null = null;
  let recheck: ReturnType<typeof setInterval> | null = null;
  let warnedAddress = false;

  function boxOf(address: string): Box {
    let box = boxes.get(address);
    if (!box) boxes.set(address, (box = { waiters: new Set(), live: { typing: false, status: null }, head: 0, open: 0, version: 0 }));
    return box;
  }
  /** Forgets a box nothing waits on and that shows nothing live. */
  function release(address: string): void {
    const box = boxes.get(address);
    if (box && !box.waiters.size && !box.open && !box.live.typing && box.live.status === null) boxes.delete(address);
  }
  function wake(address: string): void {
    const box = boxes.get(address);
    if (!box) return;
    box.version++;
    for (const waiter of box.waiters) waiter();
  }
  /** Resolves on news for the visitor since `seen` (their box's version when the reader last read), after `ms`, or when `signal` aborts. */
  function news(address: string, seen: number, ms: number, signal: AbortSignal): Promise<void> {
    const box = boxOf(address);
    if (box.version !== seen) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        box.waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      box.waiters.add(done);
      signal.addEventListener("abort", done);
      if (signal.aborted) done();
      watch();
    });
  }
  /**
   * While anyone waits, every 2 s one store call asks for the newest numbers of the visitors waiting
   * here, so what another runner kept (a deploy's overlap) reaches them too.
   */
  function watch(): void {
    if (recheck) return;
    recheck = setInterval(() => {
      const waiting = [...boxes].filter(([, box]) => box.waiters.size).map(([address]) => address);
      if (!waiting.length || !agent) {
        if (!waiting.length) clearInterval(recheck!), (recheck = null);
        return;
      }
      agent.store.webHeads(name, waiting).then(
        (heads) => {
          for (const [address, head] of Object.entries(heads)) {
            const box = boxes.get(address);
            if (box && head > box.head) (box.head = head), wake(address);
          }
        },
        () => undefined,
      );
    }, RECHECK_MS);
    recheck.unref?.();
  }

  async function keep(address: string, event: Record<string, unknown>, idempotencyKey: string | null): Promise<WebEventRow> {
    if (!agent) throw new Error("flow web chat: the channel is not on an agent yet");
    const row = await agent.store.appendWebEvent(name, address, event, idempotencyKey, now());
    const box = boxes.get(address);
    if (box && row.seq > box.head) box.head = row.seq;
    wake(address);
    return row;
  }

  function setLive(address: string, change: Partial<Box["live"]>): void {
    const box = boxOf(address);
    box.live = { ...box.live, ...change };
    wake(address);
    release(address);
  }

  /** The agent's sends: what the visitor reads goes to their outbox; typing and status live only. */
  async function send(address: string, outbound: Outbound): Promise<void | SendReceipt> {
    switch (outbound.type) {
      case "message": {
        const image = httpsPhoto(outbound.image);
        const row = await keep(address, {
          type: "message",
          from: "agent",
          text: outbound.text,
          ...(outbound.replyTo ? { replyTo: outbound.replyTo } : {}),
          ...(outbound.buttons?.length ? { buttons: outbound.buttons.map(replyButton) } : {}),
          ...(outbound.list ? { list: outbound.list } : {}),
          ...(outbound.link ? { link: outbound.link } : {}),
          ...(image ? { image } : {}),
        }, outbound.idempotencyKey ?? null);
        return { status: "sent", messageId: `a${row.seq}` };
      }
      case "carousel": {
        const cards = outbound.cards.flatMap((card) => webCard(card));
        const row = await keep(address, { type: "carousel", text: outbound.text, cards, ...(outbound.replyTo ? { replyTo: outbound.replyTo } : {}) }, outbound.idempotencyKey ?? null);
        return { status: "sent", messageId: `a${row.seq}` };
      }
      case "reaction":
        if (info.reactions) await keep(address, { type: "reaction", messageId: outbound.messageId, emoji: outbound.emoji }, null);
        return;
      case "typing":
        if (info.typing) setLive(address, { typing: outbound.on });
        return;
      case "status":
        if (info.status) setLive(address, { status: outbound.text });
        return;
      case "read":
        return;
      default:
        throw new Error(`the web chat cannot send a ${outbound.type}`);
    }
  }

  /** The client's address, as the trusted proxies say; null when none is trusted. */
  function addressOf(request: Request): string | null {
    if (!proxies) {
      if (!warnedAddress) console.warn("flow web chat: no trusted proxy (trustProxy, FLOW_TRUST_PROXY): limits per network address are off");
      warnedAddress = true;
      return null;
    }
    const hops = (request.headers.get("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    return hops.at(-proxies) ?? null;
  }

  function cors(request: Request): Record<string, string> | null {
    const origin = request.headers.get("origin");
    if (!origin) return {};
    if (patterns && !patterns.some((p) => p.test(origin))) return null;
    return { "access-control-allow-origin": origin, vary: "origin" };
  }

  function visitorOf(request: Request): Visitor | null {
    const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const claims = bearer ? verify(bearer, [sessionKey], SESSION_AUDIENCE, now()) : null;
    if (!claims || typeof claims.sub !== "string") return null;
    return { address: claims.sub, ...(typeof claims.key === "string" ? { key: claims.key } : {}) };
  }

  async function session(request: Request, headers: Record<string, string>): Promise<Response> {
    const body = await readJson(request);
    if (body === "too large") return problem(413, "too_large", `the body is at most ${MAX_BODY} bytes`, headers);
    if (!body || (body.visitor !== undefined && typeof body.visitor !== "string") || (body.identity !== undefined && typeof body.identity !== "string")) {
      return problem(400, "bad_request", "the body is JSON: { visitor?, identity? }", headers);
    }
    const ip = addressOf(request);
    const at = now();
    const answer = (visitor: Visitor, credential?: string) => {
      const expires = at + SESSION_MS;
      const token = sign({ aud: SESSION_AUDIENCE, sub: visitor.address, ...(visitor.key ? { key: visitor.key } : {}), exp: Math.floor(expires / 1000) }, sessionKey);
      return json(200, { session: token, expires_at: expires, signed_in: Boolean(visitor.key), ...(credential ? { visitor: credential } : {}), limits: { message_chars: limits.messageChars } }, headers);
    };
    if (typeof body.identity === "string") {
      if (ip && wrong.blocked(ip)) return problem(429, "rate_limited", "too many wrong identity tokens from this address; try again later", headers, 900);
      const claims = identityKeys.length ? verify(body.identity, identityKeys, IDENTITY_AUDIENCE, at) : null;
      const sub = claims?.sub;
      if (!claims || typeof sub !== "string" || !sub || sub.length > 200 || typeof claims.exp !== "number" || claims.exp * 1000 > at + IDENTITY_MAX_MS + 60_000) {
        if (ip) wrong.failed(ip);
        return problem(401, "identity_invalid", identityKeys.length ? "the identity token is not valid: an HS256 JWT { sub, aud: \"flow-web-chat\", exp } signed with the web chat's identity key, expiring within 10 minutes" : "this agent takes no identity tokens (no FLOW_WEB_CHAT_IDENTITY_KEY)", headers);
      }
      return answer({ address: `user:${sub}`, key: sub });
    }
    const known = typeof body.visitor === "string" ? verify(body.visitor, [sessionKey], VISITOR_AUDIENCE, at) : null;
    let address = typeof known?.sub === "string" && known.sub.startsWith("visitor:") ? known.sub : null;
    if (address) {
      if (!perMinute.take(`renew:${address}`, 30)) return problem(429, "rate_limited", "too many sessions for this visitor; try again in a minute", headers, 60);
    } else {
      if (ip && (!perMinute.take(`new:${ip}`, limits.newVisitorsPerMinute) || !perDay.take(`new:${ip}`, limits.newVisitorsPerDay))) {
        return problem(429, "rate_limited", "too many new chats from this address; try again later", headers, 60);
      }
      address = `visitor:${randomBytes(16).toString("base64url")}`;
    }
    const credential = sign({ aud: VISITOR_AUDIENCE, sub: address, exp: Math.floor((at + VISITOR_MS) / 1000) }, sessionKey);
    return answer({ address }, credential);
  }

  /** The events for a box, or `reset` when `after` cannot be continued (older events deleted, a number never given). */
  async function eventsAfter(address: string, after: number): Promise<{ events: WebChatEvent[]; cursor: number } | { reset: true }> {
    const { events, first, last } = await agent!.store.webEvents(name, address, after, 100);
    const box = boxes.get(address);
    if (box && last > box.head) box.head = last;
    if (after > last || (first !== null && after < first - 1) || (first === null && after < last)) return { reset: true };
    return { events: events.map(served), cursor: events.at(-1)?.seq ?? after };
  }

  async function history(visitor: Visitor, headers: Record<string, string>): Promise<Response> {
    if (!perMinute.take(`history:${visitor.address}`, 30)) return problem(429, "rate_limited", "too many history reads; try again in a minute", headers, 60);
    const { last } = await agent!.store.webEvents(name, visitor.address, 0, 0);
    const kept = await agent!.store.webEvents(name, visitor.address, Math.max(0, last - HISTORY), HISTORY);
    // Older than the outbox holds: the transcript, on this channel, before its oldest event.
    const since = kept.events[0]?.at ?? Infinity;
    const conversationId = await agent!.conversationOf({ channel: name, address: visitor.address });
    const entries = conversationId ? await agent!.transcript(conversationId) : [];
    const older = entries.filter((e) => e.at < since && "channel" in e && e.channel === name).flatMap((e, i) => fromTranscript(e, i)).slice(-HISTORY);
    return json(200, { messages: [...older, ...kept.events.map(served)], cursor: last }, headers);
  }

  async function events(request: Request, visitor: Visitor, headers: Record<string, string>): Promise<Response> {
    const url = new URL(request.url);
    const after = Number(url.searchParams.get("after"));
    if (!url.searchParams.has("after") || !Number.isSafeInteger(after) || after < 0) return problem(400, "bad_request", "give after=<seq>, from history or the last event", headers);
    const box = boxOf(visitor.address);
    if (box.open >= OPEN_PER_VISITOR) return problem(429, "rate_limited", "too many open chats for this visitor", headers, 5);
    box.open++;
    const close = () => {
      box.open--;
      release(visitor.address);
    };
    if ((request.headers.get("accept") ?? "").includes("text/event-stream")) return stream(request, visitor, after, headers, close);
    try {
      const wait = Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(url.searchParams.get("wait") ?? MAX_WAIT_SECONDS) || 0)) * 1000;
      const until = now() + wait;
      const live = JSON.stringify(box.live);
      for (;;) {
        const seen = box.version;
        const got = await eventsAfter(visitor.address, after);
        if ("reset" in got || got.events.length || JSON.stringify(box.live) !== live || now() >= until || request.signal.aborted) {
          return json(200, "reset" in got ? got : { ...got, live: box.live }, headers);
        }
        await news(visitor.address, seen, until - now(), request.signal);
      }
    } finally {
      close();
    }
  }

  /** Server-sent events: hello, each outbox event by its number, the live line, a ping every 15 s, and reconnect at 14 minutes. */
  function stream(request: Request, visitor: Visitor, after: number, headers: Record<string, string>, close: () => void): Response {
    const encoder = new TextEncoder();
    const stop = new AbortController();
    request.signal.addEventListener("abort", () => stop.abort());
    let cursor = after;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (text: string) => controller.enqueue(encoder.encode(text));
        const frame = (event: string, data: unknown, id?: number) => write(`${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const ends = now() + STREAM_MS;
        try {
          const { last } = await agent!.store.webEvents(name, visitor.address, 0, 0);
          frame("hello", { cursor: last });
          let live = "";
          let pinged = now();
          while (!stop.signal.aborted) {
            const seen = boxOf(visitor.address).version;
            const got = await eventsAfter(visitor.address, cursor);
            if ("reset" in got) {
              frame("reset", {});
              break;
            }
            for (const event of got.events) frame("message", event, event.seq);
            cursor = got.cursor;
            const shown = JSON.stringify(boxOf(visitor.address).live);
            if (shown !== live) frame("live", JSON.parse(shown)), (live = shown);
            if (now() >= ends) {
              frame("reconnect", { cursor });
              break;
            }
            if (now() - pinged >= PING_MS) write(": ping\n\n"), (pinged = now());
            await news(visitor.address, seen, Math.min(PING_MS - (now() - pinged), ends - now()), stop.signal);
          }
        } catch (error) {
          if (!stop.signal.aborted) console.warn("flow web chat: a stream ended:", error instanceof Error ? error.name : "unknown");
        } finally {
          close();
          try {
            controller.close();
          } catch {
            // The client left first.
          }
        }
      },
      cancel() {
        stop.abort();
      },
    });
    return new Response(body, { status: 200, headers: { ...headers, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
  }

  async function message(request: Request, visitor: Visitor, headers: Record<string, string>): Promise<Response> {
    const body = await readJson(request);
    if (body === "too large") return problem(413, "too_large", `the body is at most ${MAX_BODY} bytes`, headers);
    const bad = badMessage(body, limits.messageChars, patterns);
    if (bad) return problem(400, "bad_request", bad, headers);
    const m = body as { id: string; text: string; choice?: { id?: string; title: string }; page?: { url: string; title?: string }; context?: Record<string, unknown> };
    const signedIn = Boolean(visitor.key);
    const ip = addressOf(request);
    if (
      !perMinute.take(`msg:${visitor.address}`, signedIn ? limits.signedInMessagesPerMinute : limits.messagesPerMinute) ||
      !perDay.take(`msg:${visitor.address}`, signedIn ? limits.signedInMessagesPerDay : limits.messagesPerDay) ||
      (ip && !perMinute.take(`msg-ip:${ip}`, limits.messagesPerAddressPerMinute))
    ) {
      return problem(429, "rate_limited", "too many messages; wait a moment", headers, 60);
    }
    const choice = m.choice ? { ...(m.choice.id ? { id: m.choice.id } : {}), title: m.choice.title } : undefined;
    // Echoed into their outbox first, so every tab shows it, and before any reply to it.
    await keep(visitor.address, { type: "message", from: "person", id: m.id, text: choice?.title ?? m.text, ...(choice ? { choice } : {}) }, `in:${m.id}`);
    const day = new Date(now()).toISOString().slice(0, 10);
    if ((await agent!.store.webDay(name, day)) >= limits.messagesPerAgentPerDay) {
      await keep(visitor.address, { type: "message", from: "agent", text: options.busy?.text ?? BUSY_TEXT, ...(options.busy?.link ? { link: options.busy.link } : {}) }, `busy:${m.id}`);
      return json(202, { id: m.id, busy: true }, headers);
    }
    const page: PageContext | undefined = m.page || m.context ? { url: m.page?.url ?? "", ...(m.page?.title ? { title: m.page.title } : {}), ...(m.context ? { context: m.context } : {}) } : undefined;
    const taken = await agent!.message({
      channel: name,
      from: visitor.address,
      messageId: m.id,
      message: { text: choice?.title ?? m.text, ...(choice ? { choice } : {}), ...(page ? { page } : {}) },
      ...(visitor.key ? { key: visitor.key } : {}),
    });
    if (taken) {
      // 202 only once the store has it: a write that failed is asked for again.
      await agent!.stored(taken.conversationId);
      if (!(await agent!.store.inboundTaken(taken.conversationId, name, m.id))) return problem(503, "not_stored", "the message was not kept; send it again", headers, 1);
    }
    await agent!.store.countWebDay(name, day);
    return json(202, { id: m.id }, headers);
  }

  function route(handle: (request: Request, visitor: Visitor, headers: Record<string, string>) => Promise<Response>, method: "GET" | "POST", open = false) {
    return async (request: Request): Promise<Response> => {
      const headers = cors(request);
      if (!headers) return problem(403, "origin_not_allowed", "this site may not embed the chat: add it to webChat({ origins }) or FLOW_WEB_CHAT_ORIGINS");
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: { ...headers, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "authorization, content-type", "access-control-max-age": "600" } });
      }
      if (request.method !== method) return problem(405, "method_not_allowed", `use ${method}`, headers);
      if (!agent) return problem(503, "not_ready", "the web chat is starting", headers, 1);
      try {
        if (open) return await handle(request, { address: "" }, headers);
        const visitor = visitorOf(request);
        if (!visitor) return problem(401, "session_invalid", `start a session: POST ${base}/session`, headers);
        return await handle(request, visitor, headers);
      } catch (error) {
        console.warn("flow web chat: a request failed:", error instanceof Error ? error.message : "unknown");
        return problem(500, "failed", "that could not be done; try again", headers, 1);
      }
    };
  }

  const routes: Record<string, (request: Request) => Promise<Response>> = {
    "/session": route((request, _visitor, headers) => session(request, headers), "POST", true),
    "/history": route((_request, visitor, headers) => history(visitor, headers), "GET"),
    "/events": route(events, "GET"),
    "/messages": route(message, "POST"),
  };

  return {
    name,
    kind: "custom",
    traceChannel: "web",
    info,
    instructions: options.instructions,
    origins,
    base,
    send,
    turnSlot: limits.turnsAtOnce > 0 ? slots : undefined,
    serve(attached) {
      agent = attached;
      return {
        path: base,
        async handle(request) {
          const path = new URL(request.url).pathname.slice(base.length);
          const handler = routes[path];
          if (handler) return handler(request);
          const file = path === "/widget.js" ? "loader" : /^\/widget\/([a-z0-9-]+)\.js$/.exec(path)?.[1];
          if (file && (request.method === "GET" || request.method === "HEAD")) return widgetFile(file);
          return problem(404, "not_found", "no such web chat route");
        },
      };
    },
  };
}

/**
 * A signed-in visitor's identity token, made by your backend once it knows who they are: `sub` is
 * their key (the one your `resolve` gives on other channels), signed with FLOW_WEB_CHAT_IDENTITY_KEY,
 * valid `seconds` (default 300, at most 600). Any HS256 JWT library makes the same:
 * { sub, aud: "flow-web-chat", iat, exp }.
 */
export function webChatIdentity(input: { sub: string; key: string; seconds?: number; now?: number }): string {
  if (typeof input.key !== "string" || input.key.length < 32) throw new Error("webChatIdentity: the key needs at least 32 characters");
  if (typeof input.sub !== "string" || !input.sub || input.sub.length > 200) throw new Error("webChatIdentity: sub is the visitor's key, 1 to 200 characters");
  const seconds = Math.min(600, input.seconds ?? 300);
  const at = Math.floor((input.now ?? Date.now()) / 1000);
  return sign({ sub: input.sub, aud: IDENTITY_AUDIENCE, iat: at, exp: at + seconds }, input.key);
}

/** An outbox row as the box gets it: the agent's messages and carousels named by their number. */
function served(row: WebEventRow): WebChatEvent {
  const event = row.event as Record<string, unknown>;
  const id = event.type === "carousel" || (event.type === "message" && event.from === "agent") ? { id: `a${row.seq}` } : {};
  return { ...event, ...id, seq: row.seq, at: row.at } as WebChatEvent;
}

/** A transcript line as the box shows it (seq 0: from before what the outbox holds). */
function fromTranscript(e: TranscriptEntry, n: number): WebChatEvent[] {
  if (e.kind === "in") return [{ type: "message", from: "person", id: e.id, text: e.text, ...(e.choice ? { choice: { ...(e.choiceId ? { id: e.choiceId } : {}), title: e.text } } : {}), seq: 0, at: e.at }];
  if (e.kind !== "out" || e.template) return [];
  if (e.carousel) return [{ type: "carousel", id: `t${n}`, text: e.text, cards: e.carousel.flatMap(webCard), seq: 0, at: e.at }];
  const image = httpsPhoto(e.image);
  return [{
    type: "message",
    from: "agent",
    id: `t${n}`,
    text: e.text,
    ...(e.buttons?.length ? { buttons: e.buttons.map(replyButton) } : {}),
    ...(e.list ? { list: e.list } : {}),
    ...(e.link ? { link: e.link } : {}),
    ...(image ? { image } : {}),
    seq: 0,
    at: e.at,
  }];
}

/** A photo the box can show: by https URL only (a provider's file id means nothing to a browser). */
function httpsPhoto(photo: Photo | undefined): { url: string } | undefined {
  return photo && "url" in photo && /^https:\/\//i.test(photo.url) ? { url: photo.url } : undefined;
}

function webCard(card: CarouselCard) {
  const image = httpsPhoto(card.image);
  if (!image) return [];
  return [{ image, ...(card.text ? { text: card.text } : {}), ...(card.buttons?.length ? { buttons: card.buttons.map(replyButton) } : {}), ...(card.link ? { link: card.link } : {}) }];
}

/** An allowed site as a pattern for the Origin header, or null when it is not one. */
function originPattern(origin: string): RegExp | null {
  const m = /^(https):\/\/(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*)(:\d{1,5})?\/?$/i.exec(origin) ?? /^(http):\/\/()(localhost|127\.0\.0\.1)(:\d{1,5})?\/?$/i.exec(origin);
  if (!m) return null;
  const [, scheme, wildcard, host, port = ""] = m;
  const escaped = host.replace(/[.]/g, "\\.");
  return new RegExp(`^${scheme}://${wildcard ? "[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\." : ""}${escaped}${port}$`, "i");
}

/** Why a message body is refused, or null. */
function badMessage(body: Record<string, unknown> | undefined, maxChars: number, patterns: RegExp[] | null): string | null {
  if (!body) return "the body is a JSON object";
  if (body.attachments !== undefined) return "files are not taken on the web chat yet";
  if (typeof body.id !== "string" || !/^[\w.:-]{1,64}$/.test(body.id)) return "id: your own id for the message, 1 to 64 letters, digits, _ . : or -, the same when you send it again";
  if (typeof body.text !== "string" || [...body.text].length > maxChars) return `text: a string of at most ${maxChars} characters`;
  const choice = body.choice as Record<string, unknown> | undefined;
  if (choice !== undefined && (typeof choice !== "object" || choice === null || typeof choice.title !== "string" || !choice.title || choice.title.length > 100 || (choice.id !== undefined && (typeof choice.id !== "string" || choice.id.length > 64)))) {
    return "choice: { id?, title }, what they tapped";
  }
  if (!body.text.trim() && !choice) return "text is empty";
  const page = body.page as Record<string, unknown> | undefined;
  if (page !== undefined && (typeof page !== "object" || page === null || typeof page.url !== "string" || (page.title !== undefined && typeof page.title !== "string"))) return "page: { url, title? }, the page they wrote from";
  const context = body.context;
  if (context !== undefined && (typeof context !== "object" || context === null || Array.isArray(context))) return "context: an object of the page's details";
  if (JSON.stringify({ page, context }).length > MAX_PAGE) return `page and context: at most ${MAX_PAGE} bytes together`;
  if (page && patterns) {
    let origin = "";
    try {
      origin = new URL(page.url as string).origin;
    } catch {
      return "page.url is not a URL";
    }
    if (!patterns.some((p) => p.test(origin))) return "page.url is not on one of the agent's sites";
  }
  return null;
}

/** Counts per key in fixed windows of `ms`. */
function windows(ms: number, now: () => number) {
  const counts = new Map<string, { count: number; until: number }>();
  return {
    take(key: string, most: number): boolean {
      const at = now();
      if (counts.size > 50_000) for (const [k, v] of counts) if (v.until <= at) counts.delete(k);
      const entry = counts.get(key);
      if (!entry || entry.until <= at) {
        counts.set(key, { count: 1, until: at + ms });
        return true;
      }
      return ++entry.count <= most;
    },
  };
}

/** At most `most` web chat turns at once: a turn waits for a slot, and gives it back when done. */
function turnSlots(most: number): () => Promise<() => void> {
  let running = 0;
  const waiting: Array<() => void> = [];
  return () =>
    new Promise((resolve) => {
      const go = () => {
        running++;
        let given = false;
        resolve(() => {
          if (given) return;
          given = true;
          running--;
          waiting.shift()?.();
        });
      };
      if (running < most) go();
      else waiting.push(go);
    });
}

/** The chat box's files: built (dist/widget/src/<name>.js), or from source with their types stripped. */
const widgetFiles = new Map<string, Promise<string | null>>();
async function widgetFile(name: string): Promise<Response> {
  let file = widgetFiles.get(name);
  if (!file) {
    file = (async () => {
      const at = new URL(`../widget/src/${name}`, import.meta.url);
      const built = await readFile(new URL(`${at.href}.js`), "utf8").catch(() => null);
      if (built !== null) return built;
      const source = await readFile(new URL(`${at.href}.ts`), "utf8").catch(() => null);
      if (source === null) return null;
      const { stripTypeScriptTypes } = (await import("node:module")) as { stripTypeScriptTypes?: (code: string) => string };
      return stripTypeScriptTypes ? stripTypeScriptTypes(source) : null;
    })();
    widgetFiles.set(name, file);
  }
  const text = await file;
  if (text === null) return problem(404, "not_found", "no such widget file");
  return new Response(text, { status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } });
}

function randomKey(): string {
  console.warn("flow web chat: no FLOW_WEB_CHAT_SESSION_KEY: sessions and anonymous visitors last until this process stops");
  return randomBytes(32).toString("base64url");
}

const b64 = (data: string | Buffer) => Buffer.from(data).toString("base64url");

function sign(claims: Record<string, unknown>, key: string): string {
  const head = `${b64(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64(JSON.stringify(claims))}`;
  return `${head}.${createHmac("sha256", key).update(head).digest("base64url")}`;
}

/** The claims of an HS256 JWT signed with one of `keys`, for `audience`, not expired; else null. */
function verify(token: string, keys: string[], audience: string, at: number): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, signature] = parts;
  if (!keys.some((key) => sameSecret(signature, createHmac("sha256", key).update(`${head}.${body}`).digest("base64url")))) return null;
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

async function readJson(request: Request): Promise<Record<string, unknown> | undefined | "too large"> {
  const text = await request.text().catch(() => "");
  if (Buffer.byteLength(text) > MAX_BODY) return "too large";
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

function problem(status: number, error: string, message: string, headers: Record<string, string> = {}, retryAfter?: number): Response {
  return json(status, { error, message, ...(retryAfter !== undefined ? { retry_after: retryAfter } : {}) }, retryAfter !== undefined && status === 429 ? { ...headers, "retry-after": String(retryAfter) } : headers);
}

