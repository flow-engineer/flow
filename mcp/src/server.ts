// An agent's tools and skills as an MCP server (Streamable HTTP, spec 2026-07-28 with the 2025
// fallback), on the official SDK. It needs no model, channels or store: mount `fetch` on any
// web-standard runtime (Cloudflare Workers, Deno, Bun) or `node` on node:http.
//
// Sign-in is the host's OAuth against the business's own authorization server; this server only
// verifies the token on every request (`auth.verify`) and turns it into the person. A call that
// needs sign-in and has none is answered HTTP 401 with WWW-Authenticate before the SDK runs: hosts
// start sign-in only on that, never on a tool result. A token without a needed scope gets 403
// insufficient_scope. Without `auth`, every tool answers and the person is anonymous.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type AuthInfo,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import type { Agent } from "../../src/agent.ts";
import type { FlowEvents } from "../../src/business-events/engine.ts";
import { emitter, type EventSink } from "../../src/events.ts";
import { unavailableRecords, type Records } from "../../src/records.ts";
import { loadSkills, mcpInstructions, readAgentFolder, readSkillTool, SKILLS_META, type AgentFiles } from "../../src/skills.ts";
import { serveNode } from "../../src/http.ts";
import { traces, tracesFromEnv, type TracesOptions } from "../../src/traces.ts";
import { FORMATTED, render, toolContext, type CredentialProvider, type Tool, type ToolContext } from "../../src/tools.ts";
import { terminalServer } from "./terminal.ts";
import { describe, FULL_CATALOG_META, scopesFor, signInOf, toolsProblems, type McpToolDescriptor, type Scopes } from "./describe.ts";

export interface McpAuth {
  /** The authorization server(s) that issue tokens for this server, as hosts discover them. */
  issuer: string | string[];
  /** This server's public URL as hosts reach it, the resource tokens are for. Default: the request's own. */
  resource?: string;
  /** Scope names: reads need `read`, writes `write`. Without them, being signed in is enough. */
  scopes?: Scopes;
  /**
   * Check a bearer token, on every request. Return who it is for (`key`: the business's own id for
   * the person, as ToolContext.key) and the scopes it grants, or null when it is not valid.
   */
  verify(token: string, request: Request): Promise<McpIdentity | null> | McpIdentity | null;
  /** The authorization server's own routes when it is served here, on the same origin (the OAuth bridge's). */
  routes?: { paths: string[]; fetch(request: Request): Promise<Response> };
}

export interface McpIdentity {
  key: string;
  scopes?: string[];
  /** Request-bound backend access, such as a brand token exchange. Never exposed to the model. */
  credentials?: CredentialProvider;
}

export interface McpServerOptions {
  name: string;
  version: string;
  tools: Tool[];
  /** Replace the tools' mcp.deferred flags with this list. Omitted: use the flags; []: all upfront. */
  deferred?: string[];
  /** The agent's folder, for its skills (AGENTS.md is the chat agent's and is not sent). Or `files`. */
  dir?: string;
  files?: AgentFiles;
  /** Replaces the instructions a host gets on connecting (default: the skills and how to read them). */
  instructions?: string;
  auth?: McpAuth;
  /** Backend access by verified account, separate from the bearer token issued for this MCP resource. */
  credentials?: CredentialProvider;
  /** The agent's records (`agent.records`), for tools that use `context.records`. Without them, such a tool's call fails saying so. */
  records?: Records;
  /** The agent's business events side (its `flowEvents`, or `agent.events` once attached: read here once), as the tools' `context.events`. Without it, `context.events` is absent. */
  businessEvents?: FlowEvents;
  /** Where the endpoint is mounted (default "/mcp"). */
  path?: string;
  /** Native plugins deliver skills themselves. Default: tools only at `${path}/plugin`. */
  plugin?: { path?: string } | false;
  /** Host names allowed in the Host header. Default: checked only for localhost, against DNS rebinding. */
  allowedHosts?: string[];
  /** Change the descriptor of any tool (default: exactly what `describe` makes). */
  descriptor?: (tool: Tool, generated: McpToolDescriptor) => McpToolDescriptor;
  /** Add your own handlers (resources, prompts, ...) to each server the SDK makes; one level down. */
  extend?: (server: Server) => void;
  events?: EventSink[];
  /**
   * The agent, for terminal chat (`<cli> chat`) on this origin, checked with `auth` like MCP. Flow's
   * hosting passes it to the `mcp(agent, host)` factory. A getter lets this server be made first.
   */
  agent?: Agent | (() => Agent);
  /**
   * Terminal chat at /agent/terminal. Default: served when `agent` and `auth` are both given, signed
   * in only. `guests: true` lets a CLI that is not signed in chat too (on the agent's model key).
   * false turns it off. An object serves it with `agent` even without `auth` (everyone a guest).
   */
  terminal?: false | { path?: string; channel?: string; guests?: boolean };
  /** Traces from FLOW_FRAMEWORK_TRACES_* (or legacy CHINWAG_TRACES_*) by default; false disables them. */
  traces?: TracesOptions | false;
}

