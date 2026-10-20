// Business events: a business's backend posts what happened (an order shipped, a price dropped) to
// one route, signed; the agent turns each into a message by its delivery level. Critical goes at
// once; standard waits for the end of quiet hours; optional also merges by collapseKey, one a day
// per key, and is dropped when its topic closes. A newer event with the same collapseKey replaces
// one still held; `notification.cancelled` drops one not yet sent; `expiresAt` drops one held too
// long. Outside WhatsApp's window the template goes; inside it the agent may phrase it, every value
// and the link checked in code (else the template, else its text). A watch (the person asked to be
// told about a topic) raises a message about it: kept in quiet hours but never dropped as stale,
// merged away or capped; "as soon as" makes it critical. Nudges (messages the business starts
// from what people watch) are capped per day, per topic per day and per week, unless raised. A
// copy (`sentBy`: the business sent it itself) is never sent: it is the agent's context and counts
// as already told. Sends go through the agent's nudge(), so STOP and the no-contact rules apply.
//
// What an app's events mean (its catalog, its templates and wording, its own rules) stays in the
// app: `catalog` names every type it accepts, `rules` and `onEvent` decide the rest.

import type { NudgeInput, NudgeResult } from "../agent.ts";
import type { Template } from "../types.ts";
import { createPhrasing, type Phrasing } from "./phrasing.ts";
import { quietHoursEnd, type EventQuietHours } from "./quiet.ts";
import { verifyEventSignature } from "./signature.ts";

const DAY = 24 * 3_600_000;

export type DeliveryLevel = "critical" | "standard" | "optional";
export const DELIVERY_LEVELS: readonly DeliveryLevel[] = ["critical", "standard", "optional"];

/** The event cancelling one not yet sent: `data.cancels` is its id. */
export const CANCELLED_EVENT = "notification.cancelled";

/** One event, as the business posts it. */
export interface BusinessEvent {
  /** Unique per event: the same id twice is processed once. */
  id: string;
  type: string;
  occurredAt: string;
  /** What it is about, as the business names it ("user:...", "order:..."). */
  subject: string;
  /** The floor: never sent at a lower level. Default: the type's in the catalog. */
  delivery?: DeliveryLevel;
  /** The business sent this message itself: kept as context, never sent. */
  sentBy?: string;
  /** Don't send after this (ISO time). Also read from `data.expiresAt`. */
  expiresAt?: string;
  /** A newer one with the same key replaces one still held. Also read from `data.collapseKey`. */
  collapseKey?: string;
  data: Record<string, any>;
}

/** A message ready either way: the template, its text as the person would see it, its values and its button link. */
export interface EventMessage {
  template: Template;
  text: string;
  values: string[];
  link: { label: string; url: string };
}

/** A type that becomes a message for one person. */
export interface NotificationType {
  kind?: "notification";
  /** Its default level, when the event names none. */
  level: DeliveryLevel;
  /** Its message, or the field it lacks (a 400 names it). */
  message(event: BusinessEvent): EventMessage | { missing: string };
  /** Its button acts on a live topic: dropped once the topic closes, whatever the level. */
  liveOnly?: boolean;
  /** What the message is about (an order, a product): how watches raise it, closing drops it, caps count it. */
  topic?(event: BusinessEvent): string | undefined;
  /** The topic's name, to find a watch when the event names no topic. */
  title?(event: BusinessEvent): string | undefined;
}

/** A type the app handles itself in `onEvent` (no message of its own). */
export interface AppEventType {
  kind: "event";
  /** Why it is malformed, naming the field; null when fine. */
  validate?(event: BusinessEvent): EventProblem | null;
}

export type EventType = NotificationType | AppEventType;
export type EventCatalog = Record<string, EventType>;

export interface EventProblem {
  field: string;
  error: string;
}

/** A send, held or about to go. */
export interface PendingSend {
  eventId: string;
  /** The event type it came from (a nudge: `nudge.<kind>`), for logs. */
  type?: string;
  address: string;
  delivery: DeliveryLevel | "nudge";
  /** Raised by a watch: "watch" is kept, "urgent" also goes at once. */
  raised?: "watch" | "urgent";
  /** Never dropped as stale, whatever closes. */
  sticky?: true;
  /** Dropped when its topic closes, whatever the level. */
  liveOnly?: true;
  /** A nudge's kind, as the app names it. */
  nudge?: string;
  topic?: string;
  collapseKey?: string;
  notBefore: number;
  expiresAt?: number;
  /** The template, never the agent's words. */
  exact: boolean;
  message: EventMessage;
}

