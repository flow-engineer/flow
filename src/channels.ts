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
import type { CarouselCard, ChannelInfo, ListRow, Outbound, Photo, Template, TemplateDefinition } from "./types.ts";

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
  send(address: string, outbound: Outbound): Promise<void> | void;
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
  buttons?: string[];
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
  sendMessage(to: string, message: Message): Promise<void>;
  /** A media carousel; without it the agent is never offered one. */
  sendCarousel?(to: string, carousel: Carousel): Promise<void>;
  /** Which parts of a message this provider can send. Default: all. */
  features?: { buttons?: boolean; lists?: boolean; replies?: boolean; links?: boolean; images?: boolean };
  react?(to: string, messageId: string, emoji: string): Promise<void>;
  typing?(to: string, on: boolean): Promise<void>;
  markRead?(to: string, messageIds: string[]): Promise<void>;
  sendTemplate?(to: string, template: Template, idempotencyKey?: string): Promise<void>;
}

export interface SmsProvider {
  sendMessage(to: string, message: Pick<Message, "text" | "idempotencyKey">): Promise<void>;
}

/** Your own UI. `message` carries the text, any buttons, and your params by name. */
export interface CustomUIProvider {
  /** What your UI can show. Default: Markdown, no buttons. */
  info?: Omit<ChannelInfo, "reactions" | "status" | "readReceipts">;
  params?: Record<string, z.ZodType>;
  /** Your own guidance for the agent on this channel, such as how to use your params. */
  instructions?: string;
  sendMessage(to: string, message: Message & Record<string, unknown>): Promise<void>;
  /** A carousel, on a UI whose info declares carousels; without it the cards go one by one through sendMessage. */
  sendCarousel?(to: string, carousel: Carousel): Promise<void>;
  react?(to: string, messageId: string, emoji: string): Promise<void>;
  typing?(to: string, on: boolean): Promise<void>;
  markRead?(to: string, messageIds: string[]): Promise<void>;
  /** A short line of what the agent is doing, in your loading indicator; null clears it. */
  status?(to: string, text: string | null): Promise<void>;
}

/** WhatsApp's own limits, the same for every provider. */
export const WHATSAPP: ChannelInfo = {
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
export const SMS: ChannelInfo = { reactions: false, status: false, formatting: "plain", maxLength: 1530 };

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
  const info: ChannelInfo = {
    formatting: "markdown",
    ...provider.info,
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

/** Sends a carousel's messages one by one, in order, each after the last went. */
async function sendCards(info: ChannelInfo, carousel: Carousel, send: (message: Message) => Promise<void>): Promise<void> {
  for (const m of carouselMessages(info, carousel)) await send(m);
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
