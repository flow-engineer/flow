// Channels: where people reach an agent. Flow Framework knows each platform (what WhatsApp can show, its
// limits, its 24-hour window); a provider only says how to send through its own API. A provider
// implements one sendMessage, which gets everything the agent's send tool carries, plus the
// optional actions that are not messages (react, typing, markRead, sendTemplate). A feature the
// provider leaves out, or switches off, is never offered to the agent.
//
//   whatsapp(new MyWhatsApp(keys))                       every WhatsApp feature the provider has
//   whatsapp(new MyWhatsApp(keys), { disable: ["reactions"] })
//   sms(new MySms(keys))
//   customUI("app", new MyApp())                         your own web or mobile UI, with your params

import type { z } from "zod";
import type { CarouselCard, ChannelInfo, ListRow, Outbound, Photo, RecordRow, RecordsOutbound, ReplyButton, SendReceipt, Template, TemplateDefinition } from "./types.ts";

export type ChannelKind = "sms" | "whatsapp" | "custom";

/** A channel as the agent uses it. Made by whatsapp(), sms() or customUI(), or written by hand. */
export interface Channel {
  /** The agent's name for it; its send tool is always send_<name> (lowercase, other characters as _). "key" and "phone" are reserved. */
  name: string;
  kind: ChannelKind;
  /** Override the trace channel classification, e.g. a terminal custom UI as cli. */
  traceChannel?: string;
  info: ChannelInfo;
  /** Addresses are phone numbers the channel verified, so the same number on two channels is one person. */
  phone?: boolean;
  /** Extra fields of this channel's send tool, passed through to its provider as they are. */
  params?: Record<string, z.ZodType>;
  /** Your own guidance for the agent on this channel, added to its prompt while the person uses it. */
  instructions?: string;
  /** Opt-out keywords this channel honours (SMS and WhatsApp have them by default). */
  keywords?: Keywords;
  /** Resolves once the channel has the outbound (the platform accepted it), optionally with a receipt; see Deliver. */
  send(address: string, outbound: Outbound): Promise<void | SendReceipt> | void | SendReceipt;
}

/**
 * Keywords a person texts on their own (the whole message, in any case, with only spaces,
 * punctuation or emoji around it: "Stop." is one, "stop by tomorrow" is not), answered with no
 * model call. `stop` records a hard no-contact rule: nothing the
 * business starts (nudges, scheduled messages, their own reminders) goes to them on any channel
 * until they text a `start` word. `help` sends `replies.help`; without one the agent answers it.
 * A reply left out sends nothing (the provider may send its own).
 */
export interface Keywords {
  stop: string[];
  start: string[];
  help: string[];
  replies?: { stop?: string; start?: string; help?: string };
}

/**
 * SMS's default: STOP to opt out, START to resume, HELP or INFO for help. Which words carriers or
 * regulators expect differs by country; check your market's rules and pass more when they ask.
 */
export const SMS_KEYWORDS: Keywords = { stop: ["STOP"], start: ["START"], help: ["HELP", "INFO"] };

/**
 * The fuller list some US carrier rules expect on SMS, opt in:
 * `sms(provider, { keywords: US_CARRIER_KEYWORDS })`, or `{ ...US_CARRIER_KEYWORDS, replies }`.
 */
export const US_CARRIER_KEYWORDS: Keywords = {
  stop: ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"],
  start: ["START", "UNSTOP"],
  help: ["HELP", "INFO"],
};

/** WhatsApp has no carrier keywords; a business honours a plain STOP all the same. */
export const WHATSAPP_KEYWORDS: Keywords = { stop: ["STOP", "UNSUBSCRIBE"], start: ["START"], help: [] };

/** Which keyword a message is, if it is one: the whole message, with only spaces, punctuation or emoji around it. */
export function keywordOf(keywords: Keywords | undefined, text: string): "stop" | "start" | "help" | null {
  if (!keywords) return null;
  const bare = (s: string) => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/\s+/g, " ").toUpperCase();
  const word = bare(text);
  if (!word) return null;
  for (const kind of ["stop", "start", "help"] as const) if (keywords[kind].some((k) => bare(k) === word)) return kind;
  return null;
}

/** A channel factory's `keywords` option: false for none, or changes to the defaults. */
function keywordsFrom(defaults: Keywords, option: false | Partial<Keywords> | undefined): Keywords | undefined {
  return option === false ? undefined : { ...defaults, ...option };
}

/** A channel without its send: what the simulators and the test cloud need to play it. */
export interface ChannelSummary {
  name: string;
  kind: ChannelKind;
  info: ChannelInfo;
}

/** One message, as the agent's send tool wrote it. */
export interface Message {
  text: string;
  /** The person's message this one quotes. */
  replyTo?: string;
  /** Reply buttons: a label, or { id, label } (`replyButton` gives both either way). */
  buttons?: ReplyButton[];
  list?: { button: string; rows: ListRow[] };
  /** A button that opens this page. Never with buttons or a list. */
  link?: { label: string; url: string };
  /** A photo, the text its caption; with buttons or a link it heads the same message. Never with a list. */
  image?: Photo;
  /** false: send it with link previews off (a message the business started). */
  preview?: false;
  /** Given for a send the business starts (a nudge, a scheduled text): the same in every process, so a provider that takes one sends it once. */
  idempotencyKey?: string;
}

