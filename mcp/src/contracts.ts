// Versioned contracts: one MCP server keeps only its latest tools and still answers clients built
// against an older contract (a CLI already published), through one small adapter per older contract.
// A contract's number goes up only on a breaking change: a tool removed or renamed, an input changed
// incompatibly, an output reshaped. Adding tools or optional inputs never bumps it.

import { isDeepStrictEqual } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { Tool } from "../../src/tools.ts";
import { FULL_CATALOG_META, IN_PROCESS, type McpToolDescriptor } from "./describe.ts";

/** The request `_meta` key a client names its contract in (Flow's CLI sends defineCli's `contract`). */
export const CONTRACT_META = "flow.engineer/contract";

/** A client's name and version, as it sends them (clientInfo). Flow's CLI sends `<name>-cli`. */
export interface McpClientInfo { name: string; version: string }

export interface McpContracts {
  /** The contract the tools as written speak. */
  current: number;
  /** Older contracts still served, each by its adapter over the current tools. */
  supported?: Record<number, McpContractAdapter>;
  /**
   * The contract of a client that does not name one (a CLI published before it did), from its
   * clientInfo. undefined: the current one, as for MCP hosts. A client that names one is not asked about.
   */
  pick?: (client: McpClientInfo) => number | undefined;
}

/** How an older contract differs from the current one. What it does not mention is unchanged. */
export interface McpContractAdapter {
  /** By the current tool's name. */
  tools?: Record<string, McpToolAdapter>;
  /**
   * This contract's own tools: one gone from the current contract (a stand-in whose run calls its
   * replacement), or, when nothing maps, a small legacy implementation. One with a current tool's
   * name (as this contract names it) replaces that tool for this contract.
   */
  legacy?: Tool[];
}

export interface McpToolAdapter {
  /** This contract's name for the tool. */
  name?: string;
  /** This contract's input schema (default: the current tool's), with `mapInput` to the current input. */
  input?: z.ZodType;
  mapInput?: (input: any) => unknown;
  /** This contract's output schema, with `mapOutput` from the current tool's output (its text is the current tool's). */
  output?: z.ZodType;
  mapOutput?: (output: any, input: any) => unknown;
}

const ADAPTED = Symbol("flow.engineer/contract-adapted");

/** The current tool an older contract's tool stands for, with its adapter. */
export function adaptationOf(tool: Tool): { tool: Tool; adapter: McpToolAdapter } | undefined {
  return (tool as unknown as Record<symbol, { tool: Tool; adapter: McpToolAdapter } | undefined>)[ADAPTED];
}

/** The tools an older contract's clients see: the current ones as its adapter changes them, and its legacy tools. */
export function contractTools(tools: Tool[], adapter: McpContractAdapter): Tool[] {
  for (const name of Object.keys(adapter.tools ?? {})) {
    if (!tools.some((t) => t.name === name)) throw new Error(`@flow-engineer/flow/mcp: a contract adapter names ${name}, which is not a tool`);
  }
  const adapted = tools.map((tool) => {
    const a = adapter.tools?.[tool.name];
    if (!a) return tool;
    const toCurrent = (input: unknown) => tool.input.parse(a.mapInput ? a.mapInput(input) : input);
    const t: Tool = {
      ...tool,
      name: a.name ?? tool.name,
      input: a.input ?? tool.input,
      output: a.output ?? (a.mapOutput ? undefined : tool.output),
      format: undefined,
      run: async (input, context) => {
        const output = await tool.run(toCurrent(input), context);
        return a.mapOutput ? a.mapOutput(output, input) : output;
      },
    };
    Object.defineProperty(t, ADAPTED, { value: { tool, adapter: a } });
    return t;
  });
  const legacy = adapter.legacy ?? [];
  return [...adapted.filter((t) => !legacy.some((l) => l.name === t.name)), ...legacy];
}

/** The contract a request speaks: the one it names, else `pick`'s for its client, else the current one. */
export function contractOf(contracts: McpContracts, named: unknown, client: McpClientInfo | undefined, server: string): number {
  if (named !== undefined && !(Number.isInteger(named) && (named as number) > 0)) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `${CONTRACT_META} must be a positive whole number.`);
  }
  const contract = (named as number | undefined) ?? (client && contracts.pick?.(client)) ?? contracts.current;
  if (contract === contracts.current || contracts.supported?.[contract]) return contract;
  const served = [contracts.current, ...Object.keys(contracts.supported ?? {}).map(Number)];
  const who = client ? `${client.name} ${client.version}` : "This client";
  const cli = client?.name.endsWith("-cli") ? client.name.slice(0, -4) : undefined;
  const update = contract < Math.min(...served) ? (cli ? `Run \`${cli} update\` to get the newest version.` : "Update it to its newest version.") : undefined;
  const message = update
    ? `${who} is too old for ${server}: it speaks contract ${contract}, which is no longer served. ${update}`
    : `${who} speaks contract ${contract}, which ${server} does not serve (it serves ${served.sort((x, y) => x - y).join(", ")}).`;
  throw new ProtocolError(ProtocolErrorCode.InvalidRequest, message, { [CONTRACT_META]: { contract, served, ...(update ? { update: true } : {}) } });
}