/** What a person asked to be told about. Apps add their own fields. */
export interface Watch {
  id: string;
  address: string;
  /** Only watches with a topic raise messages. */
  topic?: string;
  /** The topic's name, as the agent saw it. */
  title?: string;
  /** "As soon as": raised messages go at once, even in quiet hours. */
  urgent?: true;
  createdAt: number;
  /** When its topic closed. */
  endedAt?: number;
}

/** A message the business sent itself (`sentBy`), kept as context. */
export interface EventCopy {
  eventId: string;
  type: string;
  /** When it was sent (the envelope's occurredAt), ms. */
  at: number;
  text: string;
  values: string[];
  link: { label: string; url: string };
}

export interface SentNudge {
  address: string;
  topic?: string;
  kind?: string;
  at: number;
}

/** What the events side keeps. Pass your own (with extra fields of your app's) to share it. */
export function createEventState<W extends Watch = Watch>() {
  return {
    seen: new Set<string>(),
    cancelled: new Set<string>(),
    outbox: [] as PendingSend[],
    watches: [] as W[],
    /** Closed topics. */
    closed: new Set<string>(),
    /** `${address} ${topic}`: no more nudges about it. */
    muted: new Set<string>(),
    nudges: [] as SentNudge[],
    /** `${address} ${collapseKey|eventId}` -> when an optional last went. */
    optionalLast: new Map<string, number>(),
    /** The last nudged topic per address, for "not interested". */
    lastNudged: new Map<string, string>(),
    /** Address -> copies the business sent itself, newest last. */
    copies: new Map<string, EventCopy[]>(),
    /** `${address}\n${text}` -> when it reached them: the same message never goes again within a day. */
    told: new Map<string, number>(),
    /** Conversation id -> address. */
    addresses: new Map<string, string>(),
  };
}

export type EventState<W extends Watch = Watch> = ReturnType<typeof createEventState<W>>;

/** What sends: the agent (its nudge, and reach for copies). */
export interface EventSender {
  nudge(input: NudgeInput): Promise<NudgeResult>;
  reach?(to: { channel: string; address: string }): Promise<{ conversationId: string }>;
}

export interface FlowEventsOptions<W extends Watch = Watch> {
  /** The whsec_ secret the business signs with; without it every POST is refused (503). */
  secret?: string;
  /** Every type accepted (plus notification.cancelled); any other is a 400. */
  catalog: EventCatalog;
  now?: () => number;
  /** The channel messages go on. Default whatsapp. */
  channel?: string;
  /** The zone quiet hours and copies' times are read in. Default UTC. */
  timezone?: string;
  /** How the zone reads in log reasons and notes ("Pacific time"). Default the zone's name. */
  timezoneName?: string;
  /** Default 22:00 to 08:00; null: none. */
  quietHours?: EventQuietHours | null;
  /** Nudge caps (raised nudges skip them). Default 2 a day, 1 per topic a day, 5 a week. */
  caps?: { perDay: number; perKeyPerDay: number; perWeek: number };
  /** How long a watch lasts. Default 30. */
  watchDays?: number;
  state?: EventState<W>;
  /** Who may post copies (`sentBy`); none: sentBy is refused. */
  sentBy?: string | string[];
  /** The business's name in log reasons ("Acme"). Default the first sentBy, else "the business". */
  businessName?: string;
  /** Off production, who a business-started send may go to (eventTestList). */
  testList?: { allows(address: string): boolean };
  /** A send the test list stopped. */
  onUnlisted?(send: { event: string; type: string; address: string }): void;
  /** Each decision as fields (ids, types, outcomes; never text). Default one JSON line, numbers masked. */
  log?(fields: Record<string, unknown>): void;
  /** The default log line's msg. Default "flow event". */
  logName?: string;
  /** What a topic is called in log reasons ("order"). Default "topic". */
  topicNoun?: string;
  /** The log reason for a muted nudge. Default "muted (not interested)". */
  mutedReason?: string;
  /** Where a notification's person is. Default data.user.phone. */
  addressOf?(event: BusinessEvent): string | undefined;
  /** Whether they agreed to messages. Default data.consent.whatsappUpdates === true. */
  consented?(event: BusinessEvent): boolean;
  wording?: {
    /** The note the agent gets to phrase a message (nudge: one the business started from a watch). */
    prompt?(message: EventMessage, options: { nudge: boolean }): string;
    /** The stop line a nudge sent as text ends with. */
    stopLine?: string;
    /** The text fallback puts the link in the text instead of a link button. */
    linkInText?: boolean;
  };
  copies?: {
    kept?: number;
    shown?: number;
    days?: number;
    /** The agent's note on recent copies; "" for none. */
    note?(copies: EventCopy[], options: { timezone: string; timezoneName: string }): string;
  };
  rules?: {
    /** Before the raise: "handled" when the app sent (or dropped) it itself; else it goes on. */
    notification?(event: BusinessEvent, send: PendingSend, events: FlowEvents<W>): "send" | "handled" | Promise<"send" | "handled">;
    /** A copy arrived: the app's own bookkeeping, and held sends it also counts as told. */
    copy?(event: BusinessEvent, message: EventMessage, events: FlowEvents<W>): ((held: PendingSend) => boolean) | void;
  };
  /** Types of kind "event", in order with the rest. */
  onEvent?(event: BusinessEvent, events: FlowEvents<W>): Promise<void> | void;
  /** After held sends came due, in order with the rest. */
  onTick?(now: number, events: FlowEvents<W>): Promise<void> | void;
}

