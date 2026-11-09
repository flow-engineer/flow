// An agent's tools and skills as an MCP server (Streamable HTTP, spec 2026-07-28 with the 2025
// fallback), on the official SDK. It needs no model, channels or store: mount `fetch` on any
// web-standard runtime (Cloudflare Workers, Deno, Bun) or `node` on node:http, or serve it on
// stdio (`stdio()`) for a host that runs it as a local command. The CLI (defineCli({ server:
// handle })) can also call it in the same process, with no network.
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
  CLIENT_INFO_META_KEY,
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
import { FORMATTED, JSON_TEXT, jsonTextOf, render, toolContext, ToolError, type CredentialProvider, type McpClientKind, type Tool, type ToolContext, type ToolGroup } from "../../src/tools.ts";
import { terminalServer } from "./terminal.ts";
import { APP_PATH, appServer, appViewsOn, uiTools, UI_INSTRUCTIONS, type McpAppOptions } from "./app.ts";
import { describe, FULL_CATALOG_META, IN_PROCESS, MCP_CLIENT_KINDS, scopesFor, signInOf, toolsProblems, type McpToolDescriptor, type Scopes } from "./describe.ts";
import { adaptationOf, CONTRACT_META, contractOf, contractTools, type McpClientInfo, type McpContracts } from "./contracts.ts";

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
  /**
   * Who may use this server at all, of the people `verify` signs in. With it, every request needs
   * sign-in (even tools that need none), and a signed-in person it refuses gets 403. `only` sets it.
   */
  allow?: McpAccess;
}

/** Whether a signed-in person may use a server (McpAuth.allow). */
export type McpAccess = (who: McpIdentity, request: Request) => boolean | Promise<boolean>;

/** A sign-in that several servers share, and `only` keeps to some of its people for one of them. */
export interface McpSignIn extends McpAuth {
  /** The same sign-in, kept to the people `allow` accepts (and any this one already keeps to). */
  only(allow: McpAccess): McpSignIn;
}

/** An McpAuth with `only` (the OAuth bridge's `auth`). */
export function signIn(auth: McpAuth): McpSignIn {
  return {
    ...auth,
    only: (allow) => {
      const before = auth.allow;
      return signIn({ ...auth, allow: before ? async (who, request) => (await before(who, request)) && allow(who, request) : allow });
    },
  };
}

export interface McpIdentity {
  key: string;
  /** The person's verified email, when the sign-in knows it (for McpAuth.allow). */
  email?: string;
  scopes?: string[];
  /** Request-bound backend access, such as a brand token exchange. Never exposed to the model. */
  credentials?: CredentialProvider;
  /**
   * The OAuth client the token was issued to, which decides the tools kept to some clients
   * (Tool.mcp.clients): `kind` "cli" for the agent's own CLI. The OAuth bridge fills it in; a brand
   * with its own authorization server returns it from `verify`. Absent: a client like any host.
   */
  client?: { id: string; kind?: McpClientKind };
}

export interface McpServerOptions {
  name: string;
  version: string;
  /** The tools, plain or in groups (a group's channels are the chat agent's and do not apply here). */
  tools: (Tool | ToolGroup)[];
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
  /**
   * The web app at /app: these tools, terminal chat and how to add them elsewhere, in the brand's own
   * site (`<script src="<origin>/app/embed.js">`). With the OAuth bridge's `app`, people signed in on
   * the site are signed in here too.
   */
  app?: McpAppOptions;
  /** Traces from FLOW_FRAMEWORK_TRACES_* (or legacy CHINWAG_TRACES_*) by default; false disables them. */
  traces?: TracesOptions | false;
  /**
   * The contracts this server speaks, so clients built against an older one (a published CLI) keep
   * working: the current tools, and an adapter per older contract. Without it, there is one contract.
   */
  contracts?: McpContracts;
  /**
   * The built-in `feedback` tool (the CLI's `feedback` command): whoever calls the server tells the
   * team about the server itself ("tooling") or the product, and traces carry it to the dashboard.
   * Default on; false leaves it out. A tool of the team's own named `feedback` replaces it.
   */
  feedback?: boolean;
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
  /**
   * Serve the standalone endpoint's tools on stdin and stdout, for a host that runs this server as
   * a local command, until the host closes stdin; then the traces are flushed. Nothing but the
   * protocol goes to stdout. There is no sign-in on stdio: the person who runs the command is the
   * caller, anonymous to the tools (auth applies to HTTP), and tools kept to some clients are not served.
   */
  stdio(options?: { onerror?: (error: Error) => void }): Promise<void>;
}

