// Runs an organization's CLI on Stricli (@stricli/core, the framework Sentry's CLI is built on):
// command groups whose help lists their subcommands (`acme order`, `acme order -h`), help for every
// command (`acme order place -h`), typo suggestions, typed flags and positional arguments. On top of
// it, the conventions agents and scripts rely on: --json (and --fields) on every tool command,
// --dry-run on anything that changes things, --yes needed without a terminal for what may delete or
// overwrite, and fixed exit codes. The commands come from the server's tools at run time, shaped by
// the CLI file (commands.ts).

import { runTerminal } from "./terminal.ts";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { Client, InsufficientScopeError, ProtocolError, ProtocolErrorCode, SdkHttpError, StreamableHTTPClientTransport, UnauthorizedError, type AuthProvider, type OAuthClientProvider, type Tool as McpTool } from "@modelcontextprotocol/client";
import { buildApplication, buildCommand, buildRouteMap, ExitCode, numberParser, run as runStricli, text_en, type Command as StricliCommand, type RouteMap } from "@stricli/core";
import { configDir, isSignedIn, signIn, signOut, storedProvider } from "./auth.ts";
import {
  BUILT_IN,
  commandTable,
  flagKind,
  flagName,
  findCommand,
  isCustom,
  skillFile,
  tokenEnvOf,
  typeHint,
  type CliConfig,
  type CliContext,
  type Command,
  type JsonSchema,
  type ToolInfo,
} from "./commands.ts";

export const EXIT = { ok: 0, failed: 1, usage: 2, signIn: 3, approval: 4, unreachable: 5 } as const;

export interface CliIO {
  /** An embedded client's environment; omitted uses the local process environment. */
  env?: Record<string, string | undefined>;
  /** Cancels embedded sign-in, terminal requests and discovery refreshes when the session ends. */
  signal?: AbortSignal;
  /** Schedule discovery work without delaying output. Omitted uses a detached, bounded refresh process. */
  background?: (work: () => Promise<void>) => void;
  /** Write to stdout as is. */
  write(text: string): void;
  /** Write to stderr as is. */
  writeError(text: string): void;
  /** Whether a person is at a terminal to answer a question. */
  interactive: boolean;
  /** Lines from an interactive terminal, with an optional input prompt; injectable for embedded CLIs and tests. */
  lines?: (prompt?: string) => AsyncIterable<string>;
  /** Ask a yes-or-no question (only when interactive). */
  confirm(question: string): Promise<boolean>;
}

export function processIO(): CliIO {
  return {
    write: (text) => void process.stdout.write(text),
    writeError: (text) => void process.stderr.write(text),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async *lines(prompt) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      if (prompt) { rl.setPrompt(prompt); rl.prompt(); }
      try {
        for await (const line of rl) {
          yield line;
          if (prompt) rl.prompt();
        }
      } finally { rl.close(); }
    },
    async confirm(question) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    },
  };
}

/** A failure the CLI reports with its own exit code. */
class CliExit extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** Reparse a generated command before its first call when discovery changed its schema. */
class CliReparse extends Error {}

/** Takes `--server` and `--token` out before the commands are known (they decide which commands exist). */
function connectionFlags(config: CliConfig, argv: string[]): { rest: string[]; server?: string; token?: string; refresh: boolean } {
  const rest: string[] = [];
  const found: Record<string, string> = {};
  let refresh = false;
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(server|token)(?:=(.*))?$/.exec(argv[i]!);
    if (!m) rest.push(argv[i]!);
    else found[m[1]!] = m[2] ?? argv[++i] ?? "";
  }
  const command = findCommand(commandTable(config, []), rest.filter(w => w !== "--refresh-tools"))?.command.config;
  // A handwritten command can own this flag too; framework defaults must not consume it.
  if (!(command && isCustom(command) && command.command.usesFlag("refresh-tools", "original"))) {
    for (let i = rest.length - 1; i >= 0; i--) if (rest[i] === "--refresh-tools") { rest.splice(i, 1); refresh = true; }
  }
  return { rest, server: found.server, token: found.token, refresh };
}

function callMeta(config: CliConfig, command: string): Record<string, string> {
  return { "chinwag/surface": "cli", "chinwag/command": command, "chinwag/client-version": config.version ?? "1", "chinwag/idempotency-key": randomUUID() };
}

function envName(config: CliConfig, suffix: string): string {
  return `${config.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${suffix}`;
}

function noServer(config: CliConfig): string {
  return `No server: pass --server <url> or set ${envName(config, "SERVER")}.`;
}

