// Runs an organization's CLI on Stricli (@stricli/core, the framework Sentry's CLI is built on):
// command groups whose help lists their subcommands (`acme order`, `acme order -h`), help for every
// command (`acme order place -h`), typo suggestions, typed flags and positional arguments. On top of
// it, the conventions agents and scripts rely on: --json (and --fields) on every tool command,
// --dry-run on anything that changes things, --yes needed without a terminal for what may delete or
// overwrite, and fixed exit codes. The commands come from the server's tools at run time, shaped by
// the CLI file (commands.ts).

import { forgetChat, forTerminal, runTerminal, type ChatSession } from "./terminal.ts";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { styleText } from "node:util";
import { Client, InsufficientScopeError, ProtocolError, ProtocolErrorCode, SdkHttpError, StreamableHTTPClientTransport, UnauthorizedError, type AuthProvider, type OAuthClientProvider, type Tool as McpTool } from "@modelcontextprotocol/client";
import { buildApplication, buildCommand, buildRouteMap, ExitCode, numberParser, run as runStricli, text_en, type Command as StricliCommand, type RouteMap } from "@stricli/core";
import { configDir, isSignedIn, signedInAsOtherClient, signIn, signOut, storedProvider } from "./auth.ts";
import { chooseAtTerminal, person, signInQuestion, tips, waitsForSignIn, welcomeScreen } from "./welcome.ts";
import { SKILLS_META } from "../../src/skills.ts";
import { FORMATTED } from "../../src/tools.ts";
import { FULL_CATALOG_META } from "../../mcp/src/describe.ts";
import {
  BUILT_IN,
  REPLACEABLE,
  commandEntries,
  feedbackUsage,
  commandTable,
  flagKind,
  flagName,
  flagsOf,
  findCommand,
  withDefaults,
  isCustom,
  OWN_FLAGS,
  skillFile,
  tokenEnvOf,
  typeHint,
  updatesItself,
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
  /** Replace the full-screen chat presentation; omitted uses the injected line interface. */
  chat?: (session: ChatSession) => Promise<number>;
  /** Ask a yes-or-no question (only when interactive). */
  confirm(question: string): Promise<boolean>;
  /** Pick one of a few options (only when interactive): the chosen index, or undefined to leave. Omitted asks with confirm. */
  choose?(question: string, options: string[]): Promise<number | undefined>;
  /** The terminal's width, which decides whether the welcome banner fits; default 80. */
  columns?: number;
}