/** A carousel, as the agent's send tool wrote it. */
export interface Carousel {
  text: string;
  cards: CarouselCard[];
  replyTo?: string;
  preview?: false;
  idempotencyKey?: string;
}

export interface WhatsAppProvider {
  /** Resolves once the platform accepted the message (optionally saying how far it got, SendReceipt); rejects when it refused it. */
  sendMessage(to: string, message: Message): Promise<void | SendReceipt>;
  /** A media carousel; without it the agent is never offered one. */
  sendCarousel?(to: string, carousel: Carousel): Promise<void | SendReceipt>;
  /** Which parts of a message this provider can send. Default: all. */
  features?: { buttons?: boolean; lists?: boolean; replies?: boolean; links?: boolean; images?: boolean };
  react?(to: string, messageId: string, emoji: string): Promise<void>;
  typing?(to: string, on: boolean): Promise<void>;
  markRead?(to: string, messageIds: string[]): Promise<void>;
  sendTemplate?(to: string, template: Template, idempotencyKey?: string): Promise<void | SendReceipt>;
}

export interface SmsProvider {
  /** Resolves once the provider accepted the text; rejects when it refused it. */
  sendMessage(to: string, message: Pick<Message, "text" | "idempotencyKey">): Promise<void | SendReceipt>;
}

/** Your own UI. `message` carries the text, any buttons, and your params by name. */
export interface CustomUIProvider {
  /** What your UI can show. Default: Markdown, no buttons. */
  info?: Omit<ChannelInfo, "reactions" | "status" | "readReceipts">;
  params?: Record<string, z.ZodType>;
  /** Your own guidance for the agent on this channel, such as how to use your params. */
  instructions?: string;
  /** Resolves once your UI has the message (stored or shown); rejects when it could not take it. */
  sendMessage(to: string, message: Message & Record<string, unknown>): Promise<void | SendReceipt>;
  /** A carousel, on a UI whose info declares carousels; without it the cards go one by one through sendMessage. */
  sendCarousel?(to: string, carousel: Carousel): Promise<void | SendReceipt>;
  /**
   * One page of records, on a UI whose info declares `records`: the rows and where the page is, for
   * your UI to draw (a pick comes back as a choice with the row's id). Without it each page goes
   * through sendMessage as Markdown numbered lines.
   */
  sendRecords?(to: string, records: RecordsPage): Promise<void | SendReceipt>;
  react?(to: string, messageId: string, emoji: string): Promise<void>;
  typing?(to: string, on: boolean): Promise<void>;
  markRead?(to: string, messageIds: string[]): Promise<void>;
  /** A short line of what the agent is doing, in your loading indicator; null clears it. */
  status?(to: string, text: string | null): Promise<void>;
}

/** WhatsApp's own limits, the same for every provider. */
export const WHATSAPP: ChannelInfo = {
  platform: "whatsapp",
  reactions: true,
  status: false,
  formatting: "whatsapp",
  maxLength: 4096,
  replies: true,
  buttons: { max: 3, labelMax: 20 },
  lists: { maxRows: 10, titleMax: 24, buttonMax: 20 },
  // An interactive cta_url message: one URL button, its label up to 20 characters.
  linkButton: { labelMax: 20 },
  // An image's caption is at most 1,024 characters (as is an interactive message's body).
  images: { captionMax: 1024 },
  readReceipts: true,
  replyWindowHours: 24,
};

/** WhatsApp's media carousel: 2 to 10 cards, each a photo, up to 160 characters and 1 or 2 reply buttons (or one URL button). */
export const WHATSAPP_CAROUSELS: NonNullable<ChannelInfo["carousels"]> = { maxCards: 10, textMax: 1024, cardTextMax: 160, buttons: 2, labelMax: 20 };

/** SMS: plain text; providers join up to 10 segments into one text (1,530 GSM-7 characters). */
export const SMS: ChannelInfo = { platform: "sms", reactions: false, status: false, formatting: "plain", maxLength: 1530, templates: false, typing: false };

export type WhatsAppFeature = "buttons" | "lists" | "links" | "images" | "carousels" | "replies" | "reactions" | "typing" | "readReceipts" | "templates";