/** Run the CLI once; resolves with its exit code. */
export async function runCli(config: CliConfig, argv: string[], io: CliIO = processIO()): Promise<number> {
  io.signal?.throwIfAborted();
  const env = io.env ?? process.env;
  const { rest, server: given, token: givenToken, refresh } = connectionFlags(config, argv);
  const server = given ?? config.server ?? env[envName(config, "SERVER")];
  const token = givenToken ?? env[tokenEnvOf(config)];
  if (rest[0] === "chat" && !config.commands?.[rest[0]]) return runTerminal(config, server, token, rest, io);
  const local = findCommand(commandTable(config, []), rest);
  const custom = Boolean(local?.command.config && isCustom(local.command.config));
  const prefix = rest.filter(w => w !== "--help" && w !== "-h").join(" ");
  const children = Object.entries(config.commands ?? {}).filter(([words]) => words.startsWith(`${prefix} `));
  const localOnly = custom || Boolean(prefix && children.length && children.every(([, command]) => isCustom(command)));
  const asksHelp = rest.length === 0 || rest[0] === "-h" || rest[0] === "--help";

  let client: Client | undefined;
  let tools: ToolInfo[] = [];
  let cached: Discovery | undefined;
  let recoveredCall = false;
  let file: string | undefined;
  let problem: CliExit | undefined;
  const getClient = async (): Promise<Client> => {
    if (!server) throw new CliExit(EXIT.unreachable, noServer(config));
    if (!client) {
      try { client = await connect(config, server, token, io.signal); }
      catch (error) { throw explain(config, server, error); }
    }
    return client;
  };
  const discover = async (): Promise<boolean> => {
    const before = JSON.stringify(tools);
    const started = Date.now();
    const connected = await getClient();
    const current = await listTools(connected);
    io.signal?.throwIfAborted();
    tools = current;
    cached = undefined;
    // Connecting can refresh OAuth tokens; do not reuse another credential's cache entry.
    file = await discoveryFile(config, server!, token);
    writeDiscovery(file, { format: 2, at: started, server: serverVersion(connected), tools });
    return before !== JSON.stringify(tools);
  };
  if (server && rest[0] !== "auth" && (!localOnly || refresh)) {
    try {
      file = await discoveryFile(config, server, token);
      cached = refresh ? undefined : readDiscovery(file);
      if (cached) tools = cached.tools;
      else await discover();
      io.signal?.throwIfAborted();
    } catch (error) {
      await client?.close(); client = undefined;
      problem = error instanceof CliExit ? error : explain(config, server, error);
    }
  }
  if (io.signal?.aborted) { await client?.close(); return EXIT.failed; }
  if (problem && !asksHelp) { io.writeError(`${problem.message}\n`); return problem.code; }

  // A connected server's version is available without another tools/list. Refresh before a
  // generated call if it changed, then rebuild its parser and approval flags before sending it.
  const prepare = async (tool: ToolInfo) => {
    const connected = await getClient();
    if (cached && JSON.stringify(cached.server) !== JSON.stringify(serverVersion(connected))) await discover();
    if (JSON.stringify(tools.find(t => t.name === tool.name)) !== JSON.stringify(tool)) throw new CliReparse();
  };
  const call = async (tool: string, input: Record<string, unknown>, command: string) => {
    const connected = await getClient();
    try {
      return await connected.callTool({ name: tool, arguments: input, _meta: callMeta(config, command) }, { toolDefinition: tools.find(t => t.name === tool) as McpTool | undefined });
    } catch (error) {
      // A tool request has already been sent. Refresh the help, but never replay a call:
      // third-party servers and custom commands can have side effects before reporting errors.
      if (!recoveredCall && error instanceof ProtocolError && error.code === ProtocolErrorCode.InvalidParams) {
        recoveredCall = true;
        try { await discover(); } catch {}
      }
      throw error;
    }
  };
  const disconnect = () => { void client?.close(); };
  io.signal?.addEventListener("abort", disconnect, { once: true });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      let out = "", err = "", executing = false, reparse = false;
      const output: CliIO = { ...io,
        write: text => { if (executing && !reparse) io.write(text); else out += text; },
        writeError: text => { if (executing && !reparse) io.writeError(text); else err += text; },
      };
      const stricliProcess = {
        stdout: { write: (text: string) => output.write(text) },
        stderr: { write: (text: string) => output.writeError(text) },
        env: { ...env, ...(env.NO_COLOR ? { STRICLI_NO_COLOR: "1" } : {}) },
        exitCode: undefined as number | string | null | undefined,
      };
      const context: CliContext = { process: stricliProcess, cli: {
        call: async (tool, input) => valueOf(await call(tool, input, findCommand(commandTable(config, tools), rest)?.command.words.join(" ") ?? "custom")),
        print: (value, options = {}) => output.write(`${render(value, options)}\n`),
      } };
      const refused = (error: unknown) => badArguments(config, wordsKnown(rest.filter(w => !w.startsWith("-")), config, tools), error, field => field);
      const app = buildApplication(routes(config, server, tools, async tool => {
        try { await prepare(tool); }
        catch (error) { if (error instanceof CliReparse) reparse = true; throw error; }
      }, call, output), {
        name: config.name,
        scanner: { caseStyle: "original" },
        localization: { text: { ...text_en, exceptionWhileParsingArguments(exc, ansiColor) {
          executing = false;
          return text_en.exceptionWhileParsingArguments.call(this, exc, ansiColor);
        }, exceptionWhileRunningCommand(exc, ansiColor) {
          return exc instanceof CliReparse ? "" : exc instanceof CliExit ? exc.message : refused(exc)?.message ?? text_en.exceptionWhileRunningCommand.call(this, exc, ansiColor);
        } } },
        determineExitCode: error => error instanceof CliReparse ? EXIT.usage : error instanceof CliExit ? error.code : needsSignIn(error) ? EXIT.signIn : refused(error) ? EXIT.usage : EXIT.failed,
      });
      await runStricli({ ...app, integrations: { ...app.integrations, output: { hooks: { "command:start"() {
        io.write(out); io.writeError(err); out = ""; err = ""; executing = true;
      } } } } }, rest, context);
      const code = Number(stricliProcess.exitCode ?? 0);
      const parseFailure = code === ExitCode.UnknownCommand || code === ExitCode.InvalidArgument;
      if (attempt === 0 && (reparse || (cached && parseFailure && !custom))) {
        try { if (reparse || await discover()) continue; } catch {}
      }
      io.write(out); io.writeError(err);
      if (problem) io.writeError(`\n${problem.message}\n`);
      if (code < 0) {
        const words = rest.filter(w => !w.startsWith("-"));
        io.writeError(`Run \`${[config.name, ...wordsKnown(words, config, tools)].join(" ")} --help\` to see how to use it.\n`);
        return EXIT.usage;
      }
      return code;
    }
    return EXIT.usage;
  } finally {
    io.signal?.removeEventListener("abort", disconnect);
    await client?.close();
    if (cached && file && server && !io.signal?.aborted && Date.now() - (cached.checkedAt ?? cached.at) >= ((config.discoveryCache || {}).maxAgeMs ?? 5 * 60_000)) {
      backgroundDiscovery(config, server, token, file, io);
    }
  }
}

