// Chat uses the agent's terminal endpoint; it never calls an MCP tool. Signed out, it chats as a
// guest under an id kept with its conversation reference, if the agent lets guests in.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, styleText, stripVTControlCharacters } from "node:util";
import { configDir, isSignedIn, storedAccessToken } from "./auth.ts";
import { tokenEnvOf, type CliConfig } from "./commands.ts";
import type { CliIO } from "./run.ts";

export type ChatUpdate =
  | { type: "reply"; text: string }
  | { type: "activity"; event: { type: string; callId?: string; tool?: string; input?: unknown; output?: unknown; ok?: boolean; ms?: number; skill?: string } };

export interface ChatSession {
  name: string;
  signal?: AbortSignal;
  color?: boolean;
  /** Optional six-digit hex brand accent; body text and background inherit the terminal profile. */
  accent?: string;
  send(text: string, update: (event: ChatUpdate) => void, signal: AbortSignal): Promise<void>;
  /** Forgets only the saved terminal reference; shared person history stays with the agent. */
  reset(): void;
}

export async function runTerminal(config: CliConfig, server: string | undefined, token: string | undefined, argv: string[], io: CliIO): Promise<number> {
  const usage = `${config.name} chat ["<message>"] [--json] [--new]`;
  let flags: { values: { json?: boolean; new?: boolean; help?: boolean }; positionals: string[] };
  try { flags = parseArgs({ args: argv.slice(1), allowPositionals: true, options: { json: { type: "boolean" }, new: { type: "boolean" }, help: { type: "boolean", short: "h" } } }); }
  catch { io.writeError(`Usage: ${usage}\n`); return 2; }
  if (flags.values.help) { io.write(`${usage}\nTalk to the agent. --new forgets this terminal's saved conversation reference; shared person history stays with the agent.\n\nInteractive chat opens a full-screen session. Enter sends; Shift+Enter, Alt+Enter or \\ then Enter adds a line.\nCtrl+O expands tool details; PageUp/PageDown scroll. Tab completes /help, /details, /new and /exit.\nEscape stops waiting; accepted work may still finish. Ctrl-D leaves an empty prompt.\n`); return 0; }
  if (flags.positionals.length > 1) { io.writeError(`Usage: ${usage}\n`); return 2; }
  const single = flags.positionals.length === 1;
  if (!single && !io.interactive) { io.writeError(`chat needs a terminal; for a single reply use ${config.name} chat "<message>".\n`); return 2; }
  if (!server) { io.writeError("Pass --server <url> or configure the MCP server.\n"); return 5; }
  const stored = !token && isSignedIn(config, server);
  try { if (stored) token = await storedAccessToken(config, server, false, io.signal); }
  catch { io.writeError(`Sign in again: ${config.name} auth login.\n`); return 3; }
  const humanChat = !single && !flags.values.json;
  const env = io.env ?? process.env;
  const styled = io.interactive && !env.NO_COLOR && env.FORCE_COLOR !== "0" && env.TERM !== "dumb";
  const paint = (format: Parameters<typeof styleText>[0], text: string) => styled ? styleText(format, text, { validateStream: false }) : text;
  const safe = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const endpoint = config.agent ?? new URL("/agent/terminal", server).href;
  const file = join(configDir(config), "chat.json");
  let saved: Record<string, string> = {};
  try { saved = JSON.parse(readFileSync(file, "utf8")); } catch {}
  if (flags.values.new) { delete saved[endpoint]; delete saved[`${endpoint}#guest`]; }
  const fullScreen = humanChat && Boolean(io.chat) && env.TERM !== "dumb";
  if (fullScreen && config.chat?.accent !== undefined && !/^#[0-9a-f]{6}$/i.test(config.chat.accent)) {
    io.writeError("chat.accent must be a six-digit hex color, for example #b85c00.\n"); return 2;
  }
  // A guest's conversation is its own; signing in later starts the account's.
  const reference = () => token ? endpoint : `${endpoint}#guest`;
  const save = () => {
    mkdirSync(configDir(config), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  };
  const guest = () => {
    if (!saved.guest) { saved.guest = randomUUID(); save(); }
    return saved.guest;
  };
  const reset = () => {
    delete saved[reference()];
    save();
  };
  async function send(text: string, update?: (event: ChatUpdate) => void, signal?: AbortSignal): Promise<number> {
    const fail = (message: string, code: number): number => {
      if (update) throw Object.assign(new Error(message), { exitCode: code });
      io.writeError(`${message}\n`); return code;
    };
    let response;
    const clearStatus = humanChat && !fullScreen && Boolean(process.stderr.isTTY) && (io.env ?? process.env).TERM !== "dumb";
    if (humanChat && !fullScreen) io.writeError(`${paint("dim", "  Waiting for reply…")}${clearStatus ? "" : "\n"}`);
    const requestSignal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...[io.signal, signal].filter((s): s is AbortSignal => Boolean(s))]);
    const request = () => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", ...(update ? { accept: "application/x-ndjson" } : {}), ...(token ? { authorization: `Bearer ${token}` } : { "flow-guest": guest() }) }, body: JSON.stringify({ text, ...(saved[reference()] ? { conversationId: saved[reference()] } : {}) }), signal: requestSignal });
    try {
      response = await request();
      if (response.status === 401 && stored) {
        await response.body?.cancel();
        token = await storedAccessToken(config, server!, true, requestSignal);
        if (token) response = await request();
      }
    }
    catch { response = undefined; }
    finally { if (clearStatus) io.writeError("\r\u001b[2K"); }
    if (!response) return fail(`Could not reach the agent at ${endpoint}. Is it running?`, 5);
    // The server answered, so it is running; it has no chat route (a playground, an MCP server without the agent).
    if (response.status === 404 || response.status === 405 || (response.status === 403 && !token)) return fail(`This server does not serve terminal chat (${endpoint}).`, 5);
    if (response.status === 401 || response.status === 403) return fail(`Sign in first: ${config.name} auth login${token ? "" : ` (or set ${tokenEnvOf(config)})`}.`, 3);
    if (!response.ok) return fail(`The agent could not finish (${response.status}).`, 1);
    let result: { conversationId: string; replies: Array<{ type: string; text?: string }> } | undefined;
    try {
      if (update && response.headers.get("content-type")?.includes("application/x-ndjson")) {
        if (!response.body) throw new Error("Missing stream");
        let pending = "";
        for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
          pending += chunk;
          if (pending.length > 4_000_000) throw new Error("Reply too large");
          let end: number;
          while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end); pending = pending.slice(end + 1);
            if (!line.trim()) continue;
            const event = JSON.parse(line);
            if (event.type === "done") result = event.result;
            else if (event.type === "error") throw new Error("Turn failed");
            else if (event.type === "reply" || event.type === "activity") update(event);
          }
        }
        if (pending.trim() || !result) throw new Error("Incomplete stream");
      } else {
        result = await response.json() as { conversationId: string; replies: Array<{ type: string; text?: string }> };
        if (update) for (const reply of result.replies ?? []) if (reply.type === "message") update({ type: "reply", text: reply.text ?? "" });
      }
    } catch { return fail("The agent's reply was interrupted or invalid. Work already accepted may still finish.", 1); }
    if (!result || typeof result.conversationId !== "string" || !Array.isArray(result.replies)) return fail("The agent returned an invalid reply.", 1);
    io.signal?.throwIfAborted();
    saved[reference()] = result.conversationId;
    save();
    if (update) return 0;
    const messages = result.replies.filter(r => r.type === "message").map(r => r.text ?? "");
    if (flags.values.json) io.write(`${JSON.stringify(result)}\n`);
    else {
      const text = messages.join(humanChat ? "\n\n" : "\n");
      const rendered = await forTerminal(io.interactive ? safe(text) : text, io);
      const body = io.interactive ? rendered.trimEnd() : rendered;
      if (humanChat && body) io.write(`\n${paint(["bold", "green"], config.name)}\n${body.split("\n").map(line => `  ${line}`).join("\n")}\n\n`);
      else io.write(`${body}\n`);
    }
    return 0;
  }
  if (single) return send(flags.positionals[0]!);
  if (fullScreen) {
    // The full-screen view clears its screen on leaving, so the last failure is printed again after it.
    let failed: { message: string; code: number } | undefined;
    const session: ChatSession = { name: config.name, signal: io.signal, color: styled, accent: config.chat?.accent, reset, send: async (text, update, signal) => {
      try { await send(text, update, signal); failed = undefined; }
      catch (error) { failed = signal?.aborted ? undefined : { message: error instanceof Error ? error.message : String(error), code: (error as { exitCode?: number }).exitCode ?? 1 }; throw error; }
    } };
    try {
      const code = await io.chat!(session);
      if (failed) { io.writeError(`${failed.message}\n`); return failed.code; }
      return code;
    }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND" && io.lines)) { io.writeError("Could not open the chat interface.\n"); return 1; }
      io.writeError(paint("dim", "Install @mariozechner/pi-tui@0.73.1 beside this CLI for the full-screen chat.\n"));
    }
  }
  if (!io.lines) { io.writeError("This CLI input does not support chat.\n"); return 2; }
  const help = "/help  shortcuts · /new  forget saved reference · /exit  leave";
  io.writeError(humanChat
    ? `\n${paint("bold", `${config.name} chat`)}\n${paint("dim", "Type /help for commands · Ctrl-D leaves")}\n${paint("dim", "Basic line input in this terminal")}\n\n`
    : "Type /exit or press Ctrl-D to leave.\n");
  for await (const line of io.lines(humanChat ? `${paint(["bold", "cyan"], "You")} › ` : undefined)) {
    const text = line.trim();
    if (text === "/exit") break;
    if (humanChat && text === "/help") { io.writeError(`\n${help}\nThis terminal uses basic line input. Send one message per line; Ctrl-D leaves.\n\n`); continue; }
    if (humanChat && text === "/new") {
      reset();
      io.writeError("\nForgot this terminal's saved reference. Shared person history stays with the agent.\n\n");
      continue;
    }
    if (humanChat && text.startsWith("/") && !text.includes("\n")) { io.writeError(`Unknown chat command. ${help}\n`); continue; }
    if (text) { const code = await send(text); if (code) return code; }
  }
  return 0;
}

/** The same optional Markdown renderer for chat and tool output. Pipes retain the source. */
export async function forTerminal(markdown: string, io: CliIO): Promise<string> {
  const env = io.env ?? process.env;
  if (!io.interactive || env.NO_COLOR || env.TERM === "dumb") return markdown;
  try {
    const [{ Marked }, { markedTerminal }] = await Promise.all([import("marked"), import("marked-terminal")]);
    return await new Marked(markedTerminal({ showSectionPrefix: false, width: Math.max(20, (process.stdout.columns ?? 80) - 4), reflowText: true }) as never).parse(markdown);
  } catch { return markdown; }
}
