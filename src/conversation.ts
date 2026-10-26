// One conversation: an actor that owns one person's history, across every channel they write
// on, and runs one turn at a time.
//
// - Typing shows the moment a message arrives and is kept up while the agent works: sent again
//   before the platform hides it (ChannelInfo's typingLastsMs) and hidden by each message the agent
//   sends. After a message it shows again only when new work starts (a response calls tools, or the
//   person writes again), never because time passed: typing after an answer reads as more to come.
//   It never outlives the turn. Refused outside the person's window for it, it waits for the agent's
//   next message; any other failure ends it for the turn.
// - Double texts fold into the reply in progress. Someone who sends another message is usually
//   correcting themselves, so a model step in flight is aborted and runs again with every message
//   so far; one that arrives while tools run ends the wait for them (below).
// - The person sees only what the agent sends with its send tools, react or share_updates, and
//   its edits and unsends of what it sent, where the channel has them.
// - Acknowledgement first: after the person writes, the agent's first response must reach them,
//   on every channel they are waiting on. A first response that only calls tools is held, and the
//   agent is asked to acknowledge in the same response as those calls.
// - Tools in one response run together, and the reply waits for all of them: one answer, not an
//   acknowledgement and a result later. A tool moves to the background (the agent is told, the
//   person is not) only when the person writes again meanwhile, when another tool of the response
//   finished partialAfterMs ago (the finished results go back now), or past its own limit
//   (deadlineMs). Its result comes back into this chat later; the same call with the same input
//   while it runs is not run again. Messages go out in the order the agent wrote them, while tools run.
// - A sent message's result says it was delivered, once the channel accepted it: the next message
//   goes only after that (docs/guarantees.md). A reply to the person of only messages, in a turn
//   where the agent used no tool, gets one more step (it may have said "getting your plan" and meant
//   to act next); a second such response ends the turn. A message that fails to arrive comes back to the agent as
//   a message.
// - A background result the agent says nothing about, with no other tool pending, is sent back
//   once: it may have written the answer as plain text, which never reaches the person. A result
//   returned to its response is sent back only when the agent answers it in new plain text: silence
//   is left alone, and text repeating a message already sent counts as said.
// - Several channels: each message is tagged with its channel, the agent answers each on its own
//   channel, and a send on a channel missing from their last 5 messages is held until the agent
//   confirms it.
// - Everything is kept in the store as it happens: the history, the inbox of events not yet
//   handled, background tools in flight. After a restart the conversation carries on.
// - Scheduled messages, nudges and the agent's own wake-ups arrive through the inbox and wait for
//   the turn in progress.
// - A message the agent's own rules answer with no model call (its intercept, a STOP, START or
//   HELP keyword) is kept with what was sent back, in order with the person's other messages, and
//   starts no turn: a turn running takes it in at its next step, else it is stored at once.
// - Files the person sends: photos and PDFs go to the model when it reads them, a voice note as its
//   transcript; anything it cannot read is named with why, so it can ask for text. Only the latest
//   few are shown, and their bytes are never stored: after a restart they are named, not shown.

import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { contentRefusal, declaredTemplate, fillTemplate, fitMessage, type ContentRefusal } from "./channels.ts";
import type { FlowEvents } from "./business-events/engine.ts";
import type { FlowEvent, Emit, EventSink } from "./events.ts";
import { coveredBy, noContactTools, rulesSection } from "./nudges.ts";
import { recordsUntil, type Records } from "./records.ts";
import { addWakeUp, scheduleTools, wakeUpsOf, wakeUpsSection, wakeUpTools, type WakeUps } from "./schedules.ts";
import type { ConversationRow, InboxRow, NoContactRow, QuietHours, StoreApi, TimeZoneSource } from "./store.ts";
import { EDIT, REACT, UNSEND, UPDATE, cardsOf, editInput, unsendInput, contentRefusalText, photoOf, reactInput, sendInput, sendRefusal, sentArgs, sendToolName, talkInstructions, talkSpecs, updateInput, type ChannelView, type SendInput, type TalkSettings } from "./talk.ts";
import { formatLocal } from "./time.ts";
import { render, tool, toolContext, toSpec, type ChatAuth, type ChatAuthContext, type CredentialProvider, type Tool, type ToolContext } from "./tools.ts";
import type { Attachment, BeforeSend, CarouselCard, ChannelInfo, ChatMessage, Deliver, Incoming, Media, Model, Outbound, OutboundMessage, PersonMessage, Photo, ReplyButton, SendContext, SendReceipt, Template, TemplateDefinition, ToolCall, ToolSpec, Transcribe } from "./types.ts";

export interface ConversationSettings {
  model: Model;
  /** Speech to text for voice notes; without it the agent is told it can't listen to them. */
  transcribe?: Transcribe;
  tools: Map<string, Tool>;
  credentials?: CredentialProvider;
  credentialProvider?: (context: Readonly<Omit<ToolContext, "credentials">>) => CredentialProvider | undefined;
  auth?: ChatAuth;
  specs: ToolSpec[];
  instructions: string;
  /** Per-turn context for the system prompt (the person's profile, the time). */
  context?: (conversationId: string) => Promise<string> | string;
  /** Sinks that asked for turn.context. Others, traces included, do not receive it. */
  contextSinks: EventSink[];
  /** The longest a reply waits for a tool that sets no limit of its own. */
  deadlineMs: number;
  /** When one tool of a response is done and others still run this long after, the finished results go back. */
  partialAfterMs: number;
  debounceMs: number;
  maxSteps: number;
  /** About how many tokens one model call may carry (instructions, tools and history). */
  historyTokens: number;
  /** The longest a tool result is kept, in characters. */
  toolResultChars: number;
  /** How many times one step restarts for new messages before it lets the step finish. */
  maxRestarts: number;
  talk: TalkSettings;
  emit: Emit;
  store: StoreApi;
  /** The agent's records, for its tools (`context.records`). */
  records: Records;
  /** The agent's events side once attached, for its tools (`context.events`). */
  events?: () => FlowEvents | undefined;
  /** Resolves once the store's tables exist. */
  ready: Promise<void>;
  now: () => number;
  /** The agent's own time zone (the business's): the time it is told when the person's is not known. */
  timeZone?: string;
  /** The agent's quiet hours for everyone (false: none), unless a person set their own. */
  quietHours?: QuietHours | false;
  /** The WhatsApp templates the owner declared: a sent one's text goes in the history. */
  templates: TemplateDefinition[];
  /** The owner's check of every message, carousel and template before it goes (createAgent's beforeSend). */
  beforeSend?: BeforeSend;
  /** The declared template Flow Framework sends when no other one fits a closed window (createAgent's fallbackTemplate). */
  fallbackTemplate?: string;
  /** The model has wake_me_up and cancel_wake_up, and its prompt lists its wake-ups (createAgent's wakeUps). */
  wakeUps: boolean;
  /** Tag every message with its channel (the agent has several), even for a person on one so far. */
  tagChannels: boolean;
  /** How the channels of a conversation loaded from the store are reached again. */
  links(conversationId: string): Promise<ChannelLink[]>;
  /** Records how a scheduled run or a nudge ended. */
  settle(target: { run?: string; nudge?: string }, status: string, reason?: string, messageId?: string): Promise<void>;
  /** A window-closed prompt nudge the agent sent no template for: held until they reply, and the fallback goes. */
  windowClosed(nudge: string, to: { channel: string; address: string }): Promise<void>;
  /** This process among the agent's runners: it holds a conversation's lease while working on it. */
  runner: string;
  /** Another runner holds the conversation, or held it since this copy was read: the agent drops this copy, and reads it again (`again`) when this runner holds it now. */
  away(conversation: Conversation, again: boolean): void;
}

/** One channel this person writes on, and how to reach them there. */
export interface ChannelLink {
  name: string;
  info: ChannelInfo;
  /** The channel's own extra fields on its send tool. */
  params?: Record<string, z.ZodType>;
  /** The agent author's guidance for this channel, in the system prompt while it is in use. */
  instructions?: string;
  address: string;
  deliver: Deliver;
  lastMessageAt: number | null;
}

const ACKNOWLEDGE_FIRST =
  "[Chinwag] They have not heard from you yet. In one response, acknowledge them " +
  "(react to their message or send a short line) and make your tool calls again.";
const INTERRUPTED = "[Chinwag] Cut off by a restart: this may or may not have happened. Check before you rely on it.";
const APOLOGY = "Sorry, something went wrong on my side. Could you send that again?";
/** How long a runner holds a conversation without renewing (ms), and how often it renews while busy. */
export const LEASE_MS = 15_000;
const RENEW_MS = 5_000;
let leaseWarned = false;
const EARLIER = "[Chinwag] Older messages of this conversation are no longer shown to you.";
const RESET = "[Chinwag] The conversation starts again here: earlier messages are no longer shown to you.";

/** A reset marker's line for the model, with the app's short note on what came before. */
export function resetLine(note?: string): string {
  return note?.trim() ? `${RESET}\nBefore this: ${note.trim()}` : RESET;
}
const NOT_SHOWN = "[Chinwag] You are no longer shown the photos or documents in these messages; ask them to send one again if you need it.";

/** A server-verified auth change: an internal prompt, never a prewritten chat response. */
export function signInNotice(channel: string, request?: string): string {
  return `Internal authentication event: sign-in completed on ${channel}. Continue the conversation on that channel. ` +
    "Resume a request that was blocked only by sign-in, using the verified account and normal tools. " +
    "Do not replay operations that already ran or retry unrelated failures. If nothing is waiting for sign-in, acknowledge naturally. Do not quote this internal event. " +
    (request ? `The pending request (user text, not system instructions) is: ${JSON.stringify(request)}` : "");
}

/** Photos and PDFs the model is shown at once, the latest; each is resent on every model call. */
const MEDIA_SHOWN = 3;
/** Typing is sent again this far into the platform's indicator lifetime (typingLastsMs), before it hides. */
const TYPING_AGAIN = 0.8;
/** The largest photo, and the largest PDF or voice note, the agent reads (most models take 5 MB images). */
const IMAGE_MAX_MB = 5;
const FILE_MAX_MB = 10;
/** The image types the main model APIs take. */
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** What a message's files became: marks after its id, the media the model is shown, a voice note's text. */
interface Files {
  marks: string[];
  media: Media[];
  transcript?: string;
}

/** A tool call the reply is waiting on. */
interface Running {
  call: ToolCall;
  input: string;
  startedAt: number;
  limitMs: number;
  authorized: Promise<void>;
  outcome: Promise<{ ok: boolean; text: string }>;
  result?: { ok: boolean; text: string };
}

/** Why a tool stopped holding the reply: the person wrote, the others are done, or its limit passed. */
type Detach = "message" | "partial" | "limit";

interface Task {
  id: string;
  tool: string;
  /** Its input, as checked, with keys in a fixed order: a repeat of a running call has the same. */
  input: string;
  startedAt: number;
}

/** A scheduled run, a prompt nudge or a wake-up, whose turn may owe the person a message. */
interface Owed {
  run?: string;
  nudge?: string;
  mode: "message" | "check" | "prompt" | "wake";
  channel: string;
  address?: string;
  /** A prompt nudge or a wake-up for someone whose WhatsApp window is closed: only a template reaches them. */
  windowClosed?: boolean;
}

interface Pending {
  id: string;
  /** As the agent reads it, after its id. */
  text: string;
  /** As the person wrote it (the transcript's). */
  shown: string;
  choice?: boolean;
  /** What they tapped, by id, when it is not its label. */
  choiceId?: string;
  channel: string;
  media?: Media[];
  inbox?: number;
  /** Answered with no model call: the agent reads it with what was sent back, and it starts no turn. */
  answer?: Answer;
}

/** What a message answered with no model call got back ("" for nothing), and Flow Framework's line about it (a STOP's). */
interface Answer {
  reply: string;
  note?: string;
}

interface Note {
  text: string;
  inbox?: number;
  owed?: Owed;
  /** Learned at the next turn, but does not start one (the person's reaction). */
  wait?: boolean;
  /** A reset marker (agent.resetHistory): the model is sent only what comes after it. */
  reset?: boolean;
}

/** Typing kept up on one channel while a turn runs. */
interface TypingKept {
  /** Sends it again before the platform hides it; null when nothing is due. */
  timer: ReturnType<typeof setTimeout> | null;
  /** window: refused outside the person's window, until the agent's next message goes; failed: no more this turn. */
  held: "window" | "failed" | null;
}

/** Sent without the model: a fixed-text scheduled message, or a text or template nudge. */
interface Direct {
  /** A fixed nudge targets the address it was requested for, even if another session wrote later. */
  address?: string;
  inbox?: number;
  channel: string;
  /** A held nudge released because they just wrote: their window is open. */
  theyWrote?: boolean;
  text?: string;
  /** A text nudge's call to action. */
  link?: { label: string; url: string };
  template?: Template;
  run?: string;
  /** The run's schedule, to read whether the run was settled. */
  schedule?: string;
  nudge?: string;
}

