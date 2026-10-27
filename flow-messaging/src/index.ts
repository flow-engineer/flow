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
// open conversation if there is one. On Flow's shared iMessage sender the agent can message only
// someone who wrote first, any time later (iMessage has no 24-hour window): a start to anyone else fails. What this process learns (conversations, contacts,
// event ids) is kept in memory only.
//
// A send resolves once the channel has the message: Flow answers a send with 202 (queued), and the
// channel's send waits for message.sent (from the stream or the webhook, else by reading the message
// back), so the agent's next message goes only after it. `waitFor: "delivered"` waits for the
// person's phone instead, where the channel reports it; `waitFor: "queued"` resolves on the 202.
//
// Flow Messaging's V0 API takes each kind of message at its own endpoint and sends exactly what it is
// given, or refuses it (422 unsupported_content): it never converts. So the conversions are made
// here, per channel: Markdown becomes Telegram's HTML (`telegram.parse_mode`) or iMessage's styles
// (`imessage.styles`), more than 3 choices on WhatsApp a list, and a carousel on Telegram its text
// then one message per card.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { carouselMessages, replyButton, sms as smsChannel, whatsapp as whatsappChannel, WHATSAPP_CAROUSELS, type Agent, type Attachment, type Carousel, type Channel, type ChannelInfo, type Incoming, type Message, type Photo, type SendReceipt, type Template, type WhatsAppFeature } from "../../src/index.ts";
import { Client, FlowMessagingError, idSegment, verifySignature } from "./client.ts";
import { imessageStyles, telegramHTML } from "./richtext.ts";

export { API_VERSION, FlowMessagingError, verifySignature } from "./client.ts";