export function whatsapp(provider: WhatsAppProvider, options: { name?: string; disable?: WhatsAppFeature[]; instructions?: string; keywords?: false | Partial<Keywords> } = {}): Channel {
  const off = new Set(options.disable ?? []);
  const has = (feature: WhatsAppFeature, available: boolean) => available && !off.has(feature);
  const f = provider.features ?? {};
  const info: ChannelInfo = {
    ...WHATSAPP,
    reactions: has("reactions", Boolean(provider.react)),
    readReceipts: has("readReceipts", Boolean(provider.markRead)),
    replies: has("replies", f.replies !== false),
    buttons: has("buttons", f.buttons !== false) ? WHATSAPP.buttons : undefined,
    lists: has("lists", f.lists !== false) ? WHATSAPP.lists : undefined,
    linkButton: has("links", f.links !== false) ? WHATSAPP.linkButton : undefined,
    images: has("images", f.images !== false) ? WHATSAPP.images : undefined,
    carousels: has("carousels", Boolean(provider.sendCarousel)) ? WHATSAPP_CAROUSELS : undefined,
    // Only ever true: a provider without sendTemplate keeps 0.4's behaviour (its send says so), and a
    // business run's copy of the channel, whose send goes to the test cloud, still sends templates.
    templates: has("templates", Boolean(provider.sendTemplate)) || undefined,
    typing: has("typing", Boolean(provider.typing)),
  };
  return {
    name: options.name ?? "whatsapp",
    kind: "whatsapp",
    info,
    instructions: options.instructions,
    keywords: keywordsFrom(WHATSAPP_KEYWORDS, options.keywords),
    phone: true,
    send: (to, outbound) => {
      switch (outbound.type) {
        case "message":
          return provider.sendMessage(to, message(outbound));
        case "carousel":
          return info.carousels && provider.sendCarousel ? provider.sendCarousel(to, carouselOf(outbound)) : sendCards(info, carouselOf(outbound), (m) => provider.sendMessage(to, m));
        case "reaction":
          return info.reactions ? provider.react?.(to, outbound.messageId, outbound.emoji) : undefined;
        case "typing":
          return has("typing", true) ? provider.typing?.(to, outbound.on) : undefined;
        case "read":
          return info.readReceipts ? provider.markRead?.(to, outbound.messageIds) : undefined;
        case "template": {
          if (!provider.sendTemplate || off.has("templates")) throw new Error("this WhatsApp provider sends no templates");
          const { type: _type, idempotencyKey, ...template } = outbound;
          return provider.sendTemplate(to, template, idempotencyKey);
        }
        case "status":
          return;
      }
    },
  };
}

export function sms(provider: SmsProvider, options: { name?: string; instructions?: string; keywords?: false | Partial<Keywords> } = {}): Channel {
  return {
    name: options.name ?? "sms",
    kind: "sms",
    info: SMS,
    instructions: options.instructions,
    keywords: keywordsFrom(SMS_KEYWORDS, options.keywords),
    phone: true,
    send: (to, outbound) => {
      if (outbound.type === "message") return provider.sendMessage(to, { text: outbound.text, ...(outbound.idempotencyKey ? { idempotencyKey: outbound.idempotencyKey } : {}) });
      if (outbound.type === "carousel") return sendCards(SMS, carouselOf(outbound), (m) => provider.sendMessage(to, { text: m.text, ...(m.idempotencyKey ? { idempotencyKey: m.idempotencyKey } : {}) }));
      if (outbound.type === "template") throw new Error("SMS has no templates");
      // Reactions, typing, read receipts and status do not exist on SMS.
    },
  };
}

export function customUI(name: string, provider: CustomUIProvider): Channel {
  const { records, ...declared } = provider.info ?? {};
  const info: ChannelInfo = {
    formatting: "markdown",
    ...declared,
    ...(records && provider.sendRecords ? { records } : {}),
    reactions: Boolean(provider.react),
    status: Boolean(provider.status),
    readReceipts: Boolean(provider.markRead),
  };
  return {
    name,
    kind: "custom",
    info,
    params: provider.params,
    instructions: provider.instructions,
    send: (to, outbound) => {
      switch (outbound.type) {
        case "message":
          return provider.sendMessage(to, { ...message(outbound), ...outbound.fields });
        case "carousel":
          return info.carousels && provider.sendCarousel ? provider.sendCarousel(to, carouselOf(outbound)) : sendCards(info, carouselOf(outbound), (m) => provider.sendMessage(to, { ...m }));
        case "reaction":
          return provider.react?.(to, outbound.messageId, outbound.emoji);
        case "typing":
          return provider.typing?.(to, outbound.on);
        case "read":
          return provider.markRead?.(to, outbound.messageIds);
        case "status":
          return provider.status?.(to, outbound.text);
        case "records":
          return provider.sendRecords?.(to, recordsPage(info, outbound));
        case "template":
          throw new Error(`${name} has no templates`);
      }
    },
  };
}

function message(outbound: Extract<Outbound, { type: "message" }>): Message {
  return {
    text: outbound.text,
    ...(outbound.replyTo ? { replyTo: outbound.replyTo } : {}),
    ...(outbound.buttons ? { buttons: outbound.buttons } : {}),
    ...(outbound.list ? { list: outbound.list } : {}),
    ...(outbound.link ? { link: outbound.link } : {}),
    ...(outbound.image ? { image: outbound.image } : {}),
    ...(outbound.preview === false ? { preview: false as const } : {}),
    ...(outbound.idempotencyKey ? { idempotencyKey: outbound.idempotencyKey } : {}),
  };
}

function carouselOf(outbound: Extract<Outbound, { type: "carousel" }>): Carousel {
  const { type: _type, ...carousel } = outbound;
  return carousel;
}