/** The words of the command line that name a group or command, for the help hint. */
function wordsKnown(words: string[], config: CliConfig, tools: ToolInfo[]): string[] {
  const paths = [...commandTable(config, tools).map((c) => c.words.join(" ")), ...BUILT_IN, "auth login", "auth logout", "auth status"];
  const known: string[] = [];
  for (const w of words) {
    const next = [...known, w].join(" ");
    if (!paths.some((p) => p === next || p.startsWith(`${next} `))) break;
    known.push(w);
  }
  return known;
}

async function connect(config: CliConfig, server: string, token: string | undefined, signal?: AbortSignal): Promise<Client> {
  const provider: AuthProvider | OAuthClientProvider | undefined = token ? { token: async () => token } : isSignedIn(config, server) ? storedProvider(config, server, undefined, signal) : undefined;
  const client = new Client({ name: `${config.name}-cli`, version: config.version ?? "1" });
  const abort = () => { void client.close(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    await client.connect(new StreamableHTTPClientTransport(new URL(server), provider ? { authProvider: provider } : {}), { signal });
    signal?.throwIfAborted();
  } catch (error) { await client.close(); throw error; }
  finally { signal?.removeEventListener("abort", abort); }
  return client;
}

async function listTools(client: Client): Promise<ToolInfo[]> {
  const tools: ToolInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, { cacheMode: "refresh" });
    tools.push(...(page.tools as unknown as ToolInfo[]));
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

interface Discovery {
  format: 2;
  at: number;
  checkedAt?: number;
  server?: { name: string; version: string };
  tools: ToolInfo[];
}

function serverVersion(client: Client): Discovery["server"] {
  const version = client.getServerVersion();
  return version ? { name: version.name, version: version.version } : undefined;
}

/** Cache descriptors only, never credentials or tool results. Separate files avoid lost updates. */
async function discoveryFile(config: CliConfig, server: string, token: string | undefined): Promise<string | undefined> {
  if (config.discoveryCache === false) return undefined;
  const credentials = token ? { token } : await storedProvider(config, server).tokens();
  const key = createHash("sha256").update(JSON.stringify([server, config.name, config.version ?? "1", config.clientId, config.clientMetadataUrl, credentials ?? null])).digest("hex");
  return join(configDir(config), "discovery", `${key}.json`);
}

function readDiscovery(file: string | undefined): Discovery | undefined {
  if (!file) return undefined;
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (saved.format !== 2 || !Number.isFinite(saved.at) || saved.at > Date.now() || !Array.isArray(saved.tools)) return undefined;
    if (saved.checkedAt !== undefined && (!Number.isFinite(saved.checkedAt) || saved.checkedAt > Date.now())) return undefined;
    if (saved.server !== undefined && (typeof saved.server?.name !== "string" || typeof saved.server?.version !== "string")) return undefined;
    if (!saved.tools.every((t: ToolInfo) => t && typeof t.name === "string" && t.inputSchema && typeof t.inputSchema === "object" && !Array.isArray(t.inputSchema))) return undefined;
    return saved;
  } catch { return undefined; }
}