export interface McpServerHandle {
  /** Serve one web-standard request. */
  fetch(request: Request): Promise<Response>;
  /** Serve one node:http request. */
  node(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** The descriptors `tools/list` sends. */
  descriptors: McpToolDescriptor[];
  /** Every path this handler serves, for a host that mounts paths (Flow's hosting); set when auth has routes. */
  paths?: string[];
  /** The tools-only plugin endpoint, unless disabled. */
  plugin?: { path: string; descriptors: McpToolDescriptor[] };
  /** Wait for calls queued for tracing, for shutdown or short-lived servers. */
  flushTraces(): Promise<void>;
}

const LOCAL = new Set(localhostAllowedHostnames());

const NO_RECORDS = unavailableRecords("give mcpServer({ records: agent.records })");

export function mcpServer(options: McpServerOptions): McpServerHandle {
  if (options.dir !== undefined && options.files !== undefined) throw new Error("@flow-engineer/flow/mcp: give dir or files, not both");
  const skills = options.dir !== undefined || options.files !== undefined ? loadSkills(options.files ?? readAgentFolder(options.dir!)) : [];
  const tools = [...options.tools, ...(skills.length ? [readSkillTool(skills)] : [])];
  const problems = toolsProblems(tools);
  if (problems.length) throw new Error(`@flow-engineer/flow/mcp: these tools cannot be served as declared:\n- ${problems.join("\n- ")}`);
  const scopes = options.auth?.scopes;
  const deferred = new Set(options.deferred ?? tools.filter(t => t.mcp?.deferred).map(t => t.name));
  for (const name of deferred) if (!tools.some(t => t.name === name)) throw new Error(`@flow-engineer/flow/mcp: deferred tool ${name} does not exist`);
  const sourceDescriptors = tools.map(t => {
    const generated = describe(t, scopes);
    if (t.name === "read_skill" && skills.length) generated._meta[SKILLS_META] = skills.map(({ name, description }) => ({ name, description }));
    return options.descriptor ? options.descriptor(t, generated) : generated;
  });
  const path = options.path ?? "/mcp";
  const pluginPath = options.plugin === false ? undefined : options.plugin?.path ?? `${path}/plugin`;
  for (const endpoint of [path, pluginPath].filter((p): p is string => p !== undefined)) {
    if (!endpoint.startsWith("/") || /[?#]/.test(endpoint)) throw new Error("@flow-engineer/flow/mcp: paths must be absolute URL paths");
  }
  if (pluginPath === path) throw new Error("@flow-engineer/flow/mcp: plugin and standalone paths must differ");
  const standalone = toolSurface(tools, sourceDescriptors, deferred, options.descriptor);
  const pluginSurface = toolSurface(options.tools, sourceDescriptors.slice(0, options.tools.length), deferred, options.descriptor);
  const descriptors = standalone.descriptors;
  const pluginDescriptors = pluginSurface.descriptors;
  const traceOptions = options.traces === false ? undefined : options.traces ?? tracesFromEnv();
  const trace = traceOptions ? traces(traceOptions, { service: options.name, kindOf: () => undefined }) : undefined;
  const emit = emitter([...(options.events ?? []), ...(trace ? [trace.sink] : [])]);

  // Legacy HTTP carries clientInfo only on initialize. Keep bounded metadata, never auth.
  const sessions = new Map<string, { client: { name: string; version: string }; path: string; at: number }>();
  const SESSION_TTL = 24 * 60 * 60 * 1000;
  function endpointHandler(plugin: boolean) {
    const instructions = options.instructions ?? (plugin ? "" : mcpInstructions(skills));
    const surface = plugin ? pluginSurface : standalone;
    return createMcpHandler(({ requestInfo }) => {
    const server = new Server({ name: options.name, version: options.version }, { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) });
    server.setRequestHandler("tools/list", async (_request, ctx) => ({ tools: ctx.mcpReq._meta?.[FULL_CATALOG_META] === true ? surface.full : surface.descriptors }));
    server.setRequestHandler("tools/call", async (request, ctx) => {
      const { tool: t, input } = surface.resolve(request.params.name, request.params.arguments ?? {});
      const identity = identityOf(ctx.http?.authInfo);
      const person = identity ? `key:${identity.key}` : "mcp:anonymous";
      const meta = ctx.mcpReq._meta ?? {};
      const sentKey = meta["chinwag/idempotency-key"];
      const session = requestInfo?.headers.get("mcp-session-id") ?? undefined;
      const host = server.getClientVersion() ?? (session ? sessions.get(session)?.client : undefined);
      const detail = {
        surface: meta["chinwag/surface"] === "cli" ? "cli" : plugin ? "mcp-plugin" : "mcp",
        client: host?.name,
        clientVersion: host?.version,
        session: ctx.sessionId ?? session,
        person,
        command: typeof meta["chinwag/command"] === "string" ? meta["chinwag/command"] : undefined,
      };
      const context: ToolContext = toolContext({
        conversationId: `mcp:${person}`,
        person,
        key: identity?.key ?? null,
        channel: "mcp",
        callId: randomUUID(),
        // CLI retries can preserve a call key; other hosts get one per request.
        idempotencyKey: typeof sentKey === "string" && sentKey.length > 0 && sentKey.length <= 256 ? sentKey : randomUUID(),
        signal: ctx.mcpReq?.signal ?? new AbortController().signal,
        records: options.records ?? NO_RECORDS,
        ...(options.businessEvents ? { events: options.businessEvents } : {}),
      }, (ctx.http?.authInfo?.extra?.credentials as CredentialProvider | undefined) ?? options.credentials);
      const started = Date.now();
      emit(context.conversationId, "tool.start", { callId: context.callId, tool: t.name, input, ...detail });
      const { result, formatError } = await callTool(t, input, context);
      emit(context.conversationId, "tool.end", { callId: context.callId, tool: t.name, ms: Date.now() - started, ok: !result.isError, output: result.structuredContent ?? result.content, error: result.isError ? result.content.filter(c => c.type === "text").map(c => c.text).join("\n") : undefined, formatError, ...detail });
      return result;
    });
    options.extend?.(server);
    return server;
    });
  }
  const handler = endpointHandler(false);
  const pluginHandler = pluginPath ? endpointHandler(true) : undefined;
  const terminal = terminalOf(options);
  if (terminal && [path, pluginPath, ...(options.auth?.routes?.paths ?? [])].includes(terminal.path)) throw new Error(`@flow-engineer/flow/mcp: the terminal path ${terminal.path} is already served`);

  async function serve(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const metadataPrefix = "/.well-known/oauth-protected-resource";
    const plugin = pluginPath !== undefined && (url.pathname === pluginPath || url.pathname === `${metadataPrefix}${pluginPath}`);
    const servedPath = plugin ? pluginPath! : path;
    const routes = options.auth?.routes;
    if (routes?.paths.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) return routes.fetch(request);
    if (terminal && url.pathname === terminal.path) return terminal.fetch(request);
    if (request.method === "GET" && (url.pathname === metadataPrefix || url.pathname === `${metadataPrefix}${servedPath}`)) {
      if (!options.auth) return new Response("Not found", { status: 404 });
      return Response.json({
        resource: resourceOf(url, servedPath),
        authorization_servers: [options.auth.issuer].flat(),
        bearer_methods_supported: ["header"],
        ...(scopes && (scopes.read || scopes.write) ? { scopes_supported: [...new Set([scopes.read, scopes.write].filter(Boolean))] } : {}),
      });
    }
    if (url.pathname !== servedPath) return new Response("Not found", { status: 404 });
    const rejected = options.allowedHosts
      ? hostHeaderValidationResponse(request, options.allowedHosts)
      : LOCAL.has(url.hostname)
        ? (hostHeaderValidationResponse(request, localhostAllowedHostnames()) ?? originValidationResponse(request, localhostAllowedOrigins()))
        : undefined;
    if (rejected) return rejected;

    for (const [id, saved] of sessions) if (Date.now() - saved.at > SESSION_TTL) sessions.delete(id);
    const session = request.headers.get("mcp-session-id");
    if (session && sessions.get(session)?.path !== servedPath) return new Response("Session not found", { status: 404 });
    let authInfo: AuthInfo | undefined;
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    if (options.auth && bearer) {
      const identity = await options.auth.verify(bearer, request);
      if (!identity) return challenge(url, servedPath, 401, "invalid_token", "The token is not valid.", []);
      authInfo = { token: bearer, clientId: "", scopes: identity.scopes ?? [], extra: { key: identity.key } };
      if (identity.credentials) Object.defineProperty(authInfo.extra!, "credentials", { value: identity.credentials, enumerable: false });
    }
    let parsedBody: unknown;
    if (request.method === "POST") {
      try {
        parsedBody = JSON.parse(await request.clone().text());
      } catch {
        parsedBody = undefined;
      }
      if (options.auth) {
        for (const message of [parsedBody].flat()) {
          const call = message as { method?: unknown; params?: { name?: unknown; arguments?: unknown } } | null;
          if (!call || call.method !== "tools/call" || typeof call.params?.name !== "string") continue;
          const t = (plugin ? pluginSurface : standalone).target(call.params.name, call.params.arguments);
          if (!t || signInOf(t) === "none") continue;
          const needed = scopesFor(t, scopes);
          if (!authInfo) {
            if (signInOf(t) === "required") return challenge(url, servedPath, 401, "invalid_token", `Sign in to use ${t.name}.`, needed);
            continue;
          }
          const missing = needed.filter((s) => !authInfo!.scopes.includes(s));
          if (missing.length) return challenge(url, servedPath, 403, "insufficient_scope", `${t.name} needs ${missing.join(" ")}.`, [...new Set([...authInfo.scopes, ...needed])]);
        }
      }
    }
    if (request.method === "DELETE" && session) {
      sessions.delete(session);
      return new Response(null, { status: 200 });
    }
    const response = await (plugin ? pluginHandler! : handler).fetch(request, { authInfo, parsedBody });
    const init = parsedBody as { method?: string; params?: { clientInfo?: { name?: unknown; version?: unknown } } } | undefined;
    if (response.ok && init?.method === "initialize") {
      const client = init.params?.clientInfo;
      if (typeof client?.name === "string" && typeof client.version === "string") {
        const id = randomUUID();
        sessions.set(id, { client: { name: client.name.slice(0, 256), version: client.version.slice(0, 256) }, path: servedPath, at: Date.now() });
        if (sessions.size > 4096) sessions.delete(sessions.keys().next().value!);
        const headers = new Headers(response.headers);
        headers.set("mcp-session-id", id);
        return new Response(response.body, { status: response.status, headers });
      }
    }
    return response;
  }

  function resourceOf(url: URL, servedPath: string): string {
    const resource = options.auth?.resource ?? `${url.origin}${path}`;
    if (servedPath === path) return resource;
    const pluginResource = new URL(resource);
    pluginResource.pathname = servedPath;
    return pluginResource.href;
  }

  function challenge(url: URL, servedPath: string, status: 401 | 403, error: string, description: string, scope: string[]): Response {
    const metadata = `${new URL(resourceOf(url, servedPath)).origin}/.well-known/oauth-protected-resource${servedPath}`;
    const header = `Bearer error="${error}", error_description="${description}", resource_metadata="${metadata}"${scope.length ? `, scope="${scope.join(" ")}"` : ""}`;
    return Response.json({ error, error_description: description }, { status, headers: { "WWW-Authenticate": header } });
  }

  return {
    fetch: serve,
    node: (req, res) => serveNode(serve, req, res),
    descriptors,
    flushTraces: () => trace?.flush() ?? Promise.resolve(),
    ...(pluginPath ? { plugin: { path: pluginPath, descriptors: pluginDescriptors } } : {}),
    ...(options.auth?.routes || terminal ? { paths: [...new Set([path, ...(pluginPath ? [pluginPath] : []), "/.well-known/oauth-protected-resource", ...(options.auth?.routes?.paths ?? []), ...(terminal ? [terminal.path] : [])])] } : {}),
  };
}

/** The terminal route mcpServer serves, with its auth; its channel is added to the agent before the first turn. */
function terminalOf(options: McpServerOptions) {
  const given = options.agent;
  if (!given || options.terminal === false || (!options.auth && !options.terminal)) return undefined;
  const settings = options.terminal || {};
  const agent = (): Agent => {
    const built = typeof given === "function" ? given() : given;
    built.addChannel(terminal.channel);
    return built;
  };
  const terminal = terminalServer({ agent, ...(options.auth ? { auth: options.auth } : {}), ...settings });
  if (typeof given !== "function") given.addChannel(terminal.channel);
  return terminal;
}

/** One endpoint's catalog. Plugin discovery never includes the standalone read_skill tool. */
function toolSurface(
  tools: Tool[],
  full: McpToolDescriptor[],
  deferred: Set<string>,
  override: McpServerOptions["descriptor"],
) {
  const operations = new Map<string, Tool>();
  const available = new Map<string, Tool>();
  for (const [index, tool] of tools.entries()) {
    const name = full[index].name;
    if (available.has(name)) throw new Error(`@flow-engineer/flow/mcp: two descriptors have the name ${name}`);
    available.set(name, tool);
    operations.set(name, tool);
  }
  const catalog = full.filter((_descriptor, index) => deferred.has(tools[index].name));
  const descriptors = full.filter((_descriptor, index) => !deferred.has(tools[index].name));
  let execute: Tool | undefined;

  function target(name: string, args: unknown): Tool | undefined {
    const tool = available.get(name);
    if (execute && tool === execute) {
      const parsed = execute.input.safeParse(args ?? {});
      return parsed.success ? operations.get(parsed.data.name) : undefined;
    }
    return tool;
  }

  function resolve(name: string, args: unknown): { tool: Tool; input: unknown } {
    let tool = available.get(name);
    if (!tool) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No tool named ${name}.`);
    let input = args;
    if (execute && tool === execute) {
      const parsed = execute.input.safeParse(input);
      if (!parsed.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid arguments for ${name}: ${parsed.error.message}`);
      const requested = parsed.data.name;
      tool = operations.get(requested);
      if (!tool) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No tool named ${requested}. Use search_tools to discover available tools.`);
      input = parsed.data.arguments;
    }
    const parsed = tool.input.safeParse(input);
    if (!parsed.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid arguments for ${tool.name}: ${parsed.error.message}`);
    return { tool, input: parsed.data };
  }