/**
 * A carousel as messages one after another, for a channel that cannot show one: its text, then
 * each card (its photo with its text as caption, its buttons or link), each fitted to the channel.
 * A send the business started keeps one idempotency key per message (key, key:1, key:2, ...).
 */
export function carouselMessages(info: ChannelInfo, carousel: Carousel): Message[] {
  const keyed = (i: number) => (carousel.idempotencyKey ? { idempotencyKey: i ? `${carousel.idempotencyKey}:${i}` : carousel.idempotencyKey } : {});
  const preview = carousel.preview === false ? { preview: false as const } : {};
  const cards = carousel.cards.map((card, i) =>
    fitMessage(info, {
      text: card.text ?? "",
      image: card.image,
      ...(card.buttons?.length && info.buttons ? { buttons: card.buttons } : {}),
      ...(card.link ? { link: card.link } : {}),
      ...preview,
      ...keyed(i + 1),
    }),
  );
  const first = { text: carousel.text, ...(carousel.replyTo ? { replyTo: carousel.replyTo } : {}), ...preview, ...keyed(0) };
  // A card with nothing this channel shows (no text, its photo dropped) is not sent.
  return [first, ...cards.filter((m) => m.text || m.image)];
}

/** Sends a carousel's messages one by one, in order, each after the last went; its receipt is the least far of theirs. */
async function sendCards(info: ChannelInfo, carousel: Carousel, send: (message: Message) => Promise<void | SendReceipt>): Promise<SendReceipt | undefined> {
  const receipts: Array<void | SendReceipt> = [];
  for (const m of carouselMessages(info, carousel)) receipts.push(await send(m));
  return leastOf(receipts);
}

const RECEIPT_RANK: Record<SendReceipt["status"], number> = { unconfirmed: 0, queued: 1, sent: 2, delivered: 3 };

/** The least far of several sends' receipts (none when no send gave one). */
function leastOf(receipts: Array<void | SendReceipt>): SendReceipt | undefined {
  let least: SendReceipt | undefined;
  for (const r of receipts) if (r && (!least || RECEIPT_RANK[r.status] < RECEIPT_RANK[least.status])) least = r;
  return least;
}

/**
 * A message as this channel can show it: without a link button the link's URL goes on a line after
 * the text, and without images the text goes alone. So a provider only gets what it declared.
 */
export function fitMessage<M extends { text: string; link?: { label: string; url: string }; image?: Photo }>(info: ChannelInfo, message: M): M {
  const { link, image, ...rest } = message;
  return {
    ...rest,
    ...(link && !info.linkButton ? { text: `${message.text}\n${link.url}` } : {}),
    ...(link && info.linkButton ? { link } : {}),
    ...(image && info.images ? { image } : {}),
  } as M;
}

/** The id of the "More" row or button under a page of records: a tap sends the next page. */
export const RECORDS_MORE = "chinwag:more";

/** One page of records, as a custom UI's sendRecords gets it. */
export interface RecordsPage {
  text: string;
  kind: string;
  /** This page's rows, each with its number in the whole list (from 1). */
  rows: Array<RecordRow & { number: number }>;
  pick?: { label: string };
  handle?: string;
  /** This page (from 1), how many there are, and how many rows in all. */
  page: number;
  pages: number;
  total: number;
  replyTo?: string;
}

type RecordsMode = "cards" | "list" | "buttons" | "text";

/**
 * How records are paged on a channel: what renders them (cards when every row has a photo and the
 * channel has carousels, else a list, else buttons, else numbered text; read-only rows always as
 * text), how many a page holds (a channel's records.maxRows, else 5 on SMS, else 10, within its
 * list's or buttons' maximum) and how many of those are rows (one is "More" on a list or buttons
 * when there are more pages).
 */
