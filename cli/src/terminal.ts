// ask/chat use the agent's authenticated terminal endpoint; they never call an MCP tool.
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, styleText } from "node:util";
import { configDir, isSignedIn, storedAccessToken } from "./auth.ts";
import { tokenEnvOf, type CliConfig } from "./commands.ts";
import type { CliIO } from "./run.ts";

export async function runTerminal(config: CliConfig, server: string | undefined, token: string | undefined, argv: string[], io: CliIO): Promise<number> {
  const command = argv[0]!;
  const usage = `${config.name} ${command}${command === "ask" ? ' "<question>"' : ""} [--json] [--new]`;
  let flags: { values: { json?: boolean; new?: boolean; help?: boolean }; positionals: string[] };
  try { flags = parseArgs({ args: argv.slice(1), allowPositionals: true, options: { json: { type: "boolean" }, new: { type: "boolean" }, help: { type: "boolean", short: "h" } } }); }
  catch { io.writeError(`Usage: ${usage}\n`); return 2; }
  if (flags.values.help) { io.write(`${usage}\nTalk to the agent. --new forgets this terminal's saved conversation reference; shared person history stays with the agent.\n`); return 0; }
  if (command === "ask" ? flags.positionals.length !== 1 : flags.positionals.length !== 0) { io.writeError(`Usage: ${usage}\n`); return 2; }
  if (command === "chat" && !io.interactive) { io.writeError(`chat needs a terminal; use ${config.name} ask "<question>" instead.\n`); return 2; }
  if (!server) { io.writeError("Pass --server <url> or configure the MCP server.\n"); return 5; }
  const stored = !token && isSignedIn(config, server);
  try { if (stored) token = await storedAccessToken(config, server); }
  catch { io.writeError(`Sign in again: ${config.name} auth login.\n`); return 3; }
  if (!token) { io.writeError(`Sign in first: ${config.name} auth login (or set ${tokenEnvOf(config)}).\n`); return 3; }
  const humanChat = command === "chat" && !flags.values.json;
  const endpoint = config.agent ?? new URL("/agent/terminal", server).href;
  const file = join(configDir(config), "chat.json");
  let saved: Record<string, string> = {};
  try { saved = JSON.parse(readFileSync(file, "utf8")); } catch {}
  if (flags.values.new) delete saved[endpoint];
  async function send(text: string): Promise<number> {
    let response;
    const clearStatus = humanChat && Boolean(process.stderr.isTTY) && process.env.TERM !== "dumb";
    if (humanChat) io.writeError(`${styleText("dim", "  Waiting for reply…")}${clearStatus ? "" : "\n"}`);
    const request = () => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ text, ...(saved[endpoint] ? { conversationId: saved[endpoint] } : {}) }), signal: AbortSignal.timeout(10 * 60_000) });
    try {
      response = await request();
      if (response.status === 401 && stored) {
        await response.body?.cancel();
        token = await storedAccessToken(config, server!, true);
        if (token) response = await request();
      }
    }
    catch { response = undefined; }
    finally { if (clearStatus) io.writeError("\r\u001b[2K"); }
    if (!response) { io.writeError("Could not reach the agent.\n"); return 5; }
    if (response.status === 401 || response.status === 403) { io.writeError(`Sign in first: ${config.name} auth login.\n`); return 3; }
    if (!response.ok) { io.writeError(`The agent could not finish (${response.status}).\n`); return 1; }
    let result;
    try { result = await response.json() as { conversationId: string; replies: Array<{ type: string; text?: string }> }; }
    catch { io.writeError("The agent returned invalid JSON.\n"); return 1; }
    if (typeof result.conversationId !== "string" || !Array.isArray(result.replies)) { io.writeError("The agent returned an invalid reply.\n"); return 1; }
    saved[endpoint] = result.conversationId;
    mkdirSync(configDir(config), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    const messages = result.replies.filter(r => r.type === "message").map(r => r.text ?? "");
    if (flags.values.json) io.write(`${JSON.stringify(result)}\n`);
    else if (humanChat && messages.length) io.write(`\n${styleText(["bold", "green"], config.name)}\n${messages.join("\n\n")}\n\n`);
    else io.write(`${messages.join("\n")}\n`);
    return 0;
  }
  if (command === "ask") return send(flags.positionals[0]!);
  if (!io.lines) { io.writeError("This CLI input does not support chat.\n"); return 2; }
  io.writeError(humanChat ? `\n${styleText("bold", `${config.name} chat`)}\n${styleText("dim", "Type /exit or press Ctrl-D to leave.")}\n\n` : "Type /exit or press Ctrl-D to leave.\n");
  for await (const line of io.lines(humanChat ? `${styleText(["bold", "cyan"], "You")} › ` : undefined)) {
    const text = line.trim();
    if (text === "/exit") break;
    if (text) { const code = await send(text); if (code) return code; }
  }
  return 0;
}
