// An agent: instructions, skills and tools, and one Conversation per person, across every channel
// they write on. Channels hand it messages; it says whether anything is running, so a host can stop
// it when it is idle. Its state lives in a database (in memory unless one is given), so a restart
// carries on where it stopped.
//
// Who a person is gets fixed when their message arrives, from what the channel verified, never
// from anything the model or a tool says: the owner's own key from `resolve`, else the phone
// number of a phone channel (SMS, WhatsApp, iMessage verify it), else that channel's address alone.
// Identities with the same key are one person in one conversation.
//
// Test people, declared in `testPeople`, can also write from the test playground (`simulate`), a
// different phone for the same person: same identity, history, lookups and schedules. Each identity
// remembers whether its latest message came from the playground or the channel's provider, and
// every send to it (replies, scheduled messages, nudges) goes back the same way.

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { declaredTemplate, fillTemplate, keywordOf, summarize, type Channel, type ChannelSummary, type Keywords } from "./channels.ts";
import { Conversation, PROFILE_TOOL, profileTool, resetLine, signInNotice, transcriptOf, windowClosed, type ChannelLink, type ConversationSettings, type Profile, type TranscriptEntry } from "./conversation.ts";
import { sqlite, type Database } from "./db.ts";
import { emitter, type EventSink } from "./events.ts";
import { businessSchedule, claimDue, summary } from "./schedules.ts";
import type { MediaStore } from "./media.ts";
import { loadInstructions, loadSkills, readAgentFolder, skillTool, type AgentFiles } from "./skills.ts";
import { Store, type ConversationRow, type EventStateStore, type IdentityRow, type NudgeRow, type QuietHours, type StoreApi, type TimeZoneSource, type Via } from "./store.ts";
import { clock, quietUntil, validZone } from "./time.ts";
import { STAND_IN, toSpec, type ChatAuth, type CredentialProvider, type Tool } from "./tools.ts";
import { traces, tracesFromEnv, type Traces, type TracesOptions } from "./traces.ts";
import type { BeforeSend, ChannelInfo, Deliver, Incoming, Model, Outbound, Template, TemplateDefinition, Transcribe } from "./types.ts";

/** What a host supplies to an agent: `createAgent({ ..., host })`. */
export interface HostOptions {
  files?: AgentFiles;
  database?: Database;
  store?: StoreApi;
  scheduleCheckMs?: number;
  /** A Flow Messaging client (`flowMessaging()` from @flow-engineer/flow/flow-messaging). */
  messaging?: { channels(options?: { except?: string[] }): Channel[] };
}

/** The agent's options with what its host supplies in place of its own. */
function withHost(options: AgentOptions): AgentOptions {
  const host = options.host;
  if (!host) return options;
  const declared = options.channels ?? [];
  return {
    ...options,
    ...(host.files ? { dir: undefined, files: host.files } : {}),
    ...(host.store ? { store: host.store, database: undefined, id: undefined } : host.database ? { database: host.database, store: undefined } : {}),
    ...(host.scheduleCheckMs !== undefined ? { scheduleCheckMs: host.scheduleCheckMs } : {}),
    channels: [...declared, ...(host.messaging?.channels({ except: declared.map((c) => c.name) }) ?? [])],
  };
}

export interface AgentOptions {
  /** Folder holding AGENTS.md and skills/<name>/SKILL.md. Give this or `files`. */
  dir?: string;
  /** That folder's files as text, by path ("AGENTS.md", "skills/<name>/SKILL.md"), for hosts with no file system. */
  files?: AgentFiles;
  model: Model;
  /**
   * Speech to text for voice notes, with the provider you choose: the agent reads the transcript,
   * marked as a voice note. Without it, it is told a voice note came that it can't listen to.
   */
  transcribe?: Transcribe;
  /**
   * Where files are kept (your storage, or `flowMedia()` for Flow's): what the web chat needs to take
   * a person's photos, PDFs and voice notes. Without it, nothing is kept and the web chat refuses files.
   */
  media?: MediaStore;
  tools?: Tool[];
  /** Backend credentials or clients for a verified person, available only to tool code as context.credentials. */
  credentials?: CredentialProvider;
  /** Enforce per-tool signIn in chat and send the brand's login challenge when needed. */
  auth?: ChatAuth;
  /**
   * Added to the system prompt at the start of every turn, before the model is called: keep it to
   * small facts at hand. It runs on every turn, so a lookup here (an API call, a slow query) delays
   * every reply; give the agent `profile` or a tool for those, which it calls only when it needs them.
   */
  context?: (conversationId: string) => Promise<string> | string;
  /**
   * What the business knows about the person (their account, plan, preferences), as the built-in
   * tool get_user_profile: no input, always about the person in the conversation, and run only when
   * the agent calls it. A tool of yours with that name is used instead.
   */
  profile?: Profile;
  /**
   * Answer some messages without the model: return the reply, "" to send nothing, or null to let
   * the agent reply. `message.channel` is the channel it came in on, by the name in `channels`
   * ("chat" from receive() without a `channelName`). It sees a channel's STOP, START and HELP
   * first, with `message.keyword` set (null for other messages), to keep its own state; Flow Framework
   * still keeps or lifts the STOP whatever it returns or throws, and sends its own reply unless
   * this returns one. The message and the reply are kept in the history (the agent reads them at
   * its next turn) and the transcript, and are `message.in` and `message.out` events marked
   * `answered: true`.
   */
  intercept?: (conversationId: string, text: string, message: { keyword: Keyword | null; channel: string }) => string | null;
  /**
   * Put every skill's full text in the prompt instead of loading skills on demand. Saves a model
   * round trip per skill; worth it when the skills are few and short.
   */
  inlineSkills?: boolean;
  /**
   * Live status lines (share_updates) on channels that can show them, web and app UIs. Default on;
   * pass a string to replace Flow Framework's guidance on when and what to share.
   */
  shareUpdates?: boolean | string;
  /**
   * The longest a reply waits for a tool that sets no `deadlineMs` of its own; past it the tool
   * moves to the background. Default 60,000 ms. Before that, the reply waits for all of a
   * response's tools unless the person writes again or `partialAfterMs` passes.
   */
  deadlineMs?: number;
  /** When one tool of a response is done and the others are still running this long after, the finished results go back to the agent. Default 5,000 ms. */
  partialAfterMs?: number;
  /** Quiet time after a message before the reply starts, to catch quick bursts. Default 300 ms. */
  debounceMs?: number;
  maxSteps?: number;
  /**
   * How much of a long conversation each model call carries. The latest messages are kept, older
   * ones are left out (the agent is told so). `maxTokens` is the whole call's budget, roughly: default
   * 24,000, or 60% of the model's `contextTokens` when that is less. A tool result is cut to
   * `toolResultChars` characters (default 12,000). `agent.resetHistory` starts it again from a point.
   */
  history?: { maxTokens?: number; toolResultChars?: number };
  events?: EventSink[];
  /** This agent's id in the database (several agents can share one). Default "default". */
  id?: string;
  /** Where Flow Framework keeps its state. Default: SQLite in memory (gone on restart). */
  database?: Database;
  /**
   * Instead of `database`: a store that keeps the state elsewhere, such as a client of a store
   * service that holds the database, so this process never holds its credentials. `id` is then
   * the store's to know.
   */
  store?: StoreApi;
  /** The channels people reach the agent on: whatsapp(...), sms(...), customUI(...), each with its own name. */
  channels?: Channel[];
  /**
   * The owner's own key for a person (a member id), from a channel identity, or null when there is
   * none. Identities with the same key are one person. `phone` is normalized and present only
   * when this channel verifies phone identities; an arbitrary address is never phone evidence.
   */
  resolve?: (identity: { channel: string; address: string; phone?: string }) => Promise<string | null> | string | null;
  /**
   * The calling code ("+91", "+44", "+1") for phone numbers that come without one. Set it when
   * your SMS provider gives national numbers ("098765 43210"): on every phone channel but
   * WhatsApp (whose numbers are always full), a number with no "+" or "00" is then read as this
   * country's, its trunk 0 dropped (Italy's +39 keeps it), so it joins the same number on
   * WhatsApp. Without it, bare digits are taken as international.
   */
  defaultCountryCode?: string;
  /**
   * The template sent when a nudge meets someone's closed WhatsApp window and no other template fits
   * ("You have a new message"): the nudge is then held until they reply, and a `template.missing`
   * event says which message wanted a template of its own. Declare it in `templates`. Without it a
   * nudge outside the window is refused (outside_window), as before.
   */
  fallbackTemplate?: Template;
  /**
   * Checks, changes or refuses every message, carousel and template before it goes, on every
   * channel (the agent's sends, scheduled messages and nudges, Flow Framework's own replies): return
   * nothing to send it as it is, another message to send that instead, or `{ refuse: why }` to send
   * nothing. It runs before the platform's content rules (`contentRefusal`) and before anything is
   * recorded, so the events, the history, the transcript and the test cloud's judge see what went. A
   * refused send of the agent's goes back to it, with your reason, to fix; a scheduled message or
   * nudge it refuses is settled refused. Use it rather than wrapping a channel's send, which the
   * playground and the test cloud never call. `guards(...)` composes ready-made checks (oncePerChat,
   * noRepeats, linkAllowlist, noWriteButtons) with your own.
   */
  beforeSend?: BeforeSend;
  /**
   * Quiet hours in each person's own time ("22:00" to "07:00", the default), when what the business
   * starts waits: a nudge is held until they end (or the person writes), then the agent writes one
   * message for everything held. A person may set their own; `false` turns them off. They apply only
   * where the person's time zone is known: without it nothing is held.
   */
  quietHours?: QuietHours | false;
  /**
   * The business's time zone (IANA): the time the agent is told when the person's zone is not known,
   * and the time a business-started schedule is shown in. Never taken as the person's own: set
   * theirs with setTimeZone, or the agent asks them.
   */
  timeZone?: string;
  /** How often due scheduled messages are looked for. Default 5,000 ms; 0 turns the timer off. */
  scheduleCheckMs?: number;
  /**
   * How long a provider's message id is kept, so a webhook retried within it is taken once.
   * Older ones are deleted, hourly, by one runner, on the scheduled messages' timer. Default 7.
   */
  keepMessageIdsDays?: number;
  /** The clock (tests move it). */
  now?: () => number;
  /**
   * This process's name among the agent's runners (default FLOW_RUNNER, else the host's name),
   * with a random suffix so each process differs. It is on every event, and on a conversation's
   * lease: one runner works on a conversation at a time, even while two run on one database (a
   * deploy's overlap); a runner that dies mid-turn leaves it to another after 15 s.
   */
  runner?: string;
  /**
   * Work of your own that runs on the agent's clock: called (and awaited) each time due scheduled
   * messages are looked for (every `scheduleCheckMs`, and each `runDue()`), with the time now. A
   * test that moves the clock runs it at each step, so your own timers (held sends, reminders
   * timed from your data) follow the test's clock. An error is logged, never thrown.
   */
  onTick?: (now: number) => Promise<void> | void;
  /**
   * HTTP routes the agent serves beside its chat, by path ("/v1/events": a business's event push),
   * answered by `agent.fetch(request)`. The test cloud calls them in-process with a test's events.
   */
  routes?: Record<string, (request: Request) => Response | Promise<Response>>;
  /**
   * What the place running the agent supplies: Flow's hosting gives its `store` and its Flow Messaging
   * client, a host with no file system (Cloudflare) its `files` and `database`. Pass `buildAgent`'s
   * `options.host` here as it is. Each part it gives replaces the agent's own (`files` its `dir`, `store`
   * or `database` its database); `messaging` adds Flow's channels (`channels()`) the agent does not declare.
   */
  host?: HostOptions;
  /**
   * The people who may write from the test playground (`simulate`), and no one else. Each is a
   * real person to the agent, by their phone number: the same conversation whether they write from
   * the playground or, once a channel is live, from the provider.
   */
  testPeople?: TestPerson[];
  /**
   * The WhatsApp templates the owner set up with Meta. A nudge with one of them is checked against
   * it before it goes (values that don't fit throw), the agent is told what it said, and the
   * playground shows it as WhatsApp would. A template not declared here is sent as it is.
   */
  templates?: TemplateDefinition[];
  /**
   * Send every turn to a traces endpoint as a trace. Default: from the environment, on when
   * FLOW_FRAMEWORK_TRACES_KEY is set (address FLOW_FRAMEWORK_TRACES_URL, else https://flow.engineer/observe; FLOW_FRAMEWORK_TRACES_CONTENT=1 for content),
   * never under `node --test`.
   */
  traces?: TracesOptions;
}

