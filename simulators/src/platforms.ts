// What each chat platform can do, used by the simulators and the test harness, so an
// agent meets the same rules it would on the real platform. Nothing here sends real messages.
// SMS, WhatsApp, Telegram and iMessage are modelled in full (Telegram's and iMessage's as Flow
// Messaging sends them); the web simulator plays a custom UI, whose own info says what it can do.

import type { ChannelInfo } from "../../src/index.ts";
import { IMESSAGE, TELEGRAM } from "../../flow-messaging/src/index.ts";

export interface Platform extends ChannelInfo {
  id: "sms" | "whatsapp" | "imessage" | "telegram" | "web";
  name: string;
  /** Shows "typing…" while the agent works. Plain SMS has no typing indicator. */
  typing: boolean;
  /** SMS: texts are billed and split into segments (160 GSM-7 characters, 70 with Unicode). */
  segments?: boolean;
  /** SMS: the carrier answers STOP, START and HELP itself, and blocks texts after STOP. */
  carrierKeywords?: boolean;
  /** SMS: an iPhone's tapback reaches the agent as a text, like `Liked "…"`. */
  tapbacksAsText?: boolean;
  /** The person can react to the agent's messages with these (WhatsApp's quick reactions, Telegram's, iMessage's tapbacks). */
  personReactions?: string[];
  /** The simulator models every feature and limit of the real platform. */
  complete: boolean;
  /** Simple Icons slug for the logo (cdn.simpleicons.org). */
  icon: string;
}

export const PLATFORMS: Platform[] = [
  {
    id: "sms",
    name: "SMS",
    reactions: false,
    status: false,
    typing: false,
    formatting: "plain",
    // Providers join up to 10 segments into one text: 1,530 GSM-7 characters.
    maxLength: 1530,
    segments: true,
    carrierKeywords: true,
    tapbacksAsText: true,
    complete: true,
    icon: "googlemessages",
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    reactions: true,
    status: false,
    typing: true,
    formatting: "whatsapp",
    maxLength: 4096,
    replies: true,
    buttons: { max: 3, labelMax: 20 },
    buttonIds: true,
    lists: { maxRows: 10, titleMax: 24, buttonMax: 20 },
    linkButton: { labelMax: 20 },
    images: { captionMax: 1024 },
    readReceipts: true,
    personReactions: ["👍", "❤️", "😂", "😮", "😢", "🙏"],
    complete: true,
    icon: "whatsapp",
  },
  {
    ...IMESSAGE,
    id: "imessage",
    name: "iMessage",
    typing: true,
    // Tapbacks; other emoji reach the agent as emoji reactions too.
    personReactions: ["❤️", "👍", "👎", "😂", "‼️", "❓"],
    complete: true,
    icon: "imessage",
  },
  {
    ...TELEGRAM,
    id: "telegram",
    name: "Telegram",
    typing: true,
    // The first of Telegram's default reactions, as its quick picker shows them.
    personReactions: ["❤️", "👍", "👎", "🔥", "🥰", "👏", "😁"],
    complete: true,
    icon: "telegram",
  },
  { id: "web", name: "Web", reactions: true, status: true, typing: true, formatting: "markdown", linkButton: { labelMax: 20 }, images: { captionMax: 4000 }, complete: false, icon: "googlechrome" },
];

export function platform(id: string | null): Platform {
  return PLATFORMS.find((p) => p.id === id) ?? PLATFORMS[0];
}

/** The parts of a platform the agent's runtime needs. */
export function channelOf(p: Platform): ChannelInfo {
  return {
    // Flow Messaging's content rules for the platform (CONTENT_LIMITS); the web has none.
    ...(p.id === "web" ? {} : { platform: p.id }),
    reactions: p.reactions,
    status: p.status,
    formatting: p.formatting,
    maxLength: p.maxLength,
    replies: p.replies,
    buttons: p.buttons,
    buttonIds: p.buttonIds,
    lists: p.lists,
    linkButton: p.linkButton,
    images: p.images,
    readReceipts: p.readReceipts,
    ...(p.edits ? { edits: true } : {}),
    ...(p.unsends ? { unsends: true } : {}),
  };
}

const GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;