export interface FlowMessagingOptions {
  /** The app's API key, `fk_live_...` or `fk_test_...`. Default: FLOW_MESSAGING_KEY (or the older FLOW_MESSAGING_API_KEY). */
  apiKey?: string;
  /** The webhook endpoint's signing secret(s), comma-separated while one is rotated. Default: FLOW_MESSAGING_WEBHOOK_SECRET. */
  webhookSecret?: string;
  /** Default: FLOW_MESSAGING_BASE_URL (or the older FLOW_MESSAGING_API_URL), else https://api.flow.engineer. */
  baseUrl?: string;
  /**
   * When a send resolves, so the agent's next message waits for it. "sent" (the default): the
   * channel accepted it (Flow's message.sent). "delivered": it reached the person's device
   * (message.delivered), where the channel reports it; Telegram never does, so there it is "sent".
   * "queued": Flow stored it (the 202), as before 0.5.0. A send that fails first rejects with why.
   */
  waitFor?: "queued" | "sent" | "delivered";
  /**
   * The longest a send waits for that signal (ms). Past it the send resolves anyway, as the message
   * may still go (it is never sent again), and a warning is logged. Default 30,000.
   */
  waitTimeoutMs?: number;
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
/**
 * One message as one Flow kind: `kind` names its endpoint (`contact_card`'s is contact-card) and
 * `body` is what it takes. `preview: false` is the message's, for a link that has to go as text.
 */
interface Piece {
  kind: string;
  body: Record<string, unknown>;
  preview?: false;
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

/**
 * Telegram as Flow sends it: an inline keyboard of up to 10 buttons (or one link), photos (one with
 * buttons is one message), carousels (their text, then one message per card: its photo, text and
 * buttons), Markdown (sent as Telegram's HTML), edits and unsends (Flow refuses an unsend past 48
 * hours, and the agent is told), no read receipts for bots.
 */
export const TELEGRAM: ChannelInfo = {
  platform: "telegram",
  reactions: true,
  status: false,
  formatting: "markdown",
  maxLength: 4096,
  replies: true,
  buttons: { max: 10, labelMax: 20 },
  buttonIds: true,
  linkButton: { labelMax: 20 },
  images: { captionMax: 1024 },
  carousels: WHATSAPP_CAROUSELS,
  readReceipts: false,
  templates: false,
  edits: true,
  unsends: true,
  // Telegram clears a chat action after about 5 seconds, or when the bot's message arrives.
  typingLastsMs: 5_000,
};

/**
 * iMessage as Flow sends it: text up to 9999 characters, its Markdown sent as iMessage's own styles
 * (bold, italic, underline, strikethrough), photos, inline replies, tapbacks (other emoji go as emoji
 * reactions), typing and read receipts (the whole conversation), edits and unsends (Flow refuses one
 * that comes too late, and the agent is told). No buttons, lists or templates. No reply window is
 * set: the line only answers people who wrote to it, and a send it will not deliver comes back as
 * Not delivered (outside_window).
 */
export const IMESSAGE: ChannelInfo = {
  platform: "imessage",
  reactions: true,
  status: false,
  formatting: "markdown",
  maxLength: 9999,
  replies: true,
  images: { captionMax: 1024 },
  readReceipts: true,
  templates: false,
  edits: true,
  unsends: true,
  // Flow Messaging shows iMessage's typing for 15 seconds (its default duration), or until a message goes.
  typingLastsMs: 15_000,
};

/** WhatsApp's most reply buttons in one message; more choices go as a list. */
const WHATSAPP_REPLY_BUTTONS = 3;
/** The label of the button that opens a list made of more than 3 buttons (Flow Messaging's own, before V0). */
const LIST_BUTTON = "Choose";
const MAX_BODY_BYTES = 1_000_000;
/** Event ids remembered to drop Flow's redeliveries (deliveries are at least once). */
const SEEN_MAX = 10_000;
/** The events the handler acts on; the stream asks for only these (less message.sent when sends resolve on the 202, plus message.delivered when they wait for it). */
const HANDLED = ["message.received", "message.failed", "reaction.added", "contact.deleted", "message.sent"];
/** How far a message has got: a send waiting for one status is done at it or any later one. */
const PROGRESS: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };
/** Statuses heard before their send's 202 came back, kept to settle it then. */
const EARLY_MAX = 1_000;
/** A send waiting for its status reads the message back after this, then twice as long each time, up to POLL_MAX (ms). */
const POLL_FIRST = 500;
const POLL_MAX = 5_000;
/** The stream's reconnect backoff: up to 1 s after the first close, doubling per close, up to STREAM_BACKOFF_MAX (ms), with full jitter. */
const STREAM_BACKOFF_FIRST = 1_000;
const STREAM_BACKOFF_MAX = 30_000;
/** A connection is healthy once it delivers an event or stays open this long (ms); only then does the backoff start again. */
const STREAM_HEALTHY_MS = 30_000;
/** Close codes after which reconnecting soon fails again: the route is gone (4404), too many streams opened (4429). */
const STREAM_HARD = new Set([4404, 4429]);
/** After those, with no retry_after: at least STREAM_HARD_MIN, its ceiling doubling per close up to STREAM_HARD_MAX (ms). */
const STREAM_HARD_MIN = 30_000;
const STREAM_HARD_MAX = 300_000;
/** Tries of one event before the stream gives up on it and goes on to the next. */
const STREAM_EVENT_TRIES = 5;
/** Close codes after which reconnecting unchanged fails again: authentication, permission, a bad request. */
const STREAM_FINAL = new Set([4401, 4403, 4400]);

/** A message's error as Flow gives it (the spec's ErrorBody). */
interface FlowError {
  type?: string;
  message?: string;
  channel_code?: string;
  param?: string;
  channel?: string;
}
interface FlowMessage {
  id: string;
  conversation: string;
  direction: "in" | "out";
  status?: string;
  /** A kind object (`kind`), or, for an app on Flow's bridge to the older API, its `type` content. */
  content: Record<string, unknown>;
  reply_to?: string;
  error?: FlowError;
}
interface FlowEvent {
  id: string;
  type: string;
  conversation?: { id: string; type?: "direct" | "group"; channel: string; sender: string; contact: string };
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
  let groupsWarned = false;
  const handling = new Map<string, Promise<void>>();
  const waitFor = options.waitFor ?? "sent";
  const waitTimeoutMs = options.waitTimeoutMs ?? 30_000;
  // The status events sends wait for: none when they resolve on the 202.
  const handled = waitFor === "queued" ? HANDLED.filter((t) => t !== "message.sent") : waitFor === "delivered" ? [...HANDLED, "message.delivered"] : HANDLED;
  /** Sends waiting for their message's status, by Flow message id: true once settled by it. */
  const waiting = new Map<string, (status: string, error?: FlowMessage["error"]) => boolean>();
  const early = new Map<string, { status: string; error?: FlowMessage["error"] }>();
  // A status can beat its POST response, before we know the message id to wait on.
  const posting = new Map<string, Set<Promise<void>>>();
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
    const found = (await client.get<FlowMessage>(`/v0/messages/${idSegment("msg", messageId)}`)).conversation;
    flowConversation.set(key(channel, to), found);
    return found;
  }

  function recipient(kind: Kind, to: string): Record<string, string> {
    if (to.startsWith("ct_")) return { contact: to };
    if (kind === "telegram") return { telegram_user_id: to };
    if (kind === "imessage" && !/^\+?[0-9]{7,15}$/.test(to)) return { handle: to }; // an email address
    return { phone: to.startsWith("+") ? to : `+${to}` };
  }

