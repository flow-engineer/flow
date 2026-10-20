// The simulators: a simulator per platform (SMS, WhatsApp, iMessage, Telegram, web), each with that
// platform's rules. Nothing is really sent. They run in two ways.
//
// The playground: people test an agent as real users before its numbers are live. Only the
// agent's `testPeople` can be played, on the agent's own channels, through `agent.simulate()`: the
// same path as a provider's webhook, so a test person is a real person to the agent (identity,
// lookups, history, schedules); the simulator is just a different phone. One person is one
// conversation on every channel, and what is shown is that conversation's history in the agent's
// store, so it survives restarts. On a deployed agent it needs a token (`handler`). Without one it
// answers only a loopback Host, and its API only its own page (never another site's).
//
//   GET  /?person=<phone>&channel=<name>      the playground; /person shows every channel side by side
//   POST /api/messages    {channel, person, text, replyTo?, choice?}  → {messageId, at}
//   POST /api/reactions   {channel, person, messageId, emoji}          the person reacts to an agent message
//   GET  /api/events      ?channel&person&after?   server-sent events: what the person sees, plus the trace
//   GET  /api/poll        ?channel&person&after    the same events for a page the stream can't reach (a
//                                                  tunnel that holds it back): those after `after` at once,
//                                                  else the next within 20 s → {boot, seq, events}
//   GET  /api/transcript  ?channel&person   the conversation on that channel, from the store, and the
//                                           `seq` its events continue from
//   POST /api/clear       ?person           forget the person: history, schedules, everything
//   GET  /api/status                         busy / idle, background tasks
//   GET  /api/platforms                      each platform's rules, the agent's channels and test people, link cards,
//                                            the action labels (the Person tab's "Their account")
//
// The test cloud (`testCloud: true`, for Flow Framework's test cloud only): generated people per run, any
// person id, through AgentConnection.receive; the same API with `platform` for `channel`, `person`
// free, and POST /api/reset to start a conversation over. Its transcript is kept in memory.
//
// The person's messages have the agent's ids (m1, m2, ...); the agent's messages get a1, a2, ...

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import {
  declaredTemplate,
  fillTemplate,
  fitMessage,
  type Attachment,
  type ChannelInfo,
  type ChannelSummary,
  type Deliver,
  type EventSink,
  type FilledTemplate,
  type Incoming,
  type ListRow,
  type Outbound,
  type FlowEvent,
  type PlaygroundSink,
  type Template,
  type TemplateDefinition,
  type TestPerson,
  type TranscriptEntry,
} from "../../src/index.ts";
import type { Agent } from "../../src/agent.ts";
import type { CliConfig } from "../../cli/src/commands.ts";
import type { CliIO } from "../../cli/src/run.ts";
import { requireToken, sameSecret, wrongTries } from "../../src/http.ts";
import { PLATFORMS, channelOf, platform as platformOf, smsSegments, type Platform } from "./platforms.ts";

/** What the test cloud's simulators need from an agent. */
export interface AgentConnection {
  /** A person's message; returns its id, or null when the agent answered it without a turn. */
  receive(conversationId: string, incoming: Incoming, deliver: Deliver, options: { channel: ChannelInfo; channelName?: string }): string | null;
  /**
   * The agent's own channels, if it has any: a simulator plays the one of its kind (SMS, WhatsApp,
   * and the web simulator for a custom UI) with its definition.
   */
  channels?(conversationId: string): ChannelSummary[];
  /** The person reacted to one of the agent's messages. */
  reacted(conversationId: string, emoji: string, toText: string): void;
  status(): { busy: boolean; idleForMs: number; backgroundTasks: number; conversations: number };
}

/** What the playground needs from an agent. Flow Framework's Agent is one as it is. */
export interface PlaygroundAgent {
  testPeople(): TestPerson[];
  channels(): ChannelSummary[];
  simulate(input: { person: string; channel: string; message: Incoming }): Promise<{ conversationId: string; messageId: string } | null>;
  testConversation(phone: string): Promise<string | null>;
  simulateVisitor?: Agent["simulateVisitor"];
  visitorConversation?: Agent["visitorConversation"];
  transcript(conversationId: string): Promise<TranscriptEntry[]>;
  reacted(conversationId: string, emoji: string, toText: string): void;
  forgetPerson(conversationId: string): Promise<void>;
  attachPlayground(sink: PlaygroundSink | null): void;
  status(): { busy: boolean; idleForMs: number; backgroundTasks: number; conversations: number };
  /** The WhatsApp templates the agent declared, shown as WhatsApp would show them. */
  templates?(): TemplateDefinition[];
  /** The Person panel (Flow Framework's Agent has them all): what is set and waiting for a person, nudges, the clock's due work. */
  contact?: Agent["contact"];
  outbox?: Agent["outbox"];
  recordNudge?: Agent["recordNudge"];
  setTimeZone?: Agent["setTimeZone"];
  setQuietHours?: Agent["setQuietHours"];
  runDue?: Agent["runDue"];
}

/**
 * The playground's clock: the agent's `now` (createAgent({ now: clock.now })), which the Person
 * panel moves forward to bring scheduled and held messages due. Real time plus an offset.
 */
export interface PlaygroundClock {
  now(): number;
  /** Moves the clock to `at` (ms since the epoch); never backwards. */
  set(at: number): void;
}

export function playgroundClock(): PlaygroundClock {
  let offset = 0;
  return {
    now: () => Date.now() + offset,
    set: (at) => void (offset = Math.max(offset, at - Date.now())),
  };
}

export interface SimulatorsOptions {
  /** The agent's name, shown in each simulator's header. */
  title?: string;
  /** The SMS provider's own replies; HELP is usually set to say who the agent is. */
  sms?: { helpReply?: string };
  /** How a custom UI shows the links in its params: the first card whose `match` is in the URL. */
  cards?: LinkCard[];
  /** The pages' HTML, for a host with no file system (Cloudflare); else read from this folder. */
  pages?: { page: string; person: string };
  /** The agent's clock (playgroundClock(), passed to createAgent as `now`): the Person panel can move it. */
  clock?: PlaygroundClock;
  /**
   * Adds "New user · signed out" to the person picker. `visitor` is an opaque browser identity,
   * scoped to the channel. Return the account `key` only after the application's normal auth
   * verifies it, plus its channel `address` if different from visitor. Keep credentials server-side.
   * Existing declared test people keep their current identity shortcut.
   */
  authentication?: (input: { channel: ChannelSummary; visitor: string }) => Promise<{
    key?: string;
    address?: string;
    label?: string;
    signInUrl?: string;
  }>;
}