export function recordsLayout(info: ChannelInfo, records: Pick<RecordsOutbound, "rows" | "pick" | "page">): { mode: RecordsMode; perPage: number; pages: number } {
  const total = records.rows.length;
  let size = records.page?.size ?? info.records?.maxRows ?? (info.platform === "sms" ? 5 : 10);
  // A channel that takes records itself draws them its own way: pages hold only rows.
  let mode: RecordsMode = "text";
  if (info.records) mode = "text";
  else if (records.pick && info.carousels && total >= 2 && records.rows.every((r) => r.image)) {
    mode = "cards";
    size = Math.min(size, info.carousels.maxCards);
  } else if (records.pick && info.lists) {
    mode = "list";
    size = Math.min(size, info.lists.maxRows);
  } else if (records.pick && info.buttons && info.buttons.max >= 2) {
    mode = "buttons";
    size = Math.min(size, info.buttons.max);
  }
  size = Math.max(1, size);
  const perPage = (mode === "list" || mode === "buttons") && total > size ? Math.max(1, size - 1) : size;
  return { mode, perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
}

/** One page of records with its rows numbered, as a custom UI's sendRecords gets it. */
export function recordsPage(info: ChannelInfo, records: RecordsOutbound): RecordsPage {
  const { perPage, pages } = recordsLayout(info, records);
  const page = Math.min(Math.max(1, records.page?.number ?? 1), pages);
  const from = (page - 1) * perPage;
  return {
    text: records.text,
    kind: records.kind,
    rows: records.rows.slice(from, from + perPage).map((row, i) => ({ ...row, number: from + i + 1 })),
    ...(records.pick ? { pick: records.pick } : {}),
    ...(records.handle ? { handle: records.handle } : {}),
    page,
    pages,
    total: records.rows.length,
    ...(records.replyTo ? { replyTo: records.replyTo } : {}),
  };
}

/** Cuts text to `max` code points, ending with "…" when cut. */
function trimTo(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}

/**
 * One page of records as the messages a channel without `records` is sent, in order: WhatsApp a
 * list (details as row descriptions, or numbered in the text where rows have none), Telegram
 * numbered lines and a button per row, iMessage, SMS and read-only rows numbered text that says to
 * reply with a number (and MORE), photos with a pick button as a carousel. Each fitted to the
 * channel's limits (details trimmed, then left out); ids are never cut.
 */
export function recordsMessages(info: ChannelInfo, records: RecordsOutbound): Array<Extract<Outbound, { type: "message" | "carousel" }>> {
  const { mode } = recordsLayout(info, records);
  const page = recordsPage(info, records);
  const more = page.page < page.pages;
  const nextCount = Math.min(page.rows.length, page.total - (page.rows.at(-1)?.number ?? 0));
  const keyed = (i: number) => (records.idempotencyKey ? { idempotencyKey: i ? `${records.idempotencyKey}:${i}` : records.idempotencyKey } : {});
  const head = { ...(records.replyTo ? { replyTo: records.replyTo } : {}), ...(records.preview === false ? { preview: false as const } : {}) };
  const bold = (t: string) => (info.formatting === "whatsapp" ? `*${t}*` : info.formatting === "markdown" ? `**${t}**` : t);
  const limits = info.platform ? CONTENT_LIMITS[info.platform] : undefined;
  const fits = (max: number) => (text: string) => (limits?.smsSegments ? smsSegmentsOf(text).segments <= 3 : (limits?.utf16 ? text.length : codePoints(text)) <= max);
  /** The intro, numbered lines and a footer, with details trimmed and then left out until it fits. */
  const body = (fit: (text: string) => boolean, footer: string[] = []) => {
    for (const [titleMax, detailMax] of [[60, 120], [60, 60], [60, 0], [30, 0]]) {
      const lines = page.rows.map((r) => `${r.number}. ${bold(trimTo(r.title, titleMax))}${r.detail && detailMax ? `\n${trimTo(r.detail, detailMax)}` : ""}`);
      const text = [records.text, lines.join("\n"), ...footer].filter(Boolean).join("\n\n");
      if (fit(text) || titleMax === 30) return text;
    }
    return records.text;
  };
  const maxText = info.maxLength ?? 4_000;
  if (mode === "cards" && page.rows.length >= 2) {
    const c = info.carousels!;
    const cards: CarouselCard[] = page.rows.map((r) => ({
      image: r.image!,
      text: trimTo(r.detail ? `${r.title}\n${r.detail}` : r.title, c.cardTextMax),
      buttons: [{ id: r.id, label: trimTo(records.pick!.label, c.labelMax) }],
    }));
    const out: Array<Extract<Outbound, { type: "message" | "carousel" }>> = [{ type: "carousel", text: records.text, cards, ...head, ...keyed(0) }];
    if (more) {
      const count = `${page.rows[0].number}–${page.rows.at(-1)!.number} / ${page.total}`;
      out.push(info.buttons ? { type: "message", text: count, buttons: [{ id: RECORDS_MORE, label: "More" }], ...keyed(1) } : { type: "message", text: `${count}\n\nReply MORE for the next ${nextCount}.`, ...keyed(1) });
    }
    return out;
  }
  const moreButton = more ? [{ id: RECORDS_MORE, label: "More" }] : [];
  if (mode === "list" || (mode === "cards" && info.lists)) {
    const l = info.lists!;
    const described = l.descriptions !== false;
    const max = limits?.buttonsText ?? maxText;
    const rows: ListRow[] = page.rows.map((r) => ({ id: r.id, title: trimTo(r.title, l.titleMax), ...(described && r.detail ? { description: trimTo(r.detail, 72) } : {}) }));
    const text = described ? records.text : body(fits(max));
    return [{ type: "message", text, list: { button: trimTo(records.pick!.label, l.buttonMax), rows: [...rows, ...moreButton.map((m) => ({ id: m.id, title: m.label }))] }, ...head, ...keyed(0) }];
  }
  if (mode === "buttons" || (mode === "cards" && info.buttons)) {
    const b = info.buttons!;
    const max = limits?.buttonsText ?? maxText;
    const buttons = [...page.rows.map((r) => ({ id: r.id, label: trimTo(`${r.number}. ${r.title}`, b.labelMax) })), ...moreButton];
    return [{ type: "message", text: body(fits(max)), buttons, ...head, ...keyed(0) }];
  }
  const footer = [
    ...(records.pick ? ["Reply with a number to pick one."] : []),
    ...(more ? [`Reply MORE for the next ${nextCount}.`] : []),
  ];
  return [{ type: "message", text: body(fits(maxText), [footer.join(" ")].filter(Boolean)), ...head, ...keyed(0) }];
}

/**
 * Each platform's content limits as Flow Messaging enforces them (its API spec, flow-engineer/sdk,
 * and the checks its server runs on every send: the channel's text, caption and buttons-text limits,
 * SMS segments). They are the platforms' own (WhatsApp's, Telegram's), with Flow Messaging's
 * counting: characters as code points, Telegram's as UTF-16 code units. Keep them in step with it.
 */
export const CONTENT_LIMITS: Record<NonNullable<ChannelInfo["platform"]>, ContentLimits> = {
  whatsapp: { name: "WhatsApp", text: 4096, caption: 1024, buttonsText: 1024, mediaHeaderReplies: 3 },
  // Flow sends Telegram text as Markdown and counts it as rendered; this counts it as written, so it
  // can only be stricter, and only for formatted text near the limit.
  telegram: { name: "Telegram", text: 4096, utf16: true, caption: 1024, buttonsText: 4096 },
  imessage: { name: "iMessage", text: 9999, caption: 1024 },
  sms: { name: "SMS", text: 1530, caption: 1024, smsSegments: 10 },
};

export interface ContentLimits {
  /** The platform's name in errors. */
  name: string;
  /** The most characters a text takes. */
  text: number;
  /** Characters are counted as UTF-16 code units (an emoji such as 😀 is 2), not code points. */
  utf16?: boolean;
  /** The most characters a photo's caption takes. */
  caption: number;
  /** With buttons (or a link button): the most characters their text takes. Absent: the platform shows no buttons. */
  buttonsText?: number;
  /** With a photo heading them: the most reply buttons (WhatsApp shows more as a list, whose header can only be text). */
  mediaHeaderReplies?: number;
  /** The most SMS segments one text takes. */
  smsSegments?: number;
}

/** Limits of every platform (the spec's). */
const SPEC = { buttonsText: 4096, caption: 1024, buttons: 10, label: 20, buttonId: 64, carouselText: 1024, minCards: 2, maxCards: 10, cardText: 160, cardLineBreaks: 2, cardButtons: 2 };

/** A send Flow Messaging refuses, as it refuses it: its error type, the field (`param`) and its message. */
export interface ContentRefusal {
  type: "invalid_request";
  param: string;
  message: string;
}

/**
 * Why the channel's platform would refuse this outbound (Flow Messaging's checks, in its order, on
 * the content Flow Framework's Flow Messaging channels make of it), or null. Only messages and
 * carousels are checked, on channels whose info names a platform. A link is a link button, a photo
 * with buttons or a link their header (else a photo with the text as its caption), a button's id is
 * its own or its label (a list row's, its id), and a carousel on a channel without carousels is checked as the
 * messages it is sent as. Photos by file id are the provider's own and not checked here; nor are
 * media types (Flow converts WebP, GIF, BMP and TIFF; the rest is known only from the file's bytes).
 */
export function contentRefusal(info: ChannelInfo, outbound: Outbound): ContentRefusal | null {
  // Flow Messaging's own refusal of a template where the channel has none.
  if (outbound.type === "template" && info.templates === false) return refuse("content.type", `${info.platform ? CONTENT_LIMITS[info.platform].name : "This channel"} has no templates; send a message instead.`);
  const limits = info.platform ? CONTENT_LIMITS[info.platform] : undefined;
  if (!limits) return null;
  if (outbound.type === "message") return messageRefusal(limits, outbound);
  if (outbound.type === "records") {
    if (info.records) return null;
    for (const m of recordsMessages(info, outbound)) {
      const refusal = contentRefusal(info, m);
      if (refusal) return refusal;
    }
    return null;
  }
  if (outbound.type !== "carousel") return null;
  if (info.carousels) return carouselRefusal(outbound);
  for (const m of carouselMessages(info, carouselOf(outbound))) {
    const refusal = messageRefusal(limits, m);
    if (refusal) return refusal;
  }
  return null;
}

const refuse = (param: string, message: string): ContentRefusal => ({ type: "invalid_request", param, message });
const codePoints = (s: string) => [...s].length;
const isHttps = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.host !== "";
  } catch {
    return false;
  }
};