/** How an SMS is split: its encoding, segment count, and characters left in the last segment. */
export function smsSegments(text: string): { encoding: "GSM-7" | "Unicode"; segments: number; remaining: number } {
  const gsm = GSM7.test(text);
  // GSM-7 extension characters take two septets.
  const length = gsm ? [...text].reduce((n, c) => n + ("^{}\\[~]|€".includes(c) ? 2 : 1), 0) : [...text].length;
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  if (length <= single) return { encoding: gsm ? "GSM-7" : "Unicode", segments: 1, remaining: single - length };
  const segments = Math.ceil(length / multi);
  return { encoding: gsm ? "GSM-7" : "Unicode", segments, remaining: segments * multi - length };
}

/** A message as the simulator shows it: enough of a Line (server.ts) to say what the platform's API carried. */
export interface WireMessage {
  kind: "in" | "out";
  id: string | null;
  text: string;
  at: number;
  replyTo?: string;
  choice?: boolean;
  choiceId?: string;
  attachments?: Array<{ kind: string; name?: string; mime?: string; size?: number }>;
  buttons?: Array<string | { id: string; label: string }>;
  list?: { button: string; rows: Array<{ id: string; title: string; description?: string }> };
  link?: { label: string; url: string };
  image?: { url: string } | { fileId: string };
  carousel?: Array<{ image: { url: string } | { fileId: string }; text?: string; buttons?: Array<string | { id: string; label: string }>; link?: { label: string; url: string } }>;
  template?: { name: string };
}

/** What a payload is: the request it was (method and URL), or the webhook it came in. */
export interface Wire {
  api: string;
  body: unknown;
}

/**
 * The message as the real platform's API carries it, for the simulator's debug view: the webhook
 * the person's message arrives as, the request the agent's provider makes. WhatsApp's Cloud API,
 * Telegram's Bot API, a US SMS provider's (Twilio's), and Flow Messaging's for iMessage, which has
 * no public API. Ids, numbers and tokens are made up; `quoted` is the message this one replies to.
 * Nothing for the web: a custom UI's API is its own.
 */