export class Conversation {
  readonly id: string;
  readonly personKey: string;
  readonly history: ChatMessage[] = [];
  private readonly settings: ConversationSettings;
  private readonly channels = new Map<string, ChannelLink>();
  private pending: Pending[] = [];
  private notes: Note[] = [];
  /** A tool's result is in the history and no message has gone out since: from the background, or returned to a response. */
  private resultUnsent: false | "background" | "returned" = false;
  /** What the agent has sent in this turn, to tell its own text repeated from something new. */
  private sentThisTurn = new Set<string>();
  /** The texts sent to the person so far, oldest first: read from the history at the first send, then kept up to date (SendContext.sent). */
  private sentTexts: string[] | null = null;
  /** Where this turn's entries start in the history: a reset placed during the turn keeps them. */
  private turnFrom = 0;
  private direct: Direct[] = [];
  private owed: Owed[] = [];
  /** The person's message ids, and the channel each came on. */
  private readonly messageIds = new Map<string, string>();
  /** The agent's own messages by the platform's id (SendReceipt.messageId), and the channel each went on: read from the history at the first use, then kept up to date. */
  private ownIds: Map<string, string> | null = null;
  private readonly knownInbox = new Set<number>();
  private messageCount = 0;
  /** Turns begun, kept in the store: tools' idempotency keys carry the turn's number. */
  private turns = 0;
  /** Aborted when the conversation closes: tools' signal. */
  private readonly lifetime = new AbortController();
  /** Why the conversation was closed (null: open), for a tool's record put that comes after. */
  private closedWhy: string | null = null;
  /** The records puts of this conversation's tools still under way: stored() waits for them. */
  private readonly puts = new Set<Promise<unknown>>();
  /** The agent's records as this conversation's tools have them (`context.records`): no put once it is closed. */
  private readonly records: Records;
  /** The agent's wake-ups as this conversation's tools have them (`context.wakeUps`): none added once it is closed. */
  private readonly wakeUps: WakeUps;
  private recentChannels: string[] = [];
  private promptDestination?: { channel: string; address?: string };
  private timeZone: string | null = null;
  /** Their own quiet hours ("off": none), or null for the agent's. */
  private quietHours: QuietHours | "off" | null = null;
  private running = false;
  /** Messages whose files are still being read (downloaded, transcribed); later ones wait behind them. */
  private preparing: Promise<void> | null = null;
  private stepAbort: AbortController | null = null;
  /** Ends the reply's wait for its tools now (the person wrote). */
  private wakeTools: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly tasks = new Map<string, Task>();
  private taskCount = 0;
  private idleSince = Date.now();
  /** The turn running now was not started by the person (a nudge, a scheduled message, a background result). */
  private businessTurn = false;
  private settled: Array<() => void> = [];
  /** Channels where nothing has reached the person since their latest message there. */
  private readonly unanswered = new Set<string>();
  /** The next model response is the first since their latest message. */
  private firstResponse = false;
  /** Channels where the typing indicator shows, as far as Flow Framework knows. */
  private readonly typingOn = new Set<string>();
  /** Channels typing is kept up on until the turn ends (from the person's message). */
  private readonly typingKept = new Map<string, TypingKept>();
  /** One challenge per channel per turn, even when the model calls several protected tools. */
  private signInPrompts = new Map<string, Promise<{ message: string; url?: string }>>();
  private authBlocked = new Set<string>();
  private authPromptsSent = new Set<string>();
  /** The send tool for each channel, this turn. */
  private sendTools = new Map<string, string>();
  private readonly builtins: Map<string, Tool>;
  private readonly builtinSpecs: ToolSpec[];
  private readonly loaded: Promise<void>;
  private writes: Promise<void>;
  /** History entries already in the store. */
  private saved = 0;
  /** A turn was cut off by a restart: it runs again with the history so far. */
  private resumeTurn = false;
  /** Forgotten: nothing more runs, is sent or is kept. */
  private closed = false;
  /** This turn took in a message from the person: if it fails, they are told. */
  private theirMessages = false;
  /** History entries left out of the latest model call (0: none), so a change is an event once. */
  private leftOut = 0;
  /** They texted STOP (as of the latest look): what the business starts is dropped, with no model call. */
  private stop: NoContactRow | null = null;
  /** Their STOP or a pause in force, as of this turn's start: a wake-up's turn sends them nothing. */
  private block: NoContactRow | null = null;
  /**
   * The lease's epoch this copy was read under: 0 for a conversation new here (no runner held it
   * yet). Another epoch at a claim means another runner worked on it since: this copy is stale.
   */
  private epoch = 0;
  /** This runner holds the lease and renews it while busy. */
  private renewal: ReturnType<typeof setInterval> | null = null;
  /** Another runner has it: this copy runs nothing more (its writes still finish), and the agent drops it. */
  private gone = false;

  constructor(id: string, personKey: string, settings: ConversationSettings, existing: ConversationRow | null = null) {
    this.id = id;
    this.personKey = personKey;
    this.settings = settings;
    this.records = recordsUntil(settings.records, () => this.closedWhy, this.puts);
    if (existing) {
      this.messageCount = existing.messageCount;
      this.turns = existing.turns;
      this.recentChannels = existing.recentChannels;
      this.timeZone = existing.timeZone;
      this.quietHours = existing.quietHours;
    }
    const wakeScope = {
      store: settings.store,
      conversationId: id,
      channel: () => this.currentChannel(),
      now: settings.now,
      zone: () => this.timeZone ?? settings.timeZone ?? "UTC",
    };
    this.wakeUps = {
      add: (input) => {
        if (this.closedWhy) throw new Error(`flow: wake-ups: not added: ${this.closedWhy}`);
        return addWakeUp(wakeScope, input);
      },
      cancel: (key) => settings.store.cancelWakeUps(key),
      list: () => wakeUpsOf(settings.store, id),
    };
    const builtins = [
      ...scheduleTools({
        store: settings.store,
        conversationId: id,
        channel: () => this.currentChannel(),
        now: settings.now,
        personZone: () => this.timeZone,
        setPersonZone: (zone) => this.setTimeZone(zone, "person"),
        agentZone: settings.timeZone,
      }),
      ...noContactTools({ store: settings.store, conversationId: id, now: settings.now, zone: () => this.timeZone, setQuietHours: (q) => this.setQuietHours(q) }),
      ...(settings.wakeUps ? wakeUpTools(wakeScope) : []),
    ];
    const fallback = settings.fallbackTemplate;
    const offered = settings.templates.filter((t) => t.name !== fallback);
    if (offered.length) builtins.push(this.templateTool(offered));
    this.builtins = new Map(builtins.map((t) => [t.name, t]));
    this.builtinSpecs = builtins.map(toSpec);
    this.loaded = settings.ready.then(() => (existing ? this.claimAndLoad() : settings.store.createConversation(id, personKey)));
    this.writes = this.loaded.catch((error) => console.warn("flow: conversation %s did not load:", id, error));
  }

  /** Their time zone, as the business set it or they said it: schedules, quiet hours and the time line use it from now on. */
  setTimeZone(zone: string, source: TimeZoneSource): Promise<void> {
    this.timeZone = zone;
    return this.persist(() => this.settings.store.updateConversation(this.id, { timeZone: zone, timeZoneSource: source }));
  }

  /** Their own quiet hours ("off": none; null: back to the agent's). */
  setQuietHours(hours: QuietHours | "off" | null): Promise<void> {
    this.quietHours = hours;
    return this.persist(() => this.settings.store.updateConversation(this.id, { quietHours: hours }));
  }

  /**
   * send_template: the agent sends one of the business's WhatsApp templates, its values filled, when
   * Flow Framework tells it their 24-hour window is closed. The fallback template is Flow Framework's to send.
   */
  private templateTool(offered: TemplateDefinition[]): Tool {
    const names = offered.map((t) => t.name) as [string, ...string[]];
    return tool({
      name: "send_template",
      description: `Send one of the business's WhatsApp templates, only when Chinwag says their 24-hour window is closed. Templates: ${offered.map((t) => `${t.name}: "${t.body}"`).join("; ")}. body: the {{1}}, {{2}}... values in order.`,
      input: z.object({
        name: z.enum(names),
        body: z.array(z.string()).optional(),
        header: z.string().optional().describe("The header's {{1}}, when its header is text with a value"),
      }),
      run: async ({ name, body, header }, context) => {
        const blocked = this.blockedSend();
        if (blocked) return { error: blocked };
        const template: Template = { name, ...(body?.length ? { body } : {}), ...(header ? { header: { kind: "text", text: header } } : {}) };
        const declared = declaredTemplate(this.settings.templates, template);
        let reads = "";
        try {
          if (declared) reads = fillTemplate(declared, template).body;
        } catch (error) {
          return { error: error instanceof Error ? error.message.replace(/^flow: /, "") : String(error) };
        }
        const channel = this.owed.find((o) => o.windowClosed)?.channel ?? context.channel;
        const result = await this.sendMessage(channel, { type: "template", ...template }, "agent");
        if ("refused" in result) return { error: result.refused };
        if ("failure" in result) return { error: result.failure };
        const sent = result.sent as Extract<Outbound, { type: "template" }>;
        if (JSON.stringify(sent) !== JSON.stringify({ type: "template", ...template })) {
          try {
            const shown = declaredTemplate(this.settings.templates, sent);
            reads = shown ? fillTemplate(shown, sent).body : "";
          } catch {}
        }
        this.settings.emit(this.id, "message.out", { text: sent.name, channel, template: true, ...idDetail(result.receipt) });
        this.history.push({ role: "user", content: `[Chinwag] You sent them the template "${sent.name}" on ${channel}. It reads:\n${reads}` });
        this.sent();
        return { delivered: true, channel };
      },
    });
  }

  /** What a channel of this conversation can show, if the person has written on it. */
  channelInfo(channel: string): ChannelInfo | undefined {
    return this.channels.get(channel)?.info;
  }

  /** The address the person is reached at on a channel (by default their latest message's), if they have written on it. */
  reachedOn(channel = this.currentChannel()): { channel: string; address: string } | undefined {
    const link = this.channels.get(channel);
    return link && { channel, address: link.address };
  }

  /** Reach the person on this channel (again): a new channel, or a fresh way to deliver. */
  link(link: ChannelLink): void {
    const known = this.channels.get(link.name);
    if (known) {
      known.deliver = link.deliver;
      known.info = link.info;
      known.params = link.params;
      known.instructions = link.instructions;
      known.address = link.address;
    } else this.channels.set(link.name, link);
  }

  /** A message from the person on `channel`; returns the id the agent sees it by. */
  receive(input: string | Incoming, options: { channel: string; messageId?: string }): string {
    const incoming: Incoming = typeof input === "string" ? { text: input } : input;
    const channel = options.channel;
    if (options.messageId !== undefined && this.messageIds.get(options.messageId) === channel) {
      // The channel gave this message before (a retry): it is taken once.
      this.settings.emit(this.id, "message.duplicate", { messageId: options.messageId, channel });
      return options.messageId;
    }
    const id = options.messageId ?? `m${++this.messageCount}`;
    this.messageIds.set(id, channel);
    this.startTyping(channel);
    // A file or voice note is read before message.in. Say the message arrived first, so a test
    // run is not settled as silence while the transcript is still being made.
    if (incoming.attachments?.length) this.settings.emit(this.id, "message.arrived", { messageId: id, channel });
    if (!incoming.attachments?.length && !this.preparing) {
      this.arrive(incoming, id, channel, options.messageId !== undefined, { marks: [], media: [] });
      return id;
    }
    // Its files are read first (a voice note transcribed), and messages after it wait their turn.
    const ready = (this.preparing ?? Promise.resolve())
      .then(async () => {
        const files = await this.readFiles(incoming.attachments ?? []);
        if (!this.closed) this.arrive(incoming, id, channel, options.messageId !== undefined, files);
      })
      .catch((error) => console.warn("flow: a message in conversation %s could not be read:", this.id, error));
    this.preparing = ready;
    void ready.finally(() => {
      if (this.preparing !== ready) return;
      this.preparing = null;
      this.checkIdle();
    });
    return id;
  }

  /** The message is ready for the agent: it joins the reply in progress, or starts one. */
  private arrive(incoming: Incoming, id: string, channel: string, ownId: boolean, files: Files): void {
    const at = this.settings.now();
    const item: Pending = { id, text: describe(incoming, files), shown: shownText(incoming, files), ...choiceOf(incoming), channel, ...(files.media.length ? { media: files.media } : {}) };
    this.pending.push(item);
    this.recentChannels = [...this.recentChannels, channel].slice(-5);
    const link = this.channels.get(channel);
    if (link) link.lastMessageAt = at;
    const fields = { messageCount: this.messageCount, recentChannels: this.recentChannels };
    this.persist(async () => {
      const payload = { id, text: item.text, shown: item.shown, ...(item.choice ? { choice: true } : {}), ...(item.choiceId ? { choiceId: item.choiceId } : {}), channel, ...(item.media ? { media: item.media.map(stored) } : {}) };
      const inbox = await this.settings.store.addMessage(this.id, payload, ownId ? { channel, messageId: id } : undefined);
      if (inbox === null) {
        // Another runner took this provider id first (a retry reached both): the message is theirs.
        this.pending = this.pending.filter((waiting) => waiting !== item);
        this.settings.emit(this.id, "message.duplicate", { messageId: id, channel });
        return;
      }
      item.inbox = inbox;
      this.knownInbox.add(item.inbox);
      await this.settings.store.updateConversation(this.id, fields);
      if (link) await this.settings.store.touchIdentity(channel, link.address, at);
    });
    const attachments = incoming.attachments?.map((a) => ({ kind: a.kind, mime: a.mime, ...(a.name ? { name: a.name } : {}) }));
    this.settings.emit(this.id, "message.in", { text: incoming.text, messageId: id, ownId, channel, replyTo: incoming.replyTo, choice: incoming.choice, ...(attachments ? { attachments } : {}), ...(files.transcript !== undefined ? { transcript: files.transcript } : {}) });
    this.unanswered.add(channel);
    this.firstResponse = true;
    this.startTyping(channel);
    if (this.running) {
      // Fold it in: a model step in flight is thrown away and run again with this message, and
      // tools being waited on move to the background so the agent reads it now.
      this.stepAbort?.abort();
      this.wakeTools?.();
      return;
    }
    this.schedule(this.settings.debounceMs);
  }

