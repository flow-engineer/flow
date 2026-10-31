import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent, sqlite, tool, type AgentOptions, type Database, type TemplateDefinition, type TestPerson } from "../src/index.ts";
import type { ChannelInfo, ChannelKind, ChatMessage, Keywords, Model, ModelRequest, ModelResponse, Outbound, FlowEvent, ToolCall } from "../src/index.ts";

/**
 * A model the test drives: each call waits for the test to answer it. The step after a reply that was
 * only delivered messages (one said next: "act", or something came in meanwhile) is answered with
 * nothing, and counted in `followUps`, unless `followUps: "manual"`: then it is a call like any other.
 */
export function scriptedModel(options: { followUps?: "auto" | "manual" } = {}) {
  const calls: Array<{ request: ModelRequest; answer(r: ModelResponse): void; fail(error: Error): void }> = [];
  const followUps: ModelRequest[] = [];
  const waiters: Array<() => void> = [];
  const model: Model = {
    complete(request) {
      if (options.followUps !== "manual" && isFollowUp(request)) {
        followUps.push(request);
        return Promise.resolve({ text: null, toolCalls: [] });
      }
      return new Promise((resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("aborted")));
        calls.push({ request, answer: resolve, fail: reject });
        waiters.splice(0).forEach((w) => w());
      });
    },
  };
  async function nextCall(index: number) {
    while (calls.length <= index) await new Promise<void>((r) => waiters.push(r));
    return calls[index];
  }
  return { model, calls, followUps, nextCall };
}

/** The step after a response that only talked (sent messages, reacted), all of it delivered. */
function isFollowUp(request: ModelRequest): boolean {
  const i = request.messages.findLastIndex((m) => m.role === "assistant");
  const last = request.messages[i];
  if (!last || last.role !== "assistant" || !last.toolCalls?.length) return false;
  const after = request.messages.slice(i + 1);
  const talk = (name: string) => name.startsWith("send_") || name === "react" || name === "share_updates" || name === "edit_message" || name === "unsend_message";
  const went = (name: string, content: string) =>
    name.startsWith("send_") ? content.startsWith('{"delivered":true') : name === "edit_message" ? content.startsWith('{"edited":true') : name === "unsend_message" ? content.startsWith('{"unsent":true') : content === "";
  return (
    last.toolCalls.every((c) => talk(c.name)) &&
    after.length === last.toolCalls.length &&
    after.every((m, k) => m.role === "tool" && went(last.toolCalls![k].name, m.content))
  );
}

export function gate<T = void>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((r) => (open = r));
  return { promise, open };
}

let ids = 0;
export const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: `c${++ids}`, name, arguments: JSON.stringify(args) });
export const say = (text: string) => call("send_chat", { text });
export const respond = (...toolCalls: ToolCall[]): ModelResponse => ({ text: null, toolCalls });

export const WEB: ChannelInfo = { reactions: true, status: true };