export interface TestPerson {
  name: string;
  /** Their phone number; on channels that are not phone channels they are `test:<number>`. */
  phone: string;
}

/** Where the playground shows what the agent sends to a test person who wrote from it. */
export type PlaygroundSink = (delivery: { conversationId: string; person: TestPerson & { key?: string; visitor?: string }; channel: string; outbound: Outbound }) => Promise<void> | void;

export interface AgentStatus {
  busy: boolean;
  /** Milliseconds since the last thing ran anywhere; 0 while busy. */
  idleForMs: number;
  conversations: number;
  backgroundTasks: number;
}

export interface ReceiveOptions {
  /** What the channel can show. Default: plain text only (no reactions, no status). */
  channel?: ChannelInfo;
  /** The channel's own id for the message; Flow Framework makes one (m1, m2, ...) otherwise. */
  messageId?: string;
  /** The channel's name. Default "chat". */
  channelName?: string;
}

export interface NudgeInput {
  /** The person, by a channel identity they have written from. */
  to: { channel: string; address: string };
  /** Sent as written, with no model call. */
  text?: string;
  /** With `text`: its call to action, sent as a link button (on channels without one, the URL after the text). Never a URL in the text. */
  link?: { label: string; url: string };
  /** The agent gets a turn with this note and writes the message itself, or sends nothing. */
  prompt?: string;
  /** A template the owner already set up with the channel, sent as is (also outside WhatsApp's window). */
  template?: Template;
  /** Send it later, at this time (ms since the epoch), as a scheduled message. */
  at?: number;
  /** The same key twice sends once, also when both calls come at once: the second gets the first's result. */
  idempotencyKey?: string;
  /** Wait for the end of their quiet hours (default true); false sends it now, quiet hours or not. */
  respectQuietHours?: boolean;
  /** A nudge held for quiet hours past this (ms since the epoch; default 24 hours on) is dropped as expired. */
  expiresAt?: number;
}

export interface NudgeResult {
  id: string;
  /**
   * sent; silent (the agent chose not to); dropped (a no-contact rule, or their STOP); refused
   * (outside_window, unknown_person); failed (it could not be sent, or the model failed: `reason`
   * says why, and the person was sent nothing about it); scheduled; held (for their quiet hours,
   * until they end or the person writes); or expired (held past its expiresAt, never sent).
   */
  status: NudgeStatus;
  reason?: string;
}

export type NudgeStatus = "sent" | "silent" | "dropped" | "refused" | "failed" | "scheduled" | "held" | "expired";

/** A scheduled message, as the playground lists it. */
export interface ScheduledItem {
  id: string;
  message: string;
  origin: "person" | "business";
  mode: "message" | "check";
  nextRunAt: number | null;
  timeZone: string;
  respectsQuietHours: boolean;
  summary: string;
}

/** A nudge waiting for their quiet hours to end, or for their reply (a closed window). */
export interface HeldItem {
  id: string;
  channel: string;
  kind: "text" | "prompt" | "template";
  what: string;
  reason: string;
  heldAt: number | null;
  /** When their quiet hours end; null when it waits for their reply. */
  holdUntil: number | null;
  expiresAt: number | null;
}

/** What the business and the person set for someone, as the agent goes by it. */
export interface Contact {
  timeZone: string | null;
  timeZoneSource: TimeZoneSource | null;
  /** The quiet hours that apply to them: their own, the agent's, or none ("off", or no time zone known). */
  quietHours: QuietHours | null;
  quietHoursSource: "person" | "agent" | "off" | "no_time_zone";
  /** They texted STOP. */
  stop: boolean;
  /** Nothing the business starts until each of these (ms since the epoch). */
  pauses: Array<{ id: string; until: number | null }>;
  /** What they asked not to be messaged about, in their words. */
  topics: Array<{ id: string; rule: string; until: number | null }>;
}

/** A nudge as it stands now: `queued` until it is sent or settled, else how it settled. */
export interface NudgeState {
  id: string;
  status: NudgeStatus | "queued";
  reason?: string;
}

const NO_EXTRAS: ChannelInfo = { reactions: false, status: false };
const HOUR_MS = 3_600_000;
/** Provider ids deleted per statement, so each one holds its locks briefly. */
const PRUNE_BATCH = 1_000;

export class Agent {
  private readonly conversations = new Map<string, Conversation>();
  private readonly options: AgentOptions;
  private readonly settings: ConversationSettings;
  private readonly store: StoreApi;
  /** This process among the agent's runners (`runner`). */
  readonly runner: string;
  private readonly startedAt = Date.now();
  /** Conversations in the store, known once resume() ran. */
  private readonly rows = new Map<string, ConversationRow>();
  private resumed = false;
  private readonly requestReplies = new Map<string, Deliver>();
  private readonly requestCredentials = new Map<string, CredentialProvider>();
  private readonly arriving = new Map<string, Promise<unknown>>();
  /** Callers waiting for a queued nudge to settle: its first call, and any with the same key. */
  private readonly nudgeWaiters = new Map<string, Array<(result: NudgeState) => void>>();
  private readonly now: () => number;
  private readonly channelsByName: Map<string, Channel>;
  /** Where each identity (channel, address) last wrote from; sends go back the same way. */
  private readonly via = new Map<string, Via>();
  private playgroundSink: PlaygroundSink | null = null;
  private readonly playgroundVisitors = new Map<string, { key?: string; visitor?: string }>();
  /** Before this, this runner does not ask for the pruning claim again (it, or another runner, had it). */
  private pruneAfter = 0;
  /** `defaultCountryCode`'s digits. */
  private readonly countryCode: string | undefined;
  private readonly traces: Traces | null;