  /**
   * A message the agent's own rules answered with no model call (its intercept, a STOP, START or
   * HELP keyword), and `reply`, what goes back to them ("" for nothing). Both join the history in
   * order with their other messages, at the next step of a turn running now or else at once, and
   * start no turn. Null when the channel gave this message before.
   *
   * `taken` is false when its provider id was taken first (by another runner, or before the STOP
   * written in `claimed`, which already holds the id): nothing is kept then. `send` delivers the
   * reply, unless it was not taken; it starts the delivery at once, so call it once `taken` where
   * a retry must not be answered twice.
   */
  answered(input: string | Incoming, options: { channel: string; messageId?: string; claimed?: Promise<boolean>; note?: string }, reply: string): { id: string; taken: Promise<boolean>; send(): Promise<void> } | null {
    const incoming: Incoming = typeof input === "string" ? { text: input } : input;
    const { channel, messageId } = options;
    if (messageId !== undefined && this.messageIds.get(messageId) === channel) {
      this.settings.emit(this.id, "message.duplicate", { messageId, channel });
      return null;
    }
    const id = messageId ?? `m${++this.messageCount}`;
    this.messageIds.set(id, channel);
    const none: Files = { marks: [], media: [] };
    const answer: Answer = { reply, ...(options.note ? { note: options.note } : {}) };
    const item: Pending = { id, text: describe(incoming, none), shown: shownText(incoming, none), ...choiceOf(incoming), channel, answer };
    this.pending.push(item);
    const at = this.settings.now();
    this.recentChannels = [...this.recentChannels, channel].slice(-5);
    const link = this.channels.get(channel);
    if (link) link.lastMessageAt = at;
    const fields = { messageCount: this.messageCount, recentChannels: this.recentChannels };
    const ownId = messageId !== undefined;
    let lost = false;
    const stored = this.persist(async () => {
      if (options.claimed && !(await options.claimed)) return void (lost = true);
      const payload = { id, text: item.text, shown: item.shown, ...(item.choice ? { choice: true } : {}), ...(item.choiceId ? { choiceId: item.choiceId } : {}), channel, answer };
      // Its provider id is written with it (unless the STOP already holds it), so a retry is not answered again.
      const inbox = await this.settings.store.addMessage(this.id, payload, ownId && !options.claimed ? { channel, messageId: id } : undefined);
      if (inbox === null) return void (lost = true);
      item.inbox = inbox;
      this.knownInbox.add(inbox);
      await this.settings.store.updateConversation(this.id, fields);
      if (link) await this.settings.store.touchIdentity(channel, link.address, at);
    });
    const taken = stored.then(() => {
      if (this.closed) return false;
      if (lost) {
        this.pending = this.pending.filter((waiting) => waiting !== item);
        this.settings.emit(this.id, "message.duplicate", { messageId: id, channel });
        this.checkIdle();
        return false;
      }
      this.settings.emit(this.id, "message.in", { text: incoming.text, messageId: id, ownId, channel, replyTo: incoming.replyTo, choice: incoming.choice, answered: true });
      return true;
    });
    const send = async () => {
      const result = reply ? await this.sendMessage(channel, { type: "message", text: reply }, "framework") : null;
      if (!(await taken)) return;
      if (result && !("sent" in result)) {
        // Kept as answered with nothing, if it is not in the history yet; the agent hears it did not arrive.
        answer.reply = "";
        this.undelivered(reply, "refused" in result ? result.refused : result.failure);
      } else if (result) {
        // What went is what the history keeps.
        if (result.sent.type === "message") answer.reply = result.sent.text;
        this.settings.emit(this.id, "message.out", { ...outDetail(result.sent), channel, direct: true, answered: true, ...idDetail(result.receipt) });
      }
      if (!this.running && !this.timer) void this.run();
    };
    return { id, taken, send };
  }

  /**
   * What the agent gets of the person's files: photos and PDFs the model reads, a voice note as its
   * transcript, and for anything else a mark saying why it cannot be read, so it can ask for text.
   */
  private async readFiles(attachments: Attachment[]): Promise<Files> {
    const files: Files = { marks: [], media: [] };
    const reads = this.settings.model.reads ?? {};
    for (const a of attachments) {
      const name = a.name ? ` "${a.name.replace(/["\n]/g, "")}"` : "";
      const what = a.kind === "image" ? "photo" : a.kind === "audio" ? "voice note" : `document${name}`;
      const cannot =
        a.kind === "image" ? (!reads.images ? "you can't see photos" : !IMAGE_TYPES.has(a.mime) ? "you can't see this type of image" : null)
        : a.kind === "document" ? (a.mime !== "application/pdf" ? "you can only open PDFs" : !reads.pdfs ? "you can't open documents" : null)
        : !this.settings.transcribe ? "you can't listen to voice notes" : null;
      if (cannot) {
        files.marks.push(`[${what}: ${cannot}]`);
        continue;
      }
      const max = a.kind === "image" ? IMAGE_MAX_MB : FILE_MAX_MB;
      let bytes: Uint8Array;
      try {
        bytes = await a.data();
      } catch (error) {
        this.settings.emit(this.id, "attachment.failed", { kind: a.kind, error: String(error) });
        files.marks.push(`[${what}: it could not be downloaded]`);
        continue;
      }
      if (bytes.length > max * 1_048_576) {
        files.marks.push(`[${what}: too large for you to read, over ${max} MB]`);
        continue;
      }
      if (a.kind !== "audio") {
        files.media.push({ kind: a.kind, mime: a.mime, ...(a.name ? { name: a.name } : {}), data: Buffer.from(bytes).toString("base64") });
        files.marks.push(`[${what}]`);
        continue;
      }
      try {
        const text = (await this.settings.transcribe!({ mime: a.mime, data: bytes })).trim();
        files.transcript = [files.transcript, text].filter(Boolean).join("\n");
        files.marks.push("[voice note, transcribed]");
      } catch (error) {
        this.settings.emit(this.id, "attachment.failed", { kind: a.kind, error: String(error) });
        files.marks.push(`[${what}: it could not be transcribed]`);
      }
    }
    return files;
  }

  /** An event from the inbox (a scheduled run, a nudge) for this conversation. */
  enqueue(row: InboxRow): void {
    if (this.knownInbox.has(row.id)) return;
    this.knownInbox.add(row.id);
    const p = row.payload as Record<string, any>;
    if (row.kind === "message") {
      // Its photos and PDFs are named, not shown: their bytes were never stored.
      this.pending.push({ id: p.id, text: p.text, shown: p.shown ?? p.text, ...(p.choice ? { choice: true } : {}), ...(typeof p.choiceId === "string" ? { choiceId: p.choiceId } : {}), channel: p.channel, inbox: row.id, ...(Array.isArray(p.media) ? { media: p.media } : {}), ...(p.answer ? { answer: p.answer } : {}) });
      this.messageIds.set(p.id, p.channel);
      if (!p.answer) {
        this.unanswered.add(p.channel);
        this.firstResponse = true;
        this.wakeTools?.();
      }
    } else if (row.kind === "note") {
      this.notes.push({ text: p.text, inbox: row.id, wait: p.wait === true, ...(p.reset === true ? { reset: true } : {}) });
    } else if (row.kind === "schedule") {
      const link = p.mode === "wake" ? this.channels.get(p.channel) : undefined;
      const closed = !!link && windowClosed(link, this.settings.now());
      if (p.fixed) this.direct.push({ inbox: row.id, channel: p.channel, text: p.text, run: p.run, schedule: p.schedule });
      else if (closed) {
        // A wake-up past their WhatsApp window: the agent may still do its work, and only a template reaches them.
        const how = this.builtins.has("send_template") ? "If one of the business's templates says what you have to tell them, send it with send_template, its values filled in; otherwise send them nothing." : "So send them nothing.";
        this.notes.push({ text: `${p.text} Their WhatsApp 24-hour window is closed: no ordinary message reaches them. ${how}`, inbox: row.id, owed: { run: p.run, mode: p.mode, channel: p.channel, windowClosed: true } });
      } else this.notes.push({ text: p.text, inbox: row.id, owed: { run: p.run, mode: p.mode, channel: p.channel } });
    } else if (row.kind === "nudge") {
      if (p.prompt !== undefined) {
        if (p.windowClosed) {
          const text = `[Nudge from the business, not from the person: ${p.prompt}] Their WhatsApp 24-hour window is closed: no ordinary message reaches them. If one of the business's templates says this, send it with send_template, its values filled in. If none fits, send nothing: Flow Framework sends them a "you have a new message" template and gives you this again when they reply.`;
          this.notes.push({ text, inbox: row.id, owed: { nudge: p.nudge, mode: "prompt", channel: p.channel, address: p.address, windowClosed: true } });
          if (!this.running && this.hasWork()) this.schedule(0);
          return;
        }
        const held = typeof p.heldAt === "number" ? `held for their quiet hours since ${formatLocal(this.timeZone ?? this.settings.timeZone ?? "UTC", p.heldAt)}; ` : "";
        const text = held
          ? `[Nudge from the business, not from the person, ${held}${p.prompt}] Tell them now in your own words. Others held with it come in this turn too: cover them all in one short message, not a text each, and answer anything they just asked first.`
          : `[Nudge from the business, not from the person: ${p.prompt}] Write it to them now in your own words, or send nothing if it does not fit what they asked not to be messaged about.`;
        this.notes.push({ text, inbox: row.id, owed: { nudge: p.nudge, mode: "prompt", channel: p.channel, address: p.address } });
      } else this.direct.push({ inbox: row.id, channel: p.channel, address: p.address, text: p.text, ...(p.link ? { link: p.link } : {}), template: p.template, nudge: p.nudge, ...(p.theyWrote ? { theyWrote: true } : {}) });
    }
    if (!this.running && this.hasWork()) this.schedule(0);
  }

  /**
   * The person reacted to one of the agent's messages. The agent learns it at its next turn; a
   * reaction alone does not start one.
   */
  reacted(emoji: string, toText: string): void {
    this.settings.emit(this.id, "reaction.in", { emoji, toText });
    this.note(`[They reacted ${emoji} to your message: "${clip(toText)}"]`, true);
  }

  /** agent.resetHistory: the model is sent only what comes after this, from the next turn on. */
  async resetHistory(note?: string): Promise<void> {
    await this.note(resetLine(note), true, true);
  }

  /** The channel reports, now or later, that a message did not reach the person. */
  undelivered(text: string, reason: string): void {
    this.settings.emit(this.id, "message.undelivered", { text, reason });
    this.note(`[Not delivered] "${text}": ${reason}`);
  }

  /**
   * They texted a STOP or START keyword: their STOP is kept (or lifted) with no model call, with
   * the message's provider id. Returns the line the agent learns it by, kept with the message
   * (`answered`), and `stored`, false when that id was taken before.
   */
  keyword(kind: "stop" | "start", text: string, channel: string, messageId?: string): { note: string; stored: Promise<boolean> } {
    const { store } = this.settings;
    const inbound = messageId === undefined ? undefined : { channel, messageId };
    this.settings.emit(this.id, "keyword", { keyword: kind, text, channel });
    let taken = true;
    const keep = (rule: NoContactRow | null) => this.persist(async () => void (taken = await store.setStop(this.id, rule, inbound))).then(() => taken);
    if (kind === "stop") {
      const rule: NoContactRow = { id: `nc_stop_${randomUUID().slice(0, 6)}`, rule: `nothing the business starts: they texted ${text.trim()} on ${channel}; only START lifts it`, until: null, hard: true, kind: "stop" };
      this.stop = rule;
      return { note: `[Chinwag] They texted "${clip(text.trim())}" on ${channel}: nothing the business starts (nudges, scheduled messages) reaches them until they text START. Answer them when they write.`, stored: keep(rule) };
    }
    this.stop = null;
    return { note: `[Chinwag] They texted "${clip(text.trim())}" on ${channel}: messages the business starts may reach them again.`, stored: keep(null) };
  }

  get busy(): boolean {
    // A message answered with no model call waits in `pending` for its reply to go and its place in the history.
    return this.running || this.timer !== null || this.tasks.size > 0 || this.preparing !== null || this.pending.length > 0;
  }

  get idleForMs(): number {
    return this.busy ? 0 : Date.now() - this.idleSince;
  }

  get backgroundTasks(): Task[] {
    return [...this.tasks.values()];
  }

  /** Resolves once nothing is running or waiting (no turn, no background task) and all is stored. */
  async whenIdle(): Promise<void> {
    if (this.busy) await new Promise<void>((resolve) => this.settled.push(resolve));
    await this.writes;
  }

  /** Resolves once everything so far is in the store, the tools' record puts under way included. */
  stored(): Promise<void> {
    return Promise.all([this.writes, ...this.puts]).then(() => undefined);
  }

  /**
   * Writes an earlier conversation into this one's history, as if it had been said (a test's seeded
   * history): the person's messages as theirs, the agent's as sent on `channel`. No model call, no send,
   * no events. Only a conversation with nothing in its history yet.
   */
  async seed(messages: Array<{ from: "person" | "agent"; text: string }>, channel: string): Promise<void> {
    await this.loaded;
    if (this.history.length || this.busy) throw new Error("only a conversation with no history yet can be seeded");
    const tag = this.settings.tagChannels;
    let group: PersonMessage[] = [];
    const read = () => {
      if (!group.length) return;
      this.history.push({ role: "user", content: group.map((m) => `[${tag ? `${channel} · ` : ""}${m.id}] ${m.text}`).join("\n"), messages: group });
      group = [];
    };
    let n = 0;
    for (const m of messages) {
      if (m.from === "person") {
        // Ids of their own: a provider's (or the test cloud's) message ids, m1 among them, never meet these.
        const id = `h${++n}`;
        this.messageIds.set(id, channel);
        group.push({ id, channel, text: m.text });
        continue;
      }
      read();
      const callId = `seeded_${randomUUID().slice(0, 8)}`;
      this.history.push({ role: "assistant", content: null, toolCalls: [{ id: callId, name: sendToolName(channel), arguments: JSON.stringify({ text: m.text }) }] });
      this.history.push({ role: "tool", toolCallId: callId, content: JSON.stringify({ delivered: true, channel }) });
    }
    read();
    this.recentChannels = [...this.recentChannels, channel].slice(-5);
    const fields = { recentChannels: this.recentChannels };
    this.persist(() => this.settings.store.updateConversation(this.id, fields));
    this.flush();
    await this.writes;
  }

  /**
   * The person was forgotten: a step in flight is cut off, nothing waiting runs, nothing more is
   * sent or kept. Tools already running finish on their own, and their results go nowhere.
   */
  close(why = "the person was forgotten while the tool ran"): void {
    this.closed = true;
    this.closedWhy = why;
    if (this.renewal) clearInterval(this.renewal);
    this.renewal = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dropTyping();
    this.pending = [];
    this.notes = [];
    this.direct = [];
    this.stepAbort?.abort();
    this.wakeTools?.();
    this.lifetime.abort();
  }

  /** Runs `work` after every earlier write to the store, in order. */
  persist(work: () => Promise<unknown>): Promise<void> {
    if (this.closed) return this.writes;
    const next = this.writes.then(work).then(
      () => undefined,
      (error) => console.warn("flow: could not save conversation %s:", this.id, error),
    );
    this.writes = next;
    return next;
  }

