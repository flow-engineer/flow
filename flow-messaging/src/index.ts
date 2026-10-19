// Flow Framework channels on Flow Messaging (api.flow.engineer), Flow's unified messaging API: WhatsApp,
// Telegram, iMessage and US SMS from senders Flow hosts. Events reach the agent one of two ways: the live
// stream (an outbound WebSocket, so a laptop needs no public URL or tunnel) or a webhook that checks
// Flow's signature. Both hand each event to the same handler.
//
//   const fm = flowMessaging();                    // FLOW_MESSAGING_KEY (and FLOW_MESSAGING_WEBHOOK_SECRET for a webhook)
//   const agent = createAgent({ ..., channels: [fm.whatsapp(), fm.telegram(), fm.imessage(), fm.sms()] });
//   fm.start(agent);                               // the stream, or the webhook on PORT when a webhook secret is set
//
// Addresses are what Flow Framework joins people by: the phone number on WhatsApp and SMS, the numeric
// user id on Telegram, the phone number on iMessage, else the email address that is the person's
// handle there. A reply goes into the Flow conversation the person last wrote in; with none known
// yet (a nudge, or after a restart) it starts one from the channel's sender, which Flow puts into the
// open conversation if there is one. On Flow's shared iMessage sender, as on WhatsApp after 24
// hours, the agent can only answer someone who wrote first: a start to anyone else fails. What this process learns (conversations, contacts,
// event ids) is kept in memory only.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { sms as smsChannel, whatsapp as whatsappChannel, type Agent, type Attachment, type Channel, type ChannelInfo, type Incoming, type Message, type Template, type WhatsAppFeature } from "../../src/index.ts";
import { Client, FlowMessagingError, idSegment, verifySignature } from "./client.ts";

export { API_VERSION, FlowMessagingError, verifySignature } from "./client.ts";

export interface FlowMessagingOptions {
  /** The app's API key, `fk_live_...` or `fk_test_...`. Default: FLOW_MESSAGING_KEY (or the older FLOW_MESSAGING_API_KEY). */
  apiKey?: string;
  /** The webhook endpoint's signing secret(s), comma-separated while one is rotated. Default: FLOW_MESSAGING_WEBHOOK_SECRET. */
  webhookSecret?: string;
  /** Default: FLOW_MESSAGING_BASE_URL (or the older FLOW_MESSAGING_API_URL), else https://api.flow.engineer. */
  baseUrl?: string;
}

export interface FlowChannelOptions {
  /** The Flow sender (`snd_...`) this channel starts conversations from. Default: FLOW_MESSAGING_<CHANNEL>_SENDER. */
  sender?: string;
  /** The agent's name for the channel. Default: whatsapp, telegram, imessage or sms. */
  name?: string;
  instructions?: string;
}

type Kind = "whatsapp" | "telegram" | "imessage" | "sms";
interface Route {
  kind: Kind;
  name: string;
  sender?: string;
}
/** What the webhook and the stream need of an agent. */
export type WebhookAgent = Pick<Agent, "message" | "reacted" | "undelivered">;

export interface StreamOptions {
  /**
   * A file that keeps the ID of the last event the agent handled, so a restart resumes after it and
   * Flow replays what arrived while the agent was away (for as long as the plan keeps events, 30 days
   * by default). Without it the cursor is in memory: a dropped stream still resumes, a restart starts from now.
   */
  cursorFile?: string;
}

/** Why the stream stopped for good: Flow refused the key or the request, so reconnecting cannot help. */
export interface StreamStop {
  /** The WebSocket close code, such as 4401 (authentication) or 4403 (permission). */
  code: number;
  type: string;
  message: string;
}

export interface StreamHandle {
  /** Closes the stream and waits for the event being handled. */
  close(): Promise<void>;
  /** Resolves when Flow refused the stream for good (a bad or revoked key, say); never after close(). */
  stopped: Promise<StreamStop>;
}

