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
import type { FlowEvents } from "../../src/business-events/engine.ts";
import { emitter, type EventSink } from "../../src/events.ts";
import { unavailableRecords, type Records } from "../../src/records.ts";
import { loadSkills, mcpInstructions, readAgentFolder, readSkillTool, SKILLS_META, type AgentFiles } from "../../src/skills.ts";
import { traces, tracesFromEnv, type TracesOptions } from "../../src/traces.ts";
import { render, toolContext, type CredentialProvider, type Tool, type ToolContext } from "../../src/tools.ts";
import { describe, scopesFor, signInOf, toolsProblems, type McpToolDescriptor, type Scopes } from "./describe.ts";

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
  const byName = new Map(tools.map((t) => [t.name, t]));
  const descriptors = tools.map(t => {
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
  const pluginDescriptors = descriptors.slice(0, options.tools.length);
  const traceOptions = options.traces === false ? undefined : options.traces ?? tracesFromEnv();
  const trace = traceOptions ? traces(traceOptions, { service: options.name, kindOf: () => undefined }) : undefined;
  const emit = emitter([...(options.events ?? []), ...(trace ? [trace.sink] : [])]);

  // Legacy HTTP carries clientInfo only on initialize. Keep bounded metadata, never auth.
  const sessions = new Map<string, { client: { name: string; version: string }; path: string; at: number }>();
  const SESSION_TTL = 24 * 60 * 60 * 1000;
  function endpointHandler(plugin: boolean) {
    const instructions = options.instructions ?? (plugin ? "" : mcpInstructions(skills));
    const listed = plugin ? pluginDescriptors : descriptors;
    const available = plugin ? new Map(options.tools.map((t) => [t.name, t])) : byName;
    return createMcpHandler(({ requestInfo }) => {
    const server = new Server({ name: options.name, version: options.version }, { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) });
    server.setRequestHandler("tools/list", async () => ({ tools: listed }));
    server.setRequestHandler("tools/call", async (request, ctx) => {
      const t = available.get(request.params.name);
      if (!t) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No tool named ${request.params.name}.`);
      const parsed = t.input.safeParse(request.params.arguments ?? {});
      if (!parsed.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid arguments for ${t.name}: ${parsed.error.message}`);
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
      emit(context.conversationId, "tool.start", { callId: context.callId, tool: t.name, input: parsed.data, ...detail });
      const result = await callTool(t, parsed.data, context);
      emit(context.conversationId, "tool.end", { callId: context.callId, tool: t.name, ms: Date.now() - started, ok: !result.isError, output: result.structuredContent ?? result.content, error: result.isError ? result.content.filter(c => c.type === "text").map(c => c.text).join("\n") : undefined, ...detail });
      return result;
    });
    options.extend?.(server);
    return server;
    });
  }
  const handler = endpointHandler(false);
  const pluginHandler = pluginPath ? endpointHandler(true) : undefined;

  async function serve(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const metadataPrefix = "/.well-known/oauth-protected-resource";
    const plugin = pluginPath !== undefined && (url.pathname === pluginPath || url.pathname === `${metadataPrefix}${pluginPath}`);
    const servedPath = plugin ? pluginPath! : path;
    const routes = options.auth?.routes;
    if (routes?.paths.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) return routes.fetch(request);
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
          const call = message as { method?: unknown; params?: { name?: unknown } } | null;
          if (!call || call.method !== "tools/call" || typeof call.params?.name !== "string") continue;
          const t = plugin && call.params.name === "read_skill" ? undefined : byName.get(call.params.name);
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
    ...(options.auth?.routes ? { paths: [...new Set([path, ...(pluginPath ? [pluginPath] : []), "/.well-known/oauth-protected-resource", ...options.auth.routes.paths])] } : {}),
  };
}

function identityOf(authInfo: AuthInfo | undefined): McpIdentity | null {
  const key = authInfo?.extra?.key;
  return typeof key === "string" ? { key, scopes: authInfo!.scopes } : null;
}

async function callTool(t: Tool, input: unknown, context: ToolContext): Promise<CallToolResult> {
  let output: unknown;
  try {
    output = await t.run(input, context);
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
  }
  if (!t.output) return { content: [{ type: "text", text: render(output) }] };
  const checked = t.output.safeParse(output);
  if (!checked.success) return { isError: true, content: [{ type: "text", text: `${t.name} returned a result that does not match its output schema.` }] };
  return { content: [{ type: "text", text: render(checked.data) }], structuredContent: checked.data as CallToolResult["structuredContent"] };
}

/** node:http in front of the web-standard handler, streaming the answer (event streams included). */
async function serveNode(serve: (request: Request) => Promise<Response>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const secure = (req.socket as { encrypted?: boolean }).encrypted === true;
  const url = `${secure ? "https" : "http"}://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  let body: ArrayBuffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const all = Buffer.concat(chunks);
    body = all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer;
  }
  const response = await serve(new Request(url, { method: req.method, headers, body, signal: abort.signal }));
  // Headers joins Set-Cookie values into one; node:http must get each as its own header.
  const cookies = response.headers.getSetCookie();
  res.writeHead(response.status, { ...Object.fromEntries(response.headers), ...(cookies.length ? { "set-cookie": cookies } : {}) });
  if (!response.body) return void res.end();
  try {
    for await (const chunk of response.body) res.write(chunk);
  } finally {
    res.end();
  }
}