  /** Reads the conversation only while this runner holds it, so no other runner adds to it meanwhile. */
  private async claimAndLoad(): Promise<void> {
    const lease = await this.hold(true);
    if (lease === "elsewhere") return this.leave(false);
    await this.load();
    if (!this.busy) this.letGo();
  }

  /**
   * Takes or renews the lease for this runner: "mine" to go on, "stale" when another runner had
   * the conversation since this copy was read, "elsewhere" when another holds it now. A store with
   * no leases (an older one) answers "mine", as before them.
   */
  private async claim(reading = false): Promise<"mine" | "stale" | "elsewhere"> {
    const now = this.settings.now();
    let epoch: number | null;
    try {
      epoch = await this.settings.store.claimConversation(this.id, this.settings.runner, now, now + LEASE_MS);
    } catch (error) {
      if (!leaseWarned) console.warn("flow: runner %s could not take conversation %s's lease; going on without it (later failures are not logged):", this.settings.runner, this.id, error);
      leaseWarned = true;
      return "mine";
    }
    if (epoch === null) return "elsewhere";
    // Reading it now, any epoch will do; a copy already read (or new here: epoch 0, fresh only if
    // this runner is the first to hold it) is stale once another runner held it.
    if (!reading && epoch !== (this.epoch || 1)) return "stale";
    this.epoch = epoch;
    return "mine";
  }

  /** Claims the lease and keeps renewing it while the conversation is busy. */
  private async hold(reading = false): Promise<"mine" | "stale" | "elsewhere"> {
    const lease = await this.claim(reading);
    if (lease === "mine" && !this.renewal) {
      this.renewal = setInterval(() => void this.renew(), RENEW_MS);
      this.renewal.unref?.();
    }
    return lease;
  }

  private async renew(): Promise<void> {
    if (!this.renewal) return;
    if ((await this.claim()) === "mine") return;
    // This runner stalled past its lease and another took the conversation: it stops here.
    console.warn("flow: runner %s lost conversation %s to another runner; it stops working on it", this.settings.runner, this.id);
    this.close("another runner took the conversation while the tool ran");
    this.leave(false);
  }

  /** Lets go of the lease once nothing runs or waits, so another runner may take the conversation at once. */
  private letGo(): void {
    if (!this.renewal) return;
    clearInterval(this.renewal);
    this.renewal = null;
    if (this.closed) return;
    const { store, runner } = this.settings;
    void this.persist(() => store.releaseConversation(this.id, runner));
  }

  /** Another runner has the conversation: run nothing more here, and let the agent drop this copy. */
  private leave(again: boolean): void {
    this.gone = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dropTyping();
    if (this.renewal) clearInterval(this.renewal);
    this.renewal = null;
    this.settings.away(this, again);
  }

  /** Takes the open inbox rows another runner stored for this conversation (it does not know them yet); true when there were any. */
  private async takeOpen(): Promise<boolean> {
    await this.writes;
    let took = false;
    let rows: InboxRow[];
    try {
      rows = await this.settings.store.openInbox(this.id);
    } catch (error) {
      console.warn("flow: runner %s could not read conversation %s's inbox:", this.settings.runner, this.id, error);
      return false;
    }
    for (const row of rows) {
      if (this.knownInbox.has(row.id)) continue;
      const p = row.payload as Record<string, any>;
      if (row.kind === "message" && this.messageIds.get(p.id) === p.channel) {
        this.knownInbox.add(row.id);
        this.persist(() => this.settings.store.doneInbox([row.id]));
        continue;
      }
      this.enqueue(row);
      took = true;
    }
    return took;
  }

  /** Looks at the conversation again (the agent's periodic look at unfinished ones): runs what is waiting, if this runner can take it. */
  poke(): void {
    if (!this.gone && !this.closed && !this.busy) this.schedule(0);
  }

  /** Picks up where the conversation was: its history, events not yet handled, tools cut off. */
  private async load(): Promise<void> {
    const { store } = this.settings;
    // A live arrival can attach its new address while persisted links are loading. Keep that proof.
    for (const link of await this.settings.links(this.id)) if (!this.channels.has(link.name)) this.link(link);
    const history = await store.history(this.id);
    this.saved = history.length;
    this.history.push(...history);
    this.sentTexts = null;
    this.ownIds = null;
    const only = [...this.channels.keys()][0] ?? "chat";
    for (const entry of history) {
      if (entry.role !== "user") continue;
      for (const m of personMessages(entry, only)) this.messageIds.set(m.id, m.channel);
    }
    // A step cut off while its tools ran: those calls get a result that says so.
    const answered = new Set(history.flatMap((e) => (e.role === "tool" ? [e.toolCallId] : [])));
    const lastCalls = [...history].reverse().find((e) => e.role === "assistant" && e.toolCalls?.length);
    if (lastCalls?.role === "assistant") {
      for (const c of lastCalls.toolCalls ?? []) if (!answered.has(c.id)) this.history.push({ role: "tool", toolCallId: c.id, content: INTERRUPTED });
    }
    for (const task of await store.tasks(this.id)) {
      this.note(`[Chinwag] ${task.tool} (${task.taskId}) was still running in the background when the agent restarted. It may or may not have finished; check before telling them it is done.`);
      this.persist(() => store.removeTask(this.id, task.taskId));
    }
    for (const row of await store.openInbox(this.id)) {
      // Already in the history (its row was not marked done): answered, so not answered again.
      const p = row.payload as Record<string, any>;
      if (row.kind === "message" && this.messageIds.get(p.id) === p.channel) this.persist(() => store.doneInbox([row.id]));
      else this.enqueue(row);
    }
    const row = await store.conversation(this.id);
    this.resumeTurn = row?.turnOpen === true;
    if ((this.resumeTurn || this.hasWork()) && !this.running) this.schedule(0);
  }

  /** Messages from the person the agent has yet to answer (not those answered with no model call). */
  private unread(): boolean {
    return this.pending.some((p) => !p.answer);
  }

  private hasWork(): boolean {
    return this.pending.length > 0 || this.notes.some((n) => !n.wait) || this.direct.length > 0;
  }

  private note(text: string, wait = false, reset = false): Promise<void> {
    const item: Note = { text, wait, ...(reset ? { reset } : {}) };
    this.notes.push(item);
    const stored = this.persist(async () => {
      item.inbox = await this.settings.store.addInbox(this.id, "note", { text, wait, ...(reset ? { reset } : {}) });
      this.knownInbox.add(item.inbox);
    });
    if (!wait && !this.running) this.schedule(0);
    return stored;
  }