export interface LinkCard {
  /** Text the link's URL contains, such as "/video/". */
  match: string;
  /** The card's button, such as "Start video call". */
  label: string;
  /** What opening it shows: a call screen, or a page of the app (the default). */
  kind?: "call" | "page";
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
type Listening = { close(): Promise<void>; url: string };

export interface LocalCliOptions {
  /** The team's actual defineCli configuration. The browser cannot override its endpoints. */
  config: CliConfig;
  /** The channel tab that opens this runner, e.g. "terminal". */
  channel: string;
}

export interface Playground {
  /** Pass to the agent's `events`: the trace and tool calls of test people's conversations. */
  events: EventSink;
  /** Serves the playground on 127.0.0.1 only; a token is optional there. */
  listen(agent: PlaygroundAgent, port: number, options?: { token?: string; localCli?: LocalCliOptions }): Promise<Listening>;
  /** The playground as a request handler under `base`, for a deployed agent's own server: a token is required. */
  handler(agent: PlaygroundAgent, options: { token: string; base?: string; localCli?: LocalCliOptions }): Handler;
}

/** Literal argv, with quoting and escaping, but no shell expansion, pipelines or execution. */
function cliWords(text: string): string[] {
  const words: string[] = [];
  let word = "", quote = "", started = false, escape = false;
  for (const ch of text) {
    if (escape) { word += ch; escape = false; started = true; }
    else if (ch === "\\" && quote !== "'") { escape = true; started = true; }
    else if (quote) { if (ch === quote) quote = ""; else word += ch; }
    else if (ch === '"' || ch === "'") { quote = ch; started = true; }
    else if (/\s/.test(ch)) { if (started) words.push(word); word = ""; started = false; }
    else { word += ch; started = true; }
  }
  if (quote || escape) throw new Error("Finish the quoted or escaped argument, then try again.");
  if (started) words.push(word);
  return words;
}

function localRequest(req: IncomingMessage): boolean {
  // TODO: hosted CLI execution needs a security review before implementation/deployment.
  // Keep this direct-loopback boundary; hosted support is not enabled by localCli options.
  const ip = req.socket.remoteAddress ?? "";
  return loopback(req.headers.host) && (ip === "::1" || /^127\./.test(ip) || /^::ffff:127\./.test(ip)) && !req.headers["x-forwarded-host"] && !req.headers["x-forwarded-for"];
}

/** Only explicitly enabled local playgrounds instantiate a runner; the test cloud never does. */
function localCliRunner(options: LocalCliOptions, base: string): Handler & { close(): void } {
  type Output = { seq: number; stream: "stdout" | "stderr" | "input" | "exit" | "login"; text: string };
  type Session = {
    directory: string; config: CliConfig; output: Output[]; seq: number; size: number; touched: number;
    running: boolean; waiting: boolean; abort: AbortController; accept?: (line: string | null) => void;
  };
  const sessions = new Map<string, Session>();
  const dispose = (s: Session) => { s.abort.abort(); s.accept?.(null); rmSync(s.directory, { recursive: true, force: true }); };
  const clean = () => { for (const [key, s] of sessions) if (Date.now() - s.touched > 30 * 60_000) { dispose(s); sessions.delete(key); } };
  const timer = setInterval(clean, 60_000); timer.unref();
  const close = () => { clearInterval(timer); for (const s of sessions.values()) dispose(s); sessions.clear(); process.removeListener("exit", close); };
  process.once("exit", close);
  const emit = (s: Session, stream: Output["stream"], text: string) => {
    if (s.abort.signal.aborted) return;
    // Keep a reconnectable tail, with a bounded amount of developer-visible output.
    text = text.slice(-128 * 1024);
    s.output.push({ seq: ++s.seq, stream, text }); s.size += text.length;
    while (s.size > 128 * 1024 && s.output.length > 1) s.size -= s.output.shift()!.text.length;
  };
  const input = (s: Session) => new Promise<string | null>((resolve) => {
    if (s.abort.signal.aborted) return resolve(null);
    s.waiting = true;
    s.accept = (line) => { s.waiting = false; s.accept = undefined; resolve(line); };
  });
  const handle: Handler = async (req, res) => {
    if (!localRequest(req) || crossSite(req)) return forbid(res, "The CLI runner is available only on the local playground's own origin.");
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = inside(url, base);
    clean();
    const cookie = `chinwag_cli_${createHash("sha256").update(`${req.headers.host} ${base}`).digest("hex").slice(0, 12)}`;
    let key = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${cookie}=`))?.slice(cookie.length + 1);
    let s = key ? sessions.get(key) : undefined;
    if (req.method === "POST" && path === "/api/cli/reset" && s) { dispose(s); sessions.delete(key!); s = undefined; }
    if (!s) {
      key = randomBytes(32).toString("base64url");
      const directory = mkdtempSync(join(tmpdir(), "chinwag-cli-"));
      s = { directory, config: { ...options.config, directory }, output: [], seq: 0, size: 0, touched: Date.now(), running: false, waiting: false, abort: new AbortController() };
      const owned = s;
      s.config.openUrl = (link) => emit(owned, "login", link);
      sessions.set(key, s);
      res.appendHeader("set-cookie", `${cookie}=${key}; HttpOnly; SameSite=Lax; Path=${base || "/"}`);
    }
    s.touched = Date.now();
    if (req.method === "GET" && path === "/api/cli") {
      const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
      return json(res, 200, { events: s.output.filter((e) => e.seq > after), seq: s.seq, running: s.running, waiting: s.waiting });
    }
    if (req.method === "POST" && path === "/api/cli/reset") return json(res, 200, { ok: true });
    if (req.method === "POST" && path === "/api/cli/input") {
      const body = await readBody(req, MAX_BODY);
      const text = typeof body?.text === "string" ? body.text.slice(0, 4_000) : "";
      if (!text.trim()) return json(res, 400, { error: "Enter a command or a reply." });
      if (s.running) {
        if (!s.accept) return json(res, 409, { error: "The CLI is still running. Wait for its input prompt." });
        emit(s, "input", `${text}\n`); s.accept(text);
        return json(res, 202, { ok: true });
      }
      let argv: string[];
      try { argv = cliWords(text); } catch (error) { return json(res, 400, { error: (error as Error).message }); }
      if (argv[0] === s.config.name) argv.shift();
      if (argv.some((w) => /^--(server|token)(=|$)/.test(w))) return json(res, 400, { error: "This runner uses its configured server and its own sign-in. Use auth login." });
      if (argv[0] === "skill" && argv.some((w) => /^--write(=|$)/.test(w))) return json(res, 400, { error: "Use the installed CLI to write a skill to your computer; this runner can display it with skill." });
      emit(s, "input", `$ ${text}\n`);
      s.running = true;
      const owned = s;
      const io: CliIO = {
        env: { NO_COLOR: "1", TERM: "dumb" }, signal: s.abort.signal, interactive: true,
        write: (text) => emit(owned, "stdout", text), writeError: (text) => emit(owned, "stderr", text),
        async *lines(prompt) {
          while (!owned.abort.signal.aborted) {
            if (prompt) emit(owned, "stdout", prompt);
            const line = await input(owned);
            if (line === null) return;
            yield line;
          }
        },
        confirm: async (question) => { emit(owned, "stderr", `${question} [y/N] `); return /^y(es)?$/i.test((await input(owned)) ?? ""); },
      };
      void import("../../cli/src/run.ts").then(({ runCli }) => runCli(owned.config, argv, io)).then(
        (code) => emit(owned, "exit", String(code)),
        () => { emit(owned, "stderr", "The CLI could not finish this command.\n"); emit(owned, "exit", "1"); },
      ).finally(() => { owned.running = false; owned.waiting = false; owned.accept = undefined; });
      return json(res, 202, { ok: true });
    }
    res.writeHead(404).end();
  };
  return Object.assign(handle, { close });
}

export interface TestCloudSimulators {
  events: EventSink;
  /** Where the agent's sends to one person's thread go, before they have written (a run the business starts). */
  deliverer(platform: string, person: string): Deliver;
  listen(agent: AgentConnection, port: number): Promise<Listening>;
  handler(agent: AgentConnection, base?: string): Handler;
}

export type Line =
  | { kind: "in"; id: string | null; text: string; at: number; replyTo?: string; choice?: boolean; attachments?: Array<{ kind: Attachment["kind"]; name?: string }> }
  | {
      kind: "out";
      id: string;
      text: string;
      at: number;
      replyTo?: string;
      buttons?: string[];
      list?: { button: string; rows: ListRow[] };
      /** A button under the message that opens this page. */
      link?: { label: string; url: string };
      authentication?: boolean;
      /** A photo above the text, which is its caption. */
      image?: { url: string };
      /** The channel's own params the agent filled in (an app_link): shown under the message. */
      fields?: Record<string, unknown>;
      /**
       * A WhatsApp template, by name; declared, with its header, footer and buttons, the text its
       * filled body. Not declared, the text lists the values it was sent with.
       */
      template?: { name: string; header?: FilledTemplate["header"]; footer?: string; buttons?: FilledTemplate["buttons"] };
      sms?: { segments: number; encoding: string };
      /** Sent by the SMS carrier itself (STOP, START, HELP replies), not the agent. */
      carrier?: boolean;
    }
  | { kind: "reaction"; messageId: string; emoji: string; at: number; by: "agent" | "person" }
  | { kind: "read"; messageIds: string[]; at: number }
  /** A tool call by the agent: shown only in the simulator's debug mode, never to the person. */
  | {
      kind: "tool";
      callId: string;
      tool: string;
      input: unknown;
      at: number;
      status: "running" | "background" | "done" | "failed";
      ms?: number;
      output?: string;
      /** Cloud tests: which kind of response the tool simulator played, and what it changed. */
      played?: string;
      changes?: string[];
    }
  | { kind: "undelivered"; text: string; reason: string; at: number };

// What a US SMS provider sends for the standard keywords (Twilio's defaults).
const CARRIER = {
  stop: ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"],
  start: ["START", "YES", "UNSTOP"],
  help: ["HELP", "INFO"],
  stopReply: "You have successfully been unsubscribed. You will not receive any more messages from this number. Reply START to resubscribe.",
  startReply: "You have successfully been re-subscribed to messages from this number. Reply HELP for help. Reply STOP to unsubscribe. Msg&Data Rates May Apply.",
  helpReply: "Reply STOP to unsubscribe. Msg&Data Rates May Apply.",
};

const MAX_BODY = 16_384;
/** A message may carry files (base64): up to 4, about 11 MB in all, above the largest the agent reads (10 MB). */
const MAX_MESSAGE_BODY = 15_000_000;
const MAX_FILES = 4;
const COOKIE = "chinwag_playground";
/** The events kept per conversation for pollers, and how long one stays kept after nobody asked for it. */
const RECENT_EVENTS = 500;
const RECENT_IDLE_MS = 5 * 60_000;
/** How long a poll waits for the next event before it answers with none. */
const POLL_WAIT_MS = 20_000;

/** An event as the page gets it: numbered, so a page knows what it has seen. */
type Numbered = Record<string, unknown> & { seq: number };
interface Recent {
  events: Numbered[];
  /** Events up to this number are not kept: a page that saw only those has missed some. */
  floor: number;
  waiters: Set<() => void>;
  touched: number;
}

interface Thread {
  lines: Line[];
  agentCount: number;
  carrierCount: number;
  optedOut: boolean;
}

export function simulators(options: SimulatorsOptions & { testCloud: true }): TestCloudSimulators;
export function simulators(options?: SimulatorsOptions & { testCloud?: false }): Playground;
export function simulators(options: SimulatorsOptions & { testCloud?: boolean } = {}): Playground | TestCloudSimulators {
  const cloud = options.testCloud === true;
  const playPage = options.pages?.page ?? readFileSync(new URL("./page.html", import.meta.url), "utf8");
  const personPage = options.pages?.person ?? readFileSync(new URL("./person.html", import.meta.url), "utf8");
  /**
   * Changes every time the server starts, so an open page from an older run reloads itself. Made
   * at the first request, not at import: on Cloudflare the clock and random numbers are fixed
   * until a request runs.
   */
  let started = "";
  const boot = () => (started ||= `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  const clients = new Map<string, Set<ServerResponse>>();
  const threads = new Map<string, Thread>();

  const thread = (k: string) => {
    let t = threads.get(k);
    if (!t) threads.set(k, (t = { lines: [], agentCount: 0, carrierCount: 0, optedOut: false }));
    return t;
  };

  /** The number of the last event pushed, on any conversation. */
  let seq = 0;
  /** The last events of each conversation a page opened, for pages that poll. */
  const recent = new Map<string, Recent>();

  /** The kept events of one conversation, kept from now on if they were not; drops ones nobody asked for lately. */
  function recentOf(k: string): Recent {
    const now = Date.now();
    for (const [key, r] of recent) if (!r.waiters.size && !clients.get(key)?.size && now - r.touched > RECENT_IDLE_MS) recent.delete(key);
    let r = recent.get(k);
    if (!r) recent.set(k, (r = { events: [], floor: seq, waiters: new Set(), touched: now }));
    r.touched = now;
    return r;
  }

  /** The events after `after`, or a reset when some of them are no longer kept (the page loads the transcript again). */
  function since(r: Recent, after: number): Array<Record<string, unknown>> {
    return Number.isInteger(after) && after >= r.floor ? r.events.filter((e) => e.seq > after) : [{ type: "reset" }];
  }

  function push(k: string, payload: object): void {
    const event: Numbered = { ...payload, seq: ++seq };
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients.get(k) ?? []) client.write(data);
    const r = recent.get(k);
    if (!r) return;
    r.events.push(event);
    if (r.events.length > RECENT_EVENTS) r.floor = r.events.splice(0, r.events.length - RECENT_EVENTS).at(-1)!.seq;
    for (const wake of [...r.waiters]) wake();
  }

  /** Record a line and show it to the open simulators. */
  function emitLine(k: string, line: Line): void {
    const t = thread(k);
    t.lines.push(line);
    if (t.lines.length > 500) t.lines.splice(0, t.lines.length - 500);
    push(k, { type: "line", line });
  }

  function findLine(k: string, id: string): Line | undefined {
    return thread(k).lines.find((l) => (l.kind === "in" || l.kind === "out") && l.id === id);
  }

  /** Tool calls in progress, by call id, so later events update the same line. */
  const toolLines = new Map<string, Extract<Line, { kind: "tool" }>>();

  function show(k: string, event: FlowEvent): void {
    if (event.type === "tool.start" && typeof event.callId === "string") {
      const line: Extract<Line, { kind: "tool" }> = { kind: "tool", callId: event.callId, tool: String(event.tool), input: event.input, at: event.at, status: "running" };
      toolLines.set(`${k}:${event.callId}`, line);
      emitLine(k, line);
    } else if ((event.type === "tool.end" || event.type === "tool.detached" || event.type === "task.done") && typeof event.callId === "string") {
      const line = toolLines.get(`${k}:${event.callId}`);
      if (line) {
        line.ms = Number(event.ms);
        if (event.type === "tool.detached") line.status = "background";
        else {
          line.status = event.ok === false ? "failed" : "done";
          line.output = typeof event.output === "string" ? event.output : undefined;
          toolLines.delete(`${k}:${event.callId}`);
        }
        push(k, { type: "lineUpdate", line });
      }
    }
    if (event.type === "message.undelivered") {
      emitLine(k, { kind: "undelivered", text: String(event.text), reason: String(event.reason), at: event.at });
    }
    push(k, { type: "trace", event });
  }

  /** What the platform does with one thing the agent sends. Throws when it would not arrive. */
  function deliverer(p: Platform, k: string, templates: TemplateDefinition[] = []) {
    return (outbound: Outbound) => {
      const t = thread(k);
      if (outbound.type === "template") {
        const { type: _type, ...sent } = outbound;
        const declared = declaredTemplate(templates, sent);
        let filled: FilledTemplate | null = null;
        try {
          if (p.id !== "whatsapp") throw new Error(`${p.name} has no templates`);
          if (declared) filled = fillTemplate(declared, sent);
        } catch (error) {
          emitLine(k, { kind: "undelivered", text: `template ${sent.name}`, reason: error instanceof Error ? error.message : String(error), at: Date.now() });
          throw error;
        }
        const { body, ...shown } = filled ?? { body: valuesOf(sent) };
        emitLine(k, { kind: "out", id: `a${++t.agentCount}`, text: body, at: Date.now(), template: { name: sent.name, ...shown } });
        return;
      }
      if (outbound.type === "message") {
        if (t.optedOut) throw new Error("the person texted STOP, so the carrier blocks messages to them");
        const sms = p.segments ? smsSegments(outbound.text) : undefined;
        emitLine(k, {
          kind: "out",
          id: `a${++t.agentCount}`,
          text: outbound.text,
          at: Date.now(),
          ...(outbound.replyTo ? { replyTo: outbound.replyTo } : {}),
          ...(outbound.buttons ? { buttons: outbound.buttons } : {}),
          ...(outbound.list ? { list: outbound.list } : {}),
          ...(outbound.link ? { link: outbound.link } : {}),
          ...(outbound.authentication ? { authentication: true } : {}),
          ...(outbound.image ? { image: outbound.image } : {}),
          ...(outbound.fields ? { fields: outbound.fields } : {}),
          ...(sms ? { sms: { segments: sms.segments, encoding: sms.encoding } } : {}),
        });
        return;
      }
      if (outbound.type === "reaction") {
        emitLine(k, { kind: "reaction", messageId: outbound.messageId, emoji: outbound.emoji, at: Date.now(), by: "agent" });
        return;
      }
      if (outbound.type === "read") {
        emitLine(k, { kind: "read", messageIds: outbound.messageIds, at: Date.now() });
        return;
      }
      push(k, { ...outbound, at: Date.now() });
    };
  }

  /** The SMS carrier's own handling of STOP, START and HELP. The text still reaches the agent. */
  function carrier(p: Platform, k: string, text: string): void {
    if (!p.carrierKeywords) return;
    const word = text.trim().toUpperCase();
    const t = thread(k);
    let reply: string | null = null;
    if (CARRIER.stop.includes(word)) {
      t.optedOut = true;
      reply = CARRIER.stopReply;
    } else if (CARRIER.start.includes(word)) {
      t.optedOut = false;
      reply = CARRIER.startReply;
    } else if (CARRIER.help.includes(word)) {
      reply = options.sms?.helpReply ?? CARRIER.helpReply;
    }
    if (reply) {
      const sms = smsSegments(reply);
      // In the playground the agent's ids come from the store, so the carrier's lines have their own.
      const id = cloud ? `a${++t.agentCount}` : `c${++t.carrierCount}`;
      emitLine(k, { kind: "out", id, text: reply, at: Date.now(), carrier: true, sms: { segments: sms.segments, encoding: sms.encoding } });
    }
  }

  function page(template: string, base: string): string {
    return template.replaceAll("{{title}}", escapeHtml(options.title ?? "Agent")).replaceAll("{{boot}}", boot()).replaceAll("{{base}}", base).replaceAll("{{mode}}", cloud ? "cloud" : "playground");
  }

  function serve(handle: Handler, port: number): Promise<Listening> {
    const server = createServer(handle);
    return new Promise((resolve, reject) => {
      // A port taken since it was chosen rejects, as an error the caller can print, never an unhandled 'error' event.
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () =>
        resolve({
          // The bound port, so port 0 (any free port) works too.
          url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          close: () => new Promise<void>((done) => server.close(() => done())),
        }),
      );
    });
  }