  constructor(options: AgentOptions) {
    options = withHost(options);
    this.options = options;
    this.channelsByName = new Map((options.channels ?? []).map((c) => [c.name, c]));
    if (this.channelsByName.size !== (options.channels ?? []).length) throw new Error("flow: two channels have the same name");
    // A person's key is "key:<resolve's value>", "phone:<number>" or "<channel>:<address>": a channel
    // named key or phone would make a channel identity read as one of the other two.
    for (const name of ["key", "phone"]) if (this.channelsByName.has(name)) throw new Error(`flow: "${name}" is reserved; give the channel another name`);
    this.now = options.now ?? Date.now;
    for (const path of Object.keys(options.routes ?? {})) if (!path.startsWith("/")) throw new Error(`flow: a route is a path starting with /, not "${path}"`);
    if (options.fallbackTemplate) {
      const declared = declaredTemplate(options.templates, options.fallbackTemplate);
      if (!declared) throw new Error(`flow: fallbackTemplate ${options.fallbackTemplate.name} is not one of the declared templates`);
      fillTemplate(declared, options.fallbackTemplate);
    }
    if (options.quietHours && !validQuietHours(options.quietHours)) throw new Error('flow: quietHours is { from: "HH:MM", to: "HH:MM" }');
    if (options.defaultCountryCode !== undefined && !/^\+?[1-9]\d{0,2}$/.test(options.defaultCountryCode.trim())) throw new Error(`flow: defaultCountryCode is a calling code such as "+91", not "${options.defaultCountryCode}"`);
    this.countryCode = options.defaultCountryCode?.trim().replace(/^\+/, "");
    const tracing = options.traces ?? tracesFromEnv();
    this.traces = tracing ? traces(tracing, { service: options.id ?? "flow", kindOf: (name) => this.channelsByName.get(name)?.traceChannel ?? this.channelsByName.get(name)?.kind }) : null;
    const sinks = [...(options.events ?? []), ...(this.traces ? [this.traces.sink] : [])];
    this.runner = `${options.runner ?? process.env.FLOW_RUNNER ?? hostname()}:${randomUUID().slice(0, 8)}`;
    const emit = emitter(sinks, this.runner);
    if ((options.dir === undefined) === (options.files === undefined)) throw new Error("flow: give an agent exactly one of dir or files");
    const files = options.files ?? readAgentFolder(options.dir!);
    const skills = loadSkills(files);
    // The test cloud's stand-in for get_user_profile counts only for an agent with a profile.
    const tools = (options.tools ?? []).filter((t) => options.profile || !(t as { [STAND_IN]?: boolean })[STAND_IN]);
    if (options.profile && !tools.some((t) => t.name === PROFILE_TOOL)) tools.push(profileTool(options.profile));
    if (skills.length && !options.inlineSkills) tools.push(skillTool(skills, (id, name) => emit(id, "skill.loaded", { skill: name })));
    if (options.store && (options.database || options.id)) throw new Error("flow: give an agent a store or a database (and id), not both");
    this.store = options.store ?? new Store(options.database ?? sqlite(), options.id ?? "default");
    this.settings = {
      model: options.model,
      transcribe: options.transcribe,
      tools: new Map(tools.map((t) => [t.name, t])),
      credentials: options.credentials,
      credentialProvider: ctx => this.requestCredentials.get(viaKey(ctx.channel, ctx.address ?? "")) ?? options.credentials,
      auth: options.auth,
      specs: tools.map(toSpec),
      instructions: loadInstructions(files, skills, options.inlineSkills),
      context: options.context,
      contextSinks: sinks.filter((sink) => sink.context === true),
      deadlineMs: options.deadlineMs ?? 60_000,
      partialAfterMs: options.partialAfterMs ?? 5_000,
      debounceMs: options.debounceMs ?? 300,
      maxSteps: options.maxSteps ?? 8,
      historyTokens: options.history?.maxTokens ?? defaultHistoryTokens(options.model.contextTokens),
      toolResultChars: options.history?.toolResultChars ?? 12_000,
      maxRestarts: Number.POSITIVE_INFINITY,
      talk: {
        shareUpdates: options.shareUpdates !== false,
        shareUpdatesInstructions: typeof options.shareUpdates === "string" ? options.shareUpdates : undefined,
      },
      emit,
      runner: this.runner,
      away: (conversation, again) => this.away(conversation, again),
      store: this.store,
      ready: this.store.migrate(),
      now: this.now,
      timeZone: options.timeZone,
      quietHours: options.quietHours,
      templates: options.templates ?? [],
      beforeSend: options.beforeSend,
      fallbackTemplate: options.fallbackTemplate?.name,
      windowClosed: (nudge, to) => this.windowClosed(nudge, to),
      tagChannels: (options.channels ?? []).length > 1,
      links: (id) => this.links(id),
      settle: (target, status, reason) => this.settle(target, status, reason),
    };
    const every = options.scheduleCheckMs ?? 5_000;
    if (every > 0) setInterval(() => void this.runDue().catch((error) => console.warn("flow: scheduled messages:", error)), every).unref();
  }

  /**
   * Loads what the database holds and carries on: turns cut off by a restart run again, events not
   * yet handled are handled, background tools that were running are reported as interrupted. A
   * durable database needs this before the first message.
   */
  async resume(): Promise<void> {
    await this.settings.ready;
    for (const row of await this.store.allConversations()) this.rows.set(row.id, row);
    this.resumed = true;
    for (const id of await this.store.unfinished()) this.open(id);
  }

  /**
   * A message from a person on a channel set up in `channels`. Returns the conversation and the id
   * the agent knows the message by, or null when `intercept` or a keyword answered it. Give the
   * provider's own `messageId`: the same one again (a webhook retried) is not taken twice. `key` is
   * the person's own key as your server verified it (a signed-in web visitor), never from a browser
   * body: the person is then `resolve`'s same key on every channel.
   */
  async message(input: { channel: string; from: string; message: string | Incoming; messageId?: string; key?: string }): Promise<{ conversationId: string; messageId: string } | null> {
    const { key, ...rest } = input;
    return this.released(await this.take(this.channelOf(input.channel), { ...rest, via: "provider", ...(key ? { verifiedKey: key } : {}) }));
  }

  /**
   * A signed-in HTTP channel's request. `key` must come from verified auth, never the body.
   * Uses the same person as resolve() on other channels. The caller serializes requests per key.
   */
  async request(input: { channel: string; key: string; text: string; conversationId?: string; credentials?: CredentialProvider }): Promise<{ conversationId: string; replies: Outbound[] }> {
    await this.settings.ready;
    const adapter = this.channelOf(input.channel);
    if (adapter.kind !== "custom") throw new Error("chinwag: request needs a custom UI channel");
    const identity = await this.conversationFor(adapter, input.channel, input.key, undefined, input.key);
    if (input.conversationId && input.conversationId !== identity.conversationId) throw new Error("chinwag: conversation does not belong to this person");
    const replies: Outbound[] = [];
    const address = viaKey(input.channel, input.key);
    if (input.credentials) this.requestCredentials.set(address, input.credentials);
    this.requestReplies.set(address, (reply) => { replies.push(reply); });
    try {
      await this.released(await this.take(adapter, { channel: input.channel, from: input.key, message: input.text, via: "provider", verifiedKey: input.key }));
      await this.conversation(identity.conversationId)?.whenIdle();
      return { conversationId: identity.conversationId, replies };
    } finally { this.requestReplies.delete(address); this.requestCredentials.delete(address); }
  }

  /**
   * A message from a test person (by their phone number) in the test playground: exactly what
   * message() does for the same person writing on that channel, but its replies go to the
   * playground. Anyone not in `testPeople` is refused.
   */
  async simulate(input: { person: string; channel: string; message: string | Incoming; messageId?: string }): Promise<{ conversationId: string; messageId: string } | null> {
    const person = this.testPerson(input.person);
    if (!person) throw new Error("flow: only the agent's testPeople can be simulated");
    const adapter = this.channelOf(input.channel);
    return this.released(await this.take(adapter, { channel: input.channel, from: this.testAddress(adapter, person), message: input.message, messageId: input.messageId, via: "playground", person }));
  }

  /**
   * A playground visitor, signed out or authenticated. `key` is verified by server code, never
   * accepted from the browser. Replies stay in the simulator; no provider send is made.
   */
  async simulateVisitor(input: { key?: string | null; address: string; channel: string; message: string | Incoming }): Promise<{ conversationId: string; messageId: string } | null> {
    if (!input.address) throw new Error("chinwag: a playground visitor needs a server-issued channel address");
    return this.released(await this.take(this.channelOf(input.channel), { channel: input.channel, from: input.key ? input.address : `visitor:${input.address}`, message: input.message, via: "playground", verifiedKey: input.key ?? undefined, visitor: input.key ? undefined : input.address }));
  }

