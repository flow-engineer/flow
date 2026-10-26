// The shapes every part of Flow Framework shares: chat history, the model contract, what a channel is sent.

export interface ToolCall {
  id: string;
  name: string;
  /** The model's arguments as it wrote them (a JSON string). */
  arguments: string;
}

export type ChatMessage =
  | {
      role: "user";
      content: string;
      media?: Media[];
      messages?: PersonMessage[];
      /** A reset marker (`agent.resetHistory`): the model is sent only what comes after it. */
      reset?: true;
    }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

/**
 * One of the person's messages in a history entry, kept beside its text (never sent to the model):
 * its id (the provider's, or Flow Framework's m1, m2, ...), its channel, and what they wrote or tapped.
 */
export interface PersonMessage {
  id: string;
  channel: string;
  text: string;
  /** They tapped a button or list row. */
  choice?: boolean;
  /** The id of what they tapped, when it is not its label. */
  choiceId?: string;
}

/**
 * A photo or PDF in the person's messages, for the model to read. `data` (base64) is held in memory
 * only while the model is shown it, never stored; without it, the model is told it is no longer shown.
 */
export interface Media {
  kind: "image" | "document";
  mime: string;
  name?: string;
  data?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the tool's input. */
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  /** Aborted when the step is no longer wanted (the person sent another message). */
  signal: AbortSignal;
}

export interface ModelResponse {
  /** Text outside any tool call. Never shown to the person; kept in history as the agent's note. */
  text: string | null;
  toolCalls: ToolCall[];
  /** costUsd when the provider reports it (OpenRouter does). */
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  /** The model that answered, as the provider names it. */
  model?: string;
}