/** What a contract promises, saved per contract and checked in CI: its tools' names and schemas, and sample calls with their results. */
export interface ContractSnapshot {
  contract: number;
  tools: { name: string; inputSchema: unknown; outputSchema?: unknown }[];
  calls: { tool: string; arguments: Record<string, unknown>; isError?: boolean; result: unknown }[];
}

/**
 * Take a contract's snapshot from a server in this process, as a client speaking it sees it:
 * `contract` names it, or else `client` (clientInfo) lets the server's `pick` choose. `token` signs in.
 */
export async function contractSnapshot(
  handle: { fetch(request: Request): Promise<Response> },
  options: { contract?: number; client?: McpClientInfo; token?: string; calls?: { tool: string; arguments?: Record<string, unknown> }[] },
): Promise<ContractSnapshot> {
  const path = (handle as unknown as Record<symbol, { path: string } | undefined>)[IN_PROCESS]?.path ?? "/mcp";
  const client = new Client(options.client ?? { name: "contract-snapshot", version: "1" });
  const meta = options.contract === undefined ? {} : { [CONTRACT_META]: options.contract };
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost${path}`), {
    fetch: (url, init) => handle.fetch(new Request(url, init)),
    ...(options.token ? { requestInit: { headers: { authorization: `Bearer ${options.token}` } } } : {}),
  }));
  try {
    const listed = await client.listTools({ _meta: { ...meta, [FULL_CATALOG_META]: true } });
    const tools = (listed.tools as McpToolDescriptor[]).map(({ name, inputSchema, outputSchema }) => ({ name, inputSchema, ...(outputSchema ? { outputSchema } : {}) }));
    const calls: ContractSnapshot["calls"] = [];
    for (const { tool, arguments: args = {} } of options.calls ?? []) {
      const r = await client.callTool({ name: tool, arguments: args, _meta: meta });
      const text = (r.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      calls.push({ tool, arguments: args, ...(r.isError ? { isError: true } : {}), result: r.structuredContent ?? text });
    }
    const served = listed._meta?.[CONTRACT_META];
    return { contract: typeof served === "number" ? served : options.contract ?? 0, tools, calls };
  } finally {
    await client.close();
  }
}

/**
 * What a server's snapshot of a contract breaks of the saved one, one line each; [] when it still
 * holds. Additions pass: a new tool, a new optional input, a new field in a result.
 */
export function contractProblems(saved: ContractSnapshot, now: ContractSnapshot): string[] {
  const problems: string[] = [];
  for (const old of saved.tools) {
    const tool = now.tools.find((t) => t.name === old.name);
    if (!tool) { problems.push(`${old.name}: removed or renamed`); continue; }
    const before = old.inputSchema as Schema, after = tool.inputSchema as Schema;
    for (const [field, schema] of Object.entries(before.properties ?? {})) {
      if (!after.properties?.[field]) problems.push(`${old.name}: input ${field} removed`);
      else if (!isDeepStrictEqual(after.properties[field], schema)) problems.push(`${old.name}: input ${field} changed`);
    }
    for (const field of after.required ?? []) if (!(before.required ?? []).includes(field)) problems.push(`${old.name}: input ${field} is now required`);
    if (old.outputSchema && !contains(tool.outputSchema, old.outputSchema, true)) problems.push(`${old.name}: output schema changed`);
  }
  for (const [i, call] of saved.calls.entries()) {
    const result = now.calls[i];
    if (!result || result.tool !== call.tool || !isDeepStrictEqual(result.arguments, call.arguments)) { problems.push(`call ${i + 1} (${call.tool}): not made`); continue; }
    if (Boolean(result.isError) !== Boolean(call.isError)) problems.push(`call ${i + 1} (${call.tool}): ${call.isError ? "no longer fails" : "now fails"}`);
    else if (!contains(result.result, call.result, false)) problems.push(`call ${i + 1} (${call.tool}): result changed`);
  }
  return problems;
}

interface Schema { properties?: Record<string, unknown>; required?: string[] }

/** `now` has all of `saved`: objects may gain keys (and an output schema required fields), arrays and values are equal. */
function contains(now: unknown, saved: unknown, schema: boolean): boolean {
  if (Array.isArray(saved)) return Array.isArray(now) && now.length === saved.length && saved.every((v, i) => contains(now[i], v, schema));
  if (saved && typeof saved === "object") {
    if (!now || typeof now !== "object" || Array.isArray(now)) return false;
    const n = now as Record<string, unknown>;
    return Object.entries(saved).every(([k, v]) => schema && k === "required" && Array.isArray(v) && Array.isArray(n[k])
      ? v.every((r) => (n[k] as unknown[]).includes(r))
      : schema && k === "additionalProperties" ? true : k in n && contains(n[k], v, schema));
  }
  return isDeepStrictEqual(now, saved);
}