const E164 = /^\+\d{8,15}$/;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const isNotification = (t: EventType | undefined): t is NotificationType => t !== undefined && t.kind !== "event";
const norm = (t: unknown) => (typeof t === "string" ? t.trim().toLowerCase().replace(/\s+/g, " ") : "");

/** The default note for a phrased message. */
function defaultPrompt(m: EventMessage, options: { nudge: boolean }, stopLine: string): string {
  return [
    options.nudge
      ? `An update this person asked to be kept posted on. Pass it on in one message in your own words, fitting the chat, or send exactly the message below, and end it with this line as written: ${stopLine}`
      : "A notification for this person. Pass it on in one message in your own words, fitting the chat, or send exactly the message below.",
    "The business sent this for this person's own account just now, so it holds even where earlier messages in this chat said otherwise.",
    `message: ${m.text}`,
    `values: ${m.values.join(" | ")}`,
    `link: ${m.link.label} -> ${m.link.url}`,
    "Keep every value exactly as written and put the link in the send tool's link field (its label as the button), never as a URL in the text. No other claims, no tool calls needed.",
  ].join("\n");
}

function defaultNote(copies: EventCopy[], options: { timezone: string; timezoneName: string }): string {
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: options.timezone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return [
    "The business sent this person these messages itself, from this number, for their own account. You did not send them, but they are part of this chat and they hold, even where a tool or an earlier message says otherwise. When they reply about one, answer from it: say what it said and offer its button; check a tool only for what changed since.",
    ...copies.map((c) => `- ${when.format(c.at)} ${options.timezoneName} (${c.type}): "${c.text}" (values: ${c.values.join(" | ")}; button: ${c.link.label} -> ${c.link.url})`),
  ].join("\n");
}

/**
 * The events side of an agent: mount `routes` and `onTick` on createAgent, `phrasing.check` in the
 * channel's send, `context` in the agent's context, then `attach(agent)`.
 */