export function processIO(): CliIO {
  return {
    write: (text) => void process.stdout.write(text),
    writeError: (text) => void process.stderr.write(text),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async chat(session) {
      const { runChatUI } = await import("./chat-ui.ts");
      return runChatUI(session);
    },
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
    get columns() { return process.stdout.columns; },
    choose: (question, options) => chooseAtTerminal(question, options, !process.env.NO_COLOR && process.env.TERM !== "dumb"),
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
  const table = commandTable(config, []);
  const command = findCommand(table, withDefaults(config, table, rest.filter(w => w !== "--refresh-tools")))?.command.config;
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
  // Packed into one file with the CLI file (flow cli pack), the worker's process runs the CLI file
  // too, once the worker is done: there is nothing left to run.
  if (refreshWorker && argv[0] === REFRESH_ARG) return 0;
  io.signal?.throwIfAborted();
  const checking = new AbortController();
  const notice = updateNotice(config, argv, io, checking.signal);
  const code = await runOnce(config, argv, io);
  // A slow check gets a moment after the command, never longer; it is asked again the next day.
  const line = await Promise.race([notice, delay(UPDATE_WAIT_MS, undefined, { signal: checking.signal }).catch(() => undefined)]);
  checking.abort();
  if (line) io.writeError(line);
  return code;
}

async function runOnce(config: CliConfig, argv: string[], io: CliIO): Promise<number> {
  const env = io.env ?? process.env;
  const { rest, server: given, token: givenToken, refresh } = connectionFlags(config, argv);
  // A group with a default subcommand, alone, shows its help rather than running the default.
  if (rest.length && config.defaultCommands?.[rest.join(" ")] !== undefined) rest.push("--help");
  const server = given ?? config.server ?? env[envName(config, "SERVER")];
  const token = givenToken ?? env[tokenEnvOf(config)];
  const signedIn = token ? "env" as const : server && isSignedIn(config, server) ? "login" as const : null;
  const bare = rest.length === 0;
  const welcome = bare && config.welcome !== false && person(io);
  // A bare run without a person is a request for the help, which needs no sign-in.
  if (server && !signedIn && waitsForSignIn(config, rest) && (!bare || person(io))) {
    const login = `${config.name} auth login`;
    if (!person(io)) {
      io.writeError(`${signInQuestion(config)} Run \`${login}\` (or set ${tokenEnvOf(config)}), then run this again.\n`);
      return EXIT.signIn;
    }
    // Before a command its output stays the command's own (--json), so the screen goes to stderr.
    if (config.welcome !== false) (bare ? io.write : io.writeError)(welcomeScreen(config, { server, signedIn, tokenEnv: tokenEnvOf(config) }, io, true));
    const chosen = io.choose ? await io.choose(signInQuestion(config), ["Sign in", "Exit"]) : (await io.confirm(`${signInQuestion(config)} Sign in now?`) ? 0 : undefined);
    if (chosen !== 0) { io.writeError(`Not signed in. Run \`${login}\` when you are ready.\n`); return EXIT.signIn; }
    try { await signIn(config, server, io.signal, (text) => io.writeError(text)); }
    catch (error) { const problem = error instanceof CliExit ? error : explain(config, server, error); io.writeError(`${problem.message}\n`); return problem.code; }
    forgetChat(config, server);
    io.writeError(`Signed in to ${server}.\n`);
    if (bare) { if (config.welcome !== false) io.write(`\n${tips(config, painter(io))}\n\n`); else rest.push("--help"); }
    else io.writeError("\n");
    if (welcome) return EXIT.ok;
  } else if (welcome) {
    io.write(welcomeScreen(config, { server, signedIn, tokenEnv: tokenEnvOf(config) }, io));
    return EXIT.ok;
  }
  if (rest[0] === "chat" && !config.commands?.[rest[0]]) return runTerminal(config, server, token, rest, io);
  const table = commandTable(config, []);
  const local = findCommand(table, withDefaults(config, table, rest));
  const custom = Boolean(local?.command.config && isCustom(local.command.config));
  const prefix = rest.filter(w => w !== "--help" && w !== "-h").join(" ");
  const children = commandEntries(config).filter(([words]) => words.startsWith(`${prefix} `));
  const localOnly = custom || (rest[0] === "update" && updatesItself(config)) || Boolean(prefix && children.length && children.every(([, command]) => isCustom(command)));
  const asksHelp = rest.length === 0 || rest[0] === "-h" || rest[0] === "--help";

  let client: Client | undefined;
  let connecting: Promise<Client> | undefined;
  let tools: ToolInfo[] = [];
  let cached: Discovery | undefined;
  let recoveredCall = false;
  let file: string | undefined;
  let problem: CliExit | undefined;
  const getClient = async (): Promise<Client> => {
    if (!server) throw new CliExit(EXIT.unreachable, noServer(config));
    if (client) return client;
    connecting ??= connect(config, server, token, io.signal).then(connected => client = connected).catch(error => {
      connecting = undefined;
      throw explain(config, server, error);
    });
    return connecting;
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
      await client?.close(); client = undefined; connecting = undefined;
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
        call: async (tool, input) => valueOf(await call(tool, input, findCommand(commandTable(config, tools), withDefaults(config, commandTable(config, tools), rest))?.command.words.join(" ") ?? "custom")),
        print: (value, options = {}) => output.write(`${render(value, options)}\n`),
      } };
      const refused = (error: unknown) => badArguments(config, wordsKnown(rest.filter(w => !w.startsWith("-")), config, tools), error, field => field);
      const app = buildApplication(routes(config, server, tools, async tool => {
        try { await prepare(tool); }
        catch (error) { if (error instanceof CliReparse) reparse = true; throw error; }
      }, call, output, async () => { await discover(); return tools; }), {
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
      // The top-level overview lists every command; Stricli's flat list after it would repeat them.
      // (Its routes stay visible to Stricli, which suggests only visible ones for a typo.)
      // Its usage lines, one per command, are replaced by one.
      if (asksHelp) {
        const heading = (text: string) => `(?:\\u001b\\[4m)?${text}(?:\\u001b\\[24m)?\\n`;
        out = out.replace(new RegExp(`(${heading(text_en.headers.flags)}(?:  .*\\n)+)\\n+${heading(text_en.headers.commands)}[\\s\\S]*$`), "$1");
        const paint = painter(io);
        out = out.replace(new RegExp(`^(?:${heading(text_en.headers.usage)})(?:  .*\\n)+`), `${paint("bold", text_en.headers.usage)}\n  ${config.name} <command> [flags]\n  ${config.name} <command> --help\n`);
        out = out.replace(new RegExp(`\\n${heading(text_en.headers.flags)}`), `\n${paint("bold", text_en.headers.flags)}\n`);
      }
      io.write(out); io.writeError(err);
      if (problem) io.writeError(`\n${problem.message}\n`);
      if (code < 0) {
        const words = rest.filter(w => !w.startsWith("-"));
        if (code === ExitCode.UnknownCommand && server && !token && await signedInAsOtherClient(config, server)) io.writeError(`${RENEW(config)}\n`);
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
    await withoutRefreshWarning(() => client.connect(new StreamableHTTPClientTransport(new URL(server), provider ? { authProvider: provider } : {}), { signal }));
    signal?.throwIfAborted();
  } catch (error) { await client.close(); throw error; }
  finally { signal?.removeEventListener("abort", abort); }
  return client;
}

// The SDK prints a raw console warning when a token refresh cannot reach the server; the CLI says
// so itself in one line (explain), so that warning is dropped while connecting, and nothing else.
const REFRESH_WARNING = "[mcp-sdk] Could not refresh OAuth tokens";
let connecting = 0;
let consoleWarn: typeof console.warn | undefined;
async function withoutRefreshWarning<T>(run: () => Promise<T>): Promise<T> {
  if (connecting++ === 0) {
    const warn = consoleWarn = console.warn;
    console.warn = (...args: unknown[]) => { if (!(typeof args[0] === "string" && args[0].startsWith(REFRESH_WARNING))) warn.apply(console, args); };
  }
  try { return await run(); }
  finally { if (--connecting === 0) { console.warn = consoleWarn!; consoleWarn = undefined; } }
}

async function listTools(client: Client): Promise<ToolInfo[]> {
  const tools: ToolInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools({ ...(cursor ? { cursor } : {}), _meta: { [FULL_CATALOG_META]: true } }, { cacheMode: "refresh" });
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

/**
 * Cache descriptors only, never credentials or tool results. Separate files avoid lost updates. One
 * per credential and the client it was issued to, as servers list tools per client (Tool.mcp.clients).
 */
async function discoveryFile(config: CliConfig, server: string, token: string | undefined): Promise<string | undefined> {
  if (config.discoveryCache === false) return undefined;
  const provider = storedProvider(config, server);
  const credentials = token ? { token } : await provider.tokens();
  const client = token ? null : (await provider.clientInformation())?.client_id ?? null;
  const key = createHash("sha256").update(JSON.stringify([server, config.name, config.version ?? "1", config.clientId, config.clientMetadataUrl, credentials ?? null, client])).digest("hex");
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
const refreshWorker = process.argv[2] === REFRESH_ARG && Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1]!)).href === import.meta.url;
if (refreshWorker) {
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
function routes(config: CliConfig, server: string | undefined, tools: ToolInfo[], prepare: (tool: ToolInfo) => Promise<void>, call: ToolCall, io: CliIO, refresh: () => Promise<ToolInfo[]>): RouteMap<CliContext> {
  interface Node {
    command?: StricliCommand<CliContext>;
    children: Map<string, Node>;
  }
  const root: Node = { children: new Map() };
  const feedback = feedbackUsage(config, tools);
  const replaced = new Map<string, StricliCommand<CliContext>>();
  for (const c of commandTable(config, tools)) {
    const words = c.words.join(" ");
    if (REPLACEABLE.has(words) && c.config && isCustom(c.config)) {
      replaced.set(words, c.config.command);
      continue;
    }
    let node = root;
    for (const word of c.words) {
      if (!node.children.has(word)) node.children.set(word, { children: new Map() });
      node = node.children.get(word)!;
    }
    node.command = c.config && isCustom(c.config) ? c.config.command : toolCommand(config, c, prepare, call, io, feedback);
  }
  const build = (node: Node, path: string[]): Record<string, Target> => {
    const out: Record<string, Target> = {};
    for (const [word, child] of node.children) {
      const here = [...path, word];
      if (child.command && child.children.size) throw new Error(`${config.name}: "${here.join(" ")}" is both a command and a group; a word is one or the other.`);
      if (child.command) out[word] = child.command;
      else {
        const sub = build(child, here);
        const fallback = config.defaultCommands?.[here.join(" ")];
        const brief = config.groups?.[here.join(" ")] ?? Object.keys(sub).join(", ");
        out[word] = fallback && sub[fallback]
          ? buildRouteMap({ routes: sub, defaultCommand: fallback, docs: { brief, fullDescription: `${brief}\n\n\`${config.name} ${here.join(" ")}${defaultArgs(config, `${here.join(" ")} ${fallback}`)}\` runs \`${config.name} ${here.join(" ")} ${fallback}\`.` } })
          : buildRouteMap({ routes: sub, docs: { brief } });
      }
    }
    return out;
  };
  const top = build(root, []);
  for (const word of BUILT_IN) if (top[word]) throw new Error(`${config.name}: "${word}" is the CLI's own command; name yours something else.`);
  const notice = server ? `Server: ${server}` : noServer(config);
  const paint = painter(io);
  // chat and help are the CLI's, unless the CLI file has its own.
  const own: Record<string, Target> = {
    tools: toolsCommand(tools, io), skill: skillCommand(config, tools, call, io, server ? refresh : undefined), auth: authRoutes(config, server, io, replaced.get("auth status")),
  };
  if (updatesItself(config)) own.update = updateCommand(config, io);
  if (!top.help) own.help = helpCommand(config, tools, top, own, io);
  const all = { chat: top.chat ?? buildCommand({ docs: { brief: CHAT_BRIEF }, parameters: {}, func() {} }), ...top, ...own };
  const theirs = Object.keys(top).filter((word) => word !== "chat");
  return buildRouteMap({
    routes: all,
    docs: { brief: config.description ?? config.name, fullDescription: `${overview(config, all, theirs, Object.keys(own), paint)}${feedback ? `\n\n${paint("bold", "FEEDBACK")}\n  Something failed, missing or confusing? ${paint("cyan", feedback)}` : ""}\n\n${paint("dim", `${notice}\n--server <url>, --token <token> and --refresh-tools (bypass discovery cache) work on every command.`)}` },
  });
}

/** A default subcommand's positional arguments, as help shows them (" <url>"), else " ...". */
function defaultArgs(config: CliConfig, words: string): string {
  const c = commandEntries(config).find(([w]) => w.trim().split(/\s+/).join(" ") === words)?.[1];
  const args = c && !isCustom(c) ? (c.args ?? []) : [];
  return args.length ? args.map((a) => ` <${a}>`).join("") : " ...";
}

const CHAT_BRIEF = "Ask for anything in plain words, and the agent gets it done";

/** The top-level help: the description, chat first, the team's commands (in its sections), then the CLI's own. */
function overview(config: CliConfig, all: Record<string, Target>, theirs: string[], own: string[], paint: Paint): string {
  const blocks: Array<[string, Array<[string, string]>]> = [];
  const line = (word: string): [string, string] => [word, all[word]!.brief];
  const placed = new Set<string>();
  for (const [heading, entries] of Object.entries(config.sections ?? {})) {
    const here = entries.filter((word) => theirs.includes(word) && !placed.has(word));
    here.forEach((word) => placed.add(word));
    if (here.length) blocks.push([heading.toUpperCase(), here.map(line)]);
  }
  const rest = theirs.filter((word) => !placed.has(word));
  if (rest.length) blocks.push([placed.size ? "OTHER" : "COMMANDS", rest.map(line)]);
  blocks.push(["THIS CLI", own.map((word) => (word === "help" ? [`help <words>`, all.help!.brief] : line(word)))]);
  // chat's lines are long; the sections share their own column.
  const chat: Array<[string, string]> = all.chat!.brief === CHAT_BRIEF
    ? [[`${config.name} chat "<request>"`, CHAT_BRIEF], [`${config.name} chat`, "A conversation, until /exit (chat --help)"]]
    : [["chat", all.chat!.brief]];
  const rows = (list: Array<[string, string]>, name: (text: string) => string) => {
    const width = Math.max(...list.map(([n]) => n.length));
    return list.map(([n, brief]) => `  ${name(n)}${" ".repeat(width - n.length)}  ${brief}`);
  };
  const width = Math.max(...blocks.flatMap(([, list]) => list.map(([n]) => n.length)));
  const pad = (list: Array<[string, string]>) => list.map(([n, brief]): [string, string] => [n.padEnd(width), brief]);
  return [
    config.description ?? config.name,
    [paint(["bold", "cyan"], "ASK ANYTHING"), ...rows(chat, (n) => paint(["bold", "cyan"], n))].join("\n"),
    ...blocks.map(([heading, list]) => [paint("bold", heading), ...rows(pad(list), (n) => paint("cyan", n))].join("\n")),
  ].join("\n\n");
}

type Paint = (format: Parameters<typeof styleText>[0], text: string) => string;

/** Styles for a person at a terminal; none when piped, for NO_COLOR or TERM=dumb. */
function painter(io: CliIO): Paint {
  return atTerminal(io) ? (format, text) => styleText(format, text, { validateStream: false }) : (_format, text) => text;
}

function atTerminal(io: CliIO): boolean {
  const env = io.env ?? process.env;
  return io.interactive && !env.NO_COLOR && env.TERM !== "dumb";
}

/** `help <words>`: the commands whose words or descriptions have every one of them; without words, the overview. */
function helpCommand(config: CliConfig, tools: ToolInfo[], top: Record<string, Target>, own: Record<string, Target>, io: CliIO): StricliCommand<CliContext> {
  return buildCommand<Record<string, never>, string[], CliContext>({
    docs: { brief: "Find commands by what they do" },
    parameters: { flags: {}, positional: { kind: "array", parameter: { brief: "Words to look for", parse: String, placeholder: "words" } } },
    func(_flags, ...words) {
      if (!words.length) return void io.write(`Run ${config.name} --help for every command, or ${config.name} help <words> to find one.\n`);
      const wanted = words.map((w) => w.toLowerCase());
      const rows: Array<[string, string]> = [];
      for (const c of commandTable(config, tools)) {
        if (c.config && !isCustom(c.config) && c.config.alias?.trim() === c.words.join(" ")) continue;
        const group = c.words.slice(0, -1).map((_, i) => config.groups?.[c.words.slice(0, i + 1).join(" ")] ?? "").join(" ");
        const summary = c.config && isCustom(c.config) ? c.config.command.brief : c.summary;
        const text = [c.words.join(" "), summary, c.tool?.description ?? "", group].join(" ").toLowerCase();
        if (wanted.every((w) => text.includes(w))) rows.push([c.words.join(" "), summary]);
      }
      for (const [word, target] of Object.entries({ ...own, ...(top.chat ? {} : { chat: { brief: CHAT_BRIEF } }) })) {
        if (wanted.every((w) => `${word} ${target.brief}`.toLowerCase().includes(w))) rows.push([word, target.brief]);
      }
      if (!rows.length) return void io.write(`No command matches "${words.join(" ")}". ${config.name} --help lists them all.\n`);
      const width = Math.max(...rows.map(([name]) => name.length + config.name.length + 1));
      const paint = painter(io);
      io.write(`${rows.map(([name, brief]) => `  ${paint("cyan", `${config.name} ${name}`.padEnd(width))}  ${brief}`).join("\n")}\n`);
    },
  });
}

/** A tool as a Stricli command: its input as flags (and the CLI file's positional arguments). */
function toolCommand(config: CliConfig, c: Command, prepare: (tool: ToolInfo) => Promise<void>, call: ToolCall, io: CliIO, feedback?: string): StricliCommand<CliContext> {
  const tool = c.tool!;
  const settings = c.config && !isCustom(c.config) ? c.config : undefined;
  const args = settings?.args ?? [];
  const props = tool.inputSchema.properties ?? {};
  const required = new Set(tool.inputSchema.required ?? []);
  const writes = tool.annotations?.readOnlyHint !== true;
  const destructive = writes && tool.annotations?.destructiveHint !== false;
  const defaults = settings?.defaults ?? {};
  const byFlag = new Map<string, string>();
  const flags: Record<string, unknown> = {};
  const aliases: Record<string, string> = {};
  const specs = flagsOf(tool, settings);
  for (const { field, flag, letters, long } of specs) {
    for (const key of [flag, ...(long ? [long] : [])]) {
      if (OWN_FLAGS.includes(key)) throw new Error(`${config.name}: ${tool.name}'s input ${field} clashes with the CLI's --${key}.`);
      if (byFlag.has(key)) throw new Error(`${config.name}: --${key} is both ${byFlag.get(key)} and ${field} in "${c.words.join(" ")}".`);
      byFlag.set(key, field);
    }
    const spec = flagSpec(field, settings?.help?.[field] ? { ...props[field]!, description: settings.help[field] } : props[field]!, !required.has(field) || field in defaults || Boolean(long), defaults[field]);
    flags[flag] = spec;
    // The field's own flag still works beside a word shorthand, out of help.
    if (long) flags[long] = { ...(spec as object), optional: true, hidden: true };
    for (const letter of letters) aliases[letter] = flag;
  }
  const options = Object.entries(settings?.options ?? {});
  for (const [name, o] of options) {
    if (OWN_FLAGS.includes(name) || byFlag.has(name)) throw new Error(`${config.name}: option --${name} clashes with another flag in "${c.words.join(" ")}".`);
    flags[name] = o.kind === "boolean" ? { kind: "boolean", brief: o.help, optional: true, withNegated: false } : { kind: "parsed", parse: o.kind === "number" ? numberParser : String, brief: o.help, placeholder: o.kind ?? "text", optional: true };
    if (o.short) aliases[o.short] = name;
  }
  // A list as the only argument takes every word (`scrape <urls...>`).
  const rest = args.length === 1 && flagKind(props[args[0]!] ?? {}) === "list" ? args[0]! : undefined;
  const optionalArg = (field: string) => !required.has(field) || field in defaults;
  const argBrief = (field: string) => withDefault(settings?.help?.[field] ?? props[field]?.description ?? field.replace(/_/g, " "), defaults[field]);
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
      aliases: aliases as never,
      positional: (rest
        ? { kind: "array", parameter: { brief: argBrief(rest), placeholder: rest, parse: parserFor(rest, props[rest]!.items ?? {}) }, minimum: optionalArg(rest) ? 0 : 1 }
        : { kind: "tuple", parameters: args.map((field) => ({ brief: argBrief(field), placeholder: field, parse: parserFor(field, props[field] ?? {}), optional: optionalArg(field) })) }) as never,
    },
    async func(this: CliContext, parsed: Record<string, unknown>, ...positional: unknown[]) {
      let input: Record<string, unknown> = { ...defaults };
      const refuse = (error: unknown) => new CliExit(EXIT.usage, `${error instanceof Error ? error.message : String(error)}\nRun \`${usage} --help\` to see how to use it.`);
      if (rest) {
        if (positional.length) input[rest] = positional;
      } else {
        args.forEach((field, i) => {
          if (positional[i] !== undefined) input[field] = positional[i];
        });
      }
      for (const [key, field] of byFlag) if (parsed[key] !== undefined) input[field] = parsed[key];
      if (settings?.input) {
        const given = Object.fromEntries(options.map(([name]) => [name, parsed[name]]).filter(([, v]) => v !== undefined));
        try { input = await settings.input(input, given); } catch (error) { throw refuse(error); }
      }
      if (writes && parsed["dry-run"]) return void io.write(`${JSON.stringify({ dryRun: true, tool: tool.name, arguments: input }, null, parsed.json ? undefined : 2)}\n`);
      await prepare(tool);
      if (destructive && !parsed.yes) {
        if (!io.interactive) throw new CliExit(EXIT.approval, `${usage} may delete or overwrite: run it again with --yes.`);
        if (!(await io.confirm(`${usage} may delete or overwrite. Go ahead?`))) throw new CliExit(EXIT.approval, "Stopped; nothing was sent.");
      }
      const result = await call(tool.name, input, c.words.join(" ")).catch((error: unknown) => {
        throw needsSignIn(error) ? explain(config, "", error) : (badArguments(config, c.words, error, (field) => (args.includes(field) ? `<${field}>` : `--${specs.find((f) => f.field === field)?.flag ?? flagName(field)}`)) ?? error);
      });
      if (result.isError) {
        // Agents read stderr: a failure says where to report it, unless it is feedback's own.
        const report = tool.name === "feedback" ? undefined : feedback;
        throw new CliExit(EXIT.failed, `${textOf(result.content as Block[]) || `${tool.name} failed.`}${report ? `\nIf this looks wrong, tell the team: ${report.replace("tooling|product", "tooling")}` : ""}`);
      }
      // The tool's own text, unless the person asked for data or the CLI file chose what to show.
      if (settings?.print && !parsed.json && !parsed.fields) return void io.write(`${(await settings.print(valueOf(result))).replace(/\n*$/, "")}\n`);
      const formatted = (result._meta as Record<string, unknown> | undefined)?.[FORMATTED] === true && !parsed.json && !parsed.fields && !settings?.columns && !settings?.view;
      if (formatted) return void io.write(`${(await forTerminal(textOf(result.content as Block[]), io, config)).replace(/\n*$/, "")}\n`);
      io.write(`${render(valueOf(result), { json: Boolean(parsed.json), fields: parsed.fields as string[] | undefined, columns: settings?.columns, view: settings?.view })}\n`);
    },
  });
}