export function wirePayload(p: Platform, m: WireMessage, person: { name: string; phone: string }, quoted?: WireMessage): Wire | null {
  const phone = person.phone.replace(/[^\d]/g, "") || "15555550100";
  const seconds = String(Math.floor(m.at / 1000));
  const sid = (prefix: string, id: string | null, length: number) => prefix + hex(`${phone}:${id ?? m.at}`, length);
  const buttonOf = (b: string | { id: string; label: string }) => (typeof b === "string" ? { id: b, label: b } : b);
  const photo = (image: NonNullable<WireMessage["image"]>) => ("url" in image ? { link: image.url } : { id: image.fileId });
  const file = (a: NonNullable<WireMessage["attachments"]>[number]) => ({ mime_type: a.mime ?? "application/octet-stream", sha256: hex(`${m.at}:${a.name}`, 44), id: digits(`${m.at}:${a.name}`, 16) });

  if (p.id === "whatsapp") {
    const wamid = (id: string | null) => `wamid.${Buffer.from(`${phone}:${id ?? m.at}`).toString("base64").replace(/=/g, "")}`;
    if (m.kind === "in") {
      const context = quoted ? { context: { from: BUSINESS_NUMBER, id: wamid(quoted.id) } } : {};
      const messages = m.attachments?.length
        ? m.attachments.map((a, i) => ({
            from: phone, id: wamid(`${m.id}.${i}`), timestamp: seconds, ...context, type: a.kind,
            [a.kind]: { ...(i === 0 && m.text && a.kind !== "audio" ? { caption: m.text } : {}), ...(a.kind === "document" && a.name ? { filename: a.name } : {}), ...file(a), ...(a.kind === "audio" ? { voice: true } : {}) },
          }))
        : m.choice && quoted?.template
          ? [{ from: phone, id: wamid(m.id), timestamp: seconds, ...context, type: "button", button: { payload: m.choiceId ?? m.text, text: m.text } }]
          : m.choice
            ? [{ from: phone, id: wamid(m.id), timestamp: seconds, ...context, type: "interactive", interactive: quoted?.list ? { type: "list_reply", list_reply: { id: m.choiceId ?? m.text, title: m.text } } : { type: "button_reply", button_reply: { id: m.choiceId ?? m.text, title: m.text } } }]
            : [{ from: phone, id: wamid(m.id), timestamp: seconds, ...context, type: "text", text: { body: m.text } }];
      return {
        api: "POST your webhook · WhatsApp Cloud API",
        body: { object: "whatsapp_business_account", entry: [{ id: "WHATSAPP_BUSINESS_ACCOUNT_ID", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: BUSINESS_NUMBER, phone_number_id: "PHONE_NUMBER_ID" }, contacts: [{ profile: { name: person.name }, wa_id: phone }], messages } }] }] },
      };
    }
    const header = m.image ? { header: { type: "image", image: photo(m.image) } } : {};
    const sent = m.template
      ? { type: "template", template: { name: m.template.name, language: { code: "en" } } }
      : m.carousel
        ? { type: "interactive", interactive: { type: "carousel", body: { text: m.text }, action: { cards: m.carousel.map((c, i) => ({ card_index: i, type: c.link ? "cta_url" : "button", header: { type: "image", image: photo(c.image) }, ...(c.text ? { body: { text: c.text } } : {}), action: c.link ? { name: "cta_url", parameters: { display_text: c.link.label, url: c.link.url } } : { buttons: (c.buttons ?? []).map(buttonOf).map((b) => ({ type: "quick_reply", quick_reply: { id: b.id, title: b.label } })) } })) } } }
        : m.buttons
          ? { type: "interactive", interactive: { type: "button", ...header, body: { text: m.text }, action: { buttons: m.buttons.map(buttonOf).map((b) => ({ type: "reply", reply: { id: b.id, title: b.label } })) } } }
          : m.list
            ? { type: "interactive", interactive: { type: "list", body: { text: m.text }, action: { button: m.list.button, sections: [{ rows: m.list.rows.map((r) => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) })) }] } } }
            : m.link
              ? { type: "interactive", interactive: { type: "cta_url", ...header, body: { text: m.text }, action: { name: "cta_url", parameters: { display_text: m.link.label, url: m.link.url } } } }
              : m.image
                ? { type: "image", image: { ...photo(m.image), ...(m.text ? { caption: m.text } : {}) } }
                : { type: "text", text: { preview_url: /https?:\/\//.test(m.text), body: m.text } };
    return {
      api: "POST https://graph.facebook.com/v21.0/PHONE_NUMBER_ID/messages",
      body: { messaging_product: "whatsapp", recipient_type: "individual", to: phone, ...(m.replyTo ? { context: { message_id: wamid(m.replyTo) } } : {}), ...sent },
    };
  }

  if (p.id === "telegram") {
    const user = Number(phone.slice(-10));
    const messageId = (id: string | null) => Number(digits(`${phone}:${id ?? m.at}`, 6));
    const from = { id: user, is_bot: false, first_name: person.name.split(" ")[0], language_code: "en" };
    const chat = { id: user, first_name: from.first_name, type: "private" };
    if (m.kind === "in") {
      if (m.choice && quoted) {
        return { api: "POST your webhook · Telegram Bot API Update", body: { update_id: messageId(m.id), callback_query: { id: digits(`${m.at}`, 19), from, message: { message_id: messageId(quoted.id), from: BOT, chat, date: Math.floor(quoted.at / 1000), text: quoted.text }, chat_instance: digits(phone, 19), data: m.choiceId ?? m.text } } };
      }
      const a = m.attachments?.[0];
      const media = !a ? { text: m.text }
        : a.kind === "image" ? { photo: [90, 320, 800].map((w, i) => ({ file_id: `AgACAgQAAxkBAA${hex(`${m.at}${i}`, 24)}`, file_unique_id: hex(`${m.at}u${i}`, 15), width: w, height: Math.round(w * 0.75), file_size: Math.round((a.size ?? 120_000) * (i + 1) / 3) })), ...(m.text ? { caption: m.text } : {}) }
          : a.kind === "audio" ? { voice: { duration: 3, mime_type: a.mime ?? "audio/ogg", file_id: `AwACAgQAAxkBAA${hex(`${m.at}`, 24)}`, file_unique_id: hex(`${m.at}u`, 15), file_size: a.size } }
            : { document: { file_name: a.name, mime_type: a.mime, file_id: `BQACAgQAAxkBAA${hex(`${m.at}`, 24)}`, file_unique_id: hex(`${m.at}u`, 15), file_size: a.size }, ...(m.text ? { caption: m.text } : {}) };
      return { api: "POST your webhook · Telegram Bot API Update", body: { update_id: messageId(m.id), message: { message_id: messageId(m.id), from, chat, date: Number(seconds), ...(quoted ? { reply_to_message: { message_id: messageId(quoted.id), from: quoted.kind === "out" ? BOT : from, chat, date: Math.floor(quoted.at / 1000), text: quoted.text } } : {}), ...media } } };
    }
    const keyboard = m.link
      ? [[{ text: m.link.label, url: m.link.url }]]
      : m.buttons?.map(buttonOf).map((b) => [{ text: b.label, callback_data: b.id }]);
    const markup = keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {};
    const reply = m.replyTo ? { reply_parameters: { message_id: messageId(m.replyTo) } } : {};
    if (m.image) return { api: "POST https://api.telegram.org/bot<token>/sendPhoto", body: { chat_id: user, photo: "url" in m.image ? m.image.url : m.image.fileId, ...(m.text ? { caption: m.text, parse_mode: "Markdown" } : {}), ...reply, ...markup } };
    return { api: "POST https://api.telegram.org/bot<token>/sendMessage", body: { chat_id: user, text: m.text, parse_mode: "Markdown", ...reply, ...markup } };
  }

  if (p.id === "sms") {
    const sms = smsSegments(m.text);
    if (m.kind === "in") {
      return { api: "POST your webhook · SMS provider (Twilio), form-encoded", body: { ToCountry: "US", SmsMessageSid: sid("SM", m.id, 32), NumMedia: "0", MessageSid: sid("SM", m.id, 32), AccountSid: "ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", From: `+${phone}`, To: `+${BUSINESS_NUMBER}`, Body: m.text, NumSegments: String(sms.segments), MessagingServiceSid: "MGXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", ApiVersion: "2010-04-01" } };
    }
    return { api: "POST https://api.twilio.com/2010-04-01/Accounts/AC…/Messages.json, form-encoded", body: { To: `+${phone}`, From: `+${BUSINESS_NUMBER}`, Body: m.text } };
  }

  if (p.id === "imessage") {
    const conversation = `conv_${hex(phone, 24)}`;
    if (m.kind === "in") {
      const a = m.attachments?.[0];
      const file = `file_${hex(`${m.at}`, 24)}`;
      const content = !a ? { kind: "basic", text: m.text }
        : a.kind === "audio" ? { kind: "voice", file_id: file, url: `https://api.flow.engineer/v0/files/${file}` }
          : { kind: "basic", media: { type: a.kind, file_id: file, url: `https://api.flow.engineer/v0/files/${file}`, mime_type: a.mime, ...(a.name ? { filename: a.name } : {}) }, ...(m.text ? { text: m.text } : {}) };
      return { api: "POST your webhook · Flow Messaging event (iMessage has no public API)", body: { id: `evt_${hex(`${m.at}`, 24)}`, type: "message.received", conversation: { id: conversation, channel: "imessage", sender: "snd_…", contact: `ct_${hex(phone, 24)}` }, data: { message: { id: `msg_${hex(`${m.id}`, 24)}`, conversation, direction: "in", content, ...(quoted ? { reply_to: `msg_${hex(`${quoted.id}`, 24)}` } : {}) } } } };
    }
    const body = m.image ? { media: { type: "image", ...("url" in m.image ? { url: m.image.url } : { file_id: m.image.fileId }) }, ...(m.text ? { text: m.text } : {}) } : { text: m.text };
    return { api: `POST https://api.flow.engineer/v0/conversations/${conversation}/basic · Flow Messaging`, body: { ...body, ...(m.replyTo ? { reply_to: `msg_${hex(m.replyTo, 24)}` } : {}) } };
  }
  return null;
}

const BUSINESS_NUMBER = "15550001234";
const BOT = { id: 7000000001, is_bot: true, first_name: "Agent", username: "your_agent_bot" };

/** A made-up id that stays the same for the same input: `length` hex digits. */
function hex(input: string, length: number): string {
  let out = "";
  for (let i = 0; out.length < length; i++) {
    let h = 2166136261 ^ i;
    for (const c of input) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

/** The same as `hex`, in decimal digits (never starting with 0). */
function digits(input: string, length: number): string {
  const d = hex(input, length * 2).replace(/[a-f]/g, (c) => String(c.charCodeAt(0) % 10));
  return (d.replace(/^0+/, "") + "1".repeat(length)).slice(0, length);
}