function writeDiscovery(file: string | undefined, saved: Discovery): void {
  if (!file) return;
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    // A slower background request must not replace a newer foreground snapshot.
    if ((readDiscovery(file)?.at ?? 0) > saved.at) return;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify(saved), { mode: 0o600 });
    renameSync(temp, file);
  } catch {
    // A read-only or full config directory must not stop the CLI working.
  } finally { try { rmSync(temp, { force: true }); } catch {} }
}

const REFRESH_TIMEOUT_MS = 15_000;
const REFRESH_ARG = "--flow-refresh-discovery";

function backgroundDiscovery(config: CliConfig, server: string, token: string | undefined, file: string, io: CliIO): void {
  const lock = `${file}.refresh`;
  const release = () => { try { rmSync(lock, { recursive: true, force: true }); } catch {} };
  try {
    try { if (Date.now() - statSync(lock).mtimeMs > REFRESH_TIMEOUT_MS * 2) release(); } catch {}
    mkdirSync(lock, { mode: 0o700 });
  } catch { return; } // Another invocation is refreshing, or caching is unavailable.
  const saved = readDiscovery(file);
  if (saved) writeDiscovery(file, { ...saved, checkedAt: Date.now() });
  const work = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    let client: Client | undefined;
    const signal = io.signal ? AbortSignal.any([io.signal, controller.signal]) : controller.signal;
    const abort = () => { void client?.close().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const started = Date.now();
      signal.throwIfAborted();
      client = await connect(config, server, token, signal);
      const tools = await listTools(client);
      signal.throwIfAborted();
      writeDiscovery(await discoveryFile(config, server, token), { format: 2, at: started, server: serverVersion(client), tools });
    } catch {
      // Background failures leave the last usable snapshot intact and never pollute output.
    } finally {
      clearTimeout(timeout); signal.removeEventListener("abort", abort);
      try { await client?.close(); } catch {}
      release();
    }
  };
  if (io.background) {
    try { io.background(work); } catch { release(); }
    return;
  }
  // Installed bins commonly use process.exit(await runCli(...)). A promise in that process
  // would be killed. The worker receives secrets through stdin, never command-line arguments.
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), REFRESH_ARG], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", release);
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ config: { name: config.name, version: config.version, directory: configDir(config), clientId: config.clientId, clientMetadataUrl: config.clientMetadataUrl }, server, token, file }));
    child.unref();
  } catch { release(); }
}

// Internal worker entry point; importing the CLI never launches it.
if (process.argv[2] === REFRESH_ARG && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let file: string | undefined;
  const release = () => { if (file) { try { rmSync(`${file}.refresh`, { recursive: true, force: true }); } catch {} } };
  process.once("exit", release);
  const timeout = setTimeout(() => process.exit(0), REFRESH_TIMEOUT_MS);
  let client: Client | undefined;
  try {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const job = JSON.parse(input) as { config: CliConfig; server: string; token?: string; file: string };
    file = job.file;
    const started = Date.now();
    client = await connect(job.config, job.server, job.token);
    const tools = await listTools(client);
    writeDiscovery(await discoveryFile(job.config, job.server, job.token), { format: 2, at: started, server: serverVersion(client), tools });
  } catch {} finally { await client?.close(); clearTimeout(timeout); release(); }
}