  /**
   * One message of one kind: into the person's conversation (`POST /v0/conversations/{id}/<kind>`),
   * or a new one from the channel's sender (`POST /v0/messages`, which takes a basic message or a
   * template only).
   */
  async function send(route: Route, to: string, piece: Piece, about?: string, idempotencyKey?: string): Promise<SendReceipt> {
    const person = key(route.name, to);
    let resolve!: () => void;
    const ready = new Promise<void>((done) => { resolve = done; });
    const posts = posting.get(person) ?? new Set<Promise<void>>();
    posting.set(person, posts);
    posts.add(ready);
    const registered = () => {
      if (!posts.delete(ready)) return;
      resolve();
      if (!posts.size) posting.delete(person);
    };
    try {
      const conversation = await conversationFor(route.name, to, about);
      let sent: FlowMessage;
      if (conversation) sent = await client.post(`/v0/conversations/${idSegment("conv", conversation)}/${piece.kind.replace("_", "-")}`, piece.body, undefined, idempotencyKey);
      else {
        if (!route.sender) throw new Error(`no conversation with them on ${route.name} yet, and no sender to start one (set FLOW_MESSAGING_${route.kind.toUpperCase()}_SENDER)`);
        const first = startable(route, piece);
        sent = await client.post("/v0/messages", { sender: route.sender, to: recipient(route.kind, to), kind: first.kind, ...first.body }, undefined, idempotencyKey);
      }
      flowConversation.set(key(route.name, to), sent.conversation);
      const receipt = arrived(route, sent);
      registered();
      return await receipt;
    } catch (error) {
      throw error instanceof FlowMessagingError ? new Error(reason(error)) : error;
    } finally {
      registered();
    }
  }

  /**
   * A first message as a start takes it: a basic message or a template. A link (a buttons message of
   * one URL button) goes as its text with the URL on a line after it, as on a channel without link
   * buttons; any other kind needs the conversation first.
   */
  function startable(route: Route, piece: Piece): Piece {
    if (piece.kind === "basic" || piece.kind === "template") return piece;
    const { buttons, header, ...rest } = piece.body as { text: string; buttons?: Array<{ url?: string }>; header?: { type: string; url?: string; file_id?: string }; telegram?: { parse_mode?: string } };
    const url = piece.kind === "buttons" && buttons?.length === 1 ? buttons[0]!.url : undefined;
    if (!url) throw new Error(`no conversation with them on ${route.name} yet, and a first message can only be a text or a template (this is a ${piece.kind} message)`);
    const line = rest.telegram?.parse_mode === "HTML" ? telegramHTML(url) : url;
    const { type: _type, ...photo } = header ?? { type: "" };
    return { kind: "basic", body: { ...rest, text: `${rest.text}\n${line}`, ...(header ? { media: { type: "image", ...photo } } : piece.preview === false ? { link_preview: false } : {}) } };
  }

  /** Several messages one after another, each after the last went; their receipt is the least far of theirs. */
  async function sendAll(route: Route, to: string, pieces: Array<{ piece: Piece; about?: string; idempotencyKey?: string }>): Promise<SendReceipt> {
    const receipts: SendReceipt[] = [];
    for (const p of pieces) receipts.push(await send(route, to, p.piece, p.about, p.idempotencyKey));
    return receipts.find((r) => r.status === "unconfirmed") ?? receipts.find((r) => r.status === "queued") ?? receipts.find((r) => r.status === "sent") ?? receipts[0]!;
  }

  /**
   * Waits until the channel has the message (or the person's device, with waitFor "delivered"): by
   * its status event, else by reading it back, at most waitTimeoutMs. A failure rejects, with why;
   * past the wait it resolves "unconfirmed" (the message may still go, and is never sent again).
   */
  function arrived(route: Route, message: FlowMessage): Promise<SendReceipt> {
    if (waitFor === "queued" || !message.id) return Promise.resolve({ status: "queued", ...(message.id ? { messageId: message.id } : {}) });
    const started = Date.now();
    const target = waitFor === "delivered" && route.kind !== "telegram" ? "delivered" : "sent";
    return new Promise<SendReceipt>((resolve, reject) => {
      let done = false;
      let timeout: NodeJS.Timeout | undefined;
      let poll: NodeJS.Timeout | undefined;
      const finish = (outcome: Error | SendReceipt["status"]) => {
        done = true;
        clearTimeout(timeout);
        clearTimeout(poll);
        waiting.delete(message.id);
        if (outcome instanceof Error) reject(outcome);
        else resolve({ status: outcome, waitedMs: Date.now() - started, messageId: message.id });
      };
      const take = (status: string | undefined, error?: FlowMessage["error"]): boolean => {
        if (done || !status) return done;
        if (status === "failed" || status === "unsent") {
          const type = error?.type ?? (status === "unsent" ? "unsent" : "channel_error");
          finish(new Error(reason({ type, channelCode: error?.channel_code, param: error?.param, channel: error?.channel, message: error?.message ?? "The channel did not take it.", retryable: type === "api_error" || type === "rate_limited" })));
        } else if ((PROGRESS[status] ?? -1) >= PROGRESS[target]!) finish(PROGRESS[status]! >= PROGRESS.delivered! ? "delivered" : "sent");
        return done;
      };
      if (take(message.status, message.error)) return;
      const heard = early.get(message.id);
      early.delete(message.id);
      if (heard && take(heard.status, heard.error)) return;
      waiting.set(message.id, take);
      timeout = setTimeout(() => {
        console.warn(`@flow-engineer/flow/flow-messaging: ${message.id} on ${route.name} was not ${target} within ${waitTimeoutMs} ms; going on (it may still arrive, and is not sent again)`);
        finish("unconfirmed");
      }, waitTimeoutMs);
      let delay = POLL_FIRST;
      const readBack = async () => {
        try {
          const now = await client.get<FlowMessage>(`/v0/messages/${idSegment("msg", message.id)}`);
          if (take(now.status, now.error)) return;
        } catch {
          // Read again later: the status event or the timeout settles it meanwhile.
        }
        if (done) return;
        delay = Math.min(delay * 2, POLL_MAX);
        poll = setTimeout(readBack, delay);
      };
      poll = setTimeout(readBack, delay);
    });
  }