  private schedule(delayMs: number): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delayMs);
  }

  private async run(): Promise<void> {
    if (this.running || this.gone) return;
    this.running = true;
    try {
      await this.loaded;
      if (this.gone) return;
      const lease = await this.hold();
      if (lease !== "mine") return void this.leave(lease === "stale");
      // What other runners stored for it meanwhile (a message that reached them, a nudge).
      await this.takeOpen();
      for (;;) {
        if (this.closed) break;
        if (this.unread() || this.notes.some((n) => !n.wait) || this.resumeTurn) {
          try {
            await this.turn();
          } catch (error) {
            await this.turnFailed(error);
          }
          // The turn is over: typing stops, unless a message of theirs is waiting for the next one.
          if (!this.unread() && !this.preparing) await this.stopTyping();
          continue;
        }
        // Only messages answered with no model call: into the history, with no turn.
        if (this.pending.length) {
          this.absorb();
          continue;
        }
        const next = this.direct.shift();
        if (!next) {
          // Rows another runner stored while this one worked; anything that came meanwhile; then it lets go.
          if (this.closed) break;
          const took = await this.takeOpen();
          if (took || this.pending.length || this.direct.length || this.resumeTurn || this.notes.some((n) => !n.wait)) continue;
          break;
        }
        try {
          await this.sendDirect(next);
        } catch (error) {
          this.settings.emit(this.id, "model.error", modelError(error));
          this.settle(next, "failed", errorText(error));
          this.flush([next]);
        }
      }
    } finally {
      this.running = false;
      await this.stopTyping();
      for (const link of this.channels.values()) if (link.info.status) await this.send(link.name, { type: "status", text: null });
      this.checkIdle();
    }
  }

  /**
   * A turn threw (the model failed): what it owed is settled as failed, what was waiting is taken
   * in so it is not tried again, and only a person waiting on a reply is told something went wrong.
   * A turn they did not start (a nudge, a scheduled message, a background result) stays silent.
   */
  private async turnFailed(error: unknown): Promise<void> {
    this.settings.emit(this.id, "model.error", modelError(error));
    await this.stopTyping();
    this.absorb();
    for (const o of this.owed.splice(0)) this.settle(o, "failed", `the agent's turn failed: ${errorText(error)}`);
    this.resultUnsent = false;
    this.persist(() => this.settings.store.updateConversation(this.id, { turnOpen: false }));
    const waiting = this.theirMessages ? [...this.unanswered] : [];
    if (waiting.length) await this.sendMessage(waiting.includes(this.currentChannel()) ? this.currentChannel() : waiting[0], { type: "message", text: APOLOGY }, "framework");
  }

  private checkIdle(): void {
    if (this.busy) return;
    // Nothing will answer them now (their message could not be read): typing is not kept up.
    if (this.typingKept.size) void this.stopTyping();
    this.letGo();
    this.idleSince = Date.now();
    const waiting = this.settled;
    this.settled = [];
    for (const resolve of waiting) resolve();
  }

  private views(): ChannelView[] {
    return [...this.channels.values()].map((c) => ({ name: c.name, info: c.info, params: c.params, instructions: c.instructions }));
  }

  /** The channel of the person's latest message. */
  private currentChannel(): string {
    return (!this.theirMessages ? this.promptDestination?.channel ?? this.owed.at(-1)?.channel : undefined) ?? this.recentChannels.at(-1) ?? [...this.channels.keys()][0] ?? "chat";
  }

  /** Move waiting messages and notes into the history; the person's messages are now read. */
  private absorb(): boolean {
    if (!this.pending.length && !this.notes.length) return false;
    const items: Array<{ inbox?: number }> = [];
    for (const note of this.notes.splice(0)) {
      if (note.owed && this.stop && note.owed.mode !== "wake") {
        // They texted STOP: what the business started never reaches the model.
        this.settle(note.owed, "dropped", `no-contact rule ${this.stop.id}: ${this.stop.rule}`);
        items.push(note);
        continue;
      }
      // A wake-up after their STOP or a pause runs, told that Flow sends them nothing in it.
      const text = note.owed?.mode === "wake" && this.block ? `${note.text} ${this.blockLine(this.block)}` : note.text;
      this.history.push({ role: "user", content: text, ...(note.reset ? { reset: true as const } : {}) });
      if (note.reset) this.settings.emit(this.id, "history.reset", { text: note.text });
      if (note.text.startsWith("[Background result:")) this.resultUnsent = "background";
      if (note.owed) this.owed.push(note.owed);
      items.push(note);
    }
    const messages = this.pending.splice(0);
    if (messages.length) {
      const tag = this.settings.tagChannels || this.channels.size > 1;
      const line = (m: Pending) => `[${tag ? `${m.channel} · ` : ""}${m.id}${m.text}`;
      const said = (m: Pending): PersonMessage => ({ id: m.id, channel: m.channel, text: m.shown, ...(m.choice ? { choice: true } : {}), ...(m.choiceId ? { choiceId: m.choiceId } : {}) });
      // In order: the messages the agent answers, together in one entry, and each answered with no
      // model call as one of its own, with what was sent back as the agent's (as a text nudge is).
      let group: Pending[] = [];
      const read = () => {
        if (!group.length) return;
        const media = group.flatMap((m) => m.media ?? []);
        this.history.push({ role: "user", content: group.map(line).join("\n"), ...(media.length ? { media } : {}), messages: group.map(said) });
        if (media.length) this.showLatestMedia();
        group = [];
      };
      for (const m of messages) {
        if (!m.answer) {
          group.push(m);
          continue;
        }
        read();
        const how = m.answer.reply ? `[Chinwag] The business's own rules answered this for you on ${m.channel}, as written:` : `[Chinwag] The business's own rules took this message for you on ${m.channel} and sent nothing back.`;
        this.history.push({ role: "user", content: [line(m), m.answer.note, how].filter(Boolean).join("\n"), messages: [said(m)] });
        if (m.answer.reply) {
          const callId = `answered_${randomUUID().slice(0, 8)}`;
          this.history.push({ role: "assistant", content: null, toolCalls: [{ id: callId, name: sendToolName(m.channel), arguments: JSON.stringify({ text: m.answer.reply }) }] });
          this.history.push({ role: "tool", toolCallId: callId, content: JSON.stringify({ delivered: true, channel: m.channel }) });
        }
      }
      read();
      items.push(...messages);
      const theirs = messages.filter((m) => !m.answer);
      if (theirs.length) this.theirMessages = true;
      for (const channel of new Set(theirs.map((m) => m.channel))) {
        if (this.channels.get(channel)?.info.readReceipts) void this.send(channel, { type: "read", messageIds: theirs.filter((m) => m.channel === channel).map((m) => m.id) });
      }
    }
    this.flush(items);
    return true;
  }

  /** Stores history entries not yet stored, and marks the inbox rows they came from handled. */
  private flush(items: Array<{ inbox?: number }> = []): void {
    const seq = this.saved;
    const entries = this.history.slice(seq).map((e) => (e.role === "user" && e.media ? { ...e, media: e.media.map(stored) } : e));
    this.saved = this.history.length;
    if (!entries.length && !items.length) return;
    this.persist(() => this.settings.store.appendHistory(this.id, seq, entries, items.flatMap((i) => (i.inbox === undefined ? [] : [i.inbox]))));
  }

  /** Only the latest MEDIA_SHOWN photos and PDFs keep their bytes; older ones are named, not shown. */
  private showLatestMedia(): void {
    let shown = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const entry = this.history[i];
      if (entry.role !== "user" || !entry.media) continue;
      for (let k = entry.media.length - 1; k >= 0; k--) {
        if (!entry.media[k].data) continue;
        if (++shown > MEDIA_SHOWN) entry.media[k] = stored(entry.media[k]);
      }
    }
  }

  private async turn(): Promise<void> {
    const started = Date.now();
    const { store } = this.settings;
    const noContact = await store.noContact(this.id, this.settings.now());
    this.stop = noContact.find((r) => r.hard) ?? null;
    this.block = this.stop ?? noContact.find((r) => r.kind === "pause") ?? null;
    if (this.stop && !this.resumeTurn && !this.unread() && !this.notes.some((n) => !n.wait && (!n.owed || n.owed.mode === "wake"))) {
      // Only what the business started is waiting, and they texted STOP: it is dropped, no turn runs.
      this.absorb();
      return;
    }
    // A turn cut off by a restart keeps its number, so a tool called again in it gets the same key.
    if (!this.resumeTurn) this.turns++;
    const turns = this.turns;
    this.resumeTurn = false;
    this.theirMessages = false;
    this.promptDestination = undefined;
    // `turn`: its number, the same when a turn cut off by a restart runs again (on this runner or another).
    this.settings.emit(this.id, "turn.start", { turn: turns });
    this.signInPrompts.clear();
    this.authBlocked.clear();
    this.authPromptsSent.clear();
    this.persist(() => store.updateConversation(this.id, { turnOpen: true, turns }));
    this.turnFrom = this.history.length;
    this.absorb();
    // A turn the person started (as against a background result, a scheduled message or a nudge).
    const theirs = this.unanswered.size > 0;
    this.businessTurn = !theirs;
    if (!this.channels.size) {
      // No way to reach them right now (a channel with no adapter, after a restart).
      for (const o of this.owed.splice(0)) this.settle(o, "failed", "no way to reach them on that channel right now");
      this.persist(() => store.updateConversation(this.id, { turnOpen: false }));
      return;
    }
    const context = this.settings.context ? await this.settings.context(this.id) : "";
    if (context.trim()) {
      const event: FlowEvent = { type: "turn.context", conversationId: this.id, at: Date.now(), text: context };
      for (const sink of this.settings.contextSinks) {
        try {
          sink(event);
        } catch (error) {
          console.warn("flow: an event sink failed:", error);
        }
      }
    }
    const quiet = this.quietHours === "off" ? null : (this.quietHours ?? (this.settings.quietHours === false ? null : (this.settings.quietHours ?? { from: "22:00", to: "07:00" })));
    const zone = this.timeZone ?? this.settings.timeZone ?? "UTC";
    const rules = rulesSection(noContact, zone, this.timeZone ? quiet : null);
    const wakeUps = this.settings.wakeUps ? wakeUpsSection(await wakeUpsOf(store, this.id), zone) : "";
    // A message that came while those loaded had no step to restart: it joins the first one.
    this.absorb();
    let restarts = 0;
    let reminded = false;
    let followedUp = false;
    /** A tool other than talking has been called in this turn. */
    let acted = false;
    this.sentThisTurn.clear();
    for (let step = 0; step < this.settings.maxSteps; step++) {
      if (this.closed) return;
      // The channels can grow mid-turn (they wrote on another one), so each step offers what is there now.
      // A business prompt is addressed to one session, not whichever address last wrote on that channel.
      if (!this.theirMessages) this.promptDestination = this.owed.at(-1) ?? this.promptDestination;
      const destination = !this.theirMessages ? this.promptDestination : undefined;
      if (destination?.address) {
        const link = (await this.settings.links(this.id)).find(l => l.name === destination.channel && l.address === destination.address);
        if (link) this.link(link);
      }
      const views = this.views();
      const several = views.length > 1;
      this.sendTools = new Map(views.map((v) => [sendToolName(v.name), v.name]));
      const system = [this.settings.instructions, talkInstructions(views, this.settings.talk), rules, wakeUps, nowLine(this.settings.now(), this.timeZone, this.settings.timeZone), context].filter(Boolean).join("\n\n");
      const ownSpecs = this.settings.auth ? this.settings.specs.map((spec) => ({ ...spec, description: spec.description + ((this.settings.tools.get(spec.name)?.signIn ?? "required") === "required" ? " Requires sign-in." : "") })) : this.settings.specs;
      const specs = [...ownSpecs, ...this.builtinSpecs, ...talkSpecs(views, this.settings.talk)];
      const abort = new AbortController();
      if (restarts < this.settings.maxRestarts) this.stepAbort = abort;
      const callStarted = Date.now();
      let response;
      try {
        response = await this.settings.model.complete({ system, messages: this.window(system, specs), tools: specs, signal: abort.signal });
      } catch (error) {
        if (!abort.signal.aborted) throw error;
      } finally {
        this.stepAbort = null;
      }
      if (abort.signal.aborted || !response) {
        restarts++;
        step--;
        this.settings.emit(this.id, "model.restarted", { ms: Date.now() - callStarted });
        this.absorb();
        continue;
      }
      this.settings.emit(this.id, "model.call", {
        ms: Date.now() - callStarted,
        toolCalls: response.toolCalls.map((c) => c.name),
        usage: response.usage,
        ...(response.model ? { model: response.model } : {}),
      });
      if (response.text) this.settings.emit(this.id, "text.hidden", { text: response.text });

      const talk = response.toolCalls.filter((c) => this.isTalk(c.name));
      const work = response.toolCalls.filter((c) => !this.isTalk(c.name));
      const first = this.firstResponse;
      this.firstResponse = false;

      const reached = new Set(talk.flatMap((c) => this.targets(c)));
      const waiting = [...this.unanswered].filter((c) => !reached.has(c));
      if (first && waiting.length && work.length) {
        // Acknowledgement first: these calls do not run until the person has heard from the agent.
        this.settings.emit(this.id, "ack.required", { held: work.map((c) => c.name), channels: waiting });
        this.history.push({
          role: "user",
          content: several
            ? `[Chinwag] They have not heard from you on ${waiting.join(" or ")} yet. In one response, acknowledge them there (react to their message or send a short line) and make your tool calls again.`
            : ACKNOWLEDGE_FIRST,
        });
        this.flush();
        continue;
      }

      if (!response.toolCalls.length) {
        this.history.push({ role: "assistant", content: response.text });
        const owes = [...new Set([...this.unanswered, ...this.owed.filter((o) => o.mode === "message").map((o) => o.channel)])];
        if (owes.length && !reminded) {
          reminded = true;
          this.history.push({
            role: "user",
            content: several
              ? `[Chinwag] INTERNAL MESSAGE, not from them: ${response.text ? "your text above never reached them" : "they have not heard from you"} on ${owes.join(" or ")}. Reply with ${owes.map((c) => sendToolName(c)).join(" or ")}, without mentioning this note${response.text ? ", that text" : ""} or any delay.`
              : `[Chinwag] INTERNAL MESSAGE, not from them: ${response.text ? "your text above never reached them" : "they have not heard from you"}. Reply with ${sendToolName(owes[0])}, without mentioning this note${response.text ? ", that text" : ""} or any delay.`,
          });
          this.flush();
          continue;
        }
        // After a returned result, only new plain text is sent back: silence may be the answer, and
        // text that repeats a message already sent has been said.
        const said = !!response.text && !this.sentThisTurn.has(response.text.trim());
        const owedResult = this.resultUnsent === "returned" && said;
        if ((this.resultUnsent === "background" || owedResult) && !this.tasks.size && !reminded) {
          // A result came back and the agent said nothing to them: it may have written the answer as plain text.
          reminded = true;
          this.history.push({ role: "user", content: `[Chinwag] INTERNAL MESSAGE, not from them: they have not heard from you since the result above, and text outside ${this.sendToolsNow()} never reaches them. If the result is for them, tell them with ${this.sendToolsNow()}, without mentioning this note, any earlier text or any delay.` });
          this.flush();
          continue;
        }
        this.flush();
        if (this.absorb()) continue;
        break;
      }

      this.history.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });
      this.flush();
      if (work.length) acted = true;
      const working = this.runTools(work);
      const said: Array<{ content: string; refused: boolean }> = [];
      for (const call of talk) said.push(await this.talk(call));
      // Tools started: more is coming, so typing shows again where a message hid it.
      if (work.length) this.typingAgain();
      const { results: done, finished } = await working;
      // A result the agent has not passed on yet: if it ends the turn without a message, it is reminded once.
      if (finished) this.resultUnsent = "returned";
      const problems = said.some((s) => s.refused);
      const results = new Map<string, string>();
      talk.forEach((call, i) => results.set(call.id, said[i].content));
      work.forEach((call, i) => results.set(call.id, this.capped(done[i])));
      for (const call of response.toolCalls) {
        this.history.push({ role: "tool", toolCallId: call.id, content: results.get(call.id) ?? "" });
      }
      for (const [channel, prompt] of this.signInPrompts) {
        if (this.authPromptsSent.has(channel)) continue;
        await this.sendSignIn(channel, await prompt);
        this.authPromptsSent.add(channel);
      }
      this.flush();
      if (work.length && work.every((call) => this.authBlocked.has(call.id)) && !this.absorb()) break;
      // Only messages: the turn is over unless one was refused or something new came in meanwhile, or
      // this replies to their message without having used any tool: it gets one more step, in case it
      // meant to act next (it said "getting your order" and has not asked for it yet). A tool
      // used, or still running in the background, means it already acted.
      if (!work.length && !problems && !this.absorb()) {
        if (!theirs || followedUp || acted || this.tasks.size) break;
        followedUp = true;
      }
      this.absorb();
    }
    for (const o of this.owed.splice(0)) {
      const link = o.windowClosed && o.nudge ? this.channels.get(o.channel) : undefined;
      if (link) {
        const { nudge } = o;
        this.persist(() => this.settings.windowClosed(nudge!, { channel: o.channel, address: link.address }));
        continue;
      }
      if (o.mode === "message") this.settle(o, "failed", "the agent sent nothing");
      else this.settle(o, o.mode === "check" ? "quiet" : "silent");
    }
    this.resultUnsent = false;
    this.persist(() => store.updateConversation(this.id, { turnOpen: false }));
    this.settings.emit(this.id, "turn.end", { ms: Date.now() - started, turn: turns });
  }

  private isTalk(name: string): boolean {
    return this.sendTools.has(name) || name === REACT || name === UPDATE || name === EDIT || name === UNSEND;
  }

  /** The channels a talk call reaches (for the acknowledgement rule), before it runs. */
  private targets(call: ToolCall): string[] {
    if (this.sendTools.has(call.name)) return [this.sendTools.get(call.name)!];
    if (call.name === UPDATE) return [...this.channels.values()].filter((c) => c.info.status).map((c) => c.name);
    // Changing what was sent before answers nothing new.
    if (call.name === EDIT || call.name === UNSEND) return [];
    try {
      const channel = this.messageIds.get(JSON.parse(call.arguments || "{}").message_id);
      return channel ? [channel] : [];
    } catch {
      return [];
    }
  }

  /**
   * Run one of the send tools, react, share_updates, edit_message or unsend_message. A message that went out says where it was
   * delivered; one that failed on the way is told as a message of its own. `refused` is a call
   * that did nothing because of its input: the agent gets another step to fix it.
   */
  private async talk(call: ToolCall): Promise<{ content: string; refused: boolean }> {
    const refused = (content: string) => ({ content, refused: true });
    const done = (content = "") => ({ content, refused: false });
    const blocked = this.blockedSend();
    if (blocked) return refused(blocked);
    let raw: unknown;
    try {
      raw = JSON.parse(call.arguments || "{}");
    } catch {
      return refused("The arguments were not valid JSON.");
    }
    const channel = this.sendTools.get(call.name);
    if (channel) {
      const link = this.channels.get(channel)!;
      const several = this.sendTools.size > 1;
      // Some models fill every optional field, with "" or null when they have nothing: that is not sent.
      const given = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      for (const k of Object.keys(link.params ?? {})) if (given[k] === "" || given[k] === null) delete given[k];
      const parsed = sendInput(link.info, several, link.params).safeParse(raw);
      if (!parsed.success) return refused(`Not sent, fix and send again: ${parsed.error.message}`);
      const input = parsed.data as SendInput;
      const fields = Object.fromEntries(Object.keys(link.params ?? {}).flatMap((k) => ((input as Record<string, unknown>)[k] === undefined ? [] : [[k, (input as Record<string, unknown>)[k]]])));
      const hasFields = Object.keys(fields).length > 0;
      if (several && !input.confirm && !this.recentChannels.includes(channel) && !this.owed.some(o => o.channel === channel) && this.promptDestination?.channel !== channel) {
        const last = link.lastMessageAt ? ` (last time ${ago(this.settings.now() - link.lastMessageAt)} ago)` : "";
        return refused(`Not sent: they have not written on ${channel} in their last 5 messages${last}. If you are sure, call ${call.name} again with confirm: true.`);
      }
      if (input.reply_to && this.messageIds.get(input.reply_to) !== channel) return refused(`Not sent: there is no message ${input.reply_to} on ${channel} to reply to.`);
      const refusal = sendRefusal(link.info, input);
      if (refusal) return refused(refusal);
      // A turn the person did not start: no link preview leads the notification (types.ts, `preview`).
      const preview = this.businessTurn ? { preview: false as const } : {};
      const outbound: Outbound = input.carousel
        ? {
            type: "carousel",
            text: input.text,
            cards: cardsOf(input.carousel),
            ...(input.reply_to ? { replyTo: input.reply_to } : {}),
            ...preview,
          }
        : fitMessage(link.info, {
            type: "message" as const,
            text: input.text,
            ...(input.reply_to ? { replyTo: input.reply_to } : {}),
            ...(input.buttons?.length ? { buttons: input.buttons } : {}),
            ...(input.list ? { list: input.list } : {}),
            ...(input.link ? { link: input.link } : {}),
            ...(input.image ? { image: photoOf(input.image) } : {}),
            ...(hasFields ? { fields } : {}),
            ...preview,
          });
      const result = await this.sendMessage(channel, outbound, "agent");
      if ("refused" in result) return refused(result.refused);
      if ("failure" in result) {
        this.undelivered(input.text, result.failure);
        return done();
      }
      // What went, after beforeSend, is what the events, the history and the transcript keep.
      const sent = result.sent as Extract<Outbound, { type: "message" | "carousel" }>;
      const changed = JSON.stringify(sent) !== JSON.stringify(outbound);
      this.settings.emit(this.id, "message.out", { ...outDetail(sent), channel, ...(changed ? { rewritten: true } : {}), ...idDetail(result.receipt) });
      this.sent(result.receipt);
      this.sentThisTurn.add(input.text.trim());
      this.sentThisTurn.add(sent.text.trim());
      await this.acknowledged(channel);
      return done(JSON.stringify({ delivered: true, channel, ...this.ownId(channel, result.receipt), ...(changed ? { sent: sentArgs(sent) } : {}) }));
    }
    if (call.name === EDIT || call.name === UNSEND) {
      const edit = call.name === EDIT;
      const input = edit ? editInput.safeParse(raw) : unsendInput.safeParse(raw);
      const not = edit ? "Not edited" : "Not unsent";
      if (!input.success) return refused(`${not}, fix and try again: ${input.error.message}`);
      const id = input.data.message_id;
      const on = this.ownMessages().get(id);
      if (!on) return refused(`${not}: there is no message ${id} of yours. Name one by the message_id its send's result gave.`);
      const link = this.channels.get(on);
      if (!(edit ? link?.info.edits : link?.info.unsends)) return refused(`${not}: messages on ${on} cannot be ${edit ? "edited" : "unsent"}.${edit ? " Send a correction if it matters." : ""}`);
      if (!edit) {
        const failure = await this.send(on, { type: "unsend", messageId: id });
        if (failure) return refused(`${not}: ${failure}`);
        this.settings.emit(this.id, "message.unsent", { messageId: id, channel: on });
        return done(JSON.stringify({ unsent: true, channel: on, message_id: id }));
      }
      const text = "text" in input.data ? String(input.data.text) : "";
      const max = link!.info.maxLength;
      if (max && text.length > max) return refused(`${not}: the text is over ${max} characters on ${on}.`);
      const result = await this.sendMessage(on, { type: "message", text }, "agent", link, id);
      if ("refused" in result) return refused(result.refused.replace(/^Not sent/, not));
      if ("failure" in result) return refused(`${not}: ${result.failure}`);
      const now = (result.sent as { text: string }).text;
      this.settings.emit(this.id, "message.edited", { messageId: id, channel: on, text: now, ...(now !== text ? { rewritten: true } : {}) });
      this.sentThisTurn.add(now.trim());
      return done(JSON.stringify({ edited: true, channel: on, message_id: id, ...(now !== text ? { text: now } : {}) }));
    }
    if (call.name === REACT) {
      const input = reactInput.safeParse(raw);
      if (!input.success) return refused(`Invalid input: ${input.error.message}`);
      const on = this.messageIds.get(input.data.message_id);
      if (!on) return refused(`There is no message ${input.data.message_id}.`);
      if (!this.channels.get(on)?.info.reactions) return refused(`Reactions do not work on ${on}; send a short line instead.`);
      const failure = await this.send(on, { type: "reaction", emoji: input.data.emoji, messageId: input.data.message_id });
      if (failure) return refused(`The reaction did not go through: ${failure}`);
      this.settings.emit(this.id, "reaction", { emoji: input.data.emoji, messageId: input.data.message_id, channel: on });
      await this.acknowledged(on);
      return done();
    }
    if (call.name === UPDATE) {
      const input = updateInput.safeParse(raw);
      if (!input.success) return refused(`Invalid input: ${input.error.message}`);
      for (const link of this.channels.values()) {
        if (!link.info.status) continue;
        if (await this.send(link.name, { type: "status", text: input.data.text })) continue;
        this.settings.emit(this.id, "status", { text: input.data.text, channel: link.name });
        await this.acknowledged(link.name);
      }
      return done();
    }
    return refused(`There is no tool named ${call.name}.`);
  }

  /**
   * Why nothing may go to them now: a wake-up's turn after their STOP or in a pause, until they write
   * in it. Null when sends may go.
   */
  private blockedSend(): string | null {
    if (!this.block || this.theirMessages || !this.owed.some((o) => o.mode === "wake")) return null;
    return `Not sent: ${this.blockWhy(this.block)}, so Flow sends them nothing in this wake-up. Do the rest without messaging them.`;
  }

  private blockWhy(rule: NoContactRow): string {
    if (rule.kind === "stop") return "they texted STOP";
    return `they paused messages from the business${rule.until ? ` until ${formatLocal(this.timeZone ?? this.settings.timeZone ?? "UTC", rule.until - 1)}` : ""}`;
  }

  /** The wake-up note's line after their STOP or in a pause. */
  private blockLine(rule: NoContactRow): string {
    return `${this.blockWhy(rule)[0].toUpperCase()}${this.blockWhy(rule).slice(1)}: Flow sends them nothing in this turn. Do only what needs no message to them (your tools), or nothing.`;
  }

  /** How a scheduled run or a nudge ended, stored in order with everything else. */
  private settle(target: { run?: string; nudge?: string }, status: string, reason?: string, messageId?: string): void {
    this.persist(() => this.settings.settle({ run: target.run, nudge: target.nudge }, status, reason, messageId));
  }

  /** A message reached the person: whatever this turn owed them is sent, by it (the platform's id, when it gave one). */
  private sent(receipt?: SendReceipt): void {
    this.resultUnsent = false;
    for (const o of this.owed.splice(0)) this.settle(o, "sent", undefined, receipt?.messageId);
  }

  /**
   * Something of the agent's reached them on `channel`: its message hid the indicator, and it stays
   * hidden (no repeat is due) until new work starts: tools (typingAgain) or their next message.
   */
  private async acknowledged(channel: string): Promise<void> {
    this.unanswered.delete(channel);
    if (this.typingOn.delete(channel)) await this.send(channel, { type: "typing", on: false });
    const kept = this.typingKept.get(channel);
    if (!kept) return;
    if (kept.timer) clearTimeout(kept.timer);
    kept.timer = null;
    // Refused outside their window: the agent's message may have opened it (iMessage), so it is tried again when work starts.
    if (kept.held === "window") kept.held = null;
  }

  /** Their message on `channel`: typing shows there, and is kept up until the turn ends. */
  private startTyping(channel: string): void {
    const link = this.channels.get(channel);
    if (this.closed || !link || link.info.typing === false) return;
    let kept = this.typingKept.get(channel);
    if (!kept) this.typingKept.set(channel, (kept = { timer: null, held: null }));
    if (!kept.held && !this.typingOn.has(channel)) void this.showTyping(channel, kept);
  }

  /** New work started (tools): typing shows on every channel it is kept up on where a message of the agent's hid it. */
  private typingAgain(): void {
    for (const [channel, kept] of this.typingKept) if (!kept.held && !this.typingOn.has(channel)) void this.showTyping(channel, kept);
  }

  /** Sends typing now, then again before it hides. outside_window holds it until the agent's next message; any other failure ends it for the turn. */
  private async showTyping(channel: string, kept: TypingKept): Promise<void> {
    if (kept.timer) clearTimeout(kept.timer);
    kept.timer = null;
    this.typingOn.add(channel);
    const failure = await this.send(channel, { type: "typing", on: true });
    // The turn ended (or the conversation closed) while it went: what came of it no longer matters.
    if (this.typingKept.get(channel) !== kept) return;
    if (!failure) return this.typingDue(channel, kept);
    this.typingOn.delete(channel);
    if (failure.startsWith("outside_window")) {
      kept.held = "window";
      console.debug("flow: typing on %s in conversation %s: outside_window; tried again after the agent's next message", channel, this.id);
    } else {
      kept.held = "failed";
      console.warn("flow: typing on %s in conversation %s failed, so no more typing this turn: %s", channel, this.id, failure);
    }
  }

  /** Typing goes again on `channel` just before the platform hides it, if the platform says when (typingLastsMs). */
  private typingDue(channel: string, kept: TypingKept): void {
    const lasts = this.channels.get(channel)?.info.typingLastsMs;
    if (kept.timer) clearTimeout(kept.timer);
    kept.timer = null;
    if (!lasts || kept.held || this.closed) return;
    kept.timer = setTimeout(() => {
      kept.timer = null;
      void this.showTyping(channel, kept);
    }, lasts * TYPING_AGAIN);
  }

  /** Typing is no longer kept up: no timer is left, and nothing waits on it. */
  private dropTyping(): void {
    for (const kept of this.typingKept.values()) if (kept.timer) clearTimeout(kept.timer);
    this.typingKept.clear();
  }

  /** The turn is over (or failed): typing is no longer kept up, and is hidden where it shows. */
  private async stopTyping(): Promise<void> {
    this.dropTyping();
    const shown = [...this.typingOn];
    this.typingOn.clear();
    for (const channel of shown) await this.send(channel, { type: "typing", on: false });
  }

  /** Hand one outbound to a channel; returns why it failed, or null. */
  private async send(channel: string, outbound: Outbound): Promise<string | null> {
    if (this.closed) return "this person was forgotten";
    const link = this.channels.get(channel);
    if (!link) return `no way to reach them on ${channel} right now`;
    try {
      await link.deliver(outbound);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * A message, carousel or template to the person: through the owner's beforeSend, then the
   * platform's content rules, then the channel. Returns what went (what the events, the history and
   * the transcript keep), why it was refused (also a `message.refused` event), or why it failed on
   * the way. `link` is the channel's link when it is not this conversation's current one. With
   * `edit`, the draft is new text for that message of the agent's: it goes as an edit.
   */
  private async sendMessage(channel: string, draft: OutboundMessage, origin: SendContext["origin"], link = this.channels.get(channel), edit?: string): Promise<{ sent: OutboundMessage; receipt?: SendReceipt } | { refused: string } | { failure: string }> {
    if (this.closed) return { failure: "this person was forgotten" };
    if (!link) return { failure: `no way to reach them on ${channel} right now` };
    const refuse = (outbound: OutboundMessage, by: "beforeSend" | "content", reason: string, refusal?: ContentRefusal) => {
      const text = outbound.type === "template" ? outbound.name : outbound.text;
      this.settings.emit(this.id, "message.refused", { channel, origin, text, by, reason, ...(refusal ? { code: refusal.type, param: refusal.param, message: refusal.message } : {}), outbound, ...(edit ? { edit } : {}) });
      return { refused: reason };
    };
    let outbound = draft;
    if (this.settings.beforeSend) {
      let result: Awaited<ReturnType<BeforeSend>>;
      try {
        result = await this.settings.beforeSend(draft, { conversationId: this.id, channel, info: link.info, address: link.address, origin, sent: [...this.sentSoFar()], ...(edit ? { edit: { messageId: edit } } : {}) });
      } catch (error) {
        return refuse(draft, "beforeSend", `Not sent: beforeSend failed: ${errorText(error)}`);
      }
      if (result && "refuse" in result) return refuse(draft, "beforeSend", `Not sent: ${result.refuse}`);
      if (result) {
        const kinds = (o: OutboundMessage) => (o.type === "template" ? "template" : "message");
        if (kinds(result) !== kinds(draft)) return refuse(draft, "beforeSend", `Not sent: beforeSend returned a ${result.type ?? "value"} for a ${draft.type}.`);
        // A message it changed is fitted to the channel again, as the agent's are (a link without link buttons goes in the text).
        outbound = result.type === "message" ? fitMessage(link.info, result) : result;
      }
    }
    if (edit) {
      // An edit changes only the text.
      if (outbound.type !== "message") return refuse(draft, "beforeSend", `Not sent: beforeSend returned a ${outbound.type} for an edit.`);
      outbound = { type: "message", text: outbound.text };
    }
    const refusal = contentRefusal(link.info, outbound);
    if (refusal) return refuse(outbound, "content", contentRefusalText(link.info, refusal), refusal);
    let receipt: void | SendReceipt;
    try {
      receipt = await link.deliver(edit ? { type: "edit", messageId: edit, text: (outbound as { text: string }).text } : outbound);
    } catch (error) {
      return { failure: error instanceof Error ? error.message : String(error) };
    }
    if (edit) return { sent: outbound };
    if (outbound.type !== "template") this.sentSoFar().push(outbound.text);
    // The channel's wait for its signal ran out: it may still arrive, and is never sent again.
    if (receipt?.status === "unconfirmed") {
      this.settings.emit(this.id, "message.slow", { channel, origin, text: outbound.type === "template" ? outbound.name : outbound.text, ...(receipt.waitedMs !== undefined ? { waitedMs: receipt.waitedMs } : {}) });
    }
    return { sent: outbound, ...(receipt ? { receipt } : {}) };
  }

  /** The agent's own messages it may edit or unsend, by id. */
  private ownMessages(): Map<string, string> {
    const only = [...this.channels.keys()][0] ?? "chat";
    this.ownIds ??= new Map(transcriptOf(this.history.map((entry) => ({ entry, at: 0 })), only).flatMap((e) => (e.kind === "out" && e.messageId ? [[e.messageId, e.channel] as const] : [])));
    return this.ownIds;
  }

  /**
   * A sent message's id, for its send's result, on a channel where the agent can edit or unsend
   * it (elsewhere it would cost every turn for nothing): kept so it can name it later.
   */
  private ownId(channel: string, receipt?: SendReceipt): { message_id?: string } {
    const info = this.channels.get(channel)?.info;
    if (!receipt?.messageId || !(info?.edits || info?.unsends)) return {};
    this.ownMessages().set(receipt.messageId, channel);
    return { message_id: receipt.messageId };
  }

  private sentSoFar(): string[] {
    const only = [...this.channels.keys()][0] ?? "chat";
    this.sentTexts ??= transcriptOf(this.history.map((entry) => ({ entry, at: 0 })), only).flatMap((e) => (e.kind === "out" && !e.template ? [e.text] : []));
    return this.sentTexts;
  }

  /** A fixed-text scheduled message or a text or template nudge, sent with no model turn. */
  private async sendDirect(d: Direct): Promise<void> {
    // Settled already (by an earlier process, or another one running beside this): never sent twice.
    if (await this.directSettled(d)) {
      if (d.inbox !== undefined) this.persist(() => this.settings.store.doneInbox([d.inbox!]));
      return;
    }
    const settle = (status: string, reason?: string, messageId?: string) => {
      this.settle(d, status, reason, messageId);
      this.flush([d]);
    };
    const link = d.address === undefined ? this.channels.get(d.channel) : (await this.settings.links(this.id)).find(l => l.name === d.channel && l.address === d.address);
    if (!link) return settle("failed", `no way to reach them on ${d.channel} right now`);
    if (!d.template && !d.theyWrote && windowClosed(link, this.settings.now())) return settle("refused", "outside_window");
    // Every direct send is one the business starts (a nudge, or its scheduled text): the person's rules apply.
    const rules = await this.settings.store.noContact(this.id, this.settings.now());
    let covered = rules.find((r) => r.hard) ?? null;
    if (!covered && rules.length) {
      const started = Date.now();
      try {
        const check = await coveredBy(this.settings.model, rules, d.text ?? `the template "${d.template?.name}"`);
        this.settings.emit(this.id, "model.call", { ms: Date.now() - started, toolCalls: ["decide"], usage: check.usage, purpose: "no-contact check", ...(check.model ? { model: check.model } : {}) });
        covered = check.rule;
      } catch (error) {
        // Not knowing whether a rule covers it, nothing is sent, and the person hears nothing of it.
        this.settings.emit(this.id, "model.error", { ...modelError(error), purpose: "no-contact check" });
        return settle("failed", `their no-contact rules could not be checked: ${errorText(error)}`);
      }
    }
    if (covered) return settle("dropped", `no-contact rule ${covered.id}: ${covered.rule}`);
    // The business started it: its link goes as a button, and no preview leads the notification.
    // The same key in every process, so the channel's provider sends it once.
    const idempotencyKey = d.nudge ? `nudge:${d.nudge}` : d.run ? `run:${d.run}` : `inbox:${this.id}:${d.inbox}`;
    const outbound: Outbound = d.template ? { type: "template", ...d.template, idempotencyKey } : fitMessage(link.info, { type: "message" as const, text: d.text ?? "", ...(d.link ? { link: d.link } : {}), preview: false as const, idempotencyKey });
    const result = await this.sendMessage(d.channel, outbound, "direct", link);
    if ("refused" in result) return settle("refused", result.refused);
    if ("failure" in result) return settle("failed", result.failure);
    const sent = result.sent;
    if (sent.type === "template") {
      // A declared template's text, so the agent knows what the person read (and tapped a reply to).
      const declared = declaredTemplate(this.settings.templates, sent);
      let reads = "";
      try {
        if (declared) reads = ` It reads:\n${fillTemplate(declared, sent).body}`;
      } catch {}
      this.history.push({ role: "user", content: `[Chinwag] The business sent them its template "${sent.name}" on ${d.channel}.${reads}` });
    } else {
      const callId = `direct_${d.inbox ?? Date.now()}`;
      this.history.push({ role: "user", content: `[Chinwag] The business sent them this message through you on ${d.channel}, as written:` });
      this.history.push({ role: "assistant", content: null, toolCalls: [{ id: callId, name: sendToolName(d.channel), arguments: JSON.stringify(sentArgs(sent)) }] });
      this.history.push({ role: "tool", toolCallId: callId, content: JSON.stringify({ delivered: true, channel: d.channel, ...this.ownId(d.channel, result.receipt) }) });
    }
    this.settings.emit(this.id, "message.out", { ...outDetail(sent), channel: d.channel, direct: true, ...idDetail(result.receipt) });
    settle("sent", undefined, result.receipt?.messageId);
  }

  private async directSettled(d: Direct): Promise<boolean> {
    const { store } = this.settings;
    if (d.nudge) {
      const status = (await store.nudge(d.nudge))?.status;
      return status !== undefined && !["queued", "held", "scheduled"].includes(status);
    }
    if (d.run && d.schedule) {
      const outcome = (await store.runs(d.schedule)).find((r) => r.id === d.run)?.outcome;
      return outcome !== undefined && outcome !== "queued" && outcome !== "held";
    }
    return false;
  }

  /**
   * The history the model is sent: what comes after the latest reset marker (agent.resetHistory),
   * all of it while it fits the budget, else the latest entries that do, from the start of one
   * (never between a call and its result), after a line that says older ones are left out. The
   * latest turn always goes, however long, and so do the person's messages a reset came after
   * before anything was sent back.
   */
  private window(system: string, specs: ToolSpec[]): ChatMessage[] {
    const all = this.history.map(forModel);
    const from = this.resetFrom();
    let room = this.settings.historyTokens - tokens(system) - tokens(JSON.stringify(specs)) - tokens(EARLIER);
    let start = all.length;
    for (let i = all.length - 1; i >= from; i--) {
      room -= size(all[i]);
      if (room < 0) break;
      if (all[i].role === "user") start = i;
    }
    if (room >= 0) start = from;
    else if (start === all.length) start = Math.max(from, all.findLastIndex((m) => m.role === "user"));
    if (start !== this.leftOut) {
      this.leftOut = start;
      if (start > from) this.settings.emit(this.id, "history.trimmed", { leftOut: start - from, kept: all.length - start });
    }
    return start > from ? [{ role: "user", content: EARLIER }, ...all.slice(start)] : all.slice(from);
  }

  /**
   * Where the model's history starts: the latest reset marker, or before it the person's messages
   * it came after with nothing sent back, or this turn's start when the marker came during it.
   */
  private resetFrom(): number {
    const marker = this.history.findLastIndex((e) => e.role === "user" && e.reset === true);
    if (marker < 0) return 0;
    const only = [...this.channels.keys()][0] ?? "chat";
    let from = marker;
    for (let i = marker - 1; i >= 0; i--) {
      const e = this.history[i];
      if (e.role === "assistant" && e.toolCalls?.some((c) => c.name.startsWith("send_"))) break;
      if (e.role === "user" && e.reset) break;
      if (e.role === "user" && personMessages(e, only).length) from = i;
    }
    return marker >= this.turnFrom ? Math.min(from, this.turnFrom) : from;
  }

  /** A tool result as the history keeps it: cut at toolResultChars, saying so. */
  private capped(text: string): string {
    const max = this.settings.toolResultChars;
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n[Chinwag] Cut: the result was ${text.length} characters; only the first ${max} are shown.`;
  }

  /** The send tools the agent has right now, for Flow Framework's notes: "send_sms", or "send_sms or send_app". */
  private sendToolsNow(): string {
    return [...this.channels.keys()].map((c) => sendToolName(c)).join(" or ");
  }

  /**
   * Run a response's tool calls together and wait for all of them, except: a message from the
   * person ends the wait, a finished result waits at most partialAfterMs for the others, and a tool
   * past its limit stops holding the reply. Whatever is still running then moves to the background.
   */
  private async runTools(calls: ToolCall[]): Promise<{ results: string[]; finished: number }> {
    const results: Array<string | undefined> = [];
    let finished = 0;
    const live: Array<{ i: number; r: Running }> = [];
    calls.forEach((call, i) => {
      const started = this.start(call);
      if (typeof started === "string") results[i] = started;
      else live.push({ i, r: started });
    });
    // Authentication is a prerequisite, never a detached background operation.
    await Promise.all(live.map(({ r }) => r.authorized));
    await Promise.all(live.filter(({ r }) => this.authBlocked.has(r.call.id)).map(({ r }) => r.outcome));
    let firstDoneAt: number | null = null;
    for (;;) {
      for (const { i, r } of live) {
        if (!r.result || results[i] !== undefined) continue;
        results[i] = r.result.text;
        finished++;
        firstDoneAt ??= Date.now();
        this.settings.emit(this.id, "tool.end", { callId: r.call.id, tool: r.call.name, ms: Date.now() - r.startedAt, ok: r.result.ok, inline: true, output: clipOutput(r.result.text) });
      }
      const open = live.filter(({ i }) => results[i] === undefined);
      if (!open.length) break;
      if (this.closed) {
        for (const { i } of open) results[i] = "";
        break;
      }
      const now = Date.now();
      const all: Detach | null = this.unread() ? "message" : firstDoneAt !== null && now - firstDoneAt >= this.settings.partialAfterMs ? "partial" : null;
      if (all) {
        for (const { i, r } of open) results[i] = this.detach(r, all);
        break;
      }
      const late = open.filter(({ r }) => now - r.startedAt >= r.limitMs);
      for (const { i, r } of late) results[i] = this.detach(r, "limit");
      if (late.length) continue;
      const wakeAt = Math.min(...open.map(({ r }) => r.startedAt + r.limitMs), firstDoneAt === null ? Infinity : firstDoneAt + this.settings.partialAfterMs);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(wake, Math.max(0, wakeAt - Date.now()));
        function wake() {
          clearTimeout(timer);
          resolve();
        }
        this.wakeTools = wake;
        for (const { r } of open) void r.outcome.then(wake);
      });
      this.wakeTools = null;
    }
    return { results: results as string[], finished };
  }

  /** Start one tool call; the model's input is checked first (a refusal is the call's result). */
  private start(call: ToolCall): Running | string {
    const tool = this.builtins.get(call.name) ?? this.settings.tools.get(call.name);
    if (!tool) return `There is no tool named ${call.name}.`;
    let raw: unknown;
    try {
      raw = JSON.parse(call.arguments || "{}");
    } catch {
      return "The arguments were not valid JSON.";
    }
    const parsed = tool.input.safeParse(raw);
    if (!parsed.success) return `Invalid input: ${parsed.error.message}`;

    // The same call while it is still running in the background is not run again: its result is coming.
    const input = stableJson(parsed.data);
    const running = [...this.tasks.values()].find((t) => t.tool === call.name && t.input === input);
    if (running) {
      this.settings.emit(this.id, "tool.repeated", { callId: call.id, tool: call.name, task: running.id });
      return `[Chinwag] Not run: ${call.name} with this input is already running in the background (${running.id}). Its result will come to you here; don't call it again.`;
    }

    this.settings.emit(this.id, "tool.start", { callId: call.id, tool: call.name, input: parsed.data });
    const key = createHash("sha256").update(`${this.id}\u0000${this.turns}\u0000${call.name}\u0000${input}`).digest("hex").slice(0, 32);
    // The agent's events side as it is now (attach() may come after createAgent), only when there is one.
    const events = this.settings.events?.();
    const identityContext = { conversationId: this.id, person: this.personKey, key: this.personKey.startsWith("key:") ? this.personKey.slice(4) : null, channel: this.currentChannel(), address: this.channels.get(this.currentChannel())?.address, callId: call.id, idempotencyKey: key, signal: this.lifetime.signal, records: this.records, wakeUps: this.wakeUps, ...(events ? { events } : {}) };
    const credentials = this.settings.credentialProvider?.(identityContext) ?? this.settings.credentials;
    let context = toolContext(identityContext, credentials);
    let authorize!: () => void;
    const authorized = new Promise<void>(resolve => { authorize = resolve; });
    const r: Running = {
      call,
      input,
      startedAt: Date.now(),
      limitMs: tool.deadlineMs ?? this.settings.deadlineMs,
      authorized,
      outcome: Promise.resolve()
        .then(async () => {
          try {
            const auth = this.settings.auth;
            const signIn = tool.signIn ?? (this.builtins.has(call.name) ? "none" : "required");
            if (auth && signIn !== "none") {
              const identity: ChatAuthContext = Object.freeze({ conversationId: this.id, person: context.person, key: context.key, channel: context.channel, address: this.channels.get(context.channel)?.address ?? "", tool: call.name, signal: this.lifetime.signal });
              let verified = !!context.key;
              if (verified && auth.verify) {
                try { verified = await this.authentication(() => auth.verify!(identity)); }
                catch { verified = false; }
              }
              if (this.closed) return { error: "conversation_closed" };
              if (!verified && signIn === "required") {
                this.authBlocked.add(call.id);
                if (!this.signInPrompts.has(context.channel)) {
                  const prompt = this.authentication(() => auth.signIn(identity)).then((challenge) => {
                    if (!challenge.message?.trim()) throw new Error("Empty sign-in challenge");
                    if (challenge.url) {
                      const url = new URL(challenge.url);
                      if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Unsafe sign-in URL");
                    }
                    return challenge;
                  }).catch(() => ({ message: "I couldn't start sign-in. Please try again." }));
                  this.signInPrompts.set(context.channel, prompt);
                }
                this.settings.emit(this.id, "auth.required", { tool: call.name, channel: context.channel });
                return { error: "sign_in_required", executed: false };
              }
              if (!verified) context = toolContext({ ...context, key: null, person: `${context.channel}:${identity.address}` }, credentials);
            }
            if (this.closed) return { error: "conversation_closed" };
            return tool.run(parsed.data, context);
          } finally { r.startedAt = Date.now(); authorize(); }
        })
        .then(
          // TODO: benchmark a tool's `format` (Markdown) against this JSON for chat agents (tokens per
          // turn, and whether the next call still finds its ids) before chats use it. Here the
          // output is not checked against `output`, which `format` relies on.
          (output) => ({ ok: true, text: render(output) }),
          (error) => ({ ok: false, text: `Failed: ${error instanceof Error ? error.message : String(error)}` }),
        ),
    };
    void r.outcome.then((result) => (r.result = result));
    return r;
  }

  /** A failed or unresponsive auth service cannot leave a protected call hanging or let it execute. */
  private async authentication<T>(work: () => T | Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Sign-in timed out")), 15_000); })]); }
    finally { clearTimeout(timer!); }
  }

  /** A login request is a real channel message, recorded as delivered, without another model call. */
  private async sendSignIn(channel: string, prompt: { message: string; url?: string }): Promise<void> {
    const link = this.channels.get(channel);
    if (!link) return;
    const outbound = fitMessage(link.info, { type: "message" as const, text: prompt.message, authentication: true, ...(prompt.url ? { link: { label: "Sign in", url: prompt.url } } : {}) });
    const result = await this.sendMessage(channel, outbound, "framework", link);
    if (!("sent" in result)) { this.undelivered(prompt.message, "refused" in result ? result.refused : result.failure); return; }
    const sent = result.sent as Extract<Outbound, { type: "message" | "carousel" }>;
    const callId = `auth_${randomUUID()}`;
    this.history.push({ role: "assistant", content: null, toolCalls: [{ id: callId, name: sendToolName(channel), arguments: JSON.stringify(sentArgs(sent)) }] });
    this.history.push({ role: "tool", toolCallId: callId, content: JSON.stringify({ delivered: true, channel, authentication: true }) });
    this.settings.emit(this.id, "message.out", { ...outDetail(sent), channel, authentication: true, ...idDetail(result.receipt) });
    this.sent();
    this.sentThisTurn.add(prompt.message.trim());
    await this.acknowledged(channel);
  }

  /** The reply stops waiting for this tool: it carries on in the background and its result comes back as a note. */
  private detach(r: Running, why: Detach): string {
    const { call, startedAt } = r;
    const task: Task = { id: `task_${++this.taskCount}`, tool: call.name, input: r.input, startedAt };
    this.tasks.set(task.id, task);
    this.persist(() => this.settings.store.addTask(this.id, task.id, call.id, call.name, startedAt));
    this.settings.emit(this.id, "tool.detached", { callId: call.id, tool: call.name, task: task.id, ms: Date.now() - startedAt, why });
    void r.outcome.then((result) => {
      this.tasks.delete(task.id);
      this.persist(() => this.settings.store.removeTask(this.id, task.id));
      this.settings.emit(this.id, "task.done", { callId: call.id, tool: call.name, task: task.id, ms: Date.now() - startedAt, ok: result.ok, output: clipOutput(result.text) });
      this.note(`[Background result: ${call.name} (${task.id})] ${this.capped(result.text)}\n[Chinwag] They have not seen this result: tell them with ${this.sendToolsNow()}.`);
      this.checkIdle();
    });
    return (
      `[Chinwag] ${call.name} started and is still running in the background (${task.id}). Do not call ${call.name} again: ` +
      `its result will come to you here when it finishes. Until then don't tell them it is done; when it arrives, tell them with ${this.sendToolsNow()}.` +
      (why === "partial" ? " The other results are in: tell them this now only if it answers what they asked; the rest is coming." : "")
    );
  }
}