/** A brief that says what is sent when the input is left out. */
function withDefault(brief: string, value: unknown): string {
  return value === undefined ? brief : `${brief} (default ${JSON.stringify(value)})`;
}

function flagSpec(field: string, schema: JsonSchema, optional: boolean, fallback?: unknown): unknown {
  const brief = withDefault(schema.description ?? field.replace(/_/g, " "), fallback);
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

const UPDATE_EVERY_MS = 24 * 60 * 60_000;
const UPDATE_WAIT_MS = 1_000;

/** `acme update`: says so when this is already the newest version, else runs the CLI file's update command. */
function updateCommand(config: CliConfig, io: CliIO): StricliCommand<CliContext> {
  const { command, latest } = config.update!;
  return buildCommand<{}, [], CliContext>({
    docs: { brief: `Update ${config.name} to its newest version`, fullDescription: `Update ${config.name} to its newest version. Runs: ${command}` },
    parameters: {},
    async func() {
      const newest = latest && config.version ? await newestVersion(config, io.signal ?? AbortSignal.timeout(10_000)) : undefined;
      if (newest !== undefined && !isNewer(newest, config.version!)) return void io.write(`${config.name} ${config.version} is the newest version.\n`);
      io.writeError(`Updating ${config.name}${newest ? ` to ${newest}` : ""}...\n`);
      const code = await new Promise<number | string>((done) => {
        const child = spawn(command, { shell: true, stdio: ["inherit", "pipe", "pipe"], env: io.env ?? process.env, signal: io.signal });
        child.stdout.on("data", (chunk) => io.write(String(chunk)));
        child.stderr.on("data", (chunk) => io.writeError(String(chunk)));
        child.on("error", (error) => done(error.message));
        child.on("close", (exit, signal) => done(exit ?? signal ?? 1));
      });
      if (code !== 0) throw new CliExit(EXIT.failed, `The update did not finish (${typeof code === "number" ? `exit ${code}` : code}). Run it again, or run it yourself: ${command}`);
    },
  });
}

/**
 * The line a person at a terminal sees after a command when a newer version is out: from the saved
 * answer (update.json in the CLI's config folder), asked of update.latest again once a day. Never
 * for scripts, coding agents, CI or --json, and never during `update`.
 */
async function updateNotice(config: CliConfig, argv: string[], io: CliIO, signal: AbortSignal): Promise<string | undefined> {
  const env = io.env ?? process.env;
  if (!config.update?.latest || !config.version || !person(io) || env.CI || argv.includes("--json") || (argv[0] === "update" && updatesItself(config))) return undefined;
  const file = join(configDir(config), "update.json");
  let saved: { checkedAt?: number; latest?: string } = {};
  try { saved = JSON.parse(readFileSync(file, "utf8")); } catch {}
  let newest = typeof saved.latest === "string" ? saved.latest : undefined;
  const checkedAt = Number(saved.checkedAt);
  if (!(Date.now() - checkedAt < UPDATE_EVERY_MS && checkedAt <= Date.now())) {
    // Saved before asking: a check that fails or is cut short waits a day like one that answered.
    const save = (value: object) => { try { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); } catch {} };
    save({ checkedAt: Date.now(), ...(newest ? { latest: newest } : {}) });
    const answer = await newestVersion(config, signal);
    if (answer !== undefined) save({ checkedAt: Date.now(), latest: newest = answer });
  }
  if (!newest || !isNewer(newest, config.version)) return undefined;
  const paint = painter(io);
  return `\n${paint("dim", `A new version of ${config.name} is out: ${newest} (you have ${config.version}).`)} Run ${paint("cyan", `${config.name} update`)} to get it.\n`;
}