/** A reply button's id and label: a plain label is its own id. */
export function replyButton(button: ReplyButton): { id: string; label: string } {
  return typeof button === "string" ? { id: button, label: button } : { id: button.id, label: button.label };
}

type FlowButton = { id: string; label: string } | { url: string; label: string };

/** Buttons at `param` (reply ids unique across `seen`): Flow Messaging's checkButtonList. */
function buttonsRefusal(buttons: FlowButton[], param: string, seen: Set<string>, duplicate = "Button ids must be unique within a message."): ContentRefusal | null {
  for (const [i, b] of buttons.entries()) {
    const bp = `${param}.buttons[${i}]`;
    const label = codePoints(b.label);
    if ("url" in b) {
      if (!isHttps(b.url) || label === 0 || label > SPEC.label) return refuse(bp, "A link button needs an https url and a label of 1 to 20 characters.");
      continue;
    }
    if (b.id === "" || new TextEncoder().encode(b.id).length > SPEC.buttonId || label === 0 || label > SPEC.label) return refuse(bp, "A reply button needs an id of 1 to 64 bytes and a label of 1 to 20.");
    if (seen.has(b.id)) return refuse(`${bp}.id`, duplicate);
    seen.add(b.id);
  }
  return null;
}

function messageRefusal(limits: ContentLimits, m: Pick<Message, "text" | "buttons" | "list" | "link" | "image">): ContentRefusal | null {
  const length = (s: string) => (limits.utf16 ? s.length : codePoints(s));
  const on = limits.name;
  const buttons: FlowButton[] | undefined = m.link
    ? [{ url: m.link.url, label: m.link.label }]
    : m.buttons?.length
      ? m.buttons.map(replyButton)
      : m.list?.rows.map((row) => ({ id: row.id, label: row.title }));
  const header = m.image && "url" in m.image ? m.image.url : undefined;
  if (buttons && limits.buttonsText) {
    if (m.text === "" || codePoints(m.text) > SPEC.buttonsText) return refuse("content.text", `text must be 1 to ${SPEC.buttonsText} characters.`);
    if (buttons.length < 1 || buttons.length > SPEC.buttons) return refuse("content.buttons", "Give 1 to 10 buttons.");
    const problem = buttonsRefusal(buttons, "content", new Set());
    if (problem) return problem;
    if (header !== undefined && !isHttps(header)) return refuse("content.header.url", "content.header.url must be an https URL Flow can fetch.");
    if (m.image && codePoints(m.text) > SPEC.caption) return refuse("content.text", `text must be 1 to ${SPEC.caption} characters with a media header.`);
    if (length(m.text) > limits.buttonsText) return refuse("content.text", `text must be 1 to ${limits.buttonsText} characters with buttons on ${on}.`);
    if (m.image && length(m.text) > limits.caption) return refuse("content.text", `caption must be at most ${limits.caption} characters on ${on}.`);
    const replies = buttons.filter((b) => !("url" in b)).length;
    if (m.image && limits.mediaHeaderReplies && replies > limits.mediaHeaderReplies) return refuse("content.header", `A media header goes with at most ${limits.mediaHeaderReplies} reply buttons on ${on}.`);
    return null;
  }
  if (m.image) {
    if (header !== undefined && !isHttps(header)) return refuse("content.url", "url must be an https URL Flow can fetch.");
    if (m.text && codePoints(m.text) > SPEC.caption) return refuse("content.caption", `caption must be at most ${SPEC.caption} characters.`);
    if (m.text && length(m.text) > limits.caption) return refuse("content.caption", `caption must be at most ${limits.caption} characters on ${on}.`);
    return null;
  }
  const n = length(m.text);
  if (n === 0) return refuse("content.text", `text is empty; give 1 to ${limits.text} characters on ${on}.`);
  if (n > limits.text) return refuse("content.text", `text must be 1 to ${limits.text} characters on ${on}.`);
  if (limits.smsSegments) {
    const { segments, encoding } = smsSegmentsOf(m.text);
    if (segments > limits.smsSegments) {
      return refuse(
        "content.text",
        encoding === "ucs2"
          ? `This text is ${segments} SMS segments as UCS-2 because it contains an emoji or a character outside GSM-7; SMS takes at most ${limits.smsSegments}.`
          : `This text is ${segments} SMS segments (GSM-7); SMS takes at most ${limits.smsSegments}.`,
      );
    }
  }
  return null;
}