  const guarded = (work: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Handler => (req, res) =>
    work(req, res).catch((error) => {
      console.warn("flow simulators:", error);
      if (!res.headersSent) res.writeHead(500).end();
    });

  function events(req: IncomingMessage, res: ServerResponse, k: string, url: URL): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "hello", boot: boot() })}\n\n`);
    // What happened since the page read the transcript, so nothing between the two is lost.
    const after = url.searchParams.get("after");
    if (after !== null) for (const e of since(recentOf(k), Number(after))) res.write(`data: ${JSON.stringify(e)}\n\n`);
    const set = clients.get(k) ?? new Set();
    set.add(res);
    clients.set(k, set);
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      set.delete(res);
      // Kept a while longer, so a stream that reconnects goes on from where it was.
      const r = recent.get(k);
      if (r) r.touched = Date.now();
    });
  }

  /** The same events for a page the stream does not reach: at once if there are any after `after`, else the next. */
  async function poll(res: ServerResponse, k: string, url: URL): Promise<void> {
    const r = recentOf(k);
    const after = Number(url.searchParams.get("after"));
    if (!since(r, after).length) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          r.waiters.delete(done);
          res.off("close", done);
          resolve();
        };
        const timer = setTimeout(done, POLL_WAIT_MS);
        r.waiters.add(done);
        res.on("close", done);
      });
      if (res.destroyed) return;
    }
    r.touched = Date.now();
    json(res, 200, { boot: boot(), seq, events: since(r, after) });
  }

  /** The person's message as the agent gets it: the text, a quoted message, a tapped button, files. */
  function incomingOf(k: string, body: Record<string, unknown> | null, text: string, replies: boolean): { incoming: Incoming; line: Extract<Line, { kind: "in" }> } {
    const replyId = replies && typeof body?.replyTo === "string" ? body.replyTo : undefined;
    const quoted = replyId ? findLine(k, replyId) : undefined;
    const choice = body?.choice && typeof body.choice === "object" ? (body.choice as { id?: string; title?: string }) : undefined;
    const attachments = attachmentsOf(body);
    const incoming: Incoming = {
      text,
      ...(quoted && (quoted.kind === "in" || quoted.kind === "out") ? { replyTo: { text: quoted.text, fromAgent: quoted.kind === "out" } } : {}),
      ...(choice?.title ? { choice: { id: choice.id, title: String(choice.title) } } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
    const files = attachments.map((a) => ({ kind: a.kind, ...(a.name ? { name: a.name } : {}) }));
    const line: Extract<Line, { kind: "in" }> = { kind: "in", id: null, text, at: Date.now(), ...(quoted ? { replyTo: replyId } : {}), ...(choice?.title ? { choice: true } : {}), ...(files.length ? { attachments: files } : {}) };
    return { incoming, line };
  }

  // ---------------------------------------------------------------------------------------------
  // The test cloud.

  if (cloud) {
    const generations = new Map<string, number>();
    const key = (platformId: string, person: string) => `${platformId}:${person}`;
    const conversationId = (k: string) => {
      const generation = generations.get(k) ?? 0;
      return generation ? `${k}#${generation}` : k;
    };
    const cloudEvents: EventSink = (event) => show(event.conversationId.split("#")[0], event);

    async function handle(agent: AgentConnection, req: IncomingMessage, res: ServerResponse, base: string): Promise<void> {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = inside(url, base);
      const qp = platformOf(url.searchParams.get("platform"));
      const qperson = (url.searchParams.get("person") || "demo").slice(0, 128);
      const qk = key(qp.id, qperson);

      if (req.method === "GET" && path === "/") return html(res, page(playPage, base));
      if (req.method === "GET" && path === "/api/platforms") {
        const own = PLATFORMS.filter((p) => ownChannel(agent, p, conversationId(key(p.id, qperson)))).map((p) => ({ platform: p.id, channel: ownChannel(agent, p, conversationId(key(p.id, qperson)))!.name }));
        return json(res, 200, { platforms: PLATFORMS, own, cards: options.cards ?? [] });
      }
      if (req.method === "GET" && path === "/api/status") return json(res, 200, agent.status());
      if (req.method === "GET" && path === "/api/transcript") {
        const t = thread(qk);
        recentOf(qk);
        return json(res, 200, { platform: qp.id, person: qperson, optedOut: t.optedOut, lines: t.lines, seq });
      }
      if (req.method === "POST" && path === "/api/reset") {
        generations.set(qk, (generations.get(qk) ?? 0) + 1);
        threads.delete(qk);
        push(qk, { type: "reset" });
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && path === "/api/events") return events(req, res, qk, url);
      if (req.method === "GET" && path === "/api/poll") return poll(res, qk, url);

      const body = req.method === "POST" ? await readBody(req, path === "/api/messages" ? MAX_MESSAGE_BODY : MAX_BODY) : null;
      const p = typeof body?.platform === "string" ? platformOf(body.platform) : qp;
      const person = typeof body?.person === "string" && body.person ? body.person.slice(0, 128) : qperson;
      const k = key(p.id, person);

      if (req.method === "POST" && path === "/api/reactions") {
        const messageId = typeof body?.messageId === "string" ? body.messageId : "";
        const emoji = typeof body?.emoji === "string" ? body.emoji.slice(0, 16) : "";
        const target = findLine(k, messageId);
        if (!p.personReactions || !target || target.kind !== "out" || !emoji) {
          return json(res, 400, { error: "reactions need a platform that has them, an agent message id and an emoji" });
        }
        emitLine(k, { kind: "reaction", messageId, emoji, at: Date.now(), by: "person" });
        agent.reacted(conversationId(k), emoji, target.text);
        return json(res, 202, { ok: true });
      }

      if (req.method === "POST" && path === "/api/messages") {
        const text = typeof body?.text === "string" ? body.text.trim().slice(0, 4_000) : "";
        if (!text && !attachmentsOf(body).length) return json(res, 400, { error: "text or a file is required" });
        const { incoming, line } = incomingOf(k, body, text, Boolean(p.replies));
        emitLine(k, line);
        carrier(p, k, text);
        const id = conversationId(k);
        const own = ownChannel(agent, p, id);
        const messageId = agent.receive(id, incoming, deliverer(p, k), own ? { channel: own.info, channelName: own.name } : { channel: channelOf(p) });
        line.id = messageId;
        push(k, { type: "id", at: line.at, messageId });
        return json(res, 202, { messageId, at: line.at });
      }
      res.writeHead(404).end();
    }

    const testCloud: TestCloudSimulators = {
      events: cloudEvents,
      deliverer: (platform, person) => {
        const p = platformOf(platform);
        return deliverer(p, key(p.id, person));
      },
      listen: (agent, port) => serve(guarded((req, res) => handle(agent, req, res, "")), port),
      handler: (agent, base = "") => guarded((req, res) => handle(agent, req, res, base)),
    };
    return testCloud;
  }

  // ---------------------------------------------------------------------------------------------
  // The playground.

  /** The test person (by phone) each conversation belongs to, so its trace shows in their simulators. */
  type PlayingPerson = TestPerson & { key?: string; visitor?: string; visitorChannel?: string };
  const people = new Map<string, Map<string, PlayingPerson>>();
  let playing: PlaygroundAgent | null = null;
  const personKey = (person: PlayingPerson) => person.key ? `account:${person.key}` : person.visitor ? `visitor:${person.visitor}` : person.phone;
  const threadKey = (channel: string, person: PlayingPerson) => `${channel}:${personKey(person)}`;
  const rememberPerson = (id: string, person: PlayingPerson) => {
    const all = people.get(id) ?? new Map<string, PlayingPerson>();
    all.set(personKey(person), person); people.set(id, all);
  };
  const conversation = (agent: PlaygroundAgent, person: PlayingPerson) => person.key
    ? agent.visitorConversation!(person.key) : person.visitor ? agent.visitorConversation!(null, { channel: person.visitorChannel!, address: person.visitor }) : agent.testConversation(person.phone);

  const playgroundEvents: EventSink = (event) => {
    const known = people.get(event.conversationId);
    const person = known?.values().next().value;
    // A failed turn (a wrong or expired model key, say) on the terminal too, also for no known person.
    if (event.type === "model.error") console.error(`flow: model error${person ? ` (${person.name})` : ""}: ${String(event.error)}`);
    if (!known || !playing) return;
    for (const person of known.values()) for (const c of playing.channels()) show(threadKey(c.name, person), event);
  };

  function attach(agent: PlaygroundAgent): void {
    playing = agent;
    agent.attachPlayground(({ conversationId, person, channel, outbound }) => {
      rememberPerson(conversationId, { ...person, visitorChannel: channel });
      const own = agent.channels().find((c) => c.name === channel);
      if (own) for (const other of people.get(conversationId)!.values()) deliverer(platformFor(own), threadKey(channel, other), agent.templates?.())(outbound);
    });
  }

  /** The conversation on one channel, rebuilt from the agent's store, with what only the platform showed (the carrier's replies). */
  async function load(agent: PlaygroundAgent, person: PlayingPerson, channel: ChannelSummary): Promise<Thread> {
    const k = threadKey(channel.name, person);
    const t = thread(k);
    const id = await conversation(agent, person);
    if (id) rememberPerson(id, person);
    const p = platformFor(channel);
    let count = 0;
    const lines: Line[] = [];
    for (const e of id ? await agent.transcript(id) : []) {
      if (e.kind === "tool") {
        lines.push({ kind: "tool", callId: e.callId, tool: e.tool, input: e.input, at: e.at, status: e.ok ? "done" : "failed", output: e.output });
        continue;
      }
      if (e.channel !== channel.name) continue;
      if (e.kind === "in") lines.push({ kind: "in", id: e.id, text: e.text, at: e.at, ...(e.choice ? { choice: true } : {}) });
      else if (e.kind === "out" && e.template) {
        // The store keeps a template's name and body text, not its other values: those show as declared.
        const declared = agent.templates?.().find((d) => d.name === e.template);
        lines.push({ kind: "out", id: `a${++count}`, text: e.text, at: e.at, template: { name: e.template, ...(declared ? asDeclared(declared) : {}) } });
      } else if (e.kind === "reaction") lines.push({ kind: "reaction", messageId: e.messageId, emoji: e.emoji, at: e.at, by: "agent" });
      else {
        // The agent's message as this platform showed it (a link's URL in the text where it has no link button).
        const { kind: _kind, channel: _channel, template: _template, ...rest } = fitMessage(channel.info, e);
        const sms = p.segments ? smsSegments(rest.text) : undefined;
        lines.push({ kind: "out", id: `a${++count}`, ...rest, ...(sms ? { sms: { segments: sms.segments, encoding: sms.encoding } } : {}) });
      }
    }
    const stored = new Set(lines.flatMap((l) => (l.kind === "in" && l.id ? [l.id] : [])));
    const onlyHere = t.lines.filter((l) => (l.kind === "out" && l.carrier) || (l.kind === "in" && !(l.id && stored.has(l.id))));
    t.lines = [...lines, ...onlyHere].sort((a, b) => a.at - b.at);
    t.agentCount = count;
    return t;
  }

  async function handle(agent: PlaygroundAgent, req: IncomingMessage, res: ServerResponse, base: string, gate: Gate | null, cli?: { options: LocalCliOptions; handle: Handler }): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = inside(url, base);
    // Without a token, a page on another site (or a DNS name rebound to 127.0.0.1) must not run
    // turns on the developer's key: only a loopback Host, and the API only from the playground's own page.
    if (!gate && !loopback(req.headers.host)) return forbid(res, "This playground answers only on localhost or 127.0.0.1.");
    if (path.startsWith("/api/") && crossSite(req)) return forbid(res, "This playground's API answers only its own page.");
    if (gate && !gate.allows(req, res, url, base)) return;
    if (path === "/api/cli" || path.startsWith("/api/cli/")) {
      if (!cli) { res.writeHead(404).end(); return; }
      return cli.handle(req, res);
    }

    if (req.method === "GET" && path === "/") return html(res, page(playPage, base));
    if (req.method === "GET" && path === "/person") return html(res, page(personPage, base));
    if (req.method === "GET" && path === "/api/status") return json(res, 200, agent.status());
    if (req.method === "GET" && path === "/api/platforms") {
      const channels = agent.channels().map((c) => ({ name: c.name, kind: c.kind, platform: platformFor(c) }));
      return json(res, 200, {
        platforms: PLATFORMS, channels, people: agent.testPeople(), cards: options.cards ?? [], authentication: !!options.authentication,
        ...(cli && localRequest(req) ? { localCli: { channel: cli.options.channel, name: cli.options.config.name } } : {}),
        templates: (agent.templates?.() ?? []).map((t) => ({ name: t.name, body: t.body })),
        panel: { person: !!(agent.contact && agent.outbox), nudge: !!agent.recordNudge, clock: !!(options.clock && agent.runDue) },
      });
    }

    const body = req.method === "POST" ? await readBody(req, path === "/api/messages" ? MAX_MESSAGE_BODY : MAX_BODY) : null;
    /** What the Person panel did (moved the clock, sent a nudge), in every open page's trace. */
    const announce = (label: string, outcome: { ok: true; result?: string } | { ok: false; error: string }) => {
      const event = { type: "action", label, at: Date.now(), ...outcome };
      for (const key of new Set([...clients.keys(), ...recent.keys()])) push(key, event);
    };

    if (req.method === "POST" && path === "/api/clock") {
      if (!options.clock || !agent.runDue) return json(res, 400, { error: "give simulators({ clock }) the agent's clock (playgroundClock())" });
      const to = typeof body?.to === "number" ? body.to : typeof body?.advanceMs === "number" ? options.clock.now() + body.advanceMs : NaN;
      if (!Number.isFinite(to)) return json(res, 400, { error: "give to (ms since the epoch) or advanceMs" });
      options.clock.set(to);
      const ran = await agent.runDue();
      const result = `clock at ${new Date(options.clock.now()).toISOString().replace(".000Z", "Z")}; ${ran} scheduled message${ran === 1 ? "" : "s"} due`;
      announce("Clock", { ok: true, result });
      return json(res, 200, { now: options.clock.now(), ran });
    }

    const asked = (name: string) => (typeof body?.[name] === "string" ? (body[name] as string) : (url.searchParams.get(name) ?? ""));
    const isVisitor = asked("person") === "visitor";
    let person: PlayingPerson | undefined = agent.testPeople().find((p) => digits(p.phone) === digits(asked("person")) && digits(p.phone) !== "");
    const channel = agent.channels().find((c) => c.name === asked("channel"));
    let visitorAddress = "";
    if (isVisitor && options.authentication) {
      if (!channel) return json(res, 400, { error: "channel must be one of the agent's own channels" });
      if (!agent.simulateVisitor || !agent.visitorConversation) return json(res, 400, { error: "this playground needs an agent with authenticated visitor support" });
      const cookieName = `chinwag_visitor_${createHash("sha256").update(`${req.headers.host} ${base}`).digest("hex").slice(0, 12)}`;
      let browser = (req.headers.cookie ?? "").split(/;\s*/).find((cookie) => cookie.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      if (!browser || !/^[A-Za-z0-9_-]{43}$/.test(browser)) browser = undefined;
      const reset = req.method === "POST" && path === "/api/auth/reset";
      if (!browser || reset) {
        browser = randomBytes(32).toString("base64url");
        const secure = (req.socket as TLSSocket).encrypted || req.headers["x-forwarded-proto"] === "https";
        res.setHeader("set-cookie", `${cookieName}=${browser}; HttpOnly; SameSite=Lax; Path=${base || "/"}; Max-Age=2592000${secure ? "; Secure" : ""}`);
      }
      // Each interface needs its own proof. A web login cannot authenticate an unrelated CLI.
      const visitor = createHash("sha256").update(JSON.stringify([browser, channel.name])).digest("base64url");
      const state = await options.authentication({ channel, visitor });
      const publicState = { signedIn: !!state.key, label: state.label, signInUrl: state.signInUrl };
      if (path === "/api/auth" || reset) return json(res, 200, publicState);
      visitorAddress = state.address ?? visitor;
      person = state.key ? { phone: "", name: "Signed-in user", key: state.key } : { phone: "", name: "New user", visitor: visitorAddress, visitorChannel: channel.name };
    } else if (!person) return json(res, 403, { error: "choose a declared test person, or a new user when sign-in is configured" });
    if (!person) return json(res, 403, { error: "Sign in to continue." });
    if (path === "/api/auth") return json(res, 200, { signedIn: true });

    if (req.method === "POST" && path === "/api/clear") {
      const id = await conversation(agent, person);
      if (id) {
        await agent.forgetPerson(id);
        people.delete(id);
      }
      for (const c of agent.channels()) {
        const k = threadKey(c.name, person);
        threads.delete(k);
        push(k, { type: "reset" });
      }
      return json(res, 200, { ok: true });
    }

    if (!channel) return json(res, 400, { error: "channel must be one of the agent's own channels" });
    const k = threadKey(channel.name, person);
    const p = platformFor(channel);

    // The Person panel: what is set and waiting for this person, and the business's side (nudges).
    const to = { channel: channel.name, address: person.key ? visitorAddress : person.visitor ? `visitor:${visitorAddress}` : channel.kind === "custom" ? `test:${person.phone}` : person.phone };
    if (req.method === "GET" && path === "/api/person") {
      if (!agent.contact || !agent.outbox) return json(res, 404, { error: "this agent has no contact record" });
      const id = await conversation(agent, person);
      // One person on every channel: their record from whichever channel they have written on.
      let contact = await agent.contact(to);
      if (!person.key && !person.visitor) for (const c of agent.channels()) contact ??= await agent.contact({ channel: c.name, address: c.kind === "custom" ? `test:${person.phone}` : person.phone });
      // When the agent wrote on each channel (its latest 20), so the page can flag a channel it is not showing.
      const lastOut: Record<string, number[]> = {};
      for (const e of id ? await agent.transcript(id) : []) if (e.kind === "out") lastOut[e.channel] = [...(lastOut[e.channel] ?? []), e.at].slice(-20);
      return json(res, 200, { now: options.clock?.now() ?? Date.now(), contact, outbox: id ? await agent.outbox(id) : { schedules: [], held: [] }, lastOut });
    }
    if (req.method === "POST" && path === "/api/nudge") {
      if (!agent.recordNudge) return json(res, 404, { error: "this agent takes no nudges" });
      const kind = body?.kind;
      const input = {
        to,
        ...(kind === "text" ? { text: String(body?.text ?? "") } : kind === "template" ? { template: { name: String(body?.template ?? ""), ...(Array.isArray(body?.body) && body.body.length ? { body: body.body.map(String) } : {}) } } : { prompt: String(body?.prompt ?? "") }),
        ...(typeof body?.at === "number" ? { at: body.at } : {}),
        ...(body?.respect_quiet_hours === false ? { respectQuietHours: false } : {}),
        ...(typeof body?.expires_at === "number" ? { expiresAt: body.expires_at } : {}),
        ...(typeof body?.idempotency_key === "string" && body.idempotency_key ? { idempotencyKey: body.idempotency_key } : {}),
      };
      try {
        const state = await agent.recordNudge(input);
        announce(`Nudge (${kind ?? "prompt"}) to ${person.name}`, { ok: true, result: `${state.status}${state.reason ? `: ${state.reason}` : ""}${state.id ? ` (${state.id})` : ""}` });
        return json(res, 202, state);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        announce(`Nudge to ${person.name}`, { ok: false, error: message });
        return json(res, 400, { error: message });
      }
    }
    if (req.method === "POST" && (path === "/api/time-zone" || path === "/api/quiet-hours")) {
      if (!agent.setTimeZone || !agent.setQuietHours) return json(res, 404, { error: "this agent has no contact record" });
      try {
        const result = path === "/api/time-zone"
          ? await agent.setTimeZone({ to, timeZone: String(body?.time_zone ?? "") })
          : await agent.setQuietHours({ to, quietHours: (body?.quiet_hours ?? null) as never });
        announce(path === "/api/time-zone" ? `Time zone for ${person.name}` : `Quiet hours for ${person.name}`, { ok: true, result: result.status === "set" ? "set" : "they have not written on this channel yet" });
        return json(res, result.status === "set" ? 200 : 404, result);
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (req.method === "GET" && path === "/api/transcript") {
      const t = await load(agent, person, channel);
      // Taken with the lines, in the same step: every event after this number came after these lines.
      recentOf(k);
      return json(res, 200, { channel: channel.name, person: { name: person.name, phone: person.phone }, optedOut: t.optedOut, lines: t.lines, seq });
    }
    if (req.method === "GET" && path === "/api/events") return events(req, res, k, url);
    if (req.method === "GET" && path === "/api/poll") return poll(res, k, url);

    if (req.method === "POST" && path === "/api/reactions") {
      const messageId = typeof body?.messageId === "string" ? body.messageId : "";
      const emoji = typeof body?.emoji === "string" ? body.emoji.slice(0, 16) : "";
      const target = findLine(k, messageId);
      const id = await conversation(agent, person);
      if (!p.personReactions || !target || target.kind !== "out" || !emoji || !id) {
        return json(res, 400, { error: "reactions need a platform that has them, an agent message id and an emoji" });
      }
      emitLine(k, { kind: "reaction", messageId, emoji, at: Date.now(), by: "person" });
      agent.reacted(id, emoji, target.text);
      return json(res, 202, { ok: true });
    }

    if (req.method === "POST" && path === "/api/messages") {
      const text = typeof body?.text === "string" ? body.text.trim().slice(0, 4_000) : "";
      if (!text && !attachmentsOf(body).length) return json(res, 400, { error: "text or a file is required" });
      const { incoming, line } = incomingOf(k, body, text, Boolean(p.replies));
      console.info(JSON.stringify({ chinwag: "playground.message", person: person.name, channel: channel.name, at: new Date(line.at).toISOString() }));
      emitLine(k, line);
      carrier(p, k, text);
      const taken = person.key || person.visitor ? await agent.simulateVisitor!({ key: person.key, address: visitorAddress, channel: channel.name, message: incoming })
        : await agent.simulate({ person: person.phone, channel: channel.name, message: incoming });
      if (taken) rememberPerson(taken.conversationId, person);
      line.id = taken?.messageId ?? null;
      push(k, { type: "id", at: line.at, messageId: line.id });
      return json(res, 202, { messageId: line.id, at: line.at });
    }
    res.writeHead(404).end();
  }

  const playground: Playground = {
    events: playgroundEvents,
    listen: async (agent, port, listenOptions = {}) => {
      const gate = listenOptions.token === undefined ? null : tokenGate(listenOptions.token);
      attach(agent);
      const runner = listenOptions.localCli ? localCliRunner(listenOptions.localCli, "") : undefined;
      const cli = runner ? { options: listenOptions.localCli!, handle: runner } : undefined;
      try {
        const listening = await serve(guarded((req, res) => handle(agent, req, res, "", gate, cli)), port);
        return { ...listening, close: async () => { runner?.close(); await listening.close(); } };
      } catch (error) { runner?.close(); throw error; }
    },
    handler: (agent, handlerOptions) => {
      const gate = tokenGate(handlerOptions?.token);
      attach(agent);
      const base = handlerOptions.base ?? "";
      const cli = handlerOptions.localCli ? { options: handlerOptions.localCli, handle: localCliRunner(handlerOptions.localCli, base) } : undefined;
      return guarded((req, res) => handle(agent, req, res, base, gate, cli));
    },
  };
  return playground;
}

interface Gate {
  /** Lets the request through, or answers it (refused, or the token swapped for a cookie). */
  allows(req: IncomingMessage, res: ServerResponse, url: URL, base: string): boolean;
}

/**
 * The playground's lock on a deployed agent. The token comes once as `?token=` (swapped for an
 * HttpOnly, SameSite=Lax cookie, and dropped from the URL) or on every API call as
 * `Authorization: Bearer`. Lax lets sign-in return from another site. Compared in constant time; wrong tokens are limited per address.
 */
function tokenGate(token: string | undefined): Gate {
  requireToken(token, "flow simulators: a deployed playground");
  // The cookie holds a value made from the token, not the token itself.
  const session = createHash("sha256").update(`chinwag-playground:${token}`).digest("hex");
  // Cookies are shared across localhost ports: independent agents must not overwrite each other.
  const cookieName = `${COOKIE}_${session.slice(0, 12)}`;
  const tries = wrongTries();

  return {
    allows(req, res, url, base) {
      const ip = req.socket.remoteAddress ?? "unknown";
      const blocked = tries.blocked(ip);
      const fail = () => {
        tries.failed(ip);
        refuse(res, 401);
        return false;
      };
      const secure = (req.socket as TLSSocket).encrypted || req.headers["x-forwarded-proto"] === "https";
      const sessionCookie = `${cookieName}=${session}; Path=${base || "/"}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
      const query = url.searchParams.get("token");
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      if ((query !== null || bearer !== undefined) && blocked) {
        refuse(res, 429);
        return false;
      }
      if (query !== null) {
        if (req.method !== "GET" || !sameSecret(query, token)) return fail();
        url.searchParams.delete("token");
        const rest = url.searchParams.toString();
        res.writeHead(303, { "set-cookie": sessionCookie, location: url.pathname + (rest ? `?${rest}` : ""), "cache-control": "no-store" }).end();
        return false;
      }
      if (bearer !== undefined) return sameSecret(bearer, token) ? true : fail();
      const cookie = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      if (cookie !== undefined && sameSecret(cookie, session)) {
        // Renew on page visits so existing Strict cookies also survive the next sign-in round trip.
        if (req.method === "GET" && ["/", "/person"].includes(inside(url, base))) res.setHeader("set-cookie", sessionCookie);
        return true;
      }
      refuse(res, 401);
      return false;
    },
  };
}

function refuse(res: ServerResponse, status: 401 | 429): void {
  const text = status === 429 ? "Too many wrong tokens from this address. Try again later." : "This playground needs its token: open it with ?token=<token>, or send Authorization: Bearer <token>.";
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(text);
}

/** A Host that names this machine: localhost (or a name under it), 127.x.x.x or [::1], any port. */
function loopback(host: string | undefined): boolean {
  const name = (host ?? "").toLowerCase().replace(/:\d+$/, "");
  return name === "localhost" || name.endsWith(".localhost") || name === "[::1]" || /^127(\.\d{1,3}){3}$/.test(name);
}

/** A browser call from another origin: Sec-Fetch-Site says so, or (older browsers) an Origin unlike the Host. */
function crossSite(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined) return site !== "same-origin" && site !== "none";
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  const forwarded = req.headers["x-forwarded-host"];
  const host = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0].trim() || req.headers.host;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

function forbid(res: ServerResponse, text: string): void {
  res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(text);
}

/** The path inside the simulators, whatever they are mounted under. */
function inside(url: URL, base: string): string {
  return base && url.pathname.startsWith(base) ? url.pathname.slice(base.length) || "/" : url.pathname;
}

/** The simulator that plays one of the agent's channels: SMS, WhatsApp, or the web for a custom UI. */
function platformFor(channel: ChannelSummary): Platform {
  return { ...platformOf(channel.kind === "custom" ? "web" : channel.kind), ...channel.info };
}

const digits = (phone: string) => phone.replace(/[^\d]/g, "");

/** The agent's own channel a simulator plays, if it has one of that kind. */
function ownChannel(agent: AgentConnection, p: Platform, conversationId: string): ChannelSummary | undefined {
  const kind = p.id === "web" ? "custom" : p.id;
  return agent.channels?.(conversationId).find((c) => c.kind === kind);
}

/** A template the agent did not declare: the values it was sent with, one per line. */
function valuesOf(sent: Template): string {
  const header = sent.header && (sent.header.kind === "text" ? sent.header.text : `${sent.header.kind}: ${sent.header.url ?? sent.header.fileId}`);
  const body = sent.body ?? Object.values(sent.variables ?? {});
  return [...(header ? [header] : []), ...body, ...(sent.buttons ?? []).map((b) => `button ${b.index}: ${b.value}`)].join("\n");
}

/** A declared template's header, footer and buttons without one send's values (a header's {{1}} as …). */
function asDeclared(d: TemplateDefinition): Omit<FilledTemplate, "body"> {
  const header = d.header?.kind === "text" ? { kind: "text" as const, text: d.header.text.replace("{{1}}", "…") } : d.header;
  const buttons = (d.buttons ?? []).map((b) => (b.type === "quick_reply" ? { ...b, payload: b.text } : b.type === "url" ? { ...b, url: b.url.replace(/\{\{1\}\}$/, "") } : b));
  return { ...(header ? { header } : {}), ...(d.footer ? { footer: d.footer } : {}), buttons };
}

/** The files of a message, from the page: { kind, mime, name?, data (base64) }. */
function attachmentsOf(body: Record<string, unknown> | null): Attachment[] {
  if (!Array.isArray(body?.attachments)) return [];
  return body.attachments.slice(0, MAX_FILES).flatMap((a): Attachment[] => {
    if (!a || typeof a !== "object" || typeof a.mime !== "string" || typeof a.data !== "string" || !["image", "audio", "document"].includes(a.kind)) return [];
    const bytes = new Uint8Array(Buffer.from(a.data, "base64"));
    return [{ kind: a.kind, mime: a.mime.slice(0, 100), ...(typeof a.name === "string" && a.name ? { name: a.name.slice(0, 200) } : {}), data: async () => bytes }];
  });
}

async function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<Record<string, unknown> | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(value));
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}