  /**
   * An edit or unsend: resolves once Flow took it, rejects with Flow's reason. A late or unsupported
   * one is refused at the call (`422 unsupported_content`: `edit_window_closed`, `unsend_window_closed`,
   * `first_message_not_editable`, `not_on_sms`, or `param` `kind` on a channel without them), and the
   * agent is told `unsupported_content (edit_window_closed): <Flow's message, with the limit>`.
   */
  async function change(call: () => Promise<unknown>): Promise<void> {
    try {
      await call();
    } catch (error) {
      if (!(error instanceof FlowMessagingError)) throw error;
      throw new Error(`${detailed({ type: error.type, channelCode: error.channelCode, param: error.param, channel: error.channel })}: ${error.message}`);
    }
  }

  /**
   * A read receipt is a courtesy: Flow's spec says to ignore its failures. Outside the window
   * (on iMessage, more than 5 minutes after the line's last message to that person) it is expected
   * to be refused, so that is not logged; any other failure is.
   */
  async function markRead(route: Route, to: string, body: Record<string, unknown>, messageId?: string): Promise<void> {
    try {
      const conversation = await conversationFor(route.name, to, messageId);
      if (conversation) await client.post(`/v0/conversations/${idSegment("conv", conversation)}/read`, body, 1);
    } catch (error) {
      if (error instanceof FlowMessagingError && error.type === "outside_window") return;
      console.warn(`@flow-engineer/flow/flow-messaging: read on ${route.name} failed (${error instanceof FlowMessagingError ? error.type : "error"})`);
    }
  }

  /**
   * Shows the typing indicator; it clears itself when the next message goes or after a while
   * (`typingLastsMs`), so the conversation sends it again while its turn runs, and nothing is sent
   * for "off". Each call has its own Idempotency-Key, so a second call shows the indicator again.
   * A refusal rejects for the conversation to act on: `outside_window` waits for the agent's
   * next message, anything else ends typing for the turn. On iMessage typing works for 5 minutes after
   * the line's last message to that person. On WhatsApp it works within 24 hours of their last message. The conversation logs it.
   */
  async function typing(route: Route, to: string): Promise<void> {
    try {
      const conversation = await conversationFor(route.name, to);
      if (conversation) await client.post(`/v0/conversations/${idSegment("conv", conversation)}/typing`, {}, 1);
    } catch (error) {
      if (!(error instanceof FlowMessagingError)) throw error;
      throw new Error(error.type === "outside_window" ? "outside_window" : detailed({ type: error.type, channelCode: error.channelCode, param: error.param, channel: error.channel }));
    }
  }