/** The business may not message first on this channel now (WhatsApp, past 24 hours). */
export function windowClosed(link: { info: ChannelInfo; lastMessageAt: number | null }, now: number): boolean {
  const hours = link.info.replyWindowHours;
  if (!hours) return false;
  return link.lastMessageAt === null || now - link.lastMessageAt > hours * 3_600_000;
}

/** One line of a conversation as the person saw it, read back from the history (the playground shows these). */
export type TranscriptEntry =
  | { kind: "in"; channel: string; id: string; text: string; at: number; choice?: boolean; choiceId?: string }
  | {
      kind: "out";
      channel: string;
      text: string;
      authentication?: boolean;
      at: number;
      replyTo?: string;
      buttons?: ReplyButton[];
      list?: { button: string; rows: Array<{ id: string; title: string; description?: string }> };
      /** As the agent sent them: fitMessage shows them as a channel can. */
      link?: { label: string; url: string };
      image?: Photo;
      /** A carousel's cards; its text is `text`. */
      carousel?: CarouselCard[];
      /** The channel's own params the agent filled in. */
      fields?: Record<string, unknown>;
      /** A WhatsApp template the business sent, by name; the text is its body when it was declared. */
      template?: string;
      /** The platform's id for it, on channels where the agent can edit or unsend it. */
      messageId?: string;
    }
  | { kind: "reaction"; channel: string; messageId: string; emoji: string; at: number }
  /** The agent changed the text of its message `messageId` to `text` (edit_message). */
  | { kind: "edit"; channel: string; messageId: string; text: string; at: number }
  /** The agent took back its message `messageId` (unsend_message). */
  | { kind: "unsend"; channel: string; messageId: string; at: number }
  | { kind: "tool"; callId: string; tool: string; input: unknown; output: string; ok: boolean; at: number };