  /**
   * A completed server-verified login. Bind its channel address to the account before sending a
   * confirmation with recordNudge/nudge. Never take key from a browser body or model input.
   * Anonymous history stays separate; an identity belonging to another account is refused.
   */
  async linkIdentity(input: { channel: string; address: string; key: string; via?: "provider" | "playground" }): Promise<{ conversationId: string }> {
    if (!input.address || !input.key) throw new Error("chinwag: linking needs a verified account and channel address");
    const adapter = this.channelOf(input.channel);
    const lock = viaKey(input.channel, input.address);
    const work = (this.arriving.get(lock) ?? Promise.resolve()).then(async () => {
      await this.settings.ready;
      const personKey = `key:${input.key}`;
      let row = await this.store.conversationByKey(personKey);
      if (!row) {
        await this.store.createConversation(`p_${randomUUID().slice(0, 12)}`, personKey);
        row = await this.store.conversationByKey(personKey);
      }
      if (!row) throw new Error("chinwag: could not open the verified account conversation");
      if (!await this.store.linkIdentity(row.id, input.channel, input.address)) throw new Error("chinwag: channel identity belongs to a different person");
      const identity = (await this.store.identity(input.channel, input.address))!;
      const via = input.via ?? identity.via;
      if (identity.via !== via) await this.store.setIdentityVia(input.channel, input.address, via);
      this.via.set(lock, via);
      if (via === "playground") this.playgroundVisitors.set(lock, { key: input.key });
      this.rows.set(row.id, row);
      this.open(row.id).link({ name: input.channel, info: adapter.info, params: adapter.params, instructions: adapter.instructions, address: input.address, deliver: this.deliverer(adapter, input.address, row.id), lastMessageAt: identity.lastMessageAt });
      return { conversationId: row.id };
    });
    this.arriving.set(lock, work.catch(() => undefined));
    return work;
  }

  /** Wake the agent after verified sign-in; a repeated completion queues one internal event. */
  async signInCompleted(input: { channel: string; address: string; key: string; idempotencyKey: string; conversationId?: string; via?: "provider" | "playground" }): Promise<NudgeState> {
    await this.settings.ready;
    if (!input.idempotencyKey) throw new Error("chinwag: sign-in completion needs an idempotency key");
    const earlier = await this.store.nudgeByKey(input.idempotencyKey);
    if (earlier) {
      const linked = await this.linkIdentity(input);
      if (earlier.conversationId !== linked.conversationId || earlier.channel !== input.channel || earlier.body.address !== input.address) throw new Error("chinwag: sign-in completion belongs to a different identity");
      return this.result(earlier.id, earlier.status, earlier.reason);
    }
    const known = await this.store.identity(input.channel, input.address);
    const anonymous = await this.store.identity(input.channel, `visitor:${input.address}`);
    let source: { conversationId: string } | null = input.conversationId ? [known, anonymous].find(i => i?.conversationId === input.conversationId) ?? null : known ?? anonymous;
    if (input.conversationId && !source) {
      // A previous attempt may have linked this address before the internal event could be queued.
      const row = await this.store.conversation(input.conversationId);
      const adapter = this.channelOf(input.channel);
      const phone = adapter.phone ? normalizePhone(input.address, adapter.kind === "whatsapp" ? undefined : this.countryCode) : "";
      const allowed = [`key:${input.key}`, `${input.channel}:${input.address}`, `${input.channel}:visitor:${input.address}`, ...(phone ? [`phone:${phone}`] : [])];
      if (!row || !allowed.includes(row.personKey)) throw new Error("chinwag: sign-in context does not belong to this channel address");
      source = { conversationId: row.id };
    }
    const history = source ? await this.transcript(source.conversationId) : [];
    const latest = history.findLastIndex(e => e.kind === "in" && e.channel === input.channel);
    const request = latest >= 0 ? history[latest] : undefined;
    const after = history.slice(latest + 1);
    const blocked = request?.kind === "in" && after.some(e => e.kind === "out" && e.channel === input.channel && e.authentication) && after.some(e => {
      if (e.kind !== "tool") return false;
      try { const output = JSON.parse(e.output); return output.error === "sign_in_required" && output.executed === false; }
      catch { return false; }
    });
    const { conversationId } = await this.linkIdentity(input);
    const account = source?.conversationId === conversationId ? history : await this.transcript(conversationId);
    const newer = request && account.some(e => e.kind === "in" && e.at > request.at);
    return this.recordNudge({ to: { channel: input.channel, address: input.address },
      prompt: signInNotice(input.channel, blocked && !newer && request?.kind === "in" ? request.text : undefined),
      idempotencyKey: input.idempotencyKey, respectQuietHours: false,
    });
  }

  /** A verified playground visitor's account history, including messages on other interfaces. */
  async visitorConversation(key: string | null, identity?: { channel: string; address: string }): Promise<string | null> {
    await this.settings.ready;
    if (!key) return identity ? (await this.store.identity(identity.channel, `visitor:${identity.address}`))?.conversationId ?? null : null;
    return (await this.store.conversationByKey(`key:${key}`))?.id ?? null;
  }

  /** They wrote, so they are there: what was held for their quiet hours goes now, in this turn. */
  private async released<T extends { conversationId: string } | null>(taken: T): Promise<T> {
    if (taken) await this.releaseHeld(this.now(), taken.conversationId);
    return taken;
  }

  /**
   * Held nudges whose quiet hours are over (or every one of a conversation whose person just wrote)
   * go on; ones past their expiresAt are settled as expired. Released together, they reach one turn.
   */
  private async releaseHeld(now: number, writer?: string): Promise<void> {
    for (const n of await this.store.heldNudges(writer)) {
      const body = n.body as { holdUntil?: number; expiresAt?: number };
      if ((body.expiresAt ?? Infinity) <= now) {
        await this.settle({ nudge: n.id }, "expired", "held past its expiresAt for their quiet hours");
        continue;
      }
      // Held for a closed window (no holdUntil), it waits for their reply.
      if (!writer && (body.holdUntil ?? Infinity) > now) continue;
      // Released because they just wrote: their window is open, though their message may not have landed yet.
      const inbox = await this.store.releaseNudge(writer ? { ...n, body: { ...n.body, theyWrote: true } } : n);
      if (inbox !== null) await this.wake(n.conversationId, inbox);
    }
  }

  /** Sends the traces of finished turns still waiting for the traces endpoint; call it before the process exits. */
  flushTraces(): Promise<void> {
    return this.traces?.flush() ?? Promise.resolve();
  }

  /** The templates declared in `templates`. */
  templates(): TemplateDefinition[] {
    return [...(this.options.templates ?? [])];
  }

  /** The people declared in `testPeople`. */
  testPeople(): TestPerson[] {
    return [...(this.options.testPeople ?? [])];
  }

  /** A test person's conversation, by their phone number, or null if they have not written yet. */
  async testConversation(phone: string): Promise<string | null> {
    await this.settings.ready;
    const person = this.testPerson(phone);
    if (!person) return null;
    for (const adapter of this.channelsByName.values()) {
      const known = await this.store.identity(adapter.name, this.testAddress(adapter, person));
      if (known) return known.conversationId;
    }
    return (await this.store.conversationByKey(await this.testPersonKey(person, [...this.channelsByName.values()][0])))?.id ?? null;
  }

  /** Where the playground shows what is sent to test people who wrote from it; null detaches it. */
  attachPlayground(sink: PlaygroundSink | null): void {
    this.playgroundSink = sink;
  }

  /** A conversation as the person saw it, from the store: their messages, the agent's, and its tool calls. */
  async transcript(conversationId: string): Promise<TranscriptEntry[]> {
    await this.settings.ready;
    await this.conversations.get(conversationId)?.stored();
    const only = [...this.channelsByName.keys()][0] ?? "chat";
    return transcriptOf(await this.store.historyWithTimes(conversationId), only);
  }

  /**
   * Forgets a person: a turn in progress stops, and everything kept about them goes (history,
   * inbox, background tools, schedules and their runs, nudges, no-contact rules, identities and
   * the conversation). Their next message starts from nothing.
   */
  async forgetPerson(conversationId: string): Promise<void> {
    await this.settings.ready;
    const resident = this.conversations.get(conversationId);
    if (resident) {
      resident.close();
      this.conversations.delete(conversationId);
      await resident.stored();
    }
    for (const i of await this.store.identities(conversationId)) {
      this.via.delete(viaKey(i.channel, i.address));
      await this.options.media?.forget?.(`${i.channel}:${i.address}`);
    }
    this.rows.delete(conversationId);
    await this.store.forgetPerson(conversationId);
  }

  private channelOf(name: string): Channel {
    const adapter = this.channelsByName.get(name);
    if (!adapter) throw new Error(`flow: no channel named ${name}`);
    this.mustBeResumed();
    return adapter;
  }

  /** Messages from one address are taken in order, so a new person is made only once. */
  private take(adapter: Channel, input: Arrival): Promise<{ conversationId: string; messageId: string } | null> {
    const key = viaKey(input.channel, input.from);
    const previous = this.arriving.get(key) ?? Promise.resolve();
    const handled = previous.then(() => this.arrive(adapter, input));
    this.arriving.set(key, handled.catch(() => undefined));
    return handled;
  }