  /**
   * A message as one Flow kind. A link is a buttons message with one URL button (WhatsApp's
   * cta_url), a photo a basic message with the text as its caption; a photo with buttons or a link is
   * their message's image header. On WhatsApp a list, or more than 3 buttons, is a list message.
   */
  function pieceOf(kind: Kind, message: Message): Piece {
    const replyTo = message.replyTo ? { reply_to: message.replyTo } : {};
    const preview = message.preview === false ? { preview: false as const } : {};
    const buttons = message.link ? [{ url: message.link.url, label: message.link.label }] : message.buttons?.length ? message.buttons.map(replyButton) : undefined;
    const many = kind === "whatsapp" && !message.link && (buttons?.length ?? 0) > WHATSAPP_REPLY_BUTTONS;
    if (message.list || many) {
      if (message.image) throw new Error("a WhatsApp list cannot have a photo: send the photo in a message of its own");
      const rows = message.list ? message.list.rows.map((r) => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) })) : (buttons as Array<{ id: string; label: string }>).map((b) => ({ id: b.id, title: b.label }));
      return { kind: "list", body: { text: message.text, button: message.list?.button ?? LIST_BUTTON, sections: [{ rows }], ...replyTo }, ...preview };
    }
    const text = styled(kind, message.text);
    if (buttons) return { kind: "buttons", body: { ...text, buttons, ...(message.image ? { header: { type: "image", ...file(message.image) } } : {}), ...replyTo }, ...preview };
    if (message.image) return { kind: "basic", body: { media: { type: "image", ...file(message.image) }, ...(message.text ? text : {}), ...replyTo } };
    return { kind: "basic", body: { ...text, ...replyTo, ...(message.preview === false ? { link_preview: false } : {}) } };
  }

  /** A WhatsApp carousel as Flow's carousel message: each card's photo is its header. */
  function carouselOf(carousel: Carousel): Piece {
    return {
      kind: "carousel",
      body: {
        text: carousel.text,
        cards: carousel.cards.map((card) => ({
          header: { type: "image", ...file(card.image) },
          ...(card.text ? { text: card.text } : {}),
          buttons: card.link ? [{ url: card.link.url, label: card.link.label }] : (card.buttons ?? []).map(replyButton),
        })),
      },
    };
  }

  /**
   * A carousel on Telegram, which has none: its text, then one message per card, in order, each its
   * photo with the card's text as caption and its buttons or link under it (a card with neither is the
   * photo alone). Each has its own Idempotency-Key, the carousel's plus what it is (`:text`, `:card:0`, ...).
   */
  function telegramCarousel(route: Route, to: string, carousel: Carousel): Promise<SendReceipt> {
    const bare = carousel.cards.findIndex((card) => (card.buttons?.length || card.link) && !card.text);
    if (bare >= 0) return Promise.reject(new Error(`Telegram shows a card's buttons under its text, and card ${bare + 1} has none: give every card with buttons a text`));
    const keyed = (what: string) => (carousel.idempotencyKey ? `${carousel.idempotencyKey}:${what}` : undefined);
    const preview = carousel.preview === false ? { preview: false as const } : {};
    return sendAll(route, to, [
      { piece: pieceOf("telegram", { text: carousel.text, ...(carousel.replyTo ? { replyTo: carousel.replyTo } : {}), ...preview }), about: carousel.replyTo, idempotencyKey: keyed("text") },
      ...carousel.cards.map((card, i) => ({
        piece: pieceOf("telegram", { text: card.text ?? "", image: card.image, ...(card.link ? { link: card.link } : card.buttons?.length ? { buttons: card.buttons } : {}) }),
        idempotencyKey: keyed(`card:${i}`),
      })),
    ]);
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
        const page = await client.get<{ data: typeof all; has_more: boolean }>(`/v0/templates?${new URLSearchParams({ sender: idSegment("snd", sender), status: "approved", limit: "100", ...(after ? { after } : {}) })}`);
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
      sendMessage: (to: string, message: Message) => send(route, to, pieceOf(route.kind, message), message.replyTo, message.idempotencyKey),
      sendCarousel: (to: string, carousel: Carousel) =>
        route.kind === "telegram" ? telegramCarousel(route, to, carousel) : send(route, to, carouselOf(carousel), carousel.replyTo, carousel.idempotencyKey),
      react: async (to: string, messageId: string, emoji: string) => void (await send(route, to, { kind: "reaction", body: { message_id: messageId, emoji } }, messageId)),
      // An edit or unsend Flow refuses (too late, or a channel without them) rejects with its reason, for the agent.
      editMessage: (to: string, messageId: string, text: string) => change(() => client.patch(`/v0/messages/${idSegment("msg", messageId)}`, styled(route.kind, text))),
      unsendMessage: (to: string, messageId: string) => change(() => client.delete(`/v0/messages/${idSegment("msg", messageId)}`)),
      typing: async (to: string, on: boolean) => (on ? typing(route, to) : undefined),
      // iMessage marks the whole conversation read, and refuses `up_to`.
      markRead: (to: string, messageIds: string[]) => markRead(route, to, route.kind === "whatsapp" ? { up_to: messageIds.at(-1) } : {}, messageIds.at(-1)),
      sendTemplate: async (to: string, wanted: Template, idempotencyKey?: string) => {
        if (!route.sender) throw new Error(`a template needs the channel's sender (set FLOW_MESSAGING_${route.kind.toUpperCase()}_SENDER)`);
        const found = await template(route.sender, wanted);
        const params = templateParams(wanted);
        return send(route, to, { kind: "template", body: { template_id: found.id, language: wanted.language ?? found.language, ...(Object.keys(params).length ? { params } : {}) } }, undefined, idempotencyKey);
      },
    };
  }

  /** WhatsApp from a Flow sender: buttons (a list past 3), lists, link buttons, photos (as the header of buttons or a link), carousels, quotes, reactions, typing, blue ticks, templates. */
  function whatsapp(o: FlowChannelOptions & { disable?: WhatsAppFeature[] } = {}): Channel {
    const route = register("whatsapp", o);
    const channel = whatsappChannel(provider(route), { name: route.name, disable: o.disable, instructions: o.instructions });
    // Flow Messaging sends every reply button's own id and gives it back on the tap.
    return { ...channel, info: { ...channel.info, ...(channel.info.buttons ? { buttonIds: true } : {}) } };
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

  /**
   * Flow's channels this app is on: Telegram always, WhatsApp and iMessage when their sender is set
   * (FLOW_MESSAGING_WHATSAPP_SENDER, FLOW_MESSAGING_IMESSAGE_SENDER). `except` leaves out the names an
   * agent declares itself; createAgent's `host.messaging` uses it.
   */
  function channels(o: { except?: string[]; env?: Record<string, string | undefined> } = {}): Channel[] {
    const skip = new Set(o.except ?? []);
    const env = o.env ?? process.env;
    return [
      ...(skip.has("telegram") ? [] : [telegram()]),
      ...(!skip.has("whatsapp") && env.FLOW_MESSAGING_WHATSAPP_SENDER ? [whatsapp()] : []),
      ...(!skip.has("imessage") && env.FLOW_MESSAGING_IMESSAGE_SENDER ? [imessage()] : []),
    ];
  }

  /**
   * A Flow channel Flow Framework has no kind for: text, quotes, buttons and links as `info` allows,
   * photos, reactions, typing, read receipts. Its traces name its platform (telegram, imessage), not web.
   */
  function custom(route: Route, info: ChannelInfo, o: FlowChannelOptions): Channel {
    const p = provider(route);
    return {
      name: route.name,
      kind: "custom",
      traceChannel: route.kind,
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
          case "carousel": {
            const { type: _type, ...carousel } = outbound;
            if (info.carousels) return p.sendCarousel(to, carousel);
            return (async () => {
              const receipts: SendReceipt[] = [];
              for (const m of carouselMessages(info, carousel)) receipts.push(await p.sendMessage(to, m));
              // The carousel got as far as its least far card; its id is its first message's.
              const least = receipts.find((r) => r.status === "unconfirmed") ?? receipts.find((r) => r.status === "queued") ?? receipts.find((r) => r.status === "sent") ?? receipts[0];
              return least && { ...least, messageId: receipts[0]!.messageId };
            })();
          }
          case "reaction":
            return p.react(to, outbound.messageId, outbound.emoji);
          case "edit":
            return p.editMessage(to, outbound.messageId, outbound.text);
          case "unsend":
            return p.unsendMessage(to, outbound.messageId);
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
    const contact = await client.get<{ address?: { phone?: string; telegram_user_id?: string; handle?: string } }>(`/v0/contacts/${idSegment("ct", contactId)}`);
    const a = contact.address;
    const address = (route.kind === "telegram" ? a?.telegram_user_id : route.kind === "imessage" ? (a?.phone ?? a?.handle) : a?.phone) ?? contactId;
    contacts.set(contactId, address);
    return address;
  }

  async function quoted(id: string): Promise<{ text: string; fromAgent: boolean } | undefined> {
    try {
      const m = await client.get<FlowMessage>(`/v0/messages/${idSegment("msg", id)}`);
      const text = textOf(m.content);
      return text ? { text, fromAgent: m.direction === "out" } : undefined;
    } catch {
      return undefined; // past Flow's retention, or not known to it: the message reads without the quote
    }
  }

  async function incoming(m: FlowMessage): Promise<Incoming | null> {
    const c = kindOf(m.content);
    const media = c.kind === "basic" && c.media && typeof c.media === "object" ? (c.media as Record<string, unknown>) : undefined;
    const caption = c.text === undefined ? "" : String(c.text);
    let base: Incoming;
    if (c.kind === "basic" && !media) base = { text: caption };
    else if (c.kind === "button_reply") {
      const id = String(c.button_id ?? "");
      const title = String(c.label ?? id);
      base = { text: title, choice: id ? { id, title } : { title } };
    } else if (c.kind === "voice" && c.transcript) base = { text: String(c.transcript) }; // Flow transcribed it already
    else if ((c.kind === "voice" && c.file_id) || (media?.file_id && media.type !== "video")) {
      // Photos, audio and documents go as attachments, their bytes fetched from Flow only when the agent can use them.
      const file = media ?? c;
      const kind = c.kind === "voice" || file.type === "audio" ? "audio" : file.type === "image" ? "image" : "document";
      const fileId = String(file.file_id);
      const attachment: Attachment = { kind, mime: String(file.mime_type ?? "application/octet-stream"), ...(file.filename ? { name: String(file.filename) } : {}), data: () => client.download(fileId) };
      base = { text: caption, attachments: [attachment] };
    } else if (media || c.kind === "file_blocked") {
      // A video (Flow Framework reads none), or a file Flow did not keep: the caption, and what it was.
      const what = String((media ? media.type : c.media_type) ?? "file");
      base = { text: [media ? caption : c.caption, c.kind === "file_blocked" ? `[${what}: not received (${String(c.reason)})]` : `[${what}]`].filter(Boolean).join(" ") };
    } else if (c.kind === "location") base = { text: `[location: ${[c.name, c.address].filter(Boolean).join(", ")} (${c.lat}, ${c.lng})]` };
    else if (c.kind === "contact_card") base = { text: `[contact: ${String(c.name ?? "")}]` };
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
    if (event.type === "message.sent" || event.type === "message.delivered" || event.type === "message.read" || event.type === "message.failed") {
      const m = event.data?.message;
      if (!m?.id) return;
      const status = event.type.slice("message.".length);
      if (status === "failed" && !waiting.has(m.id) && event.conversation) {
        const route = routeOf(event);
        if (route) {
          const address = await addressOf(route, event.conversation.contact);
          await Promise.all([
            ...posting.get(key(route.name, address)) ?? [],
            ...posting.get(key(route.name, event.conversation.contact)) ?? [],
          ]);
        }
      }
      const settle = waiting.get(m.id);
      if (typeof settle === "function") {
        // A failure its send is waiting on is told through that send, not again as Not delivered.
        if (settle(status, m.error) && status === "failed") return;
      } else if (status !== "failed" && waitFor !== "queued") {
        early.set(m.id, { status, error: m.error });
        if (early.size > EARLY_MAX) early.delete(early.keys().next().value!);
      }
      if (event.type !== "message.failed") return;
    }
    if (event.conversation?.type === "group") {
      // An iMessage group has no one address to answer, so the agent never takes part: nothing is
      // answered there, and no typing or read receipt goes to it.
      if (!groupsWarned) console.warn("@flow-engineer/flow/flow-messaging: group conversations are not handled; their events are passed over");
      groupsWarned = true;
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
      // An edit or unsend Flow took and the channel then refused (it waited behind earlier messages past the limit, say): told as what it was.
      const c = kindOf(m.content);
      const target = typeof c.message_id === "string" ? c.message_id : "";
      const text = c.kind === "edit" ? `edit of ${target}: ${textOf(c)}` : c.kind === "unsend" ? `unsend of ${target}` : textOf(m.content);
      const type = m.error?.type ?? "channel_error";
      if (text) agent.undelivered(conversationId, text, reason({ type, channelCode: m.error?.channel_code, param: m.error?.param, channel: m.error?.channel, message: m.error?.message ?? "The channel did not take it.", retryable: type === "api_error" || type === "rate_limited" }));
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
   * The live event stream (GET /v0/stream): an outbound WebSocket, so the agent needs no public URL.
   * Events are handled one at a time, in log order, by the webhook's handler. There is no ack frame
   * for events: the stream resumes from `after`, so an event counts as acknowledged once the agent
   * has handled it and the cursor (in memory, or `cursorFile`) has moved past it. A failed event, a
   * dropped socket or Flow's `reconnect` frame reconnects from that cursor, and Flow replays what
   * came after it: at once after a reconnect frame, else after a jittered backoff (up to 1 s, doubling
   * to 30 s; 30 s to 5 min after 4404 or 4429), never sooner than Flow's retry_after. The backoff starts
   * again only once a connection delivers an event or stays open 30 s, so a stream refused right after
   * it opens never reconnects in a tight loop. An event that fails 5 times in a row is passed over, so
   * it cannot hold up every later one. A refused key or request stops the stream (`stopped`). Replies
   * go over HTTP (with Idempotency-Keys), so they do not depend on the stream being up.
   */
  function stream(agent: WebhookAgent, o: StreamOptions = {}): StreamHandle {
    if (!apiKey) throw new Error("@flow-engineer/flow/flow-messaging: set FLOW_MESSAGING_KEY (or pass apiKey) to open the stream");
    let cursor = o.cursorFile ? readCursor(o.cursorFile) : undefined;
    let socket: WebSocket | undefined;
    let timer: NodeJS.Timeout | undefined;
    let healthy: NodeJS.Timeout | undefined;
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
      const url = new URL(`${client.baseUrl.replace(/^http/, "ws")}/v0/stream`);
      if (cursor) url.searchParams.set("after", cursor);
      for (const type of handled) url.searchParams.append("type", type);
      // Node's WebSocket cannot set headers: the key goes as a subprotocol beside "flow", which Flow selects.
      const ws = new WebSocket(url, ["flow", `flow.key.${apiKey}`]);
      socket = ws;
      let refusal: { type?: string; message?: string; param?: string; retry_after?: number } | undefined;
      // A socket that opens is not yet healthy: a refused stream opens, sends an error frame and closes.
      // The backoff starts again once the connection delivers an event or stays open STREAM_HEALTHY_MS;
      // a failing event keeps its backoff across reconnects.
      ws.onopen = () => {
        healthy = setTimeout(() => {
          if (!failing) tries = 0;
        }, STREAM_HEALTHY_MS);
      };
      ws.onmessage = (message) => {
        let frame: { type?: string; event?: FlowEvent; error?: typeof refusal; ref?: string };
        try {
          frame = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (frame.type === "event" && frame.event && typeof frame.event.id === "string") {
          if (!failing) tries = 0;
          const event = frame.event;
          queue = queue.then(() => take(event, mine, ws));
        } else if (frame.type === "error" && !frame.ref) refusal = frame.error ?? {};
      };
      ws.onerror = () => {}; // a close always follows
      ws.onclose = ({ code, reason }) => {
        clearTimeout(healthy);
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
        // 1012 follows a reconnect frame: at once. Else back off, never less than Flow's retry_after.
        if (code === 1012) {
          console.debug("@flow-engineer/flow/flow-messaging: the stream closed (1012) after a reconnect frame; reconnecting now");
          return void later(0);
        }
        const ms = streamWait(code, refusal?.retry_after, tries++);
        console.warn(`@flow-engineer/flow/flow-messaging: the stream closed (${code}${refusal?.type ? ` ${refusal.type}` : ""}); reconnecting in ${(ms / 1000).toFixed(1)} s`);
        later(ms);
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
        console.warn(`@flow-engineer/flow/flow-messaging: event ${event.id} failed ${times} times; going on without it (it stays in Flow's log, GET /v0/events)`);
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
        clearTimeout(healthy);
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

  return { whatsapp, telegram, imessage, sms, channels, webhook, receive, stream, start };
}

/**
 * How long to wait before reconnecting the stream after its `tries`-th close in a row (from 0), in ms.
 * Full jitter: a random wait up to a ceiling that doubles per close. 4404 and 4429 wait at least
 * STREAM_HARD_MIN. A retry_after from Flow is waited first, with the jittered backoff on top.
 */
function streamWait(code: number, retryAfter: number | undefined, tries: number): number {
  const normal = Math.random() * Math.min(STREAM_BACKOFF_MAX, STREAM_BACKOFF_FIRST * 2 ** tries);
  if (typeof retryAfter === "number" && retryAfter >= 0) return retryAfter * 1000 + normal;
  if (!STREAM_HARD.has(code)) return normal;
  return STREAM_HARD_MIN + Math.random() * (Math.min(STREAM_HARD_MAX, STREAM_HARD_MIN * 2 ** (tries + 1)) - STREAM_HARD_MIN);
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

/**
 * A text in the channel's own terms. Telegram: the agent's Markdown as Telegram's HTML, with
 * `parse_mode` HTML (left plain when there is nothing to mark or escape). iMessage: the Markdown's
 * marks taken out and kept as styled ranges (`imessage.styles`). WhatsApp reads its own marks
 * (*bold*) itself, and SMS shows none: there the text goes as written.
 */
function styled(kind: Kind, text: string): { text: string; telegram?: { parse_mode: "HTML" }; imessage?: { styles: ReturnType<typeof imessageStyles>["styles"] } } {
  if (kind === "telegram") {
    const html = telegramHTML(text);
    return html === text ? { text } : { text: html, telegram: { parse_mode: "HTML" } };
  }
  if (kind === "imessage") {
    const plain = imessageStyles(text);
    return { text: plain.text, ...(plain.styles.length ? { imessage: { styles: plain.styles } } : {}) };
  }
  return { text };
}

/** A photo as Flow takes it: by URL, or by a file uploaded to Flow. */
function file(image: Photo): { url: string } | { file_id: string } {
  return "url" in image ? { url: image.url } : { file_id: image.fileId };
}

/**
 * A message's content as a kind object (`kind`), from either shape: an app Flow still serves through
 * its bridge to the older API gets the older one (`type`: text, media with its `kind` and `caption`,
 * file_blocked with the file's `kind`), which reads here as the kind it became.
 */
function kindOf(content: Record<string, unknown>): Record<string, unknown> & { kind: string } {
  if (typeof content.type !== "string") return { ...content, kind: String(content.kind ?? "") };
  const { type, kind, caption, ...rest } = content;
  if (type === "text") return { ...rest, kind: "basic" };
  if (type === "media") {
    const { url, file_id, filename, mime_type, size_bytes, ...other } = rest;
    return { ...other, kind: "basic", ...(caption === undefined ? {} : { text: caption }), media: { type: kind, url, file_id, filename, mime_type, size_bytes } };
  }
  if (type === "file_blocked") return { ...rest, kind: "file_blocked", media_type: kind, caption };
  return { ...rest, kind: type, ...(caption === undefined ? {} : { caption }) };
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

/**
 * Why a send did not reach the person, for the agent: Flow Framework's outside_window, else Flow's
 * type and whether to resend. A 422 unsupported_content says what the channel does not take
 * (`param`), where (`channel`) and why (`channel_code`, such as group_unsupported or not_on_sms).
 */
/** An error's type with its channel code (and, for unsupported content, what was refused and where): `unsupported_content (param kind, on whatsapp)`. */
function detailed(e: { type: string; channelCode?: string; param?: string; channel?: string }): string {
  const detail = [e.channelCode, ...(e.type === "unsupported_content" ? [e.param && `param ${e.param}`, e.channel && `on ${e.channel}`] : [])].filter(Boolean);
  return detail.length ? `${e.type} (${detail.join(", ")})` : e.type;
}

function reason(e: { type: string; channelCode?: string; param?: string; channel?: string; message: string; retryable: boolean }): string {
  const what = detailed(e);
  if (e.type === "outside_window" && e.channelCode === "quiet_hours") return `${what}: it is night where they are; send it later`;
  if (e.type === "outside_window") return "outside_window";
  if (e.channelCode === "channel_timeout_unknown_outcome") return `${what}: it may have arrived; ask them before sending it again`;
  if (e.retryable) return `${what}: Flow Messaging could not send it now; it may go through later`;
  return `${what}: ${e.message} It will fail again: don't resend it.`;
}