/** Telegram as Flow sends it: an inline keyboard of up to 10 buttons (or one link), photos, Markdown, no read receipts for bots. */
export const TELEGRAM: ChannelInfo = {
  reactions: true,
  status: false,
  formatting: "markdown",
  maxLength: 4096,
  replies: true,
  buttons: { max: 10, labelMax: 20 },
  linkButton: { labelMax: 20 },
  images: { captionMax: 1024 },
  readReceipts: false,
};

/**
 * iMessage as Flow sends it: plain text up to 9999 characters, photos, inline replies, tapbacks
 * (other emoji go as emoji reactions), typing and read receipts (the whole conversation). No buttons,
 * lists or templates. No reply window is set: the line only answers people who wrote to it, and a
 * send it will not deliver comes back as Not delivered (outside_window).
 */
export const IMESSAGE: ChannelInfo = {
  reactions: true,
  status: false,
  formatting: "plain",
  maxLength: 9999,
  replies: true,
  images: { captionMax: 1024 },
  readReceipts: true,
};

/** Flow sends a list as buttons, whose labels take at most 20 characters, and has no row descriptions. */
const LIST_TITLE_MAX = 20;
const MAX_BODY_BYTES = 1_000_000;
/** Event ids remembered to drop Flow's redeliveries (deliveries are at least once). */
const SEEN_MAX = 10_000;
/** The events the handler acts on; the stream asks for only these. */
const HANDLED = ["message.received", "message.failed", "reaction.added", "contact.deleted"];
/** The longest wait between two tries to reconnect the stream (ms). */
const STREAM_BACKOFF_MAX = 30_000;
/** Tries of one event before the stream gives up on it and goes on to the next. */
const STREAM_EVENT_TRIES = 5;
/** Close codes after which reconnecting unchanged fails again: authentication, permission, a bad request. */
const STREAM_FINAL = new Set([4401, 4403, 4400]);

interface FlowMessage {
  id: string;
  conversation: string;
  direction: "in" | "out";
  content: Record<string, unknown> & { type: string };
  reply_to?: string;
  error?: { type?: string; message?: string; channel_code?: string };
}
interface FlowEvent {
  id: string;
  type: string;
  conversation?: { id: string; channel: string; sender: string; contact: string };
  data?: { message?: FlowMessage; message_id?: string; emoji?: string; contact?: string };
}