/** Why the server could not be used, as one line and an exit code. */
function explain(config: CliConfig, server: string, error: unknown): CliExit {
  if (needsSignIn(error)) return new CliExit(EXIT.signIn, `Sign in first: ${config.name} auth login (or set ${tokenEnvOf(config)}).`);
  const status = error instanceof SdkHttpError ? (error.data as { status?: number } | undefined)?.status : undefined;
  const why = short((error as Error).message);
  return new CliExit(EXIT.unreachable, status ? `${server} answered ${status}, not as an MCP server: is this its /mcp address? (${why})` : `Could not reach ${server}: ${why}`);
}

/**
 * The server refused the arguments (its schema can be stricter than the flags: a maximum, a pattern):
 * a usage error, one line per field and the command's help, never the protocol error's stack.
 */
function badArguments(config: CliConfig, words: string[], error: unknown, label: (field: string) => string): CliExit | undefined {
  if (!(error instanceof ProtocolError) || error.code !== ProtocolErrorCode.InvalidParams) return undefined;
  const lines = issuesIn(error.message, label) ?? [short(error.message.replace(/^MCP error -?\d+:\s*/, ""))];
  return new CliExit(EXIT.usage, `${lines.join("\n")}\nRun \`${[config.name, ...words].join(" ")} --help\` to see how to use it.`);
}

/** The schema's issues in a server's message (a JSON list of { path, message }), as "<field>: <what is wrong>". */
function issuesIn(message: string, label: (field: string) => string): string[] | undefined {
  const start = message.indexOf("[");
  if (start < 0) return undefined;
  try {
    const issues = JSON.parse(message.slice(start)) as { path?: (string | number)[]; message?: string }[];
    if (!Array.isArray(issues) || !issues.length || !issues.every((i) => typeof i?.message === "string")) return undefined;
    return issues.map(({ path = [], message }) => {
      const [field, ...rest] = path.map(String);
      return field === undefined ? message! : `${[label(field), ...rest].join(".")}: ${message}`;
    });
  } catch {
    return undefined;
  }
}