function carouselRefusal(c: Carousel): ContentRefusal | null {
  if (c.text === "" || codePoints(c.text) > SPEC.carouselText) return refuse("content.text", `text must be 1 to ${SPEC.carouselText} characters.`);
  if (c.cards.length < SPEC.minCards || c.cards.length > SPEC.maxCards) return refuse("content.cards", `Give ${SPEC.minCards} to ${SPEC.maxCards} cards.`);
  const seen = new Set<string>();
  let first: { links: boolean; count: number } | undefined;
  for (const [i, card] of c.cards.entries()) {
    const cp = `content.cards[${i}]`;
    if ("url" in card.image && !isHttps(card.image.url)) return refuse(`${cp}.header.url`, `${cp}.header.url must be an https URL Flow can fetch.`);
    if (card.text !== undefined) {
      const n = codePoints(card.text);
      if (n === 0 || n > SPEC.cardText) return refuse(`${cp}.text`, `${cp}.text must be 1 to ${SPEC.cardText} characters.`);
      if (card.text.split("\n").length - 1 > SPEC.cardLineBreaks) return refuse(`${cp}.text`, `${cp}.text has more than ${SPEC.cardLineBreaks} line breaks.`);
    }
    const buttons: FlowButton[] = card.link ? [{ url: card.link.url, label: card.link.label }] : (card.buttons ?? []).map(replyButton);
    if (buttons.length < 1 || buttons.length > SPEC.cardButtons) return refuse(`${cp}.buttons`, `${cp}.buttons must hold 1 to ${SPEC.cardButtons} buttons.`);
    const problem = buttonsRefusal(buttons, cp, seen, "Reply button ids must be unique across the carousel.");
    if (problem) return problem;
    const links = Boolean(card.link);
    if (!first) first = { links, count: buttons.length };
    else if (links !== first.links || buttons.length !== first.count) return refuse(`${cp}.buttons`, `${cp}.buttons differ from cards[0].buttons in number or kind.`);
  }
  return null;
}