  private async arrive(adapter: Channel, input: Arrival) {
    await this.settings.ready;
    const identity = await this.conversationFor(adapter, input.channel, input.from, input.person, input.verifiedKey);
    if (input.via === "playground") {
      const address = viaKey(input.channel, input.from);
      if (input.verifiedKey || input.visitor) this.playgroundVisitors.set(address, { key: input.verifiedKey, visitor: input.visitor });
      else this.playgroundVisitors.delete(address);
    }
    const conversationId = identity.conversationId;
    if (input.messageId !== undefined && (await this.store.inboundTaken(conversationId, input.channel, input.messageId))) {
      // The provider sent this message before (a webhook retried): it was taken then. Its id is
      // written with what the message stores (its inbox row, a STOP), so a crash keeps neither.
      this.settings.emit(conversationId, "message.duplicate", { messageId: input.messageId, channel: input.channel });
      return { conversationId, messageId: input.messageId };
    }
    if (identity.via !== input.via) await this.store.setIdentityVia(input.channel, input.from, input.via);
    this.via.set(viaKey(input.channel, input.from), input.via);
    const conversation = this.open(conversationId);
    const deliver = this.deliverer(adapter, input.from, conversationId);
    conversation.link({ name: input.channel, info: adapter.info, params: adapter.params, instructions: adapter.instructions, address: input.from, deliver, lastMessageAt: null });
    const text = typeof input.message === "string" ? input.message : input.message.text;
    const kind = keywordIn(adapter.keywords, input.message);
    const fixed = this.intercepted(conversationId, text, { keyword: kind, channel: input.channel });
    const answer = kind ? this.keyword(conversation, adapter.keywords!, kind, text, fixed, input.channel, input.messageId) : null;
    const reply = answer ? answer.reply : fixed;
    if (reply === null) return { conversationId, messageId: conversation.receive(input.message, { channel: input.channel, messageId: input.messageId }) };
    // Answered with no model call: kept with its reply and its id, and sent once that is stored, so a retry is not answered again.
    const answered = conversation.answered(input.message, { channel: input.channel, messageId: input.messageId, claimed: answer?.stored, note: answer?.note }, reply);
    if (answered && (await answered.taken)) await answered.send();
    return null;
  }

  /**
   * The agent's `intercept`, told the message's channel and whether it is a keyword. A keyword is
   * handled the same whatever the hook does, so its error there is logged, not thrown.
   */
  private intercepted(conversationId: string, text: string, message: { keyword: Keyword | null; channel: string }): string | null {
    if (!message.keyword) return this.options.intercept?.(conversationId, text, message) ?? null;
    try {
      return this.options.intercept?.(conversationId, text, message) ?? null;
    } catch (error) {
      console.warn(`flow: intercept threw on a ${message.keyword.toUpperCase()} keyword; Flow Framework handled it as usual:`, error);
      return null;
    }
  }

  /**
   * A STOP, START or HELP keyword, answered with no model call: what to send back (the hook's own
   * reply, else the channel's, else "" for nothing), and for STOP and START the line the agent
   * learns it by and their write, which holds the message's id. Null for HELP with no reply: the
   * hook's answer, or the agent, takes it like any message.
   */
  private keyword(conversation: Conversation, keywords: Keywords, kind: Keyword, text: string, own: string | null, channel: string, messageId?: string): { reply: string; note?: string; stored?: Promise<boolean> } | null {
    const reply = own || keywords.replies?.[kind] || "";
    if (kind === "help") return reply ? { reply } : null;
    return { reply, ...conversation.keyword(kind, text, channel, messageId) };
  }

  /** The identity a message comes from, made (and linked to its person's conversation) the first time it writes. */
  private async conversationFor(adapter: Channel, channel: string, address: string, testPerson?: TestPerson, verifiedKey?: string): Promise<IdentityRow> {
    const known = await this.store.identity(channel, address);
    if (known) {
      if (verifiedKey && (await this.store.conversation(known.conversationId))?.personKey !== `key:${verifiedKey}`) throw new Error("chinwag: channel identity belongs to a different person");
      return known;
    }
    let personKey: string;
    let verifiedBy: string;
    if (testPerson && !adapter.phone) {
      // Not a phone channel: their playground address joins the person their number is.
      [personKey, verifiedBy] = [await this.testPersonKey(testPerson, adapter), "test person"];
    } else {
      const phone = adapter.phone ? normalizePhone(address, adapter.kind === "whatsapp" ? undefined : this.countryCode) : "";
      const owner = verifiedKey ?? await this.options.resolve?.({ channel, address, ...(phone ? { phone } : {}) });
      [personKey, verifiedBy] = owner ? [`key:${owner}`, "resolver"] : phone ? [`phone:${phone}`, "phone"] : [`${channel}:${address}`, "channel"];
    }
    let row = await this.store.conversationByKey(personKey);
    if (!row) {
      // Two first messages from one person at once (on two channels) both get here; one insert
      // wins, and both carry on with the conversation that is there now.
      await this.store.createConversation(`p_${randomUUID().slice(0, 12)}`, personKey);
      row = await this.store.conversationByKey(personKey);
      if (!row) throw new Error(`flow: could not make a conversation for ${personKey}`);
      if (!this.conversations.has(row.id)) this.rows.set(row.id, row);
    }
    const id = row.id;
    await this.store.addIdentity(id, channel, address, verifiedBy);
    return { channel, address, conversationId: id, verifiedBy, lastMessageAt: null, via: "provider" };
  }

  /**
   * The key the real person has: what the owner's resolve() gives their phone number (on the
   * agent's first phone channel, else this one), else their phone number. So the playground and
   * the provider reach one conversation, on every channel.
   */
  private async testPersonKey(person: TestPerson, adapter: Channel | undefined): Promise<string> {
    const phone = normalizePhone(person.phone);
    const channel = [...this.channelsByName.values()].find((c) => c.phone) ?? adapter;
    const owner = channel ? await this.options.resolve?.({ channel: channel.name, address: phone, ...(channel.phone ? { phone } : {}) }) : null;
    return owner ? `key:${owner}` : `phone:${phone}`;
  }

  private testPerson(phone: string): TestPerson | undefined {
    const wanted = normalizePhone(phone);
    return wanted ? this.options.testPeople?.find((p) => normalizePhone(p.phone) === wanted) : undefined;
  }

  /** A test person's address on a channel: their number on phone channels, else `test:<number>`. */
  private testAddress(adapter: Channel, person: TestPerson): string {
    const phone = normalizePhone(person.phone);
    return adapter.phone ? phone : `test:${phone}`;
  }

  /** Sends to one identity: to the playground if it last wrote from there, else through the channel's provider. */
  private deliverer(adapter: Channel, address: string, conversationId: string): Deliver {
    return (outbound) => {
      const reply = this.requestReplies.get(viaKey(adapter.name, address));
      if (reply) return reply(outbound);
      if (this.via.get(viaKey(adapter.name, address)) !== "playground") return adapter.send(address, outbound);
      const visitor = this.playgroundVisitors.get(viaKey(adapter.name, address));
      if (visitor) return this.playgroundSink?.({ conversationId, person: { name: visitor.key ? "Signed-in user" : "New user", phone: "", ...visitor }, channel: adapter.name, outbound });
      const phone = address.startsWith("test:") ? address.slice(5) : address;
      const person = this.testPerson(phone);
      // With no playground page open, nothing is shown, and the conversation keeps it as sent.
      if (person) return this.playgroundSink?.({ conversationId, person, channel: adapter.name, outbound });
      const key = this.rows.get(conversationId)?.personKey;
      if (key?.startsWith("key:")) return this.playgroundSink?.({ conversationId, person: { name: "Signed-in user", phone: "", key: key.slice(4) }, channel: adapter.name, outbound });
      if (address.startsWith("visitor:")) return this.playgroundSink?.({ conversationId, person: { name: "New user", phone: "", visitor: address.slice(8) }, channel: adapter.name, outbound });
    };
  }

  /**
   * A message from a person; replies go to `deliver`, the channel it came in on. Returns the id
   * the agent knows the message by, or null when `intercept` or a keyword answered it. The conversation is
   * this id alone: use message() and `channels` for one person across several channels. When
   * `channelName` is one of the agent's channels, its definition (what it shows, its params) is
   * used and replies go to `deliver`: that is how the simulators play an agent's own channels.
   */
  receive(conversationId: string, message: string | Incoming, deliver: Deliver, options: ReceiveOptions = {}): string | null {
    const text = typeof message === "string" ? message : message.text;
    const name = options.channelName ?? "chat";
    const defined = this.channelsByName.get(name);
    const kind = keywordIn(defined?.keywords, message);
    const fixed = this.intercepted(conversationId, text, { keyword: kind, channel: name });
    this.mustBeResumed();
    const isNew = !this.conversations.has(conversationId) && !this.rows.has(conversationId);
    const conversation = this.open(conversationId, `${name}:${conversationId}`);
    if (isNew) conversation.persist(() => this.store.addIdentity(conversationId, name, conversationId, "channel"));
    conversation.link({ name, info: defined?.info ?? options.channel ?? NO_EXTRAS, params: defined?.params, instructions: defined?.instructions, address: conversationId, deliver, lastMessageAt: null });
    const answer = kind ? this.keyword(conversation, defined!.keywords!, kind, text, fixed, name) : null;
    const reply = answer ? answer.reply : fixed;
    if (reply === null) return conversation.receive(message, { channel: name, messageId: options.messageId });
    const answered = conversation.answered(message, { channel: name, messageId: options.messageId, claimed: answer?.stored, note: answer?.note }, reply);
    // A STOP's or START's reply goes once it is kept; any other starts now, while receive() runs, so
    // a caller that waits on what it delivers sees it.
    if (answered) void (answer?.stored ? answer.stored.then((taken) => (taken ? answered.send() : undefined)) : answered.send());
    return null;
  }