/** The version update.latest names, or undefined when it cannot be read. */
async function newestVersion(config: CliConfig, signal: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetch(config.update!.latest!, { signal, headers: { accept: "application/json" } });
    if (!response.ok) return undefined;
    const version = ((await response.json()) as { version?: unknown })?.version;
    return typeof version === "string" && /^v?\d+\.\d+\.\d+/.test(version) ? version : undefined;
  } catch { return undefined; }
}

/**
 * Whether `latest` is a newer build than `current`: a higher major.minor.patch, or the same with
 * another suffix (a rebuild such as 0.1.2-production.ece030e), since latest is what was published.
 */
function isNewer(latest: string, current: string): boolean {
  const core = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number);
  const a = core(latest), b = core(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return latest.replace(/^v/, "") !== current.replace(/^v/, "");
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

interface CliSkill {
  name: string;
  description: string;
  reader?: string;
}

/** Handwritten workflows and the generated CLI guide share discovery, not their full bodies. */
function skillCatalog(config: CliConfig, tools: ToolInfo[]): CliSkill[] {
  const reader = tools.find(t => Array.isArray(t._meta?.[SKILLS_META])) ?? tools.find(t => t.name === "read_skill");
  const entries = new Map<string, CliSkill>();
  if (reader) {
    const given = reader._meta?.[SKILLS_META];
    const summaries = Array.isArray(given) ? given : (reader.inputSchema.properties?.name?.enum ?? []).map(name => ({ name, description: "" }));
    for (const item of summaries) {
      if (!item || typeof item.name !== "string" || !item.name || entries.has(item.name)) continue;
      entries.set(item.name, { name: item.name, description: typeof item.description === "string" ? item.description : "", reader: reader.name });
    }
  }
  const name = `${config.name}-cli`;
  // An authored skill may replace the generated entry, just as authored commands replace defaults.
  if (!entries.has(name)) entries.set(name, { name, description: `How to use the ${config.name} command line` });
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function skillCommand(config: CliConfig, tools: ToolInfo[], call: ToolCall, io: CliIO, refresh?: () => Promise<ToolInfo[]>): StricliCommand<CliContext> {
  const usage = `${config.name} skill list | ${config.name} skill get <name> [name...] [--json] [--write <dir>]`;
  return buildCommand<{ write?: string; json?: boolean }, string[], CliContext>({
    docs: { brief: "List skills or read selected skills", fullDescription: `${usage}\n\nWith no arguments, list names and descriptions. The generated CLI guide is ${config.name}-cli. --write with no action keeps exporting that guide.` },
    parameters: {
      flags: {
        json: { kind: "boolean", brief: "Print named skill records as JSON", optional: true, withNegated: false },
        write: { kind: "parsed", parse: String, brief: "Write selected skills into this skills folder", placeholder: "dir", optional: true },
      },
      positional: { kind: "array", parameter: { brief: "list, or get followed by one or more skill names", placeholder: "action/name", parse: String } },
    },
    async func(flags, ...words) {
      const legacy = words.length === 0 && flags.write !== undefined;
      const action = words.shift() ?? "list";
      const names = legacy ? [`${config.name}-cli`] : [...new Set(words)];
      if ((action !== "list" && action !== "get") || (!legacy && action === "list" && (names.length > 0 || flags.write !== undefined)) || (action === "get" && names.length === 0)) {
        throw new CliExit(EXIT.usage, `Usage: ${usage}`);
      }
      let current = tools;
      let catalog = skillCatalog(config, current);
      if (!legacy && action === "list") {
        const summaries = catalog.map(({ name, description }) => ({ name, description }));
        if (flags.json) return void io.write(`${JSON.stringify(summaries)}\n`);
        const width = Math.max(...summaries.map(s => s.name.length));
        return void io.write(`${summaries.map(s => `${s.name.padEnd(width)}  ${s.description}`.trimEnd()).join("\n")}\n`);
      }
      if (!legacy && names.some(name => !catalog.some(s => s.name === name)) && refresh) {
        current = await refresh();
        catalog = skillCatalog(config, current);
      }
      const missing = names.filter(name => !catalog.some(s => s.name === name));
      if (!legacy && missing.length) throw new CliExit(EXIT.usage, `No skill named ${missing.join(", ")}. Run \`${config.name} skill list\` to see available skills.`);
      const selected = legacy ? [{ name: `${config.name}-cli`, description: `How to use the ${config.name} command line` }] : names.map(name => catalog.find(s => s.name === name)!);
      if (flags.write) {
        for (const { name } of selected) {
          if (name !== basename(name) || name === "." || name === ".." || /[\\:]/.test(name)) throw new CliExit(EXIT.usage, `Cannot write skill ${JSON.stringify(name)}: its name must be a single folder name.`);
        }
      }
      const records = await Promise.all(selected.map(async skill => {
        if (!skill.reader) return { name: skill.name, description: skill.description, content: skillFile(config, current) };
        const result = await call(skill.reader, { name: skill.name }, `skill get ${names.join(" ")}`);
        if (result.isError) throw new CliExit(EXIT.failed, textOf(result.content as Block[]) || `Could not read skill ${skill.name}.`);
        const body = textOf(result.content as Block[]);
        return { name: skill.name, description: skill.description, content: `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${body}\n` };
      }));
      if (flags.write) {
        for (const { name, content } of records) {
          const folder = join(flags.write, name);
          mkdirSync(folder, { recursive: true });
          writeFileSync(join(folder, "SKILL.md"), content);
          io.writeError(`Wrote ${join(folder, "SKILL.md")}\n`);
        }
      }
      if (flags.json) io.write(`${JSON.stringify(records)}\n`);
      else if (!flags.write) io.write(records.length === 1 ? records[0]!.content : records.map(s => `# Skill: ${s.name}\n\n${s.content}`).join("\n"));
    },
  });
}

/** An old sign-in (the CLI registered itself) hides the commands kept to the CLI until the next one. */
const RENEW = (config: CliConfig) => `Some commands need a new sign-in: run \`${config.name} auth login\` to see them.`;

function authRoutes(config: CliConfig, server: string | undefined, io: CliIO, status?: StricliCommand<CliContext>): RouteMap<CliContext> {
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
          await signIn(config, need(), io.signal, (text) => io.writeError(text));
          forgetChat(config, need());
          io.writeError(`Signed in to ${need()}.\n`);
        },
      }),
      logout: buildCommand<{}, [], CliContext>({
        docs: { brief: "Forget this computer's sign-in" },
        parameters: {},
        func() {
          signOut(config, need());
          forgetChat(config, need());
          io.writeError(`Signed out of ${need()}.\n`);
        },
      }),
      // The CLI file's own "auth status" replaces this one.
      status: status ?? buildCommand<{ json?: boolean }, [], CliContext>({
        docs: { brief: "Whether you are signed in, and how" },
        parameters: { flags: { json: { kind: "boolean", brief: "Print JSON", optional: true, withNegated: false } } },
        async func(flags) {
          const s = need();
          const env = (io.env ?? process.env)[tokenEnvOf(config)];
          const source = env ? "env" : isSignedIn(config, s) ? "login" : null;
          const renew = source === "login" && await signedInAsOtherClient(config, s);
          if (flags.json) return void io.write(`${JSON.stringify({ server: s, signedIn: source !== null, source, ...(source === "login" ? { renew } : {}) })}\n`);
          io.write(`${s}: ${env ? `using ${tokenEnvOf(config)}` : source ? "signed in" : "not signed in"}\n`);
          if (renew) io.writeError(`${RENEW(config)}\n`);
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