/** A server's error as one short line: a web page answering instead of an MCP server is not printed whole. */
function short(message: string): string {
  if (/<html|<!doctype/i.test(message)) return "it answered with a web page, not an MCP server (is this the /mcp address?)";
  const line = message.split("\n")[0]!;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** Only a real challenge means sign in: a 401, or a 403 asking for more scope. Any other 403 is a refusal. */
function needsSignIn(error: unknown): boolean {
  if (error instanceof UnauthorizedError || error instanceof InsufficientScopeError) return true;
  return error instanceof SdkHttpError && (error.data as { status?: number } | undefined)?.status === 401;
}

type Target = StricliCommand<CliContext> | RouteMap<CliContext>;
type ToolCall = (tool: string, input: Record<string, unknown>, command: string) => ReturnType<Client["callTool"]>;

/** The command tree: groups from the commands' words, then the CLI's own commands. */
function routes(config: CliConfig, server: string | undefined, tools: ToolInfo[], prepare: (tool: ToolInfo) => Promise<void>, call: ToolCall, io: CliIO): RouteMap<CliContext> {
  interface Node {
    command?: StricliCommand<CliContext>;
    children: Map<string, Node>;
  }
  const root: Node = { children: new Map() };
  for (const c of commandTable(config, tools)) {
    let node = root;
    for (const word of c.words) {
      if (!node.children.has(word)) node.children.set(word, { children: new Map() });
      node = node.children.get(word)!;
    }
    node.command = c.config && isCustom(c.config) ? c.config.command : toolCommand(config, c, prepare, call, io);
  }
  const build = (node: Node, path: string[]): Record<string, Target> => {
    const out: Record<string, Target> = {};
    for (const [word, child] of node.children) {
      const here = [...path, word];
      if (child.command && child.children.size) throw new Error(`${config.name}: "${here.join(" ")}" is both a command and a group; a word is one or the other.`);
      if (child.command) out[word] = child.command;
      else {
        const sub = build(child, here);
        out[word] = buildRouteMap({ routes: sub, docs: { brief: config.groups?.[here.join(" ")] ?? Object.keys(sub).join(", ") } });
      }
    }
    return out;
  };
  const top = build(root, []);
  for (const word of BUILT_IN) if (top[word]) throw new Error(`${config.name}: "${word}" is the CLI's own command; name yours something else.`);
  const notice = server ? `Server: ${server}` : noServer(config);
  return buildRouteMap({
    routes: { ...top,
      chat: top.chat ?? buildCommand({ docs: { brief: "Chat with the agent in a terminal (chat --help)" }, parameters: {}, func() {} }),
      tools: toolsCommand(tools, io), skill: skillCommand(config, tools, io), auth: authRoutes(config, server, io) },
    docs: { brief: config.description ?? config.name, fullDescription: `${config.description ?? config.name}\n\n${notice}\n--server <url>, --token <token> and --refresh-tools (bypass discovery cache) work on every command.` },
  });
}

/** Flags the CLI puts on tool commands itself. */
const OWN_FLAGS = ["json", "fields", "dry-run", "yes", "refresh-tools"];

/** A tool as a Stricli command: its input as flags (and the CLI file's positional arguments). */
function toolCommand(config: CliConfig, c: Command, prepare: (tool: ToolInfo) => Promise<void>, call: ToolCall, io: CliIO): StricliCommand<CliContext> {
  const tool = c.tool!;
  const settings = c.config && !isCustom(c.config) ? c.config : undefined;
  const args = settings?.args ?? [];
  const props = tool.inputSchema.properties ?? {};
  const required = new Set(tool.inputSchema.required ?? []);
  const writes = tool.annotations?.readOnlyHint !== true;
  const destructive = writes && tool.annotations?.destructiveHint !== false;
  const byFlag = new Map<string, string>();
  const flags: Record<string, unknown> = {};
  for (const [field, schema] of Object.entries(props)) {
    if (args.includes(field)) continue;
    const key = flagName(field);
    if (OWN_FLAGS.includes(key)) throw new Error(`${config.name}: ${tool.name}'s input ${field} clashes with the CLI's --${key}.`);
    byFlag.set(key, field);
    flags[key] = flagSpec(field, schema, !required.has(field));
  }
  flags.json = { kind: "boolean", brief: "Print JSON: for scripts and agents", optional: true, withNegated: false };
  flags.fields = { kind: "parsed", parse: (v: string) => v.split(",").map((f) => f.trim()).filter(Boolean), brief: "Only these fields, comma-separated (a.b for nested ones)", placeholder: "a,b", optional: true };
  if (writes) flags["dry-run"] = { kind: "boolean", brief: "Show the call it would make, and send nothing", optional: true, withNegated: false };
  if (destructive) flags.yes = { kind: "boolean", brief: "Don't ask first (needed without a terminal)", optional: true, withNegated: false };
  const examples = settings?.examples?.length ? `\n\nExamples:\n${settings.examples.map((e) => `  ${e}`).join("\n")}` : "";
  const usage = `${config.name} ${c.words.join(" ")}`;
  return buildCommand<Record<string, unknown>, unknown[], CliContext>({
    docs: { brief: c.summary, fullDescription: `${tool.description ?? c.summary}${examples}` },
    parameters: {
      flags: flags as never,
      positional: { kind: "tuple", parameters: args.map((field) => ({ brief: props[field]?.description ?? field.replace(/_/g, " "), placeholder: field, parse: parserFor(field, props[field] ?? {}), optional: !required.has(field) })) } as never,
    },
    async func(this: CliContext, parsed: Record<string, unknown>, ...positional: unknown[]) {
      const input: Record<string, unknown> = {};
      args.forEach((field, i) => {
        if (positional[i] !== undefined) input[field] = positional[i];
      });
      for (const [key, field] of byFlag) if (parsed[key] !== undefined) input[field] = parsed[key];
      if (writes && parsed["dry-run"]) return void io.write(`${JSON.stringify({ dryRun: true, tool: tool.name, arguments: input }, null, parsed.json ? undefined : 2)}\n`);
      await prepare(tool);
      if (destructive && !parsed.yes) {
        if (!io.interactive) throw new CliExit(EXIT.approval, `${usage} may delete or overwrite: run it again with --yes.`);
        if (!(await io.confirm(`${usage} may delete or overwrite. Go ahead?`))) throw new CliExit(EXIT.approval, "Stopped; nothing was sent.");
      }
      const result = await call(tool.name, input, c.words.join(" ")).catch((error: unknown) => {
        throw needsSignIn(error) ? explain(config, "", error) : (badArguments(config, c.words, error, (field) => (args.includes(field) ? `<${field}>` : `--${flagName(field)}`)) ?? error);
      });
      if (result.isError) throw new CliExit(EXIT.failed, textOf(result.content as Block[]) || `${tool.name} failed.`);
      io.write(`${render(valueOf(result), { json: Boolean(parsed.json), fields: parsed.fields as string[] | undefined, columns: settings?.columns, view: settings?.view })}\n`);
    },
  });
}

function flagSpec(field: string, schema: JsonSchema, optional: boolean): unknown {
  const brief = schema.description ?? field.replace(/_/g, " ");
  const kind = flagKind(schema);
  if (schema.enum && schema.enum.every((v) => typeof v === "string")) return { kind: "enum", values: schema.enum, brief, optional };
  if (kind === "boolean") return optional ? { kind: "boolean", brief, optional: true, withNegated: false } : { kind: "parsed", parse: parseBoolean, brief, placeholder: "true|false" };
  if (kind === "list") return { kind: "parsed", parse: parserFor(field, schema.items ?? {}), variadic: ",", brief: `${brief} (repeat the flag, or comma-separated)`, placeholder: flagKind(schema.items ?? {}), optional };
  if (kind === "json") return { kind: "parsed", parse: parserFor(field, schema), brief: `${schema.description ? `${schema.description}: ` : ""}JSON ${typeHint(schema)}, or @file.json`, placeholder: "json", optional };
  return { kind: "parsed", parse: parserFor(field, schema), brief, placeholder: kind === "string" ? "text" : kind, optional };
}

function parseBoolean(v: string): boolean {
  if (/^(true|1|yes)$/i.test(v)) return true;
  if (/^(false|0|no)$/i.test(v)) return false;
  throw new Error("must be true or false");
}

function parserFor(field: string, schema: JsonSchema): (input: string) => unknown {
  const kind = flagKind(schema);
  if (kind === "number") return numberParser;
  if (kind === "integer") {
    return (v) => {
      const n = numberParser(v);
      if (!Number.isInteger(n)) throw new Error(`${field} must be a whole number`);
      return n;
    };
  }
  if (kind === "boolean") return parseBoolean;
  if (kind === "json") return (v) => JSON.parse(v.startsWith("@") ? readFileSync(v.slice(1), "utf8") : v);
  return String;
}

function toolsCommand(tools: ToolInfo[], io: CliIO): StricliCommand<CliContext> {
  return buildCommand<{ search?: string; json?: boolean }, [string?], CliContext>({
    docs: { brief: "Every tool, with its input and output schema", fullDescription: "Every tool the server has, or one tool's full description: its input, output and hints." },
    parameters: {
      flags: {
        search: { kind: "parsed", parse: String, brief: "Only tools whose name or description has this", placeholder: "text", optional: true },
        json: { kind: "boolean", brief: "Print JSON", optional: true, withNegated: false },
      },
      positional: { kind: "tuple", parameters: [{ brief: "One tool's name", placeholder: "tool", parse: String, optional: true }] },
    },
    func(flags, named) {
      if (named) {
        const one = tools.find((t) => t.name === named);
        if (!one) throw new CliExit(EXIT.usage, `No tool named ${named}.`);
        return void io.write(`${JSON.stringify(one, null, flags.json ? undefined : 2)}\n`);
      }
      const q = flags.search?.toLowerCase();
      const picked = tools.filter((t) => !q || `${t.name} ${t.title ?? ""} ${t.description ?? ""}`.toLowerCase().includes(q));
      if (flags.json) return void io.write(`${JSON.stringify(picked)}\n`);
      const width = Math.max(4, ...picked.map((t) => t.name.length));
      io.write(`${picked.map((t) => `${t.name.padEnd(width)}  ${t.title ?? ""}${t.annotations?.readOnlyHint ? "" : "  (changes things)"}`).join("\n")}\n`);
    },
  });
}

function skillCommand(config: CliConfig, tools: ToolInfo[], io: CliIO): StricliCommand<CliContext> {
  return buildCommand<{ write?: string }, [], CliContext>({
    docs: { brief: "This CLI's SKILL.md for coding agents", fullDescription: "Every command, flag, JSON shape and exit code, for Claude Code, Codex or Cursor. --write puts it in <dir>/<name>-cli/SKILL.md." },
    parameters: { flags: { write: { kind: "parsed", parse: String, brief: "Write it into this skills folder", placeholder: "dir", optional: true } } },
    async func(flags) {
      const text = skillFile(config, tools);
      if (!flags.write) return void io.write(text);
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const folder = join(flags.write, `${config.name}-cli`);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "SKILL.md"), text);
      io.writeError(`Wrote ${join(folder, "SKILL.md")}\n`);
    },
  });
}