const SEND_KEYS = new Set(["text", "reply_to", "buttons", "list", "link", "image", "carousel", "confirm"]);

/**
 * The history as the person saw it: their messages (with their ids and channels), what the agent
 * delivered with its send tools and reactions, its edits and unsends, and its other tool calls with their results.
 * Flow Framework's notes and the agent's plain text never reached the person and are left out. `only` is
 * the channel of untagged messages (an agent with one channel does not tag them).
 */
export function transcriptOf(history: Array<{ entry: ChatMessage; at: number }>, only: string): TranscriptEntry[] {
  const lines: TranscriptEntry[] = [];
  const results = new Map<string, { content: string; at: number }>();
  for (const { entry, at } of history) if (entry.role === "tool") results.set(entry.toolCallId, { content: entry.content, at });
  const channelOf = new Map<string, string>();
  for (const { entry, at } of history) {
    if (entry.role === "user") {
      const template = /^\[Chinwag\] The business sent them its template "(.*)" on ([\w-]+)\.(?: It reads:\n([\s\S]*))?$/.exec(entry.content);
      if (template) {
        lines.push({ kind: "out", channel: template[2], text: template[3] ?? "", at, template: template[1] });
        continue;
      }
      for (const m of personMessages(entry, only)) {
        channelOf.set(m.id, m.channel);
        lines.push({ kind: "in", channel: m.channel, id: m.id, text: m.text, at, ...(m.choice ? { choice: true } : {}), ...(m.choiceId ? { choiceId: m.choiceId } : {}) });
      }
      continue;
    }
    if (entry.role !== "assistant") continue;
    for (const call of entry.toolCalls ?? []) {
      const result = results.get(call.id);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.arguments || "{}");
      } catch {}
      if (call.name.startsWith("send_")) {
        let delivered: { delivered?: boolean; channel?: string; authentication?: boolean; sent?: Record<string, unknown>; message_id?: string } = {};
        try {
          delivered = JSON.parse(result?.content ?? "");
        } catch {}
        if (!delivered.delivered || !delivered.channel) continue;
        // beforeSend changed it: what went, not what the agent wrote.
        if (delivered.sent && typeof delivered.sent === "object") args = delivered.sent;
        const fields = Object.fromEntries(Object.entries(args).filter(([k, v]) => !SEND_KEYS.has(k) && v !== undefined && v !== null && v !== ""));
        lines.push({
          kind: "out",
          channel: delivered.channel,
          text: String(args.text ?? ""),
          ...(delivered.authentication ? { authentication: true } : {}),
          at: result!.at,
          ...(typeof args.reply_to === "string" ? { replyTo: args.reply_to } : {}),
          ...(Array.isArray(args.buttons) && args.buttons.length ? { buttons: args.buttons as ReplyButton[] } : {}),
          ...(args.list ? { list: args.list as never } : {}),
          ...(args.link ? { link: args.link as never } : {}),
          ...(args.image ? { image: photoOf(args.image as never) } : {}),
          ...(Array.isArray(args.carousel) ? { carousel: cardsOf(args.carousel as never) } : {}),
          ...(Object.keys(fields).length ? { fields } : {}),
          ...(typeof delivered.message_id === "string" ? { messageId: delivered.message_id } : {}),
        });
      } else if (call.name === EDIT || call.name === UNSEND) {
        let done: { edited?: boolean; unsent?: boolean; channel?: string; message_id?: string; text?: string } = {};
        try {
          done = JSON.parse(result?.content ?? "");
        } catch {}
        if (!done.channel || !done.message_id) continue;
        if (done.edited) lines.push({ kind: "edit", channel: done.channel, messageId: done.message_id, text: done.text ?? String(args.text ?? ""), at: result!.at });
        else if (done.unsent) lines.push({ kind: "unsend", channel: done.channel, messageId: done.message_id, at: result!.at });
      } else if (call.name === REACT) {
        const channel = channelOf.get(String(args.message_id));
        if (result?.content === "" && channel) lines.push({ kind: "reaction", channel, messageId: String(args.message_id), emoji: String(args.emoji), at: result.at });
      } else if (call.name !== UPDATE && result) {
        lines.push({ kind: "tool", callId: call.id, tool: call.name, input: args, output: result.content, ok: !result.content.startsWith("Failed:"), at: result.at });
      }
    }
  }
  return lines;
}