const LOCAL = new Set(localhostAllowedHostnames());

const NO_RECORDS = unavailableRecords("give mcpServer({ records: agent.records })");

export function mcpServer(options: McpServerOptions): McpServerHandle {
  if (options.dir !== undefined && options.files !== undefined) throw new Error("@flow-engineer/flow/mcp: give dir or files, not both");
  const skills = options.dir !== undefined || options.files !== undefined ? loadSkills(options.files ?? readAgentFolder(options.dir!)) : [];
  const own = options.tools.flatMap(t => "tools" in t ? t.tools : [t]);
  const feedback = options.feedback === false || own.some(t => t.name === "feedback") ? undefined : feedbackTool(options.name);
  const tools = [...own, ...(skills.length ? [readSkillTool(skills)] : []), ...(feedback ? [feedback] : [])];
  const problems = toolsProblems(tools);
  if (problems.length) throw new Error(`@flow-engineer/flow/mcp: these tools cannot be served as declared:\n- ${problems.join("\n- ")}`);
  // A verified token says which client is calling; without auth, only the CLI in this process
  // (defineCli({ server: handle })) is told apart, so such a tool reaches it alone.
  const kept = tools.filter(t => t.mcp?.clients);
  const scopes = options.auth?.scopes;
  const deferred = new Set(options.deferred ?? tools.filter(t => t.mcp?.deferred).map(t => t.name));
  for (const name of deferred) if (!tools.some(t => t.name === name)) throw new Error(`@flow-engineer/flow/mcp: deferred tool ${name} does not exist`);
  const describeAll = (list: Tool[]) => list.map(t => {
    const generated = describe(t, scopes);
    if (t.name === "read_skill" && skills.length) (generated._meta ??= {})[SKILLS_META] = skills.map(({ name, description }) => ({ name, description }));
    return options.descriptor ? options.descriptor(t, generated) : generated;
  });
  const contracts = options.contracts;
  if (contracts) {
    for (const n of [contracts.current, ...Object.keys(contracts.supported ?? {}).map(Number)]) if (!Number.isInteger(n) || n < 1) throw new Error("@flow-engineer/flow/mcp: contracts are positive whole numbers");
    if (contracts.supported?.[contracts.current]) throw new Error("@flow-engineer/flow/mcp: the current contract needs no adapter");
  }
  const path = options.path ?? "/mcp";
  const pluginPath = options.plugin === false ? undefined : options.plugin?.path ?? `${path}/plugin`;
  for (const endpoint of [path, pluginPath].filter((p): p is string => p !== undefined)) {
    if (!endpoint.startsWith("/") || /[?#]/.test(endpoint)) throw new Error("@flow-engineer/flow/mcp: paths must be absolute URL paths");
  }
  if (pluginPath === path) throw new Error("@flow-engineer/flow/mcp: plugin and standalone paths must differ");
  // One catalog per kind of client a tool is kept to, and the default for every other client, so
  // a tool never reaches a client it is not for: not listed, not searchable, not callable.
  // An older contract's clients get the tools its adapter makes of these (contracts.ts).
  const surfacesFor = (kind: McpClientKind | undefined, contract: number | undefined) => {
    const adapter = contract === undefined || contract === contracts!.current ? undefined : contracts!.supported![contract]!;
    const surface = (source: Tool[]) => {
      const list = adapter ? contractTools(source, adapter) : source;
      const problems = adapter ? toolsProblems(list) : [];
      if (problems.length) throw new Error(`@flow-engineer/flow/mcp: contract ${contract}'s tools cannot be served as declared:\n- ${problems.join("\n- ")}`);
      const shown = list.filter(t => !t.mcp?.clients || (kind !== undefined && t.mcp.clients.includes(kind)));
      const hidden = new Set(shown.filter(t => deferred.has((adaptationOf(t)?.tool ?? t).name) || (!adaptationOf(t) && !source.includes(t) && t.mcp?.deferred)).map(t => t.name));
      return toolSurface(shown, describeAll(shown), hidden, options.descriptor);
    };
    return { standalone: surface(tools), plugin: surface([...own, ...(feedback ? [feedback] : [])]) };
  };
  const contractsServed = contracts ? [contracts.current, ...Object.keys(contracts.supported ?? {}).map(Number)] : [undefined];
  const kinds = [undefined, ...MCP_CLIENT_KINDS.filter(kind => kept.some(t => t.mcp!.clients!.includes(kind)))];
  const audiences = new Map<string, ReturnType<typeof surfacesFor>>(contractsServed.flatMap(contract => kinds.map(kind => [`${contract}:${kind}`, surfacesFor(kind, contract)] as const)));
  const surfaceOf = (plugin: boolean, authInfo: AuthInfo | undefined, contract?: number) => {
    const surfaces = audiences.get(`${contract}:${authInfo?.extra?.clientKind}`) ?? audiences.get(`${contract}:undefined`)!;
    return plugin ? surfaces.plugin : surfaces.standalone;
  };
  /** The contract a request speaks (undefined without contracts); throws for one not served. */
  const contractFor = (meta: Record<string, unknown> | undefined, client: McpClientInfo | undefined) => contracts ? contractOf(contracts, meta?.[CONTRACT_META], client, options.name) : undefined;
  const descriptors = surfaceOf(false, undefined, contracts?.current).descriptors;
  const pluginDescriptors = surfaceOf(true, undefined, contracts?.current).descriptors;
  const traceOptions = options.traces === false ? undefined : options.traces ?? tracesFromEnv();
  const trace = traceOptions ? traces(traceOptions, { service: options.name, kindOf: () => undefined }) : undefined;
  const emit = emitter([...(options.events ?? []), ...(trace ? [trace.sink] : [])]);

  // Legacy HTTP carries clientInfo only on initialize. Keep bounded metadata, never auth.
  const sessions = new Map<string, { client: { name: string; version: string }; path: string; at: number }>();
  const SESSION_TTL = 24 * 60 * 60 * 1000;
  /** The SDK server for one connection; `headers` are the HTTP request's (none on stdio). */
  function serverFor(plugin: boolean, headers?: Headers): Server {
    const instructions = options.instructions ?? mcpInstructions(plugin ? [] : skills, Boolean(feedback)) ?? "";
    const server = new Server({ name: options.name, version: options.version }, { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) });
    const clientOf = (): McpClientInfo | undefined => {
      const session = headers?.get("mcp-session-id") ?? undefined;
      return server.getClientVersion() ?? (session ? sessions.get(session)?.client : undefined);
    };
    server.setRequestHandler("tools/list", async (_request, ctx) => {
      const contract = contractFor(ctx.mcpReq._meta, clientOf());
      const surface = surfaceOf(plugin, ctx.http?.authInfo, contract);
      return { tools: ctx.mcpReq._meta?.[FULL_CATALOG_META] === true ? surface.full : surface.descriptors, ...(contract !== undefined ? { _meta: { [CONTRACT_META]: contract } } : {}) };
    });
    server.setRequestHandler("tools/call", async (request, ctx) => {
      const contract = contractFor(ctx.mcpReq._meta, clientOf());
      const { tool: t, input } = surfaceOf(plugin, ctx.http?.authInfo, contract).resolve(request.params.name, request.params.arguments ?? {});
      const identity = identityOf(ctx.http?.authInfo);
      const person = identity ? `key:${identity.key}` : "mcp:anonymous";
      const meta = ctx.mcpReq._meta ?? {};
      const sentKey = meta["chinwag/idempotency-key"];
      const session = headers?.get("mcp-session-id") ?? undefined;
      const host = clientOf();
      const detail = {
        surface: meta["chinwag/surface"] === "cli" ? "cli" : plugin ? "mcp-plugin" : "mcp",
        client: host?.name,
        clientVersion: host?.version,
        session: ctx.sessionId ?? session,
        person,
        command: typeof meta["chinwag/command"] === "string" ? meta["chinwag/command"] : undefined,
        ...(contract !== undefined ? { contract } : {}),
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
        ...(detail.surface === "cli" ? { cli: { ...(detail.command ? { command: detail.command } : {}) } } : {}),
      }, (ctx.http?.authInfo?.extra?.credentials as CredentialProvider | undefined) ?? options.credentials);
      const started = Date.now();
      emit(context.conversationId, "tool.start", { callId: context.callId, tool: t.name, input, ...detail });
      const { result, formatError } = await callTool(t, input, context);
      emit(context.conversationId, "tool.end", { callId: context.callId, tool: t.name, ms: Date.now() - started, ok: !result.isError, output: result.structuredContent ?? result.content, error: result.isError ? result.content.filter(c => c.type === "text").map(c => c.text).join("\n") : undefined, formatError, ...(t === feedback ? { feedback: input } : {}), ...detail });
      return result;
    });
    options.extend?.(server);
    return server;
  }
  const endpointHandler = (plugin: boolean) => createMcpHandler(({ requestInfo }) => serverFor(plugin, requestInfo?.headers));
  const handler = endpointHandler(false);
  const pluginHandler = pluginPath ? endpointHandler(true) : undefined;
  const terminal = terminalOf(options);
  if (terminal && [path, pluginPath, ...(options.auth?.routes?.paths ?? [])].includes(terminal.path)) throw new Error(`@flow-engineer/flow/mcp: the terminal path ${terminal.path} is already served`);
  const app = options.app ? appServer(options.app, { name: options.name, mcpPath: path, resource: options.auth?.resource, terminalPath: terminal?.path, tools: (audiences.get(`${contracts?.current}:cli`) ?? audiences.get(`${contracts?.current}:undefined`)!).standalone.full, chat: appChatOf(options, terminal), verify: options.auth && (async (token, request) => options.auth!.verify(token, request)) }) : undefined;

  /**
   * One request; `local` is the CLI in this process (IN_PROCESS): no sign-in or host checks, and the
   * client kind "cli". `at` is a path `mount` serves this server at: then only its endpoint (with
   * `${at}/plugin`) and their metadata are served here, and mount serves the rest once.
   */
  async function serve(request: Request, local = false, at?: string): Promise<Response> {
    const url = new URL(request.url);
    const metadataPrefix = "/.well-known/oauth-protected-resource";
    const endpoint = at ?? path;
    const pluginAt = pluginPath === undefined ? undefined : at === undefined ? pluginPath : `${at}/plugin`;
    const plugin = pluginAt !== undefined && (url.pathname === pluginAt || url.pathname === `${metadataPrefix}${pluginAt}`);
    const servedPath = plugin ? pluginAt! : endpoint;
    if (at === undefined) {
      const routes = options.auth?.routes;
      if (routes?.paths.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) return routes.fetch(request);
      if (terminal && url.pathname === terminal.path) return terminal.fetch(request);
      if (app?.paths.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) return app.fetch(request);
    }
    if (request.method === "GET" && (url.pathname === metadataPrefix || url.pathname === `${metadataPrefix}${servedPath}`)) {
      if (!options.auth) return new Response("Not found", { status: 404 });
      return Response.json({
        resource: resourceOf(url, servedPath, at),
        authorization_servers: [options.auth.issuer].flat(),
        bearer_methods_supported: ["header"],
        ...(scopes && (scopes.read || scopes.write) ? { scopes_supported: [...new Set([scopes.read, scopes.write].filter(Boolean))] } : {}),
      });
    }
    if (url.pathname !== servedPath) return new Response("Not found", { status: 404 });
    const rejected = local ? undefined : options.allowedHosts
      ? hostHeaderValidationResponse(request, options.allowedHosts)
      : LOCAL.has(url.hostname)
        ? (hostHeaderValidationResponse(request, localhostAllowedHostnames()) ?? originValidationResponse(request, localhostAllowedOrigins()))
        : undefined;
    if (rejected) return rejected;

    for (const [id, saved] of sessions) if (Date.now() - saved.at > SESSION_TTL) sessions.delete(id);
    const session = request.headers.get("mcp-session-id");
    if (session && sessions.get(session)?.path !== servedPath) return new Response("Session not found", { status: 404 });
    let authInfo: AuthInfo | undefined = local ? { token: "", clientId: "", scopes: [], extra: { clientKind: "cli" } } : undefined;
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    // A server kept to some people (auth.allow) answers nobody else, whatever the tool.
    if (options.auth?.allow && !bearer && !local) return challenge(url, servedPath, at, 401, "invalid_token", `Sign in to use ${options.name}.`, []);
    if (options.auth && bearer && !local) {
      const identity = await options.auth.verify(bearer, request);
      if (!identity) return challenge(url, servedPath, at, 401, "invalid_token", "The token is not valid.", []);
      if (options.auth.allow && !(await options.auth.allow(identity, request))) return Response.json({ error: "access_denied", error_description: `${options.name} is not available to this account.` }, { status: 403 });
      authInfo = { token: bearer, clientId: identity.client?.id ?? "", scopes: identity.scopes ?? [], extra: { key: identity.key, ...(identity.client?.kind ? { clientKind: identity.client.kind } : {}) } };
      if (identity.credentials) Object.defineProperty(authInfo.extra!, "credentials", { value: identity.credentials, enumerable: false });
    }
    let parsedBody: unknown;
    if (request.method === "POST") {
      try {
        parsedBody = JSON.parse(await request.clone().text());
      } catch {
        parsedBody = undefined;
      }
      if (options.auth && !local) {
        for (const message of [parsedBody].flat()) {
          const call = message as { method?: unknown; params?: { name?: unknown; arguments?: unknown; _meta?: Record<string, unknown> } } | null;
          if (!call || call.method !== "tools/call" || typeof call.params?.name !== "string") continue;
          let contract: number | undefined;
          // A contract not served is refused by the call itself, with how to upgrade.
          try { contract = contractFor(call.params._meta, (call.params._meta?.[CLIENT_INFO_META_KEY] as McpClientInfo | undefined) ?? (session ? sessions.get(session)?.client : undefined)); } catch { continue; }
          const t = surfaceOf(plugin, authInfo, contract).target(call.params.name, call.params.arguments);
          if (!t || signInOf(t) === "none") continue;
          const needed = scopesFor(t, scopes);
          if (!authInfo) {
            if (signInOf(t) === "required") return challenge(url, servedPath, at, 401, "invalid_token", `Sign in to use ${t.name}.`, needed);
            continue;
          }
          const missing = needed.filter((s) => !authInfo!.scopes.includes(s));
          if (missing.length) return challenge(url, servedPath, at, 403, "insufficient_scope", `${t.name} needs ${missing.join(" ")}.`, [...new Set([...authInfo.scopes, ...needed])]);
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

  /** The protected resource a path is: auth.resource for the endpoint, and its origin with the path for any other (the plugin's, or a path mount serves it at). */
  function resourceOf(url: URL, servedPath: string, at: string | undefined): string {
    const resource = options.auth?.resource ?? `${url.origin}${path}`;
    return at === undefined && servedPath === path ? resource : new URL(servedPath, resource).href;
  }

  function challenge(url: URL, servedPath: string, at: string | undefined, status: 401 | 403, error: string, description: string, scope: string[]): Response {
    const metadata = `${new URL(resourceOf(url, servedPath, at)).origin}/.well-known/oauth-protected-resource${servedPath}`;
    const header = `Bearer error="${error}", error_description="${description}", resource_metadata="${metadata}"${scope.length ? `, scope="${scope.join(" ")}"` : ""}`;
    return Response.json({ error, error_description: description }, { status, headers: { "WWW-Authenticate": header } });
  }

  async function stdio(settings: { onerror?: (error: Error) => void } = {}): Promise<void> {
    // Loaded only here: the HTTP endpoint runs on runtimes without node:process streams.
    const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
    const closed = new Promise<void>((done) => process.stdin.once("close", done).once("end", done));
    const served = serveStdio(() => serverFor(false), settings.onerror ? { onerror: settings.onerror } : {});
    await closed;
    await served.close();
    await trace?.flush();
  }

  const handle: McpServerHandle = {
    fetch: (request) => serve(withHost(request)),
    node: (req, res) => serveNode((request) => serve(request), req, res),
    descriptors,
    flushTraces: () => trace?.flush() ?? Promise.resolve(),
    stdio,
    ...(pluginPath ? { plugin: { path: pluginPath, descriptors: pluginDescriptors } } : {}),
    ...(options.auth?.routes || terminal || app ? { paths: [...new Set([path, ...(pluginPath ? [pluginPath] : []), "/.well-known/oauth-protected-resource", ...(options.auth?.routes?.paths ?? []), ...(terminal ? [terminal.path] : []), ...(app?.paths ?? [])])] } : {}),
  };
  // The CLI in this process reaches the standalone endpoint here, never over the network.
  Object.defineProperty(handle, IN_PROCESS, { value: { path, fetch: (request: Request) => serve(request, true) }, enumerable: false });
  const mountable: Mountable = {
    name: options.name, auth: options.auth, plugin: pluginPath !== undefined, own: Boolean(options.path || (options.plugin && options.plugin.path) || options.agent || options.app),
    appTools: (audiences.get(`${contracts?.current}:cli`) ?? audiences.get(`${contracts?.current}:undefined`)!).standalone.full,
    serve: (request, at) => serve(request, false, at),
  };
  Object.defineProperty(handle, MOUNTABLE, { value: mountable, enumerable: false });
  return handle;
}

/** What mount needs of a server: serving one of its paths, and what the web app shows of it. */
interface Mountable {
  name: string;
  auth?: McpAuth;
  plugin: boolean;
  /** It was given paths, a plugin path, terminal chat or a web app of its own, which mount serves instead. */
  own: boolean;
  appTools: McpToolDescriptor[];
  serve(request: Request, at: string): Promise<Response>;
}
const MOUNTABLE = Symbol("flow.mcp.mountable");
const WEB_APP = Symbol("flow.mcp.webApp");

export interface WebAppOptions extends McpAppOptions {
  /** The agent for the app's chat and terminal chat (/agent/terminal), as mcpServer's `agent`. Without it, the app has no chat. */
  agent?: Agent | (() => Agent);
  /** Terminal chat, as mcpServer's `terminal`. */
  terminal?: McpServerOptions["terminal"];
  /** The MCP server the app's panel calls and people add to their assistant. Default: the first server mounted. */
  server?: McpServerHandle;
}

/** The web app (panel, views, onboard widget) with its chat and terminal chat, for mount at "/app". */
export interface WebApp { readonly [WEB_APP]: WebAppOptions }

export function webApp(options: WebAppOptions): WebApp {
  return { [WEB_APP]: options };
}

/** Several MCP servers, the web app and terminal chat as one deployment: Flow's hosting takes it from the `mcp(agent, host)` factory like one server. */
export interface McpMount {
  fetch(request: Request): Promise<Response>;
  node(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Every path served, for a host that mounts paths (Flow's hosting). */
  paths: string[];
  /** Every server's descriptors, once by name. */
  descriptors: McpToolDescriptor[];
  flushTraces(): Promise<void>;
}

/**
 * Serve servers by path: each at its path (with `${path}/plugin` when it has a plugin endpoint), its
 * own protected resource `<origin><path>`, and one server may be at several paths. The sign-in's
 * routes (the OAuth bridge's, which every server shares) are served once, as are the web app at "/app"
 * and its terminal chat.
 */
export function mount(routes: Record<string, McpServerHandle | WebApp>): McpMount {
  const endpoints: { path: string; server: McpServerHandle; mountable: Mountable }[] = [];
  let app: WebAppOptions | undefined;
  for (const [path, value] of Object.entries(routes)) {
    if (!path.startsWith("/") || /[?#]/.test(path) || (path !== "/" && path.endsWith("/"))) throw new Error(`@flow-engineer/flow/mcp: mount paths are absolute URL paths, not "${path}"`);
    if (WEB_APP in value) {
      if (path !== APP_PATH) throw new Error(`@flow-engineer/flow/mcp: the web app is served at ${APP_PATH}, not ${path}`);
      app = value[WEB_APP];
      continue;
    }
    const mountable = (value as unknown as Record<symbol, Mountable | undefined>)[MOUNTABLE];
    if (!mountable) throw new Error(`@flow-engineer/flow/mcp: mount ${path}: give an mcpServer or webApp`);
    if (mountable.own) throw new Error(`@flow-engineer/flow/mcp: mount ${path}: ${mountable.name} has its own path, plugin path, terminal chat or app; mount sets its paths, and the web app and terminal chat go in webApp`);
    endpoints.push({ path, server: value, mountable });
  }
  if (!endpoints.length) throw new Error("@flow-engineer/flow/mcp: mount needs at least one MCP server");
  const served = endpoints.flatMap(({ path, mountable }) => mountable.plugin ? [path, `${path}/plugin`] : [path]);
  const duplicate = served.find((path, index) => served.indexOf(path) !== index || path === APP_PATH || path.startsWith(`${APP_PATH}/`));
  if (duplicate) throw new Error(`@flow-engineer/flow/mcp: mount serves ${duplicate} twice`);
  // One sign-in for all: the OAuth bridge's routes are served once, so every server must share them.
  const signInRoutes = [...new Set(endpoints.map(({ mountable }) => mountable.auth?.routes).filter((r) => r !== undefined))];
  if (signInRoutes.length > 1) throw new Error("@flow-engineer/flow/mcp: mounted servers share one sign-in (the same OAuth bridge's auth, kept to some people with only)");
  const signIn = signInRoutes[0];

  const appServerAt = app && (endpoints.find(({ server }) => server === app!.server) ?? (app.server ? undefined : endpoints[0]));
  if (app && !appServerAt) throw new Error("@flow-engineer/flow/mcp: webApp's server is not mounted");
  const auth = appServerAt?.mountable.auth;
  const terminal = app && terminalOf({ agent: app.agent, terminal: app.terminal, auth });
  if (terminal && served.includes(terminal.path)) throw new Error(`@flow-engineer/flow/mcp: the terminal path ${terminal.path} is already served`);
  const web = app && appServerAt && appServer(app, {
    name: appServerAt.mountable.name, mcpPath: appServerAt.path, terminalPath: terminal?.path, tools: appServerAt.mountable.appTools,
    ...(auth?.resource ? { resource: new URL(appServerAt.path, auth.resource).href } : {}),
    chat: appChatOf({ app, agent: app.agent, auth }, terminal),
    verify: auth && (async (token, request) => auth.verify(token, request)),
  });

  const metadataPrefix = "/.well-known/oauth-protected-resource";
  const under = (pathname: string, paths: string[]) => paths.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  async function serve(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (signIn && under(pathname, signIn.paths)) return signIn.fetch(request);
    if (terminal && pathname === terminal.path) return terminal.fetch(request);
    if (web && under(pathname, web.paths)) return web.fetch(request);
    const resource = pathname.startsWith(`${metadataPrefix}/`) ? pathname.slice(metadataPrefix.length) : pathname;
    for (const { path, mountable } of endpoints) {
      if (resource === path || (mountable.plugin && resource === `${path}/plugin`)) return mountable.serve(request, path);
    }
    return new Response("Not found", { status: 404 });
  }
  const servers = [...new Set(endpoints.map(({ server }) => server))];
  return {
    fetch: (request) => serve(withHost(request)),
    node: (req, res) => serveNode(serve, req, res),
    paths: [...new Set([...served, metadataPrefix, ...(signIn?.paths ?? []), ...(terminal ? [terminal.path] : []), ...(web?.paths ?? [])])],
    descriptors: [...new Map(servers.flatMap((server) => server.descriptors).map((d) => [d.name, d])).values()],
    flushTraces: async () => { await Promise.all(servers.map((server) => server.flushTraces())); },
  };
}

/**
 * A request made in code (a client's own fetch to handle.fetch) has no Host header: its URL's host
 * is the one it is for. A browser always sends Host, so the DNS-rebinding check still reads the browser's.
 */
function withHost(request: Request): Request {
  if (request.headers.has("host")) return request;
  const headers = new Headers(request.headers);
  headers.set("host", new URL(request.url).host);
  return new Request(request, { headers });
}

/**
 * The web app's own chat (its channel "app"), beside terminal chat and checked the same way. On Flow's
 * hosting its answers are drawn as views, so the agent is told to keep its words short.
 */
function appChatOf(options: Pick<McpServerOptions, "app" | "agent" | "auth">, terminal: ReturnType<typeof terminalOf>) {
  if (!options.app || !terminal || !options.agent) return undefined;
  const given = options.agent;
  const views = appViewsOn();
  const ui = views && options.app.ui?.length ? uiTools(options.app.ui, options.app.pages, options.app.site) : undefined;
  const chat = terminalServer({
    agent: () => { const built = typeof given === "function" ? given() : given; join(built); return built; },
    ...(options.auth ? { auth: { verify: (token: string, request: Request) => options.auth!.verify(token, request) } } : {}),
    path: "/app/chat",
    channel: "app",
    traceChannel: "web",
    // The panel draws every tool call as it runs, so the agent answers once instead of acknowledging first.
    showsTools: true,
    // On Flow's hosting the answer is shown with the brand's UI tools (uiTools), picked by the agent.
    ...(ui ? { instructions: UI_INSTRUCTIONS, onRequest: ui.answer } : {}),
  });
  // The views are a group of the agent's, limited to this channel; an agent that has its own views group keeps it.
  const join = (built: Agent) => { built.addChannel(chat.channel); if (ui && !built.group(ui.name)) built.addGroup(ui); };
  if (typeof given !== "function") join(given);
  return chat;
}

/** The terminal route mcpServer serves, with its auth; its channel is added to the agent before the first turn. */
function terminalOf(options: Pick<McpServerOptions, "agent" | "terminal" | "auth">) {
  const given = options.agent;
  if (!given || options.terminal === false || (!options.auth && !options.terminal)) return undefined;
  const settings = options.terminal || {};
  const agent = (): Agent => {
    const built = typeof given === "function" ? given() : given;
    built.addChannel(terminal.channel);
    return built;
  };
  // Chat can lead to any tool, and the chat runner checks sign-in, not scopes: only a token with every
  // scope the server names may chat. One without them is refused as if it were not valid.
  const auth = options.auth;
  const needed = [auth?.scopes?.read, auth?.scopes?.write].filter((s): s is string => Boolean(s));
  const verify = auth && (async (token: string, request: Request) => {
    const identity = await auth.verify(token, request);
    return identity && needed.every(s => identity.scopes?.includes(s)) ? identity : null;
  });
  const terminal = terminalServer({ agent, ...(verify ? { auth: { verify } } : {}), ...settings });
  if (typeof given !== "function") given.addChannel(terminal.channel);
  return terminal;
}

/** The built-in feedback tool. Its run only thanks: the call's tool.end event carries what was said. */
function feedbackTool(name: string): Tool {
  return {
    name: "feedback",
    title: "Tell the team what failed, is missing or could be better",
    description: `Tell the team behind ${name} what went wrong, what is missing or what could be better. about "tooling": this MCP server or CLI itself (a tool that failed or is missing, confusing inputs or results); "product": ${name} itself. Never include keys, passwords or anyone's personal details.`,
    input: z.object({
      about: z.enum(["tooling", "product"]).describe("tooling: this MCP server or CLI; product: the service behind it"),
      message: z.string().trim().min(1).max(2000).describe("What happened and what you expected"),
      tool: z.string().trim().min(1).max(100).optional().describe("The tool the feedback is about, if any"),
    }),
    signIn: "none",
    hints: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
    run: () => `Sent to the team behind ${name}. Thank you.`,
  };
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

/** An older contract's tool runs the current one: its text is the current tool's, its data reshaped by the adapter. */
async function callTool(t: Tool, input: unknown, context: ToolContext): Promise<{ result: CallToolResult; formatError?: string }> {
  const adapted = adaptationOf(t);
  if (!adapted) return presentTool(t, input, context);
  const { tool: current, adapter } = adapted;
  let given: unknown;
  try { given = current.input.parse(adapter.mapInput ? adapter.mapInput(input) : input); }
  catch (error) { return { result: { isError: true, content: [{ type: "text", text: `${t.name}: its input does not map to ${current.name}'s (${error instanceof Error ? error.message : String(error)})` }] } }; }
  const { value: output, ...shown } = await presentTool(current, given, context);
  if (shown.result.isError || !adapter.mapOutput) return shown;
  let value: unknown;
  try { value = adapter.mapOutput(output, input); }
  catch (error) { return { result: { isError: true, content: [{ type: "text", text: `${t.name}: its result does not map to its contract's (${error instanceof Error ? error.message : String(error)})` }] } }; }
  if (t.output && !t.output.safeParse(value).success) return { result: { isError: true, content: [{ type: "text", text: `${t.name} returned a result that does not match its contract's output schema.` }] } };
  const formatted = shown.result._meta?.[FORMATTED] === true;
  return { ...shown, result: {
    content: formatted ? shown.result.content : [{ type: "text", text: render(value) }],
    ...(t.output ? { structuredContent: value as CallToolResult["structuredContent"] } : {}),
    ...(formatted ? { _meta: { [FORMATTED]: true } } : {}),
  } };
}

/** Run a tool and make its result; `value` is its output as checked, for an adapter. */
async function presentTool(t: Tool, input: unknown, context: ToolContext): Promise<{ result: CallToolResult; formatError?: string; value?: unknown }> {
  let output: unknown;
  try {
    output = await t.run(input, context);
  } catch (error) {
    // A ToolError is a failure document the caller acts on: structured, and the same as text.
    if (error instanceof ToolError) {
      const document = error.document;
      return { result: { isError: true, structuredContent: document as unknown as CallToolResult["structuredContent"], content: [{ type: "text", text: `${error.message}${error.next ? `\nNext: ${error.next}` : ""}\n${JSON.stringify(document)}` }] } };
    }
    return { result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] } };
  }
  // Output given with its JSON as text (jsonText) is sent as that text, byte for byte.
  const raw = jsonTextOf(output);
  const marked = raw === undefined ? {} : { _meta: { [JSON_TEXT]: true } };
  if (!t.output) return { result: { content: [{ type: "text", text: render(output) }], ...marked }, value: output };
  const checked = t.output.safeParse(output);
  if (!checked.success) return { result: { isError: true, content: [{ type: "text", text: `${t.name} returned a result that does not match its output schema.` }] } };
  const data = { content: [{ type: "text" as const, text: raw ?? render(checked.data) }], structuredContent: checked.data as CallToolResult["structuredContent"], ...marked };
  const value = checked.data;
  if (!t.format) return { result: data, value };
  // The tool has run: a formatter that fails sends the data as JSON, never an error.
  try {
    const text: unknown = t.format(checked.data, input);
    if (typeof text !== "string") return { result: data, value, formatError: `format returned ${typeof text}, not text` };
    // A CLI prints the JSON text with --json, so it rides beside the tool's own text; hosts read the text.
    return { result: { ...data, content: [{ type: "text", text }], _meta: { [FORMATTED]: true, ...(raw !== undefined && context.cli ? { [JSON_TEXT]: raw } : {}) } }, value };
  } catch (error) {
    return { result: data, value, formatError: error instanceof Error ? error.message : String(error) };
  }
}