/** Any model behind Flow Framework. `complete` must reject promptly when `signal` aborts. */
export interface Model {
  complete(request: ModelRequest): Promise<ModelResponse>;
  /** Its context window in tokens, when known: each call is kept well within it (see `history`). */
  contextTokens?: number;
  /** What it reads besides text, as `media` on the person's messages. Without it: text only, and a note for each photo or PDF. */
  reads?: { images?: boolean; pdfs?: boolean };
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

/** A photo by https URL, or by the provider's own id for a file it holds (Flow Messaging's file_..., WhatsApp's media id). */
export type Photo = { url: string } | { fileId: string };

/**
 * A reply button: its label (the id a tap carries back is then the label), or an id and a label.
 * Ids are 1 to 64 bytes and unique within a message and across a carousel; labels may repeat.
 */
export type ReplyButton = string | { id: string; label: string };

/** One card of a carousel: its photo, a short text, and either reply buttons or one link button (the same kind and number on every card). */
export interface CarouselCard {
  image: Photo;
  text?: string;
  /** Reply buttons; a tap comes back as the person's message, with the button's id as `choice.id`. */
  buttons?: ReplyButton[];
  /** One button that opens this https page. */
  link?: { label: string; url: string };
}

/** What a conversation sends to its channel. */
export type Outbound =
  | {
      type: "message";
      text: string;
      /** A framework-generated login challenge; its link opens real authentication in simulators. */
      authentication?: boolean;
      /** The person's message this one quotes (channels with replies). */
      replyTo?: string;
      /** Reply buttons; a tap comes back as the person's message, with the button's id as `choice.id`. */
      buttons?: ReplyButton[];
      /** A list the person picks one row from. */
      list?: { button: string; rows: ListRow[] };
      /** A button that opens this https page; only on channels with linkButton (elsewhere Flow Framework puts the URL in the text). */
      link?: { label: string; url: string };
      /** A photo, the text its caption (with buttons or a link, the photo heads the same message); only on channels with images (elsewhere the text goes alone). */
      image?: Photo;
      /** The channel's own params (see Channel.params), as the agent filled them in. */
      fields?: Record<string, unknown>;
      /**
       * false: no link preview. Set on every message the business starts (a nudge, a scheduled
       * message, a turn the person did not start): on WhatsApp a preview card's title would become
       * the phone's notification instead of the message's text. Its call to action goes as `link`.
       */
      preview?: false;
      /** The same in every process for one send the business starts (a nudge, a scheduled text), for providers that take one. */
      idempotencyKey?: string;
    }
  /**
   * Cards side by side the person swipes through, under a text (WhatsApp's media carousel); only on
   * channels with carousels. A channel that cannot show one sends the text, then each card as a message, in order.
   */
  | { type: "carousel"; text: string; cards: CarouselCard[]; replyTo?: string; preview?: false; idempotencyKey?: string }
  /** The agent has picked these messages up (WhatsApp's blue ticks). */
  | { type: "read"; messageIds: string[] }
  /** A reaction on one of the person's messages, by the id Flow Framework gave it. */
  | { type: "reaction"; emoji: string; messageId: string }
  /**
   * New text for one of the agent's own messages, by the id its send resolved with
   * (`SendReceipt.messageId`); only on channels with `edits`. Rejects when the platform refuses it
   * (too late, say), with the platform's reason.
   */
  | { type: "edit"; messageId: string; text: string }
  /** Takes back one of the agent's own messages, by the id its send resolved with; only on channels with `unsends`. */
  | { type: "unsend"; messageId: string }
  /** A template the owner set up with the channel (WhatsApp), sent as is, even outside its window. */
  | ({ type: "template"; idempotencyKey?: string } & Template)
  /** A short line of what the agent is doing, shown in the loading indicator; null clears it. */
  | { type: "status"; text: string | null }
  | { type: "typing"; on: boolean };

/** What the person reads: a message, a carousel or a template. */
export type OutboundMessage = Extract<Outbound, { type: "message" | "carousel" | "template" }>;

/** Where a message is going, and what started it: what `beforeSend` gets with it. */
export interface SendContext {
  conversationId: string;
  /** The channel's name (whatsapp, sms, your UI's), and what it can show. */
  channel: string;
  info: ChannelInfo;
  /** The person's address on it. */
  address: string;
  /**
   * agent: its send tools, or a template it sent. direct: a fixed-text scheduled message or a nudge,
   * with no model. framework: Flow Framework's own (a keyword's or intercept's reply, a sign-in
   * prompt, the apology after a failed turn).
   */
  origin: "agent" | "direct" | "framework";
  /** Set when the message is new text for one of the agent's sent messages (edit_message): that message's id. */
  edit?: { messageId: string };
  /**
   * The texts already sent to the person in this conversation, oldest first, read from its stored
   * history (so they hold across restarts): what guards such as `oncePerChat` and `noRepeats` check against.
   */
  sent?: readonly string[];
}

/**
 * createAgent's `beforeSend`: every message, carousel and template passes through it before it is
 * checked against the platform's content rules, sent and recorded, and so does an edit's new text,
 * as a message with only `text` (`context.edit` names the message it changes; what is returned
 * keeps only its text). Return nothing (or the message)
 * to send it as it is, another message to send that instead, or `{ refuse: why }` to send nothing.
 * A refused send of the agent's goes back to it with the reason, to fix and send again.
 */
export type BeforeSend = (
  message: OutboundMessage,
  context: SendContext,
) => OutboundMessage | { refuse: string } | void | Promise<OutboundMessage | { refuse: string } | void>;

/** A WhatsApp template as it is sent: its name and the values for its placeholders (Meta's template parameters). */
export interface Template {
  /** Its name as approved (or the provider's own id for it). */
  name: string;
  language?: string;
  /** The header's value: the text for its {{1}}, or its photo, video or document by https URL or the provider's file id. */
  header?: { kind: "text"; text: string } | { kind: "image" | "video" | "document"; url?: string; fileId?: string };
  /** Values for the body's {{1}}, {{2}}, ... in order. */
  body?: string[];
  /** Values for the buttons that take one, by the button's position from 0: a URL button's suffix, a quick reply's payload. */
  buttons?: Array<{ index: number; value: string }>;
  /** The body's values by number ({ "1": "Maria" }), the older form of `body`: give one or the other. */
  variables?: Record<string, string>;
}

/**
 * A WhatsApp template as the owner set it up with Meta, declared in `createAgent({ templates })`:
 * Flow Framework checks every send of it against this, and the playground shows it as WhatsApp would.
 */
export interface TemplateDefinition {
  name: string;
  /** Meta's language code: en, en_US, hi. */
  language: string;
  category: "utility" | "marketing" | "authentication";
  /** Text (which may hold one {{1}}), or a photo, video or document sent with each message. */
  header?: { kind: "text"; text: string } | { kind: "image" | "video" | "document" };
  /** The message, with {{1}}, {{2}}, ... where its values go. */
  body: string;
  footer?: string;
  /** Quick replies come back as the person's tap; a URL may end in {{1}}, its value given at each send. */
  buttons?: TemplateButton[];
}

export type TemplateButton = { type: "quick_reply"; text: string } | { type: "url"; text: string; url: string } | { type: "phone"; text: string; phone: string };

/**
 * Sends one outbound. It resolves once the channel has it (the platform accepted it), so the next
 * message goes only after it; a rejection means it did not reach the person. It may resolve with a
 * receipt saying how far the message got.
 */
export type Deliver = (outbound: Outbound) => Promise<void | SendReceipt> | void | SendReceipt;

/**
 * How far a sent message got when its send resolved. sent: the platform accepted it. delivered: it
 * reached the person's device. queued: the provider stored it to send later (it does not wait).
 * unconfirmed: no signal came within the provider's wait; it may still arrive and is never sent
 * again (Flow Framework emits `message.slow`).
 */
export interface SendReceipt {
  status: "queued" | "sent" | "delivered" | "unconfirmed";
  /** How long the send waited for that, ms. */
  waitedMs?: number;
  /**
   * The platform's id for the message (Flow Messaging's msg_...), when the provider knows it: what
   * an edit or unsend names it by. A carousel sent card by card gives its first message's.
   */
  messageId?: string;
}

/** What the channel a conversation is on can show. */
export interface ChannelInfo {
  /** Reactions on the person's message (WhatsApp, iMessage, web); plain SMS has none. */
  reactions: boolean;
  /** A live status line in the loading indicator (web and app UIs). */
  status: boolean;
  /** How text is formatted: none (SMS shows markdown raw), WhatsApp's own marks, or Markdown. */
  formatting?: "plain" | "whatsapp" | "markdown";
  /** The most characters one message can carry. */
  maxLength?: number;
  /** A message can quote one of the person's messages. */
  replies?: boolean;
  /** Reply buttons under a message. */
  buttons?: { max: number; labelMax: number };
  /**
   * A tap on a `{ id, label }` button comes back with that id (`choice.id`). Without it a provider may
   * know only the label: number the labels yourself if taps must be told apart.
   */
  buttonIds?: boolean;
  /** A list the person picks one row from. */
  lists?: { maxRows: number; titleMax: number; buttonMax: number };
  /** One button under a message that opens a web page (WhatsApp's call-to-action URL button). */
  linkButton?: { labelMax: number };
  /** Photos sent by URL, with the message's text as their caption. */
  images?: { captionMax: number };
  /**
   * The platform whose content rules (Flow Messaging's, CONTENT_LIMITS) every send on this channel is
   * checked against, after beforeSend and before it goes: what the platform would refuse is refused
   * here, with its error, in the playground, the test cloud and production alike.
   */
  platform?: "whatsapp" | "telegram" | "imessage" | "sms";
  /** Carousels: 2 to maxCards cards, each a photo, up to cardTextMax characters and 1 to `buttons` reply buttons (or one link). */
  carousels?: { maxCards: number; textMax: number; cardTextMax: number; buttons: number; labelMax: number };
  /** The channel shows the person when their message has been read. */
  readReceipts?: boolean;
  /**
   * Templates the owner set up with the platform (WhatsApp's), which also go outside its window.
   * false: a template send is refused before it goes, with the platform's error. Absent: not known
   * (a hand-written channel), so its send decides, as before.
   */
  templates?: boolean;
  /** A typing indicator while the agent writes. Absent: not known, so typing is handed to the channel, as before. */
  typing?: boolean;
  /**
   * How long the platform shows one typing indicator, in ms (WhatsApp 25 s, Telegram 5 s, iMessage
   * on Flow Messaging 15 s). While a turn runs, Flow Framework sends typing again at 80% of it, so the
   * indicator does not lapse. Absent: it shows until it is turned off or a message goes, and is sent once.
   */
  typingLastsMs?: number;
  /**
   * The agent can change the text of a message it sent (Telegram, iMessage): it is offered
   * edit_message. The platform decides how late an edit may come; a refused one goes back to the agent.
   */
  edits?: boolean;
  /** The agent can take back a message it sent (Telegram, iMessage): it is offered unsend_message. */
  unsends?: boolean;
  /**
   * The business may message first only this many hours after the person's last message
   * (WhatsApp: 24); after that, only templates.
   */
  replyWindowHours?: number;
}

/** A message from the person, with what the channel knows about it. */
export interface Incoming {
  text: string;
  /** The message they replied to (theirs or the agent's), quoted. */
  replyTo?: { text: string; fromAgent: boolean };
  /** They tapped a button or picked a list row rather than typing: its id (a button's, a row's) and its label. */
  choice?: { id?: string; title: string };
  /** Photos, voice notes and documents sent with it; `text` is then their caption, or "". */
  attachments?: Attachment[];
}

/** A file the person sent. Its bytes are fetched only when the agent can use them. */
export interface Attachment {
  kind: "image" | "audio" | "document";
  mime: string;
  /** The file name, when the channel gives one (documents). */
  name?: string;
  /** The bytes. A provider fetches its media here with its own credentials: no URL reaches the model. */
  data(): Promise<Uint8Array>;
}

/** Turns a voice note into text, with whatever speech-to-text the agent's author chose. */
export type Transcribe = (audio: { mime: string; data: Uint8Array }) => Promise<string>;
