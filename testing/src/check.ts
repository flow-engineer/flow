// `flow check`, from an agent's folder: whether its tools can be served over MCP exactly as
// declared, whether its CLI file (src/cli.ts) still matches them, and whether the skills it would
// send to MCP hosts name tools only chats have. Rules only, no model: what it reports is
// objectively wrong (errors, exit 1) or worth a look (warnings).

import { existsSync } from "node:fs";
import { pluginProblems } from "./plugin.ts";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cliProblems, type CliConfig } from "../../cli/src/commands.ts";
import { CHAT_ONLY, describe, FULL_CATALOG_META, toolsProblems } from "../../mcp/src/describe.ts";
import { loadSkills, readAgentFolder } from "../../src/skills.ts";
import type { Tool } from "../../src/tools.ts";

export const CHECK_LINE = `  flow check [--json] [--plugin <dir>]    Check the agent's tools, CLI file and skills for MCP and the CLI`;

/** A file of the agent's, imported; TypeScript Node cannot run is one line saying what to change, not a stack. */
async function load(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return await import(pathToFileURL(file).href);
  } catch (error) {
    if ((error as { code?: string }).code !== "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") throw error;
    console.error(`${(error as Error).message.split("\n")[0]}\nNode runs .ts files by stripping types only: no parameter properties (constructor(readonly x)), enums or namespaces. Write them as plain fields and objects.`);
    return undefined;
  }
}

/**
 * The names of the tools src/mcp.ts's server lists to a CLI, asked in-process as the CLI asks it
 * (tools/list, the full catalog), so check says what `<cli> <command>` really reaches. undefined
 * when there is no src/mcp.ts, it exports no `mcp`, or it will not answer here (sign-in, another
 * path); null when it cannot be imported (said already). A src/mcp.ts that throws is an error.
 */
async function servedTools(dir: string, errors: string[]): Promise<Set<string> | undefined | null> {
  const file = join(dir, "src/mcp.ts");
  if (!existsSync(file)) return undefined;
  let mcp: { fetch?: unknown } | undefined;
  try {
    const loaded = await load(file);
    if (!loaded) return null;
    mcp = loaded.mcp as typeof mcp;
  } catch (error) {
    errors.push(`src/mcp.ts: ${(error as Error).message.split("\n")[0]}`);
    return undefined;
  }
  if (typeof mcp?.fetch !== "function") return undefined;
  const serve = mcp.fetch as (request: Request) => Promise<Response>;
  // Every request goes to the handle in this process, never the network; as from 127.0.0.1, which
  // mcpServer's Host check lets in.
  const here = (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("host", "127.0.0.1");
    return serve(new Request(url, { ...init, headers }));
  };
  // An optional peer dependency, as the CLI's own (cli/src/run.ts): imported only here.
  let sdk: typeof import("@modelcontextprotocol/client");
  try {
    sdk = await import("@modelcontextprotocol/client");
  } catch {
    return undefined;
  }
  const { Client, StreamableHTTPClientTransport } = sdk;
  const client = new Client({ name: "flow-check", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), { fetch: here }));
    const names = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools({ ...(cursor ? { cursor } : {}), _meta: { [FULL_CATALOG_META]: true } });
      for (const t of page.tools) names.add(t.name);
      cursor = page.nextCursor;
    } while (cursor);
    return names;
  } catch {
    return undefined;
  } finally {
    await client.close().catch(() => {});
  }
}

export async function checkCli(argv: string[], dir = process.cwd()): Promise<number> {
  const json = argv.includes("--json");
  const errors: string[] = [];
  const warnings: string[] = [];
  const pluginAt = argv.indexOf("--plugin");
  const pluginDir = pluginAt >= 0 ? argv[pluginAt + 1] : undefined;
  if (pluginAt >= 0 && (!pluginDir || pluginDir.startsWith("--"))) errors.push("--plugin needs its generated folder");
  if (pluginDir) errors.push(...pluginProblems(dir, resolve(dir, pluginDir)));
  const agentFile = join(dir, "src/agent.ts");
  if (!existsSync(agentFile)) {
    console.error(`No src/agent.ts in ${dir}. Run flow check from the agent's folder.`);
    return 1;
  }
  const agent = await load(agentFile);
  if (!agent) return 1;
  const tools: Tool[] = Array.isArray(agent.tools) ? agent.tools : [];
  if (!Array.isArray(agent.tools)) errors.push("src/agent.ts exports no tools array");
  errors.push(...toolsProblems(tools));

  if (existsSync(join(dir, "agent"))) {
    for (const skill of loadSkills(readAgentFolder(join(dir, "agent")))) {
      const named = CHAT_ONLY.exec(skill.body);
      if (named) (pluginAt >= 0 ? errors : warnings).push(`skill ${skill.name}: names ${named[1]}, which MCP hosts and the CLI do not have`);
    }
  }

  const cliFile = join(dir, "src/cli.ts");
  if (existsSync(cliFile)) {
    const loaded = await load(cliFile);
    if (!loaded) return 1;
    const cli = loaded.cli as CliConfig | undefined;
    if (!cli) errors.push("src/cli.ts exports no cli (export const cli = defineCli({ ... }))");
    else {
      // The CLI's commands are the tools its MCP server lists: src/mcp.ts's, when it can be asked.
      const served = await servedTools(dir, errors);
      if (served === null) return 1;
      // A tool kept to the CLI (mcp.clients) is listed only to a signed-in CLI, never here: it counts as served.
      const described = tools.filter((t) => !served || served.has(t.name) || t.mcp?.clients?.includes("cli")).flatMap((t) => {
        try {
          return [describe(t)];
        } catch {
          return [];
        }
      });
      const found = cliProblems(cli, described, served !== undefined);
      errors.push(...found.errors.map((e) => `src/cli.ts: ${e}`));
      warnings.push(...found.warnings.map((w) => `src/cli.ts: ${w}`));
    }
  }

  if (!existsSync(cliFile)) {
    for (const t of tools) if (t.mcp?.clients?.includes("cli")) warnings.push(`tool ${t.name}: kept to the CLI (mcp.clients), but there is no CLI file (src/cli.ts), so no client sees it`);
  }

  if (json) console.log(JSON.stringify({ ok: errors.length === 0, errors, warnings }));
  else {
    for (const e of errors) console.log(`error  ${e}`);
    for (const w of warnings) console.log(`warn   ${w}`);
    console.log(errors.length ? `${errors.length} error${errors.length === 1 ? "" : "s"}.` : `No errors in ${tools.length} tool${tools.length === 1 ? "" : "s"}.`);
  }
  return errors.length ? 1 : 0;
}

/** `flow mcp update`: loads the agent with every mcpTools call writing its server's current tools to mcp.lock.json. */
export async function mcpUpdateCli(dir = process.cwd()): Promise<number> {
  const agentFile = join(dir, "src/agent.ts");
  if (!existsSync(agentFile)) {
    console.error(`No src/agent.ts in ${dir}. Run flow mcp update from the agent's folder.`);
    return 1;
  }
  const { UPDATE_ENV } = await import("../../mcp/src/client.ts");
  process.env[UPDATE_ENV] = "1";
  await import(pathToFileURL(agentFile).href);
  console.error(`Updated ${join(dir, "mcp.lock.json")}. Run flow check and the tests, then commit it.`);
  return 0;
}