  function add(tool: Tool) {
    const generated = describe(tool);
    const descriptor = override ? override(tool, generated) : generated;
    if (available.has(descriptor.name)) throw new Error(`@flow-engineer/flow/mcp: two descriptors have the name ${descriptor.name}`);
    available.set(descriptor.name, tool);
    descriptors.push(descriptor);
  }

  if (catalog.length) {
    // A team's own tool with either name replaces that generated piece.
    if (!available.has("search_tools")) add({
      name: "search_tools",
      description: "Find MCP tools not listed upfront. Search by the task, tool name or keywords; use the returned name and inputSchema with execute_tool.",
      input: z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(20).default(5) }),
      output: z.object({ tools: z.array(z.record(z.string(), z.unknown())), total: z.number().int().nonnegative() }),
      signIn: "none",
      hints: { readOnly: true, idempotent: true, openWorld: false },
      run: ({ query, limit }) => searchCatalog(catalog, query, limit),
    });
    if (!available.has("execute_tool")) {
      execute = {
        name: "execute_tool",
        description: "Call an MCP tool by name with arguments matching its inputSchema. Use search_tools to discover deferred tools. The target's sign-in, scopes and validation still apply.",
        input: z.object({ name: z.string().min(1), arguments: z.record(z.string(), z.unknown()).default({}) }),
        signIn: "optional",
        hints: { readOnly: false, destructive: true, openWorld: true },
        run: (args, context) => {
          const resolved = resolve("execute_tool", args);
          return resolved.tool.run(resolved.input, context);
        },
      };
      add(execute);
    }
  }
  return { descriptors, full, resolve, target };
}