export function flowEvents<W extends Watch = Watch>(options: FlowEventsOptions<W>) {
  const now = options.now ?? Date.now;
  const state = options.state ?? createEventState<W>();
  const channel = options.channel ?? "whatsapp";
  const zone = options.timezone ?? "UTC";
  const quiet = options.quietHours === undefined ? { from: "22:00", to: "08:00" } : options.quietHours;
  const caps = options.caps ?? { perDay: 2, perKeyPerDay: 1, perWeek: 5 };
  const watchMs = (options.watchDays ?? 30) * DAY;
  const noun = options.topicNoun ?? "topic";
  const zoneName = options.timezoneName ?? zone;
  const mutedReason = options.mutedReason ?? "muted (not interested)";
  const senders = options.sentBy === undefined ? [] : Array.isArray(options.sentBy) ? options.sentBy : [options.sentBy];
  const business = options.businessName ?? (options.sentBy === undefined ? "the business" : [options.sentBy].flat()[0]!);
  const stopLine = options.wording?.stopLine ?? "Reply *not interested* to stop these.";
  const prompt = options.wording?.prompt ?? ((m: EventMessage, o: { nudge: boolean }) => defaultPrompt(m, o, stopLine));
  const copiesKept = options.copies?.kept ?? 10;
  const copiesShown = options.copies?.shown ?? 5;
  const copyMs = (options.copies?.days ?? 7) * DAY;
  const note = options.copies?.note ?? defaultNote;
  const addressOf = options.addressOf ?? ((e: BusinessEvent) => (typeof e.data?.user?.phone === "string" ? e.data.user.phone : undefined));
  const consented = options.consented ?? ((e: BusinessEvent) => e.data?.consent?.whatsappUpdates === true);
  const logName = options.logName ?? "flow event";
  const report =
    options.log ??
    ((fields: Record<string, unknown>) => {
      // A key may carry a number (`<event>:<nudge>:+1555...`): masked, as every number is.
      console.log(JSON.stringify({ severity: fields.outcome === "failed" ? "WARNING" : "INFO", msg: logName, ...fields }).replace(/\+\d{8,15}/g, "+<phone>"));
    });
  const phrasing = createPhrasing();
  let sender: EventSender | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const later = (work: () => Promise<unknown>) => {
    chain = chain.then(work).catch((error) => console.error(`${logName}:`, error));
    return chain;
  };
  const to = (address: string) => ({ channel, address });
  const fieldOf = (e: BusinessEvent, name: "expiresAt" | "collapseKey") => (typeof e[name] === "string" ? e[name] : typeof e.data?.[name] === "string" ? (e.data[name] as string) : undefined);

  /** Whether this envelope is a copy the business sent itself (`sentBy`, or the same in data.sentBy). */
  const isCopy = (e: BusinessEvent) => (e.sentBy !== undefined && senders.includes(e.sentBy)) || (e.data?.sentBy !== undefined && senders.includes(e.data.sentBy));

  /** Why an envelope is malformed, naming the field; null when it is fine. */
  function invalid(body: unknown): EventProblem | null {
    if (!body || typeof body !== "object" || Array.isArray(body)) return { field: "(body)", error: "not a JSON object" };
    const e = body as Record<string, any>;
    for (const f of ["id", "type", "occurredAt", "subject"]) if (typeof e[f] !== "string" || !e[f]) return { field: f, error: "required string" };
    if (Number.isNaN(Date.parse(e.occurredAt))) return { field: "occurredAt", error: "not an ISO time" };
    if (!e.data || typeof e.data !== "object") return { field: "data", error: "required object" };
    const kind = options.catalog[e.type];
    if (!kind && e.type !== CANCELLED_EVENT) return { field: "type", error: `unknown type ${String(e.type).slice(0, 80)}` };
    if (e.delivery !== undefined && !DELIVERY_LEVELS.includes(e.delivery)) return { field: "delivery", error: "critical, standard or optional" };
    for (const [field, v] of [["sentBy", e.sentBy], ["data.sentBy", e.data.sentBy]] as const) {
      if (v === undefined) continue;
      if (!senders.includes(v)) return { field, error: senders.length ? `only ${senders.map((s) => JSON.stringify(s)).join(" or ")}, or leave it out` : "not accepted here" };
      if (!isNotification(kind)) return { field, error: "only on notification events" };
    }
    for (const f of ["expiresAt", "collapseKey"] as const) if (e[f] !== undefined && typeof e[f] !== "string") return { field: f, error: "a string, or leave it out" };
    if (e.expiresAt !== undefined && Number.isNaN(Date.parse(e.expiresAt))) return { field: "expiresAt", error: "not an ISO time" };
    if (e.type === CANCELLED_EVENT) return typeof e.data.cancels === "string" ? null : { field: "data.cancels", error: "required string" };
    if (isNotification(kind)) {
      const address = addressOf(e as BusinessEvent);
      if (typeof address !== "string" || !E164.test(address)) return { field: "data.user.phone", error: "required, E.164" };
      const made = kind.message(e as BusinessEvent);
      if ("missing" in made) return { field: made.missing, error: "required value" };
      return null;
    }
    return kind?.kind === "event" && kind.validate ? kind.validate(e as BusinessEvent) : null;
  }

  /** The template, as is (also outside the window). */
  async function sendTemplate(address: string, m: EventMessage, key: string) {
    const r = await sender!.nudge({ to: to(address), template: m.template, idempotencyKey: `${key}:template`, respectQuietHours: false });
    report({ event: key, via: "template", template: m.template.name, outcome: r.status, ...(r.reason ? { reason: r.reason } : {}) });
    return r;
  }

  /** The agent's own words inside the window, checked against the values and link: whether it went, and the nudge's status. */
  async function phrased(p: PendingSend, nudge: boolean): Promise<{ delivered: boolean; status: string }> {
    const expectation = phrasing.expect(p.address, p.message.values, p.message.link.url);
    let result: NudgeResult;
    try {
      result = await sender!.nudge({ to: to(p.address), prompt: prompt(p.message, { nudge }), idempotencyKey: `${p.eventId}:phrased`, respectQuietHours: false });
    } finally {
      phrasing.done(p.address);
    }
    report({ event: p.eventId, via: "phrased", outcome: expectation.delivered ? "sent" : result.status, ...(result.reason ? { reason: result.reason } : {}) });
    return { delivered: expectation.delivered, status: result.status };
  }

  /** The template's words as a plain message with its link, for when the template failed (not approved on this sender): only inside the window. */
  async function sendText(p: PendingSend, nudge: boolean): Promise<string> {
    const m = p.message;
    const inText = options.wording?.linkInText === true;
    const text = [m.text, ...(inText ? [`${m.link.label}: ${m.link.url}`] : []), ...(nudge ? [stopLine] : [])].join("\n\n");
    const r = await sender!.nudge({ to: to(p.address), text, ...(inText ? {} : { link: m.link }), idempotencyKey: `${p.eventId}:text`, respectQuietHours: false });
    report({ event: p.eventId, via: "text", outcome: r.status, ...(r.reason ? { reason: r.reason } : {}) });
    return r.status;
  }

  /** Inside the window the agent's own words, checked; else (or when it fails) the template; with no template, its words as text. */
  async function sendNotification(p: PendingSend): Promise<string> {
    if (p.exact) {
      const status = (await sendTemplate(p.address, p.message, p.eventId)).status;
      return status === "failed" ? sendText(p, false) : status;
    }
    const r = await phrased(p, false);
    if (r.delivered) return "sent";
    if (r.status === "dropped") return "dropped";
    const status = (await sendTemplate(p.address, p.message, p.eventId)).status;
    return status === "failed" ? sendText(p, false) : status;
  }

  /** The template; when it failed (not approved on the sender), inside the window its words as the agent's, else as text. */
  async function sendNudge(p: PendingSend): Promise<string> {
    let status: string = (await sendTemplate(p.address, p.message, p.eventId)).status;
    if (status === "failed") {
      const r = await phrased(p, true);
      status = r.delivered ? "sent" : r.status === "dropped" ? "dropped" : await sendText(p, true);
    }
    if (status === "sent") {
      // A raised nudge (they asked about this topic) does not use up the caps.
      if (!p.raised) state.nudges.push({ address: p.address, topic: p.topic, kind: p.nudge, at: now() });
      if (p.topic !== undefined) state.lastNudged.set(p.address, p.topic);
    }
    return status;
  }

  /** The business sent this exact message to this person within a day. */
  const told = (address: string, text: string) => {
    const at = state.told.get(`${address}\n${text}`);
    return at !== undefined && now() - at < DAY;
  };
  const muted = (address: string, topic: string | undefined) => topic !== undefined && state.muted.has(`${address} ${topic}`);

  /** Why it is no longer worth sending (cancelled, expired, told, closed, muted, capped), or null when it still goes. */
  function whyNot(p: PendingSend): string | null {
    if (state.cancelled.has(p.eventId)) return "cancelled";
    if (p.expiresAt !== undefined && p.expiresAt <= now()) return "expired";
    if (p.delivery !== "nudge" && told(p.address, p.message.text)) return `already told: ${business} sent it`;
    if (p.sticky) return null;
    const closed = p.topic !== undefined && state.closed.has(p.topic);
    if (closed && p.liveOnly) return `${noun} closed`;
    if (p.delivery === "critical") return null;
    if (closed && !p.raised) return `${noun} closed`;
    if (p.raised) return p.delivery === "nudge" && muted(p.address, p.topic) ? mutedReason : null;
    if (p.delivery === "optional") {
      const last = state.optionalLast.get(`${p.address} ${p.collapseKey ?? p.eventId}`);
      if (last !== undefined && now() - last < DAY) return "optional: one a day per collapse key";
    }
    if (p.delivery === "nudge") {
      if (muted(p.address, p.topic)) return mutedReason;
      const mine = state.nudges.filter((n) => n.address === p.address);
      const t = now();
      if (mine.filter((n) => t - n.at < DAY).length >= caps.perDay) return `cap: ${caps.perDay} nudges a day`;
      if (mine.filter((n) => n.topic === p.topic && t - n.at < DAY).length >= caps.perKeyPerDay) return `cap: ${caps.perKeyPerDay} per ${noun} a day`;
      if (mine.filter((n) => t - n.at < 7 * DAY).length >= caps.perWeek) return `cap: ${caps.perWeek} nudges a week`;
    }
    return null;
  }

  /** Off production, an address not on the test list gets nothing. */
  function listed(p: PendingSend): boolean {
    if (!options.testList || options.testList.allows(p.address)) return true;
    const info = { event: p.eventId, type: p.type ?? (p.nudge ? `nudge.${p.nudge}` : "notification"), address: p.address };
    if (options.onUnlisted) options.onUnlisted(info);
    else report({ event: info.event, type: info.type, outcome: "not sent", reason: "not on the test list" });
    return false;
  }

  async function go(p: PendingSend) {
    // Checked again when a held send comes due, so what was held is never sent past the list.
    if (!listed(p)) return;
    const why = whyNot(p);
    if (why) {
      report({ event: p.eventId, delivery: p.delivery, ...(p.nudge ? { nudge: p.nudge } : {}), outcome: "not sent", reason: why });
      return;
    }
    if (p.delivery === "nudge") await sendNudge(p);
    else {
      const status = await sendNotification(p);
      if (p.delivery === "optional" && status === "sent") state.optionalLast.set(`${p.address} ${p.collapseKey ?? p.eventId}`, now());
    }
  }

  /** Now, or held to the end of quiet hours (`exempt`: never waits). A newer one replaces a held one with its collapseKey. */
  async function schedule(p: PendingSend, exempt: boolean = p.delivery === "critical") {
    // The test list first, at receipt: an unlisted address is neither held nor sent (go checks it again).
    if (!listed(p)) return;
    if (p.collapseKey && p.delivery !== "critical" && !p.raised) drop((o) => o.address === p.address && o.collapseKey === p.collapseKey);
    const quietEnd = exempt || !quiet ? null : quietHoursEnd(quiet, zone, now());
    if (quietEnd !== null) {
      state.outbox.push({ ...p, notBefore: quietEnd });
      report({ event: p.eventId, delivery: p.delivery, ...(p.nudge ? { nudge: p.nudge } : {}), outcome: "held", until: new Date(quietEnd).toISOString(), reason: `quiet hours (${zoneName})` });
    } else await go(p);
  }

  /** Removes held sends that match; how many. In place, so a shared state keeps its array. */
  function drop(match: (p: PendingSend) => boolean): number {
    const before = state.outbox.length;
    const kept = state.outbox.filter((p) => !match(p));
    state.outbox.splice(0, state.outbox.length, ...kept);
    return before - kept.length;
  }

  /** Within its days, and (when its topic closed) a day after the close at most. */
  const alive = (w: Watch, t = now()) => t - w.createdAt < watchMs;

  /** This person's watch on a topic: by topic, else by the topic's name. */
  function watchFor(address: string, topic: string | undefined, title?: unknown, titleOf?: (topic: string) => string | undefined): W | undefined {
    const name = norm(title);
    const t = now();
    return state.watches.find((w) => {
      if (w.address !== address || !w.topic) return false;
      if (!alive(w, t) || (w.endedAt !== undefined && t - w.endedAt >= DAY)) return false;
      if (muted(address, w.topic)) return false; // "not interested" on it takes the ask back
      if (topic) return w.topic === topic;
      return name !== "" && (norm(w.title) === name || norm(titleOf?.(w.topic)) === name);
    });
  }

  /** The raise rule: a watch keeps a message (optional becomes standard); "as soon as" makes it critical. Never lowers. */
  function raise(event: string, type: string, delivery: DeliveryLevel, watch: Watch | undefined): { delivery: DeliveryLevel; raised?: "watch" | "urgent" } {
    if (!watch || delivery === "critical") return { delivery };
    const raised = watch.urgent ? ("urgent" as const) : ("watch" as const);
    report({ event, type, outcome: "raised", from: delivery, to: raised === "urgent" ? "critical" : "kept", reason: raised === "urgent" ? "they asked to be told as soon as" : `they asked to be told about this ${noun}` });
    return { delivery: raised === "urgent" ? "critical" : delivery === "optional" ? "standard" : delivery, raised };
  }

  /** A copy of a message the business sent itself: never sent; the agent's context; told for what is held and what comes later. */
  async function copied(e: BusinessEvent, kind: NotificationType) {
    const address = addressOf(e)!;
    const message = kind.message(e) as EventMessage;
    const extra = options.rules?.copy?.(e, message, api) ?? undefined;
    const sentAt = Date.parse(e.occurredAt);
    const copies = [...(state.copies.get(address) ?? []), { eventId: e.id, type: e.type, at: Number.isNaN(sentAt) ? now() : sentAt, text: message.text, values: message.values, link: message.link }];
    state.copies.set(address, copies.slice(-copiesKept));
    state.told.set(`${address}\n${message.text}`, now());
    const collapseKey = fieldOf(e, "collapseKey");
    if (collapseKey) state.optionalLast.set(`${address} ${collapseKey}`, now());
    const dropped = drop((p) => p.address === address && p.delivery !== "nudge" && (p.message.text === message.text || (collapseKey !== undefined && p.collapseKey === collapseKey) || (extra ? extra(p) : false)));
    report({ event: e.id, type: e.type, outcome: "recorded", reason: `sent by ${business}: kept as context, not sent`, droppedHeld: dropped });
    // Someone who never wrote gets their conversation now, so the copy is there when they reply.
    if (sender?.reach) {
      try {
        const { conversationId } = await sender.reach(to(address));
        state.addresses.set(conversationId, address);
      } catch (error) {
        report({ event: e.id, type: e.type, outcome: "failed", reason: `reach: ${error instanceof Error ? error.message.slice(0, 200) : "error"}` });
      }
    }
  }

  async function notification(e: BusinessEvent, kind: NotificationType) {
    if (isCopy(e)) return copied(e, kind);
    if (state.cancelled.has(e.id) || !consented(e)) {
      report({ event: e.id, type: e.type, outcome: "not sent", reason: state.cancelled.has(e.id) ? "cancelled" : channel === "whatsapp" ? "no WhatsApp consent" : "no consent" });
      return;
    }
    const expires = fieldOf(e, "expiresAt");
    const expiresAt = expires ? Date.parse(expires) : undefined;
    if (expiresAt !== undefined && expiresAt <= now()) {
      report({ event: e.id, type: e.type, outcome: "not sent", reason: "expired" });
      return;
    }
    const message = kind.message(e) as EventMessage;
    const topic = kind.topic?.(e);
    const send: PendingSend = {
      eventId: e.id,
      type: e.type,
      address: addressOf(e)!,
      delivery: e.delivery ?? kind.level,
      ...(kind.liveOnly ? { liveOnly: true as const } : {}),
      topic,
      collapseKey: fieldOf(e, "collapseKey"),
      notBefore: now(),
      expiresAt,
      exact: e.data?.wording === "exact",
      message,
    };
    if (options.rules?.notification && (await options.rules.notification(e, send, api)) === "handled") return;
    const r = raise(e.id, e.type, send.delivery as DeliveryLevel, watchFor(send.address, topic, kind.title?.(e), titleOf));
    await schedule({ ...send, delivery: r.delivery, ...(r.raised ? { raised: r.raised } : {}) }, r.delivery === "critical");
  }

  let titleOf: ((topic: string) => string | undefined) | undefined;

  async function process(e: BusinessEvent) {
    const kind = options.catalog[e.type];
    if (e.type === CANCELLED_EVENT && !kind) {
      state.cancelled.add(e.data.cancels);
      drop((p) => p.eventId === e.data.cancels);
    } else if (isNotification(kind)) await notification(e, kind);
    else await options.onEvent?.(e, api);
  }

  /** POST /v1/events: 202 accepted (also a duplicate), 400 names the field, 401 a bad signature. */
  async function handler(req: Request): Promise<Response> {
    if (req.method !== "POST") return json(405, { error: "POST only" });
    if (!options.secret) return json(503, { error: "events are not configured" });
    const raw = await req.text();
    if (!verifyEventSignature(options.secret, req.headers.get("flow-signature"), raw, now())) return json(401, { error: "bad or missing Flow-Signature" });
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "not JSON", field: "(body)" });
    }
    const problem = invalid(body);
    if (problem) return json(400, problem);
    const key = req.headers.get("idempotency-key");
    if (key && key !== (body as BusinessEvent).id && state.seen.has(`key:${key}`)) return json(202, { status: "duplicate" });
    const fresh = accept(body as BusinessEvent);
    if (key && key !== (body as BusinessEvent).id) state.seen.add(`key:${key}`);
    return json(202, { status: fresh ? "accepted" : "duplicate" });
  }

  /** Records an event (false: a duplicate id, already taken) and processes it in order, in the background. */
  function accept(e: BusinessEvent): boolean {
    if (state.seen.has(e.id)) return false;
    state.seen.add(e.id);
    later(() => process(e));
    return true;
  }

  /** Held sends that came due, one by one, then the app's onTick. */
  function tick() {
    return later(async () => {
      const t = now();
      const due = state.outbox.filter((p) => p.notBefore <= t);
      drop((p) => p.notBefore <= t);
      for (const p of due) await go(p);
      await options.onTick?.(t, api);
    });
  }

  const api = {
    state,
    phrasing: phrasing as Phrasing,
    handler,
    /** For createAgent's `routes`. */
    routes: { "/v1/events": handler } as Record<string, (request: Request) => Promise<Response>>,
    /** For createAgent's `onTick`. */
    onTick: async () => void (await tick()),
    attach(s: EventSender) {
      sender = s;
    },
    invalid,
    accept,
    tick,
    /** Resolves once everything accepted so far is processed. */
    idle: () => chain.then(() => undefined),
    report: (fields: Record<string, unknown>) => report(fields),
    schedule,
    drop,
    raise,
    /** This person's live watch on a topic (by topic, else by its name, with `titleOf` the app's names for topics). */
    watchFor: (address: string, topic: string | undefined, title?: unknown) => watchFor(address, topic, title, titleOf),
    /** How a topic's name is found, for watches matched by name. */
    setTitles(fn: (topic: string) => string | undefined) {
      titleOf = fn;
    },
    /** Whether a watch is within its days. */
    alive: (w: Watch, t?: number) => alive(w, t),
    told,
    muted,
    isCopy,
    /**
     * Saves a watch; `same` finds one this person already has (it is refreshed: another 30 days, its
     * title kept, urgent kept). "saved" or "already watching".
     */
    watch(w: Omit<W, "id" | "createdAt"> & { createdAt?: number }, same?: (existing: W) => boolean): { outcome: "saved" | "already watching"; watch: W } {
      const watch = { ...w, id: `w_${state.watches.length + 1}`, createdAt: w.createdAt ?? now() } as W;
      const found = state.watches.find((x) => x.address === watch.address && (same ? same(x) : x.topic !== undefined && x.topic === watch.topic));
      if (!found) {
        state.watches.push(watch);
        return { outcome: "saved", watch };
      }
      if (watch.title && !found.title) found.title = watch.title;
      if (watch.urgent) found.urgent = true;
      found.createdAt = watch.createdAt;
      return { outcome: "already watching", watch: found };
    },
    /**
     * A topic closed (sold, cancelled, ended): held sends about it are dropped, except a critical or
     * raised one, a sticky one, and never a live-only one; its watches end. How many were dropped.
     */
    close(topic: string): number {
      state.closed.add(topic);
      const dropped = drop((p) => p.topic === topic && !p.sticky && (p.liveOnly === true || (p.delivery !== "critical" && p.raised === undefined)));
      for (const w of state.watches) if (w.topic === topic && w.endedAt === undefined) w.endedAt = now();
      return dropped;
    },
    /** No more nudges to this person about this topic. */
    mute(address: string, topic: string) {
      state.muted.add(`${address} ${topic}`);
    },
    /** "Not interested" on a nudge: that topic is muted, its watch and held nudges go. The topic, or null. */
    notInterested(address: string): string | null {
      const topic = state.lastNudged.get(address);
      if (!topic) return null;
      state.muted.add(`${address} ${topic}`);
      state.watches.splice(0, state.watches.length, ...state.watches.filter((w) => !(w.address === address && w.topic === topic)));
      drop((p) => p.address === address && p.topic === topic && p.delivery === "nudge");
      return topic;
    },
    /** STOP: their watches end and held nudges go (the agent itself stops every send). */
    stopped(address: string) {
      state.watches.splice(0, state.watches.length, ...state.watches.filter((w) => w.address !== address));
      drop((p) => p.address === address && p.delivery === "nudge");
    },
    /** Which address a conversation is (from tool calls, copies). */
    remember(conversationId: string, address: string) {
      state.addresses.set(conversationId, address);
    },
    /** The note on recent copies for this person; "" when none. */
    copiesNote(address: string): string {
      const t = now();
      const recent = (state.copies.get(address) ?? []).filter((c) => t - c.at < copyMs).slice(-copiesShown);
      return recent.length ? note(recent, { timezone: zone, timezoneName: zoneName }) : "";
    },
    /** The turn's context: recent copies for this conversation's person ("" when none). `address` when the caller knows it. */
    context(conversationId: string, address?: string | null): string {
      const known = state.addresses.get(conversationId) ?? address;
      return known ? api.copiesNote(known) : "";
    },
  };
  return api;
}

export type FlowEvents<W extends Watch = Watch> = ReturnType<typeof flowEvents<W>>;
