// An authenticated terminal channel beside MCP. Mount fetch wherever the agent's HTTP routes live.
import { customUI } from "../../src/channels.ts";
import type { Agent } from "../../src/agent.ts";
import type { McpAuth } from "./server.ts";

export interface TerminalServerOptions {
  /** A getter lets the channel be declared before building the agent that uses it. */
  agent: () => Agent;
  auth: Pick<McpAuth, "verify">;
  path?: string;
  channel?: string;
}

export function terminalServer(options: TerminalServerOptions) {
  const path = options.path ?? "/agent/terminal";
  const channel = { ...customUI(options.channel ?? "terminal", { sendMessage: async () => { throw new Error("No terminal request is listening"); } }), traceChannel: "cli" };
  let inFlight = 0;
  const pending = new Map<string, Promise<unknown>>();
  return {
    path,
    channel,
    async fetch(request: Request): Promise<Response> {
      if (new URL(request.url).pathname !== path) return new Response("Not found", { status: 404 });
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
      const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      let identity;
      try { identity = token ? await options.auth.verify(token, request) : null; } catch { identity = null; }
      if (!identity?.key) return Response.json({ error: "sign_in_required" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
      let input;
      try { input = await request.json() as { text?: unknown; conversationId?: unknown }; } catch { return Response.json({ error: "invalid_request" }, { status: 400 }); }
      if (!input || typeof input.text !== "string" || !input.text.trim() || input.text.length > 32_768 || (input.conversationId !== undefined && typeof input.conversationId !== "string")) return Response.json({ error: "invalid_request" }, { status: 400 });
      if (inFlight >= 128) return Response.json({ error: "busy" }, { status: 429 });
      inFlight++;
      const previous = pending.get(identity.key) ?? Promise.resolve();
      const work = previous.catch(() => undefined).then(() => options.agent().request({ channel: channel.name, key: identity.key, text: input.text as string, conversationId: input.conversationId as string | undefined, credentials: identity.credentials }));
      pending.set(identity.key, work);
      try { return Response.json(await work); }
      catch { return Response.json({ error: "turn_failed" }, { status: 500 }); }
      finally { inFlight--; if (pending.get(identity.key) === work) pending.delete(identity.key); }
    },
  };
}