function searchCatalog(catalog: McpToolDescriptor[], query: string, limit: number): { tools: McpToolDescriptor[]; total: number } {
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])];
  const matches = catalog.map(tool => {
    const name = tool.name.toLowerCase();
    const text = `${tool.title} ${tool.description}`.toLowerCase();
    const score = (name === query.toLowerCase() ? 20 : 0) + terms.reduce((sum, term) => sum + (name.includes(term) ? 8 : 0) + (text.includes(term) ? 2 : 0), 0);
    return { tool, score };
  }).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  return { tools: matches.slice(0, limit).map(({ tool }) => tool), total: matches.length };
}

function identityOf(authInfo: AuthInfo | undefined): McpIdentity | null {
  const key = authInfo?.extra?.key;
  return typeof key === "string" ? { key, scopes: authInfo!.scopes } : null;
}

async function callTool(t: Tool, input: unknown, context: ToolContext): Promise<{ result: CallToolResult; formatError?: string }> {
  let output: unknown;
  try {
    output = await t.run(input, context);
  } catch (error) {
    return { result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] } };
  }
  if (!t.output) return { result: { content: [{ type: "text", text: render(output) }] } };
  const checked = t.output.safeParse(output);
  if (!checked.success) return { result: { isError: true, content: [{ type: "text", text: `${t.name} returned a result that does not match its output schema.` }] } };
  const data = { content: [{ type: "text" as const, text: render(checked.data) }], structuredContent: checked.data as CallToolResult["structuredContent"] };
  if (!t.format) return { result: data };
  // The tool has run: a formatter that fails sends the data as JSON, never an error.
  try {
    const text: unknown = t.format(checked.data);
    if (typeof text !== "string") return { result: data, formatError: `format returned ${typeof text}, not text` };
    return { result: { ...data, content: [{ type: "text", text }], _meta: { [FORMATTED]: true } } };
  } catch (error) {
    return { result: data, formatError: error instanceof Error ? error.message : String(error) };
  }
}