  /**
   * The person reacted to one of the agent's messages; the agent learns it at its next turn. The
   * conversation is loaded from the store when it is not in memory (after a restart).
   */
  reacted(conversationId: string, emoji: string, toText: string): void {
    this.withConversation(conversationId, (c) => c.reacted(emoji, toText));
  }

  /** The channel reports that a message did not reach the person; the agent hears about it, also after a restart. */
  undelivered(conversationId: string, text: string, reason: string): void {
    this.withConversation(conversationId, (c) => c.undelivered(text, reason));
  }

  /** Acts on a conversation now when it is in memory, else once it is loaded from the store; never on one the store does not hold. */
  private withConversation(conversationId: string, act: (conversation: Conversation) => void): void {
    const resident = this.conversations.get(conversationId);
    if (resident) return act(resident);
    void (async () => {
      await this.settings.ready;
      const row = this.rows.get(conversationId) ?? (await this.store.conversation(conversationId));
      if (!row) return;
      this.rows.set(conversationId, row);
      act(this.open(conversationId));
    })().catch((error) => console.warn("flow: conversation %s could not be loaded for a report:", conversationId, error));
  }

  conversation(conversationId: string): Conversation | undefined {
    return this.conversations.get(conversationId);
  }

  /**
   * A message the business starts. Resolves once it is settled: sent, silent (a prompt nudge the
   * agent chose not to send), dropped (a no-contact rule covers it), refused (outside_window,
   * unknown_person) or failed; or scheduled, for one with `at`.
   */
  /**
   * The person's time zone as the business knows it (an IANA name, "Asia/Kolkata"), by a channel
   * identity they have written from, like a nudge's `to`. Schedules and the agent's time use it from
   * then on. Throws for a name that is not a zone; refused (unknown_person) for someone who never wrote.
   */
  async setTimeZone(input: { to: { channel: string; address: string }; timeZone: string }): Promise<{ status: "set" } | { status: "refused"; reason: "unknown_person" }> {
    if (!validZone(input.timeZone)) throw new Error(`flow: ${input.timeZone} is not a time zone; use an IANA name such as America/New_York`);
    await this.settings.ready;
    const identity = await this.store.identity(input.to.channel, input.to.address);
    if (!identity) return { status: "refused", reason: "unknown_person" };
    const id = identity.conversationId;
    const resident = this.conversations.get(id);
    if (resident) await resident.setTimeZone(input.timeZone, "business");
    else {
      await this.store.updateConversation(id, { timeZone: input.timeZone, timeZoneSource: "business" });
      const row = this.rows.get(id);
      if (row) this.rows.set(id, { ...row, timeZone: input.timeZone, timeZoneSource: "business" });
    }
    return { status: "set" };
  }

  /**
   * Starts the history the model is sent again from now, for someone by a channel identity they have
   * written from (a new order, a new case, a day later): later calls carry only what comes after,
   * with `note`, the app's short summary of what came before, if given. Nothing is deleted: the
   * transcript, the events and the guards' record of what was sent keep all of it. The person's
   * messages that are not answered yet stay. It does not start a turn; it is a `history.reset` event
   * when the next one reads it. Refused (unknown_person) for someone who never wrote.
   */
  async resetHistory(input: { to: { channel: string; address: string }; note?: string }): Promise<{ status: "reset" } | { status: "refused"; reason: "unknown_person" }> {
    await this.settings.ready;
    const identity = await this.store.identity(input.to.channel, input.to.address);
    if (!identity) return { status: "refused", reason: "unknown_person" };
    const resident = this.conversations.get(identity.conversationId);
    if (resident) await resident.resetHistory(input.note);
    else await this.store.addInbox(identity.conversationId, "note", { text: resetLine(input.note), wait: true, reset: true });
    return { status: "reset" };
  }

  /**
   * Their own quiet hours, as the business knows them: `{ from, to }`, "off" for none, or null to go
   * back to the agent's. Refused (unknown_person) for someone who never wrote.
   */
  async setQuietHours(input: { to: { channel: string; address: string }; quietHours: QuietHours | "off" | null }): Promise<{ status: "set" } | { status: "refused"; reason: "unknown_person" }> {
    const q = input.quietHours;
    if (q !== null && q !== "off" && !validQuietHours(q)) throw new Error('flow: quietHours is { from: "HH:MM", to: "HH:MM" }, "off" or null');
    await this.settings.ready;
    const identity = await this.store.identity(input.to.channel, input.to.address);
    if (!identity) return { status: "refused", reason: "unknown_person" };
    const resident = this.conversations.get(identity.conversationId);
    if (resident) await resident.setQuietHours(q);
    else await this.store.updateConversation(identity.conversationId, { quietHours: q });
    return { status: "set" };
  }

  /** What the business and the person set for someone, by a channel identity they wrote from; null for someone who never wrote. */
  /** The conversation a channel identity belongs to, or null when that address never wrote. */
  /** The agent's file store (`createAgent({ media })`), or undefined. */
  get media(): MediaStore | undefined {
    return this.options.media;
  }

  async conversationOf(identity: { channel: string; address: string }): Promise<string | null> {
    await this.settings.ready;
    return (await this.store.identity(identity.channel, identity.address))?.conversationId ?? null;
  }

  async contact(to: { channel: string; address: string }): Promise<Contact | null> {
    await this.settings.ready;
    const identity = await this.store.identity(to.channel, to.address);
    const row = identity && (await this.store.conversation(identity.conversationId));
    if (!row) return null;
    const rules = await this.store.noContact(row.id, this.now());
    const own = row.quietHours;
    const hours = quietHoursOf(row, this.options.quietHours);
    return {
      timeZone: row.timeZone,
      timeZoneSource: row.timeZoneSource,
      quietHours: row.timeZone ? hours : null,
      quietHoursSource: !hours ? "off" : !row.timeZone ? "no_time_zone" : own && own !== "off" ? "person" : "agent",
      stop: rules.some((r) => r.kind === "stop"),
      pauses: rules.filter((r) => r.kind === "pause").map((r) => ({ id: r.id, until: r.until })),
      topics: rules.filter((r) => r.kind === "topic").map((r) => ({ id: r.id, rule: r.rule, until: r.until })),
    };
  }

  /** A window-closed prompt nudge got no template from the agent: held until they reply, and the fallback goes now. */
  private async windowClosed(nudge: string, to: { channel: string; address: string }): Promise<void> {
    const row = await this.store.nudge(nudge);
    if (!row) return;
    const { windowClosed: _closed, ...body } = row.body;
    await this.store.holdNudge(nudge, body, "window_closed");
    this.release(nudge, this.result(nudge, "held", "window_closed"));
    await this.sendFallback(row.conversationId, to, nudge, body);
  }

  /** The fallback template for a held nudge, once, and the event that says it wanted a template of its own. */
  private async sendFallback(conversationId: string, to: { channel: string; address: string }, nudge: string, body: Record<string, unknown>): Promise<void> {
    this.settings.emit(conversationId, "template.missing", { nudge, channel: to.channel, ...(body.text !== undefined ? { text: body.text } : { prompt: body.prompt }) });
    await this.recordNudge({ to, template: this.options.fallbackTemplate!, idempotencyKey: `fallback:${nudge}` });
  }

  /**
   * What is waiting to go to a person: their scheduled messages (theirs and the business's) and the
   * nudges held for their quiet hours or a closed window. The playground shows it.
   */
  async outbox(conversationId: string): Promise<{ schedules: ScheduledItem[]; held: HeldItem[] }> {
    await this.settings.ready;
    const schedules = (await this.store.schedules(conversationId)).map((s) => ({
      id: s.id,
      message: s.instruction,
      origin: s.origin === "person" ? ("person" as const) : ("business" as const),
      mode: s.mode,
      nextRunAt: s.nextRunAt,
      timeZone: s.timeZone,
      respectsQuietHours: (s.rule as { quiet?: boolean }).quiet === true,
      summary: summary(s).summary,
    }));
    const held = (await this.store.heldNudges(conversationId)).map((n) => {
      const b = n.body as { text?: string; prompt?: string; template?: Template; heldAt?: number; holdUntil?: number | null; expiresAt?: number };
      return {
        id: n.id,
        channel: n.channel,
        kind: b.template ? ("template" as const) : b.text !== undefined ? ("text" as const) : ("prompt" as const),
        what: b.template?.name ?? b.text ?? b.prompt ?? "",
        reason: n.reason ?? "",
        heldAt: b.heldAt ?? null,
        holdUntil: b.holdUntil ?? null,
        expiresAt: b.expiresAt ?? null,
      };
    });
    return { schedules, held };
  }