export function flowMessaging(options: FlowMessagingOptions = {}) {
  const env = (...names: string[]) => names.map((n) => process.env[n]).find(Boolean);
  const apiKey = options.apiKey ?? env("FLOW_MESSAGING_KEY", "FLOW_MESSAGING_API_KEY") ?? "";
  const secrets = (options.webhookSecret ?? process.env.FLOW_MESSAGING_WEBHOOK_SECRET ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const client = new Client({ apiKey, baseUrl: options.baseUrl ?? env("FLOW_MESSAGING_BASE_URL", "FLOW_MESSAGING_API_URL") ?? "https://api.flow.engineer" });

  const routes: Route[] = [];
  const flowConversation = new Map<string, string>(); // channel + address -> Flow conversation id
  const frameworkConversation = new Map<string, string>(); // channel + address -> Flow Framework conversation id
  const contacts = new Map<string, string>(); // Flow contact id -> address
  const templates = new Map<string, Array<{ id: string; name: string; language: string }>>(); // sender -> approved templates
  const seen = new Set<string>();
  const handling = new Map<string, Promise<void>>();
  const key = (channel: string, address: string) => `${channel}\u0000${address}`;

  function register(kind: Kind, o: FlowChannelOptions): Route {
    const route: Route = { kind, name: o.name ?? kind, sender: o.sender ?? (process.env[`FLOW_MESSAGING_${kind.toUpperCase()}_SENDER`] || undefined) };
    routes.push(route);
    return route;
  }

  /** The Flow conversation to send into: the one the person wrote in, else the one a message they quote is in. */
  async function conversationFor(channel: string, to: string, messageId?: string): Promise<string | undefined> {
    const known = flowConversation.get(key(channel, to));
    if (known || !messageId) return known;
    const found = (await client.get<FlowMessage>(`/v1/messages/${idSegment("msg", messageId)}`)).conversation;
    flowConversation.set(key(channel, to), found);
    return found;
  }

  function recipient(kind: Kind, to: string): Record<string, string> {
    if (to.startsWith("ct_")) return { contact: to };
    if (kind === "telegram") return { telegram_user_id: to };
    if (kind === "imessage" && !/^\+?[0-9]{7,15}$/.test(to)) return { handle: to }; // an email address
    return { phone: to.startsWith("+") ? to : `+${to}` };
  }

  /** One message: into the person's conversation, or a new one from the channel's sender. */
  async function send(route: Route, to: string, content: Record<string, unknown>, replyTo?: string, about = replyTo, idempotencyKey?: string): Promise<void> {
    try {
      const conversation = await conversationFor(route.name, to, about);
      let sent: FlowMessage;
      if (conversation) sent = await client.post(`/v1/conversations/${idSegment("conv", conversation)}/messages`, { content, ...(replyTo ? { reply_to: replyTo } : {}) }, undefined, idempotencyKey);
      else {
        if (!route.sender) throw new Error(`no conversation with them on ${route.name} yet, and no sender to start one (set FLOW_MESSAGING_${route.kind.toUpperCase()}_SENDER)`);
        sent = await client.post("/v1/messages", { sender: route.sender, to: recipient(route.kind, to), content }, undefined, idempotencyKey);
      }
      flowConversation.set(key(route.name, to), sent.conversation);
    } catch (error) {
      throw error instanceof FlowMessagingError ? new Error(reason(error)) : error;
    }
  }

  /**
   * Typing and read receipts are a courtesy: Flow's spec says to ignore their failures. Outside the
   * window (iMessage and WhatsApp until the person writes) they are expected to be refused, so that
   * is not logged; any other failure is, once.
   */
  async function courtesy(route: Route, to: string, action: "typing" | "read", body: Record<string, unknown>, messageId?: string): Promise<void> {
    try {
      const conversation = await conversationFor(route.name, to, messageId);
      if (conversation) await client.post(`/v1/conversations/${idSegment("conv", conversation)}/${action}`, body, 1);
    } catch (error) {
      if (error instanceof FlowMessagingError && error.type === "outside_window") return;
      console.warn(`@flow-engineer/flow/flow-messaging: ${action} on ${route.name} failed (${error instanceof FlowMessagingError ? error.type : "error"})`);
    }
  }

  /**
   * A message as Flow content. A link is a url button (WhatsApp's cta_url), a photo a media message
   * with the text as its caption. Flow's button messages have no image header, so a photo with
   * buttons or a link goes just before them, on its own.
   */
  function contents(kind: Kind, message: Message): Array<Record<string, unknown>> {
    const buttons = message.link
      ? [{ url: message.link.url, label: message.link.label }]
      : message.buttons?.length
        ? message.buttons.map((label) => ({ id: label, label }))
        : message.list?.rows.map((row) => ({ id: row.id, label: row.title }));
    const photo = message.image && { type: "media", kind: "image", url: message.image.url };
    if (photo && !buttons) return [{ ...photo, ...(message.text ? { caption: message.text } : {}) }];
    const main = buttons ? { type: "buttons", text: message.text, buttons } : { type: "text", text: message.text, format: kind === "telegram" ? "markdown" : "plain" };
    return photo ? [photo, main] : [main];
  }

  async function template(sender: string, wanted: Template): Promise<{ id: string; language: string }> {
    if (wanted.name.startsWith("tpl_")) {
      if (!wanted.language) throw new Error(`template ${wanted.name} needs its language`);
      return { id: wanted.name, language: wanted.language };
    }
    const find = () => templates.get(sender)?.find((t) => t.name === wanted.name && (!wanted.language || t.language === wanted.language));
    if (!find()) {
      const all: Array<{ id: string; name: string; language: string }> = [];
      let after = "";
      for (;;) {
        const page = await client.get<{ data: typeof all; has_more: boolean }>(`/v1/templates?${new URLSearchParams({ sender: idSegment("snd", sender), status: "approved", limit: "100", ...(after ? { after } : {}) })}`);
        all.push(...page.data);
        if (!page.has_more || !page.data.length) break;
        after = page.data.at(-1)!.id;
      }
      templates.set(sender, all);
    }
    const found = find();
    if (!found) throw new Error(`no approved template named ${wanted.name}${wanted.language ? ` in ${wanted.language}` : ""} on this sender`);
    return found;
  }

  function provider(route: Route) {
    return {
      sendMessage: async (to: string, message: Message) => {
        const [first, ...rest] = contents(route.kind, message);
        const key = message.idempotencyKey;
        await send(route, to, first, message.replyTo, message.replyTo, key);
        for (const [i, next] of rest.entries()) await send(route, to, next, undefined, undefined, key && `${key}:${i + 1}`);
      },
      react: (to: string, messageId: string, emoji: string) => send(route, to, { type: "reaction", message_id: messageId, emoji }, undefined, messageId),
      typing: (to: string, on: boolean) => courtesy(route, to, "typing", { state: on ? "on" : "off" }),
      markRead: (to: string, messageIds: string[]) => courtesy(route, to, "read", { up_to: messageIds.at(-1) }, messageIds.at(-1)),
      sendTemplate: async (to: string, wanted: Template, idempotencyKey?: string) => {
        if (!route.sender) throw new Error(`a template needs the channel's sender (set FLOW_MESSAGING_${route.kind.toUpperCase()}_SENDER)`);
        const found = await template(route.sender, wanted);
        const params = templateParams(wanted);
        await send(route, to, { type: "template", template_id: found.id, language: wanted.language ?? found.language, ...(Object.keys(params).length ? { params } : {}) }, undefined, undefined, idempotencyKey);
      },
    };
  }

  /** WhatsApp from a Flow sender: buttons (a list past 3), lists, link buttons, photos, quotes, reactions, typing, blue ticks, templates. */
  function whatsapp(o: FlowChannelOptions & { disable?: WhatsAppFeature[] } = {}): Channel {
    const route = register("whatsapp", o);
    const channel = whatsappChannel(provider(route), { name: route.name, disable: o.disable, instructions: o.instructions });
    return { ...channel, info: { ...channel.info, ...(channel.info.lists ? { lists: { ...channel.info.lists, titleMax: LIST_TITLE_MAX } } : {}) } };
  }

  /** US SMS from a Flow number: plain text; STOP, START and HELP are Flow's. */
  function sms(o: FlowChannelOptions = {}): Channel {
    const route = register("sms", o);
    return smsChannel(provider(route), { name: route.name, instructions: o.instructions });
  }

  /** A Telegram bot connected to Flow. Flow Framework has no Telegram kind yet, so it is a custom channel. */
  function telegram(o: FlowChannelOptions = {}): Channel {
    return custom(register("telegram", o), TELEGRAM, o);
  }

  /**
   * An iMessage line connected to Flow (Flow's shared one by default). Flow Framework has no iMessage
   * kind yet, so it is a custom channel. Its addresses are not marked as phone numbers, since a handle
   * may be an email address: the person on iMessage is their own, not joined with their WhatsApp or SMS.
   */
  function imessage(o: FlowChannelOptions = {}): Channel {
    return custom(register("imessage", o), IMESSAGE, o);
  }

  /** A Flow channel Flow Framework has no kind for: text, quotes, buttons and links as `info` allows, photos, reactions, typing, read receipts. */
  function custom(route: Route, info: ChannelInfo, o: FlowChannelOptions): Channel {
    const p = provider(route);
    return {
      name: route.name,
      kind: "custom",
      info,
      instructions: o.instructions,
      send: (to, outbound) => {
        switch (outbound.type) {
          case "message":
            return p.sendMessage(to, {
              text: outbound.text,
              ...(outbound.replyTo ? { replyTo: outbound.replyTo } : {}),
              ...(outbound.buttons && info.buttons ? { buttons: outbound.buttons } : {}),
              ...(outbound.link && info.linkButton ? { link: outbound.link } : {}),
              ...(outbound.image && info.images ? { image: outbound.image } : {}),
              ...(outbound.idempotencyKey ? { idempotencyKey: outbound.idempotencyKey } : {}),
            });
          case "reaction":
            return p.react(to, outbound.messageId, outbound.emoji);
          case "typing":
            return p.typing(to, outbound.on);
          case "read":
            return info.readReceipts ? p.markRead(to, outbound.messageIds) : undefined; // Telegram bots cannot send them
          case "template":
            throw new Error(`${route.kind === "telegram" ? "Telegram" : "iMessage"} has no templates`);
          // status: neither has a status line.
        }
      },
    };
  }

  // ---- the webhook ----

  function routeOf(event: FlowEvent) {
    const c = event.conversation;
    if (!c) return undefined;
    return routes.find((r) => r.sender === c.sender) ?? routes.find((r) => r.kind === c.channel && !r.sender);
  }

  async function addressOf(route: { kind: Kind }, contactId: string): Promise<string> {
    const known = contacts.get(contactId);
    if (known) return known;
    const contact = await client.get<{ address?: { phone?: string; telegram_user_id?: string; handle?: string } }>(`/v1/contacts/${idSegment("ct", contactId)}`);
    const a = contact.address;
    const address = (route.kind === "telegram" ? a?.telegram_user_id : route.kind === "imessage" ? (a?.phone ?? a?.handle) : a?.phone) ?? contactId;
    contacts.set(contactId, address);
    return address;
  }

  async function quoted(id: string): Promise<{ text: string; fromAgent: boolean } | undefined> {
    try {
      const m = await client.get<FlowMessage>(`/v1/messages/${idSegment("msg", id)}`);
      const text = textOf(m.content);
      return text ? { text, fromAgent: m.direction === "out" } : undefined;
    } catch {
      return undefined; // past Flow's retention, or not known to it: the message reads without the quote
    }
  }

  async function incoming(m: FlowMessage): Promise<Incoming | null> {
    const c = m.content;
    let base: Incoming;
    if (c.type === "text") base = { text: String(c.text ?? "") };
    else if (c.type === "button_reply") {
      const id = String(c.button_id ?? "");
      const title = String(c.label ?? id);
      base = { text: title, choice: id && id !== title ? { id, title } : { title } };
    } else if (c.type === "voice" && c.transcript) base = { text: String(c.transcript) }; // Flow transcribed it already
    else if ((c.type === "voice" || c.type === "media") && c.file_id && c.kind !== "video") {
      // Photos, audio and documents go as attachments, their bytes fetched from Flow only when the agent can use them.
      const kind = c.type === "voice" || c.kind === "audio" ? "audio" : c.kind === "image" ? "image" : "document";
      const fileId = String(c.file_id);
      const attachment: Attachment = { kind, mime: String(c.mime_type ?? "application/octet-stream"), ...(c.filename ? { name: String(c.filename) } : {}), data: () => client.download(fileId) };
      base = { text: String(c.caption ?? ""), attachments: [attachment] };
    } else if (c.type === "media" || c.type === "file_blocked") {
      // A video (Flow Framework reads none), or a file Flow did not keep: the caption, and what it was.
      const what = String(c.kind ?? "file");
      base = { text: [c.caption, c.type === "file_blocked" ? `[${what}: not received (${String(c.reason)})]` : `[${what}]`].filter(Boolean).join(" ") };
    } else if (c.type === "location") base = { text: `[location: ${[c.name, c.address].filter(Boolean).join(", ")} (${c.lat}, ${c.lng})]` };
    else if (c.type === "contact_card") base = { text: `[contact: ${String(c.name ?? "")}]` };
    else return null; // reactions arrive as reaction.added
    if (m.reply_to) {
      const replyTo = await quoted(m.reply_to);
      if (replyTo) base.replyTo = replyTo;
    }
    return base;
  }

  async function handle(agent: WebhookAgent, event: FlowEvent): Promise<void> {
    if (event.type === "contact.deleted") {
      // Flow erased the contact and their conversations: forget what this process keeps about them.
      const id = event.data?.contact;
      if (!id) return;
      const address = contacts.get(id);
      contacts.delete(id);
      for (const r of routes) {
        for (const a of address ? [address, id] : [id]) {
          flowConversation.delete(key(r.name, a));
          frameworkConversation.delete(key(r.name, a));
        }
      }
      return;
    }
    const route = routeOf(event);
    if (!route || !event.conversation) return;
    const address = await addressOf(route, event.conversation.contact);
    const person = key(route.name, address);
    if (event.type === "message.received" && event.data?.message) {
      flowConversation.set(person, event.conversation.id);
      const message = await incoming(event.data.message);
      if (!message) return;
      const arrived = await agent.message({ channel: route.name, from: address, message, messageId: event.data.message.id });
      if (arrived) frameworkConversation.set(person, arrived.conversationId);
      return;
    }
    const conversationId = frameworkConversation.get(person);
    if (!conversationId) return; // not heard from since this process started: nothing to tell
    if (event.type === "reaction.added" && event.data?.message_id && event.data.emoji) {
      const target = await quoted(event.data.message_id);
      if (target?.fromAgent) agent.reacted(conversationId, event.data.emoji, target.text);
    } else if (event.type === "message.failed" && event.data?.message) {
      const m = event.data.message;
      const text = textOf(m.content);
      const type = m.error?.type ?? "channel_error";
      if (text) agent.undelivered(conversationId, text, reason({ type, channelCode: m.error?.channel_code, message: m.error?.message ?? "The channel did not take it.", retryable: type === "api_error" || type === "rate_limited" }));
    }
  }

  /** Hands one event to the agent once: a redelivery (or the same event by webhook and stream) is dropped. */
  async function once(agent: WebhookAgent, event: FlowEvent): Promise<void> {
    if (seen.has(event.id)) return;
    let handled = handling.get(event.id);
    if (!handled) {
      handled = handle(agent, event).finally(() => handling.delete(event.id));
      handling.set(event.id, handled);
    }
    await handled;
    seen.add(event.id);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value!);
  }

  const failed = (event: FlowEvent, error: unknown) =>
    console.warn(`@flow-engineer/flow/flow-messaging: event ${event.id} (${event.type}) failed: ${error instanceof FlowMessagingError ? error.type : error instanceof Error ? error.name : "error"}`);

  /**
   * One delivery: checks Flow-Signature, drops a redelivered event, hands the event to the agent.
   * 2xx tells Flow it arrived; a failure answers 500, so Flow delivers it again.
   */
  const noSecret = () => new Error("@flow-engineer/flow/flow-messaging: set FLOW_MESSAGING_WEBHOOK_SECRET (or pass webhookSecret)");

  async function receive(agent: WebhookAgent, request: { body: Buffer | string; headers: Record<string, string | string[] | undefined> }): Promise<{ status: number; body: string }> {
    if (!secrets.length) throw noSecret();
    const raw = typeof request.body === "string" ? Buffer.from(request.body) : request.body;
    const signature = request.headers["flow-signature"];
    if (!verifySignature(raw, Array.isArray(signature) ? signature.join(",") : signature, secrets)) return { status: 401, body: '{"error":"bad signature"}' };
    let event: FlowEvent;
    try {
      event = JSON.parse(raw.toString("utf8")) as FlowEvent;
    } catch {
      return { status: 400, body: '{"error":"not JSON"}' };
    }
    if (typeof event?.id !== "string" || typeof event.type !== "string") return { status: 400, body: '{"error":"not an event"}' };
    try {
      await once(agent, event);
      return { status: 200, body: "{}" };
    } catch (error) {
      failed(event, error);
      return { status: 500, body: '{"error":"failed"}' };
    }
  }

  /** A Node http handler for the webhook endpoint: give it the requests to the URL Flow posts to. */
  function webhook(agent: WebhookAgent) {
    if (!secrets.length) throw noSecret();
    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const answer = (status: number, body: string) => res.writeHead(status, { "content-type": "application/json" }).end(body);
      if (req.method !== "POST") return void answer(405, '{"error":"POST only"}');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) return void answer(413, '{"error":"too large"}');
        chunks.push(chunk as Buffer);
      }
      const result = await receive(agent, { body: Buffer.concat(chunks), headers: req.headers });
      answer(result.status, result.body);
    };
  }

  // ---- the stream ----

  /**
   * The live event stream (GET /v1/stream): an outbound WebSocket, so the agent needs no public URL.
   * Events are handled one at a time, in log order, by the webhook's handler. There is no ack frame
   * for events: the stream resumes from `after`, so an event counts as acknowledged once the agent
   * has handled it and the cursor (in memory, or `cursorFile`) has moved past it. A failed event, a
   * dropped socket or Flow's `reconnect` frame reconnects from that cursor, and Flow replays what
   * came after it: at once the first time, then with a backoff up to 30 s, or after Flow's
   * retry_after. An event that fails 5 times in a row is passed over, so it cannot hold up every
   * later one. A refused key or request stops the stream (`stopped`). Replies go over HTTP
   * (with Idempotency-Keys), so they do not depend on the stream being up.
   */
  function stream(agent: WebhookAgent, o: StreamOptions = {}): StreamHandle {
    if (!apiKey) throw new Error("@flow-engineer/flow/flow-messaging: set FLOW_MESSAGING_KEY (or pass apiKey) to open the stream");
    let cursor = o.cursorFile ? readCursor(o.cursorFile) : undefined;
    let socket: WebSocket | undefined;
    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    let tries = 0;
    let failing: { id: string; times: number } | undefined;
    let generation = 0;
    let queue = Promise.resolve();
    let stop!: (reason: StreamStop) => void;
    const stopped = new Promise<StreamStop>((resolve) => (stop = resolve));

    const moveCursor = (id: string | undefined) => {
      cursor = id;
      if (o.cursorFile) writeCursor(o.cursorFile, id);
    };

    function connect(): void {
      const mine = ++generation;
      const url = new URL(`${client.baseUrl.replace(/^http/, "ws")}/v1/stream`);
      if (cursor) url.searchParams.set("after", cursor);
      for (const type of HANDLED) url.searchParams.append("type", type);
      // Node's WebSocket cannot set headers: the key goes as a subprotocol beside "flow", which Flow selects.
      const ws = new WebSocket(url, ["flow", `flow.key.${apiKey}`]);
      socket = ws;
      let refusal: { type?: string; message?: string; param?: string; retry_after?: number } | undefined;
      ws.onopen = () => {
        if (!failing) tries = 0; // a failing event keeps its backoff across reconnects
      };
      ws.onmessage = (message) => {
        let frame: { type?: string; event?: FlowEvent; error?: typeof refusal; ref?: string };
        try {
          frame = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (frame.type === "event" && frame.event && typeof frame.event.id === "string") {
          const event = frame.event;
          queue = queue.then(() => take(event, mine, ws));
        } else if (frame.type === "error" && !frame.ref) refusal = frame.error ?? {};
      };
      ws.onerror = () => {}; // a close always follows
      ws.onclose = ({ code, reason }) => {
        if (socket === ws) socket = undefined;
        if (closed || mine !== generation) return;
        if (STREAM_FINAL.has(code)) {
          if (code === 4400 && refusal?.param === "after" && cursor) {
            // The cursor's event has left Flow's log (past retention): start again from now.
            console.warn("@flow-engineer/flow/flow-messaging: the last handled event is no longer in Flow's log; the stream starts again from now");
            moveCursor(undefined);
            return void later(0);
          }
          closed = true;
          const type = refusal?.type ?? (code === 4401 ? "authentication" : code === 4403 ? "permission" : "invalid_request");
          const why = refusal?.message ?? reason ?? "Flow Messaging refused the stream.";
          console.warn(`@flow-engineer/flow/flow-messaging: the stream stopped: ${type} (${code})`);
          return void stop({ code, type, message: why });
        }
        // 1012 follows a reconnect frame: at once. 4429 and 45xx say when (retry_after). Else back off.
        if (code === 1012) return void later(0);
        if (refusal?.retry_after !== undefined) return void later(refusal.retry_after * 1000);
        later(Math.min(STREAM_BACKOFF_MAX, tries === 0 ? 0 : 1000 * 2 ** (tries - 1)));
        tries++;
      };
    }

    function later(ms: number): void {
      if (closed) return;
      timer = setTimeout(connect, ms);
    }

    /** Handles one event of connection `mine`; one that fails makes the stream reconnect from the cursor. */
    async function take(event: FlowEvent, mine: number, ws: WebSocket): Promise<void> {
      if (closed || mine !== generation) return; // a newer connection replays it from the cursor
      try {
        await once(agent, event);
      } catch (error) {
        failed(event, error);
        const times = failing?.id === event.id ? failing.times + 1 : 1;
        if (times < STREAM_EVENT_TRIES) {
          failing = { id: event.id, times };
          if (mine === generation) ws.close(1000, "event failed; resuming");
          return;
        }
        console.warn(`@flow-engineer/flow/flow-messaging: event ${event.id} failed ${times} times; going on without it (it stays in Flow's log, GET /v1/events)`);
      }
      failing = undefined;
      tries = 0;
      moveCursor(event.id);
    }

    connect();
    return {
      stopped,
      async close() {
        closed = true;
        clearTimeout(timer);
        socket?.close(1000, "closing");
        await queue;
      },
    };
  }

  /**
   * Starts receiving events: the webhook on `port` (default PORT, else 8080) when a webhook secret is
   * set, which means Flow posts to a public URL; otherwise the stream, which needs no URL.
   */
  function start(agent: WebhookAgent, o: StreamOptions & { port?: number } = {}): StreamHandle & { mode: "webhook" | "stream" } {
    if (!secrets.length) return { mode: "stream", ...stream(agent, o) };
    const server = createServer(webhook(agent)).listen(o.port ?? Number(process.env.PORT ?? 8080));
    return { mode: "webhook", stopped: new Promise<StreamStop>(() => {}), close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  return { whatsapp, telegram, imessage, sms, webhook, receive, stream, start };
}

function readCursor(file: string): string | undefined {
  try {
    const id = readFileSync(file, "utf8").trim();
    return /^evt_[A-Za-z0-9_]+$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function writeCursor(file: string, id: string | undefined): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, id ? `${id}\n` : "");
}

/** The text of a message's content, as the agent knew it. */
function textOf(content: Record<string, unknown> | undefined): string {
  if (!content) return "";
  return String(content.text ?? content.caption ?? content.label ?? "");
}

/** A template's values as Flow's `params`: header, body (or the older `variables`, by number) and button values, each only when given. */
function templateParams(t: Template): Record<string, unknown> {
  const h = t.header;
  const header = !h ? undefined : h.kind === "text" ? { kind: "text", text: h.text } : { kind: h.kind, ...(h.url ? { url: h.url } : {}), ...(h.fileId ? { file_id: h.fileId } : {}) };
  let body = t.body;
  if (!body) {
    const values = Object.entries(t.variables ?? {});
    if (values.every(([k]) => /^\d+$/.test(k))) values.sort(([a], [b]) => Number(a) - Number(b));
    body = values.map(([, v]) => v);
  }
  return {
    ...(header ? { header } : {}),
    ...(body.length ? { body } : {}),
    ...(t.buttons?.length ? { buttons: t.buttons.map(({ index, value }) => ({ index, value })) } : {}),
  };
}

/** Why a send did not reach the person, for the agent: Flow Framework's outside_window, else Flow's type and whether to resend. */
function reason(e: { type: string; channelCode?: string; message: string; retryable: boolean }): string {
  const what = e.channelCode ? `${e.type} (${e.channelCode})` : e.type;
  if (e.type === "outside_window" && e.channelCode === "quiet_hours") return `${what}: it is night where they are; send it later`;
  if (e.type === "outside_window") return "outside_window";
  if (e.channelCode === "channel_timeout_unknown_outcome") return `${what}: it may have arrived; ask them before sending it again`;
  if (e.retryable) return `${what}: Flow Messaging could not send it now; it may go through later`;
  return `${what}: ${e.message} It will fail again: don't resend it.`;
}