function authRoutes(config: CliConfig, server: string | undefined, io: CliIO): RouteMap<CliContext> {
  const need = () => {
    if (!server) throw new CliExit(EXIT.usage, noServer(config));
    return server;
  };
  return buildRouteMap({
    docs: { brief: "Sign in, sign out, or see who is signed in" },
    routes: {
      login: buildCommand<{}, [], CliContext>({
        docs: { brief: "Sign in on the organization's own login page" },
        parameters: {},
        async func() {
          await signIn(config, need(), io.signal);
          io.writeError(`Signed in to ${need()}.\n`);
        },
      }),
      logout: buildCommand<{}, [], CliContext>({
        docs: { brief: "Forget this computer's sign-in" },
        parameters: {},
        func() {
          signOut(config, need());
          io.writeError(`Signed out of ${need()}.\n`);
        },
      }),
      status: buildCommand<{ json?: boolean }, [], CliContext>({
        docs: { brief: "Whether you are signed in, and how" },
        parameters: { flags: { json: { kind: "boolean", brief: "Print JSON", optional: true, withNegated: false } } },
        func(flags) {
          const s = need();
          const env = (io.env ?? process.env)[tokenEnvOf(config)];
          const source = env ? "env" : isSignedIn(config, s) ? "login" : null;
          if (flags.json) return void io.write(`${JSON.stringify({ server: s, signedIn: source !== null, source })}\n`);
          io.write(`${s}: ${env ? `using ${tokenEnvOf(config)}` : source ? "signed in" : "not signed in"}\n`);
        },
      }),
    },
  });
}