  /** Whether the agent has a profile (get_user_profile), so the test cloud knows to play it. */
  hasProfile(): boolean {
    return this.options.profile !== undefined;
  }

  /**
   * A person the business may message before they have written (they gave it their number): their
   * conversation, made the first time, with no message in it. Until they write, their WhatsApp
   * window is closed, so only a template reaches them there.
   */
  async reach(to: { channel: string; address: string }): Promise<{ conversationId: string }> {
    await this.settings.ready;
    const adapter = this.channelOf(to.channel);
    const identity = await this.conversationFor(adapter, to.channel, to.address);
    const conversation = this.open(identity.conversationId);
    conversation.link({ name: to.channel, info: adapter.info, params: adapter.params, instructions: adapter.instructions, address: to.address, deliver: this.deliverer(adapter, to.address, identity.conversationId), lastMessageAt: identity.lastMessageAt });
    return { conversationId: identity.conversationId };
  }

  /**
   * Where flowEvents (business events) keeps its send state, so a restart does not forget it; its
   * attach() asks. null when the database does not survive a restart or the store cannot hold it.
   */
  eventStateStore(): EventStateStore | null {
    const store = this.store;
    if (!store.durable || !store.loadEventState || !store.takeEvents || !store.saveEventState) return null;
    return {
      loadEventState: async () => {
        await this.settings.ready;
        return store.loadEventState!();
      },
      takeEvents: async (...args) => {
        await this.settings.ready;
        return store.takeEvents!(...args);
      },
      saveEventState: async (...args) => {
        await this.settings.ready;
        return store.saveEventState!(...args);
      },
    };
  }

  /** A channel the agent was given, by name, as it was given (the test cloud plays a copy of it). */
  channel(name: string): Channel | undefined {
    return this.channelsByName.get(name);
  }

  /** Answers a request to one of `routes` by its path; 404 for any other. */
  async fetch(request: Request): Promise<Response> {
    const route = this.options.routes?.[new URL(request.url).pathname];
    if (!route) return Response.json({ error: "no such route" }, { status: 404 });
    return route(request);
  }

  async nudge(input: NudgeInput): Promise<NudgeResult> {
    // outcome() waits while it is queued, so what it resolves is settled.
    return (await this.outcome(await this.recordNudge(input))) as NudgeResult;
  }

  /**
   * Records a nudge and resolves at once, without waiting for its send or turn: `queued`, or what
   * was decided as it was recorded (dropped, refused, scheduled). The same idempotency key gets the
   * first nudge's state now. `nudgeState(id)` reads it later.
   */
  async recordNudge(input: NudgeInput): Promise<NudgeState> {
    await this.settings.ready;
    const kinds = [input.text, input.prompt, input.template].filter((v) => v !== undefined).length;
    if (kinds !== 1) throw new Error("flow: a nudge has exactly one of text, prompt or template");
    if (input.link && (input.text === undefined || input.at !== undefined)) throw new Error("flow: a nudge's link goes with text, sent now (not with `at`)");
    // A declared template whose values don't fit it never goes: Meta would refuse it, the playground would show nonsense.
    const declared = input.template && declaredTemplate(this.options.templates, input.template);
    if (declared) fillTemplate(declared, input.template!);
    if (input.idempotencyKey) {
      const earlier = await this.store.nudgeByKey(input.idempotencyKey);
      if (earlier) return this.result(earlier.id, earlier.status, earlier.reason);
    }
    const identity = await this.store.identity(input.to.channel, input.to.address);
    if (!identity) return { id: "", status: "refused", reason: "unknown_person" };
    const id = `n_${randomUUID().slice(0, 8)}`;
    const conversationId = identity.conversationId;
    const record = { id, conversationId, channel: input.to.channel, idempotencyKey: input.idempotencyKey ?? null, reason: null };
    const stop = input.at === undefined ? await this.blockOf(conversationId) : null;
    // Written once per key: a call that loses the insert to one with the same key gets that one's result.
    const add = async (row: NudgeRow, schedule?: Parameters<StoreApi["addNudge"]>[1]): Promise<NudgeState | number> => {
      const inbox = await this.store.addNudge(row, schedule);
      if (inbox !== null) return inbox;
      const first = (await this.store.nudgeByKey(input.idempotencyKey!))!;
      return this.result(first.id, first.status, first.reason);
    };
    const settledAs = async (row: NudgeRow): Promise<NudgeState> => {
      const added = await add(row);
      return typeof added === "number" ? this.result(row.id, row.status, row.reason) : added;
    };
    if (stop) {
      const reason = `no-contact rule ${stop.id}: ${stop.rule}`;
      return settledAs({ ...record, body: input.template ? { template: input.template } : { text: input.text, prompt: input.prompt }, status: "dropped", reason });
    }
    if (input.at !== undefined) {
      if (input.template) throw new Error("flow: a template nudge cannot be scheduled yet");
      const zone = (await this.store.conversation(conversationId))?.timeZone ?? this.options.timeZone ?? "UTC";
      const schedule = businessSchedule(conversationId, input.to.channel, input.at, zone, { text: input.text, prompt: input.prompt }, input.respectQuietHours !== false);
      const added = await add({ ...record, body: { text: input.text, prompt: input.prompt, at: input.at }, status: "scheduled" }, schedule);
      return typeof added === "number" ? { id, status: "scheduled" } : added;
    }
    const body = { address: input.to.address, ...(input.template ? { template: input.template } : input.text !== undefined ? { text: input.text, ...(input.link ? { link: input.link } : {}) } : { prompt: input.prompt }) };
    const now = this.now();
    const quietEnds = input.respectQuietHours === false ? null : await this.quietEnd(conversationId, now);
    if (quietEnds !== null) {
      const held = { ...body, heldAt: now, holdUntil: quietEnds, expiresAt: input.expiresAt ?? now + DAY_MS };
      const added = await add({ ...record, body: held, status: "held", reason: "quiet_hours" });
      return typeof added === "number" ? { id, status: "held", reason: "quiet_hours" } : added;
    }
    if (!input.template && windowClosed({ info: this.infoOf(input.to.channel, conversationId), lastMessageAt: identity.lastMessageAt }, this.now())) {
      if (!this.options.fallbackTemplate) return settledAs({ ...record, body, status: "refused", reason: "outside_window" });
      if (input.text !== undefined) {
        // Exact wording: it waits for their reply, and the fallback tells them something is waiting.
        const added = await add({ ...record, body: { ...body, expiresAt: input.expiresAt ?? now + DAY_MS }, status: "held", reason: "window_closed" });
        if (typeof added !== "number") return added;
        await this.sendFallback(conversationId, input.to, id, body);
        return { id, status: "held", reason: "window_closed" };
      }
      // A prompt nudge: the agent may find a template that says it; else the fallback (windowClosed below).
      Object.assign(body, { windowClosed: true, expiresAt: input.expiresAt ?? now + DAY_MS });
    }
    const added = await add({ ...record, body, status: "queued" });
    if (typeof added !== "number") return added;
    void this.wake(conversationId, added);
    return { id, status: "queued" };
  }

  /** A nudge's state now, or null for an id the store does not hold. */
  async nudgeState(id: string): Promise<NudgeState | null> {
    await this.settings.ready;
    const row = await this.store.nudge(id);
    return row && this.result(row.id, row.status, row.reason);
  }

  /** A recorded nudge as `nudge()` returns it: settled, or (still queued) once it settles. */
  private async outcome(state: NudgeState): Promise<NudgeState> {
    if (state.status !== "queued") return state;
    const settled = this.waitFor(state.id);
    // It may have settled between the read and the wait.
    const now = await this.store.nudge(state.id);
    if (now && now.status !== "queued") this.release(state.id, this.result(state.id, now.status, now.reason));
    return settled;
  }

  private waitFor(id: string): Promise<NudgeState> {
    return new Promise((resolve) => this.nudgeWaiters.set(id, [...(this.nudgeWaiters.get(id) ?? []), resolve]));
  }

  private release(id: string, result: NudgeState): void {
    for (const resolve of this.nudgeWaiters.get(id) ?? []) resolve(result);
    this.nudgeWaiters.delete(id);
  }

  /**
   * Looks for due scheduled messages once and hands each to its conversation. Returns how many.
   * Once an hour, one runner also deletes provider message ids older than `keepMessageIdsDays`.
   */
  async runDue(): Promise<number> {
    await this.settings.ready;
    if (this.store.durable && !this.resumed) return 0;
    const now = this.now();
    const queued = await claimDue(this.store, now, (s) => this.quietEnd(s.conversationId, now), async (s) => {
      const stop = s.origin === "person" ? await this.stopOf(s.conversationId) : await this.blockOf(s.conversationId);
      if (stop) return `no-contact rule ${stop.id}: ${stop.rule}`;
      const identity = (await this.store.identities(s.conversationId)).find((i) => i.channel === s.channel);
      if (!identity) return `no way to reach them on ${s.channel}`;
      return windowClosed({ info: this.infoOf(s.channel, s.conversationId), lastMessageAt: identity.lastMessageAt }, now) ? "outside_window" : null;
    });
    // Awaited, so a caller that then waits for the conversation (a test moving the clock) sees the turn.
    await Promise.all(queued.map((q) => this.wake(q.conversationId, q.inbox)));
    await this.lookAgain();
    await this.releaseHeld(now);
    if (this.options.onTick) await Promise.resolve().then(() => this.options.onTick!(now)).catch((error) => console.warn("flow: onTick:", error));
    await this.pruneMessageIds(now).catch((error) => console.warn("flow: pruning message ids:", error));
    return queued.length;
  }