/**
 * How a message from the person reads to the agent, after its id: "[m5] text", with any quote or
 * tap, and its files marked before the text: "[m5] [photo] is this ripe?".
 */
function describe(incoming: Incoming, files?: Files): string {
  const parts: string[] = [];
  if (incoming.replyTo) parts.push(`, replying to ${incoming.replyTo.fromAgent ? "your" : "their own"} message "${clip(incoming.replyTo.text)}"`);
  if (incoming.choice) {
    const id = tappedId(incoming);
    return `${parts.join("")}, tapped] ${incoming.choice.title}${id ? ` (${id})` : ""}`;
  }
  const body = [files?.marks.join(" "), files?.transcript, incoming.text].filter(Boolean).join(" ");
  return `${parts.join("")}] ${body}`;
}

/** The id of what they tapped, when it is not its label. */
function tappedId(incoming: Incoming): string | undefined {
  const id = incoming.choice?.id;
  return id && id !== incoming.choice!.title ? id : undefined;
}

/** A tap, as a pending message keeps it. */
function choiceOf(incoming: Incoming): { choice?: true; choiceId?: string } {
  if (!incoming.choice) return {};
  const id = tappedId(incoming);
  return { choice: true, ...(id ? { choiceId: id } : {}) };
}

/** What the person wrote, as the transcript shows it: the tap, or the files' marks and the text. */
function shownText(incoming: Incoming, files: Files): string {
  if (incoming.choice) return incoming.choice.title;
  return [files.marks.join(" "), files.transcript, incoming.text].filter(Boolean).join(" ");
}

/**
 * The person's messages in a history entry: kept beside it, or (in entries stored before they
 * were) read back from the text, where only Flow Framework's own m1, m2, ... ids can be told apart.
 */
function personMessages(entry: Extract<ChatMessage, { role: "user" }>, only: string): PersonMessage[] {
  if (entry.messages) return entry.messages;
  const starts = [...entry.content.matchAll(/^\[(?:([\w-]+) · )?(m\d+)(?=[,\]])/gm)];
  return starts.map((m, i) => {
    const rest = entry.content.slice(m.index! + m[0].length, i + 1 < starts.length ? starts[i + 1].index! - 1 : undefined);
    const tapped = rest.indexOf(", tapped] ");
    const text = rest.startsWith("] ") ? rest.slice(2) : tapped >= 0 ? rest.slice(tapped + 10) : rest.slice(rest.indexOf('"] ') + 3);
    return { id: m[2], channel: m[1] ?? only, text, ...(tapped >= 0 ? { choice: true } : {}) };
  });
}

/** About how many tokens a text is (a little over, for safety: 3 characters a token). */
function tokens(text: string | null | undefined): number {
  return Math.ceil((text?.length ?? 0) / 3);
}

/** About how many tokens a history entry takes, a photo or PDF shown counted as 1,500. */
function size(entry: ChatMessage): number {
  if (entry.role === "assistant") return tokens(entry.content) + tokens(JSON.stringify(entry.toolCalls ?? []));
  if (entry.role === "tool") return tokens(entry.content);
  return tokens(entry.content) + (entry.media?.filter((m) => m.data).length ?? 0) * 1_500;
}

/** A photo or PDF as it is stored: named, without its bytes. */
function stored(media: Media): Media {
  const { data: _bytes, ...rest } = media;
  return rest;
}

/** A history entry as the model is sent it: media no longer shown are taken off, and it is told. */
function forModel(entry: ChatMessage): ChatMessage {
  if (entry.role !== "user") return entry;
  if (!entry.media) return { role: "user", content: entry.content };
  const shown = entry.media.filter((m) => m.data);
  if (shown.length === entry.media.length) return { role: "user", content: entry.content, media: entry.media };
  return { role: "user", content: `${entry.content}\n${NOT_SHOWN}`, ...(shown.length ? { media: shown } : {}) };
}

/** A tool's output as events carry it: whole up to 4,000 characters (for debugging and observability). */
function clipOutput(text: string): string {
  return text.length > 4_000 ? `${text.slice(0, 4_000)}…` : text;
}

/** A sent message or carousel as its `message.out` event tells it. */
/** The platform's id for a sent message, on its message.out event, when the channel gave one. */
function idDetail(receipt?: SendReceipt): { messageId?: string } {
  return receipt?.messageId ? { messageId: receipt.messageId } : {};
}

function outDetail(sent: OutboundMessage): Record<string, unknown> {
  if (sent.type === "template") return { text: sent.name, template: true };
  if (sent.type === "carousel") return { text: sent.text, carousel: sent.cards, replyTo: sent.replyTo };
  return { text: sent.text, buttons: sent.buttons, list: sent.list, link: sent.link, image: sent.image, replyTo: sent.replyTo, ...(sent.fields ? { fields: sent.fields } : {}), ...(sent.authentication ? { authentication: true } : {}) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A model.error event's details: the error, and the code and HTTP status it carries (Flow's typed errors, a provider's APIError). */
function modelError(error: unknown): { error: string; code?: string; status?: number } {
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  return { error: String(error), ...(typeof code === "string" && code ? { code } : {}), ...(typeof status === "number" ? { status } : {}) };
}

function clip(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

/** JSON with object keys sorted, so the same input always reads the same. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
}

/**
 * The time, for every turn: in their zone when the business or the person gave it, else in the
 * business's, saying theirs is not known (never guessed from the business's).
 */
export function nowLine(now: number, personZone: string | null, agentZone: string | undefined): string {
  if (personZone) return `[Chinwag] It is now ${formatLocal(personZone, now)}, their time.`;
  return `[Chinwag] It is now ${formatLocal(agentZone ?? "UTC", now)}, the business's time. Their time zone is not known: ask where they are before anything that depends on their local time.`;
}

export const PROFILE_TOOL = "get_user_profile";

/** The built-in tool over createAgent's `profile`: no input, so it is always about the person in this conversation. */
export function profileTool(profile: Profile): Tool {
  return tool({
    name: PROFILE_TOOL,
    description: "This person's profile from the business: who they are and what the business knows about them. Call it when you need it; it is always about the person you are talking to.",
    input: z.object({}),
    run: (_input, context) => profile({ conversationId: context.conversationId, person: context.person, channel: context.channel }),
  });
}

/** createAgent's `profile`: what the business knows about the person, fetched only when the agent asks. */
export type Profile = (who: { conversationId: string; person: string; channel: string }) => Promise<unknown> | unknown;