type Block = { type: string; text?: string };

function textOf(content: Block[]): string {
  return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

function valueOf(result: { content?: unknown; structuredContent?: unknown; isError?: unknown }): unknown {
  if (result.isError) throw new CliExit(EXIT.failed, textOf(result.content as Block[]) || "The tool failed.");
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = textOf((result.content ?? []) as Block[]);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A field by its dotted path ("event.id"). */
function get(value: unknown, path: string): unknown {
  let v = value;
  for (const part of path.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[part] : undefined;
  return v;
}

function pick(value: unknown, fields: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => pick(v, fields));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = get(value, f);
    if (v !== undefined) out[f] = v;
  }
  return out;
}

function render(value: unknown, options: { json?: boolean; fields?: string[]; columns?: string[]; view?: string[] }): string {
  const shown = options.fields ? pick(value, options.fields) : value;
  if (options.json) return JSON.stringify(shown);
  return human(shown, options.fields ?? options.columns, options.fields ?? options.view);
}

/** For people: a table for a list of records (also one inside an object, its other fields after it), field lines for one record, else the value. */
function human(value: unknown, columns?: string[], view?: string[]): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return table(value, columns);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const lists = Object.keys(record).filter((k) => isRecords(record[k]));
    if (lists.length === 1 && !view) {
      const rest = Object.keys(record).filter((k) => k !== lists[0]);
      return [table(record[lists[0]!] as unknown[], columns), ...(rest.length ? ["", fields(record, rest)] : [])].join("\n");
    }
    return fields(record, view ?? Object.keys(record));
  }
  return JSON.stringify(value);
}

function isRecords(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && v.every((r) => r && typeof r === "object" && !Array.isArray(r));
}

function table(rows: unknown[], columns?: string[]): string {
  if (!rows.length) return "(none)";
  if (!isRecords(rows)) return rows.map(cell).join("\n");
  const first = rows[0] as Record<string, unknown>;
  const cols = columns ?? Object.keys(first).filter((k) => isScalar(first[k])).slice(0, 6);
  const cells = rows.map((r) => cols.map((c) => cell(get(r, c))));
  const widths = cols.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i]!.length)));
  const line = (parts: string[]) => parts.map((p, i) => p.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(cols.map((c) => c.toUpperCase())), ...cells.map(line)].join("\n");
}

function fields(record: Record<string, unknown>, keys: string[]): string {
  const width = Math.max(...keys.map((k) => k.length));
  return keys.map((k) => `${k.padEnd(width)}  ${cell(get(record, k))}`).join("\n");
}

function isScalar(v: unknown): boolean {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

function cell(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v) && v.every(isScalar)) return v.join(", ");
  return isScalar(v) ? String(v) : JSON.stringify(v);
}