  /** Deletes provider message ids past their keep, in batches, when this runner claims it (at most hourly). */
  private async pruneMessageIds(now: number): Promise<void> {
    if (now < this.pruneAfter) return;
    this.pruneAfter = now + HOUR_MS;
    if (!(await this.store.claimUpkeep("prune_message_ids", now, now + HOUR_MS))) return;
    const before = now - (this.options.keepMessageIdsDays ?? 7) * 24 * HOUR_MS;
    while ((await this.store.pruneInbound(before, PRUNE_BATCH)) === PRUNE_BATCH);
  }

  /** The agent's channels without their sends: what the simulators and the test cloud play. */
  channels(): ChannelSummary[] {
    return [...this.channelsByName.values()].map(summarize);
  }

  status(): AgentStatus {
    const all = [...this.conversations.values()];
    const busy = all.some((c) => c.busy);
    const idle = all.length ? Math.min(...all.map((c) => c.idleForMs)) : Date.now() - this.startedAt;
    return {
      busy,
      idleForMs: busy ? 0 : idle,
      conversations: all.length,
      backgroundTasks: all.reduce((n, c) => n + c.backgroundTasks.length, 0),
    };
  }

  /** The conversation in memory, made (and loaded from the store, if it is there) when needed. */
  private open(id: string, personKey = id): Conversation {
    let conversation = this.conversations.get(id);
    if (!conversation) {
      const row = this.rows.get(id) ?? null;
      conversation = new Conversation(id, row?.personKey ?? personKey, this.settings, row);
      this.conversations.set(id, conversation);
    }
    return conversation;
  }

  /**
   * Another runner has a conversation (or had it since this copy was read): the copy is dropped
   * once its writes are in. `again`: this runner holds it now, so it is read again at once;
   * otherwise the holder takes what is waiting, or lookAgain() does once its lease runs out.
   */
  private away(conversation: Conversation, again: boolean): void {
    const id = conversation.id;
    if (this.conversations.get(id) === conversation) this.conversations.delete(id);
    if (!again) return;
    void conversation
      .stored()
      .then(() => this.store.conversation(id))
      .then((row) => {
        if (row) this.rows.set(id, row);
        if (!this.conversations.has(id)) this.open(id);
      })
      .catch((error) => console.warn("flow: runner %s could not read conversation %s again:", this.runner, id, error));
  }

  /**
   * Conversations with work left (a turn cut off, inbox rows open), looked at again on the
   * scheduled messages' timer: one another runner held until it died, or rows stored here while
   * another runner worked on it, are taken once its lease is free.
   */
  private async lookAgain(): Promise<void> {
    // Nudges waited on here that another runner's copy of the conversation settled.
    for (const id of [...this.nudgeWaiters.keys()]) {
      const row = await this.store.nudge(id);
      if (row && row.status !== "queued") this.release(id, this.result(id, row.status, row.reason));
    }
    for (const id of await this.store.unfinished()) {
      const resident = this.conversations.get(id);
      if (resident) {
        resident.poke();
        continue;
      }
      const row = await this.store.conversation(id);
      if (!row || this.conversations.has(id)) continue;
      this.rows.set(id, row);
      this.open(id);
    }
  }

  /** An inbox row for a conversation: handed to it in memory, or found when it loads. */
  private wake(conversationId: string, inbox: number): Promise<void> {
    const resident = this.conversations.get(conversationId);
    if (!resident) {
      return this.store.conversation(conversationId).then((row) => {
        if (row) this.rows.set(conversationId, row);
        this.open(conversationId);
      });
    }
    return this.store.openInbox(conversationId).then((rows) => {
      const row = rows.find((r) => r.id === inbox);
      if (row) resident.enqueue(row);
    });
  }

  private async links(conversationId: string): Promise<ChannelLink[]> {
    const identities: IdentityRow[] = await this.store.identities(conversationId);
    // Oldest first, so on a channel with two identities (the app, and the playground's) the latest one wins.
    identities.sort((a, b) => (a.lastMessageAt ?? 0) - (b.lastMessageAt ?? 0));
    return identities.flatMap((i) => {
      const adapter = this.channelsByName.get(i.channel);
      if (!adapter) return [];
      this.via.set(viaKey(i.channel, i.address), i.via);
      return [{ name: i.channel, info: adapter.info, params: adapter.params, instructions: adapter.instructions, address: i.address, deliver: this.deliverer(adapter, i.address, conversationId), lastMessageAt: i.lastMessageAt }];
    });
  }

  /** What a channel can show: its adapter's, else what the conversation was last told. */
  private infoOf(channel: string, conversationId: string): ChannelInfo {
    return this.channelsByName.get(channel)?.info ?? this.conversations.get(conversationId)?.channelInfo(channel) ?? NO_EXTRAS;
  }

  private async settle(target: { run?: string; nudge?: string }, status: string, reason?: string): Promise<void> {
    if (target.run) await this.store.settleRun(target.run, status, reason);
    if (target.nudge) {
      await this.store.settleNudge(target.nudge, status, reason);
      this.release(target.nudge, this.result(target.nudge, status, reason));
    }
  }

  /** Their STOP, if they texted one. */
  private async stopOf(conversationId: string) {
    return (await this.store.noContact(conversationId, this.now())).find((r) => r.hard) ?? null;
  }

  /** Their STOP, or a pause in force: either way nothing the business starts goes now. */
  private async blockOf(conversationId: string) {
    return (await this.store.noContact(conversationId, this.now())).find((r) => r.hard || r.kind === "pause") ?? null;
  }

  /** When their quiet hours end, if they are in them now; null when not, or when their time zone is not known. */
  private async quietEnd(conversationId: string, now: number): Promise<number | null> {
    const row = await this.store.conversation(conversationId);
    const hours = row && quietHoursOf(row, this.options.quietHours);
    return row?.timeZone && hours ? quietUntil(now, row.timeZone, hours) : null;
  }

  private result(id: string, status: string, reason?: string | null): NudgeState {
    return reason ? { id, status: status as NudgeState["status"], reason } : { id, status: status as NudgeState["status"] };
  }

  private mustBeResumed(): void {
    if (this.store.durable && !this.resumed) throw new Error("flow: call await agent.resume() before the first message when the database is durable");
  }
}

interface Arrival {
  verifiedKey?: string;
  visitor?: string;
  channel: string;
  from: string;
  message: string | Incoming;
  messageId?: string;
  via: Via;
  /** A test person writing from the playground. */
  person?: TestPerson;
}

const viaKey = (channel: string, address: string) => `${channel}\u0000${address}`;

type Keyword = "stop" | "start" | "help";

/** Which keyword a message is on a channel with them: text alone, never a file or a tap. */
function keywordIn(keywords: Keywords | undefined, message: string | Incoming): Keyword | null {
  if (typeof message !== "string" && (message.attachments?.length || message.choice)) return null;
  return keywordOf(keywords, typeof message === "string" ? message : message.text);
}

/**
 * A phone number as one string however the channel gave it, in E.164: formatting dropped, a 00
 * prefix read as +, and digits with no + taken as international (WhatsApp gives "15550100100" for
 * "+1 555 010 0100"), or, given a `countryCode`, as that country's national number. "" when there
 * are no digits (not a phone number).
 */
export function normalizePhone(address: string, countryCode?: string): string {
  const trimmed = address.trim();
  const digits = trimmed.replace(/^00/, "").replace(/\D/g, "");
  if (!digits) return "";
  if (!countryCode || trimmed.startsWith("+") || trimmed.startsWith("00")) return `+${digits}`;
  return `+${countryCode}${countryCode === "39" ? digits : digits.replace(/^0/, "")}`;
}

export function createAgent(options: AgentOptions): Agent {
  return new Agent(options);
}

const DAY_MS = 24 * 60 * 60_000;
export const DEFAULT_QUIET_HOURS: QuietHours = { from: "22:00", to: "07:00" };

/** The history budget when the agent gives none: 24,000 tokens, or 60% of the model's window when that is less. */
export function defaultHistoryTokens(contextTokens?: number): number {
  return contextTokens ? Math.min(24_000, Math.floor(contextTokens * 0.6)) : 24_000;
}

function validQuietHours(q: unknown): q is QuietHours {
  const v = q as QuietHours;
  return typeof v === "object" && v !== null && typeof v.from === "string" && typeof v.to === "string" && !!clock(v.from) && !!clock(v.to);
}

/** The quiet hours that apply to a person: their own, else the agent's (the default unless it turned them off). */
export function quietHoursOf(row: Pick<ConversationRow, "quietHours">, agent: QuietHours | false | undefined): QuietHours | null {
  if (row.quietHours === "off") return null;
  if (row.quietHours) return row.quietHours;
  return agent === false ? null : (agent ?? DEFAULT_QUIET_HOURS);
}