export function harness(tools = [] as ReturnType<typeof tool>[], deadlineMs = 50, channel: ChannelInfo = WEB, followUps: "auto" | "manual" = "auto") {
  const dir = mkdtempSync(join(tmpdir(), "flow-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel({ followUps });
  const events: FlowEvent[] = [];
  const agent = createAgent({ dir, model: scripted.model, tools, deadlineMs, partialAfterMs: 20, debounceMs: 0, events: [(e) => events.push(e)] });
  const out: Outbound[] = [];
  let fail: string | null = null;
  const deliver = (o: Outbound) => {
    if (fail && o.type === "message") throw new Error(fail);
    out.push(o);
  };
  const sent = () => out.flatMap((o) => (o.type === "message" ? [o.text] : []));
  const send = (conversation: string, text: string) => agent.receive(conversation, text, deliver, { channel });
  return { agent, out, sent, send, events, failNext: (reason: string | null) => (fail = reason), ...scripted };
}

export const users = (messages: ChatMessage[]) => messages.filter((m) => m.role === "user").map((m) => m.content);
export const last = (messages: ChatMessage[]) => messages.at(-1) as { role: string; content: string };

export const WHATSAPP: ChannelInfo = {
  reactions: true,
  status: false,
  formatting: "whatsapp",
  maxLength: 4096,
  replies: true,
  buttons: { max: 3, labelMax: 20 },
  lists: { maxRows: 10, titleMax: 24, buttonMax: 20 },
  readReceipts: true,
};
export const SMS: ChannelInfo = { reactions: false, status: false, formatting: "plain", maxLength: 1600 };

export const WEB_APP: ChannelInfo = { reactions: true, status: true, formatting: "markdown", buttons: { max: 3, labelMax: 20 } };

/** An agent with real channels (by name), for one person across several of them. */
export function multi(options: {
  /** Each channel is custom unless it names its kind. */
  channels: Record<string, { info: ChannelInfo; phone?: boolean; kind?: ChannelKind; keywords?: Keywords }>;
  tools?: ReturnType<typeof tool>[];
  database?: Database;
  /** Instead of `database`: the agent's store. */
  store?: AgentOptions["store"];
  resolve?: AgentOptions["resolve"];
  credentials?: AgentOptions["credentials"];
  auth?: AgentOptions["auth"];
  now?: () => number;
  timeZone?: string;
  dir?: string;
  testPeople?: TestPerson[];
  templates?: TemplateDefinition[];
  history?: { maxTokens?: number; toolResultChars?: number };
  defaultCountryCode?: string;
  intercept?: AgentOptions["intercept"];
  profile?: AgentOptions["profile"];
  fallbackTemplate?: AgentOptions["fallbackTemplate"];
  beforeSend?: AgentOptions["beforeSend"];
  wakeUps?: AgentOptions["wakeUps"];
}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "flow-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  const database = options.database ?? sqlite();
  const events: FlowEvent[] = [];
  const out: Array<{ channel: string; address: string; outbound: Outbound }> = [];
  const channels = Object.entries(options.channels).map(([name, c]) => ({
    name,
    kind: "custom" as const,
    ...c,
    send: (address: string, outbound: Outbound) => {
      out.push({ channel: name, address, outbound });
      for (const w of waiting.splice(0)) (w.test() ? w.resolve() : waiting.push(w));
    },
  }));
  const waiting: Array<{ test: () => boolean; resolve: () => void }> = [];
  /** Resolves once something sent so far passes `test` (a gate on the channels' sends). */
  const sentWhere = (test: (o: (typeof out)[number]) => boolean) =>
    new Promise<void>((resolve) => {
      const check = () => out.some(test);
      if (check()) resolve();
      else waiting.push({ test: check, resolve });
    });
  const agent = createAgent({
    dir,
    model: scripted.model,
    tools: options.tools ?? [],
    deadlineMs: 50,
    debounceMs: 0,
    events: [(e) => events.push(e)],
    channels,
    ...(options.store ? { store: options.store } : { database }),
    resolve: options.resolve,
    credentials: options.credentials,
    auth: options.auth,
    now: options.now,
    timeZone: options.timeZone,
    testPeople: options.testPeople,
    templates: options.templates,
    history: options.history,
    defaultCountryCode: options.defaultCountryCode,
    intercept: options.intercept,
    profile: options.profile,
    fallbackTemplate: options.fallbackTemplate,
    beforeSend: options.beforeSend,
    wakeUps: options.wakeUps,
    scheduleCheckMs: 0,
  });
  const texts = (channel?: string) =>
    out.flatMap((o) => (o.outbound.type === "message" && (!channel || o.channel === channel) ? [o.outbound.text] : []));
  const message = (channel: string, from: string, text: string) => agent.message({ channel, from, message: text });
  /** The first model call from `from` on that satisfies `test` (earlier ones were restarted by a later message). */
  async function callWith(from: number, test: (c: Awaited<ReturnType<typeof scripted.nextCall>>) => boolean) {
    for (let i = from; ; i++) {
      const c = await scripted.nextCall(i);
      if (test(c)) return { call: c, index: i };
    }
  }
  return { agent, out, texts, message, events, callWith, dir, database, sentWhere, ...scripted };
}

/**
 * An agent folder in `parent`, committed to git, for `flow cli pack`: a CLI file over the
 * framework's own source, named acme, that ships context/about.txt and reads its description from
 * it. `guard` replaces the line that starts it; `agent` sets an agent URL, `servers` its servers;
 * `brand: false` leaves its brand name out (package.json's displayName is Acme Coffee).
 */
export function cliAgentFolder(parent: string, options: { guard?: string; agent?: string; servers?: Record<string, string>; brand?: false } = {}): string {
  const framework = fileURLToPath(new URL("../cli/src/index.ts", import.meta.url));
  const dir = mkdtempSync(join(parent, "agent-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "context"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "acme", displayName: "Acme Coffee", version: "0.1.0", type: "module" }));
  writeFileSync(join(dir, "package-lock.json"), "{}");
  writeFileSync(join(dir, "src", "agent.ts"), "export function buildAgent() {}\n");
  writeFileSync(join(dir, "src", "cli.ts"), `#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cliFile, defineCli, runCli } from ${JSON.stringify(framework)};

export const cli = defineCli({
  name: "acme",
  server: process.env.ACME_SERVER ?? "http://127.0.0.1:8790/mcp",${options.agent ? `\n  agent: ${JSON.stringify(options.agent)},` : ""}
  description: readFileSync(cliFile("context/about.txt"), "utf8").trim(),
${options.brand === false ? "" : `  brand: { name: "Acme's Coffee" },\n`}${options.servers ? `  servers: ${JSON.stringify(options.servers)},\n` : ""}  files: ["context/about.txt"],
});

if (${options.guard ?? "process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)"}) process.exit(await runCli(cli, process.argv.slice(2)));
`);
  writeFileSync(join(dir, "context", "about.txt"), "Coffee, ordered from a terminal.\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "agent");
  return dir;
}