/** GSM 03.38's alphabet: one septet each, its extension table's characters two. */
const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€\f";

/**
 * How many SMS segments a text takes, as Flow Messaging counts them: GSM-7 when every character is
 * in the GSM alphabet (160 in one segment, 153 per segment when split, an extension character two
 * and never split across segments), else UCS-2 (70 UTF-16 units, 67 when split, a character outside
 * the BMP two and never split).
 */
function smsSegmentsOf(text: string): { segments: number; encoding: "gsm7" | "ucs2" } {
  const chars = [...text];
  const gsm = chars.every((c) => GSM_BASIC.includes(c) || GSM_EXTENDED.includes(c));
  const unit = gsm ? (c: string) => (GSM_EXTENDED.includes(c) ? 2 : 1) : (c: string) => c.length;
  const [single, split] = gsm ? [160, 153] : [70, 67];
  const encoding = gsm ? ("gsm7" as const) : ("ucs2" as const);
  if (chars.reduce((n, c) => n + unit(c), 0) <= single) return { segments: 1, encoding };
  let segments = 1;
  let used = 0;
  for (const c of chars) {
    if (used + unit(c) > split) {
      segments++;
      used = 0;
    }
    used += unit(c);
  }
  return { segments, encoding };
}

/** A declared template filled with the values of one send: what the person sees. */
export interface FilledTemplate {
  header?: { kind: "text"; text: string } | { kind: "image" | "video" | "document"; url?: string; fileId?: string };
  body: string;
  footer?: string;
  /** A quick reply's tap comes back with its payload (its text when the send gave none). */
  buttons: Array<{ type: "quick_reply"; text: string; payload: string } | { type: "url"; text: string; url: string } | { type: "phone"; text: string; phone: string }>;
}

/**
 * A declared template filled with one send's values. Throws, saying what is wrong, when the values
 * don't fit it (Meta would refuse the send): a missing or extra body value, header value or button
 * value.
 */
export function fillTemplate(definition: TemplateDefinition, template: Template): FilledTemplate {
  const fail = (problem: string): never => {
    throw new Error(`flow: template "${definition.name}" (${definition.language}) ${problem}`);
  };
  if (template.body && template.variables) fail("got both body and variables: give one");
  const values = template.body ?? numbered(template.variables);
  const wanted = new Set([...definition.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
  if (values.length !== wanted) fail(`takes ${wanted} body value${wanted === 1 ? "" : "s"}, got ${values.length}`);
  const body = definition.body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => values[Number(n) - 1] ?? "");

  const shape = definition.header;
  const given = template.header;
  let header: FilledTemplate["header"];
  if (shape?.kind === "text" && shape.text.includes("{{1}}")) {
    if (given?.kind !== "text") fail("takes a text value for its header");
    header = { kind: "text", text: shape.text.replace("{{1}}", (given as { text: string }).text) };
  } else if (shape && shape.kind !== "text") {
    if (given?.kind !== shape.kind || !(given.url || given.fileId)) fail(`takes a ${shape.kind} for its header, by url or fileId`);
    header = given;
  } else {
    if (given) fail("takes no header value");
    header = shape;
  }

  const buttonValues = new Map((template.buttons ?? []).map((b) => [b.index, b.value]));
  for (const index of buttonValues.keys()) {
    const button = definition.buttons?.[index];
    if (!button || button.type === "phone" || (button.type === "url" && !button.url.endsWith("{{1}}"))) fail(`takes no value for button ${index}`);
  }
  const buttons = (definition.buttons ?? []).map((button, index): FilledTemplate["buttons"][number] => {
    const value = buttonValues.get(index);
    if (button.type === "quick_reply") return { ...button, payload: value ?? button.text };
    if (button.type === "url" && button.url.endsWith("{{1}}")) {
      if (value === undefined) fail(`takes the end of button ${index}'s URL ("${button.text}")`);
      return { ...button, url: button.url.slice(0, -5) + value };
    }
    return button;
  });
  return { ...(header ? { header } : {}), body, ...(definition.footer ? { footer: definition.footer } : {}), buttons };
}

/** The declared template a send is of: by name, and by language when the send names one. */
export function declaredTemplate(definitions: TemplateDefinition[] | undefined, template: Template): TemplateDefinition | undefined {
  return definitions?.find((d) => d.name === template.name && (!template.language || d.language === template.language));
}

/** The older `variables` as body values: by number when every key is one, else in the order given. */
function numbered(variables: Record<string, string> | undefined): string[] {
  const entries = Object.entries(variables ?? {});
  if (entries.every(([k]) => /^\d+$/.test(k))) entries.sort(([a], [b]) => Number(a) - Number(b));
  return entries.map(([, v]) => v);
}

export function summarize(channel: Channel): ChannelSummary {
  return { name: channel.name, kind: channel.kind, info: channel.info };
}
