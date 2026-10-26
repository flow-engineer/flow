// A terminal channel beside MCP. Mount fetch wherever the agent's HTTP routes live. A bearer token
// makes the person whoever auth.verify says; without one, a guest chats under the id its CLI keeps.
import { customUI } from "../../src/channels.ts";
import type { Agent } from "../../src/agent.ts";
import type { McpAuth } from "./server.ts";

export interface TerminalServerOptions {
  /** A getter lets the channel be declared before building the agent that uses it. */
  agent: () => Agent;
  /** Verifies a signed-in person's token. Without it every person is a guest. */
  auth?: Pick<McpAuth, "verify">;
  /** Chat without sign-in, as a guest; tools that need sign-in still ask. Default: on without `auth`, off with it. */
  guests?: boolean;
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
      try { identity = token && options.auth ? await options.auth.verify(token, request) : null; } catch { identity = null; }
      const guest = !token && (options.guests ?? !options.auth) ? request.headers.get("flow-guest") : null;
      if (!identity?.key && !guest) return Response.json({ error: "sign_in_required" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
      if (guest && !/^[A-Za-z0-9_-]{16,128}$/.test(guest)) return Response.json({ error: "invalid_request" }, { status: 400 });
      const person = identity?.key ? { key: identity.key, credentials: identity.credentials } : { guest: guest! };
      const queue = identity?.key ? `key:${identity.key}` : `guest:${guest}`;
      let input;
      try { input = await request.json() as { text?: unknown; conversationId?: unknown }; } catch { return Response.json({ error: "invalid_request" }, { status: 400 }); }
      if (!input || typeof input.text !== "string" || !input.text.trim() || input.text.length > 32_768 || (input.conversationId !== undefined && typeof input.conversationId !== "string")) return Response.json({ error: "invalid_request" }, { status: 400 });
      if (inFlight >= 128) return Response.json({ error: "busy" }, { status: 429 });
      inFlight++;
      const previous = pending.get(queue) ?? Promise.resolve();
      const run = (callbacks: Partial<Parameters<Agent["request"]>[0]> = {}) => {
        const work = previous.catch(() => undefined).then(() => options.agent().request({ channel: channel.name, ...person, text: input.text as string, conversationId: input.conversationId as string | undefined, ...callbacks }));
        pending.set(queue, work);
        return work.finally(() => { inFlight--; if (pending.get(queue) === work) pending.delete(queue); });
      };
      // Opt-in streaming leaves the original JSON contract unchanged for scripts and older clients.
      if (request.headers.get("accept")?.includes("application/x-ndjson")) {
        const encoder = new TextEncoder();
        let closed = false;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const push = (value: unknown) => { if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`)); };
            void run({
              onReply: reply => { if (reply.type === "message") push({ type: "reply", text: reply.text }); },
              onActivity: event => {
                // Deliberately project public activity fields, never a model prompt or hidden text.
                const { type, callId, tool, input, output, ok, ms, skill } = event;
                push({ type: "activity", event: { type, callId, tool, input, output, ok, ms, skill } });
              },
            }).then(result => push({ type: "done", result }), error => push(mismatch(error) ? { type: "error", code: "conversation_mismatch", message: "That conversation is another person's." } : { type: "error", message: "The agent could not finish." }))
              .finally(() => { if (!closed) { closed = true; controller.close(); } });
          },
          // Work already accepted by the agent continues if the client stops watching.
          cancel() { closed = true; },
        });
        return new Response(body, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      }
      try { return Response.json(await run()); }
      catch (error) { return mismatch(error) ? Response.json({ error: "conversation_mismatch" }, { status: 409 }) : Response.json({ error: "turn_failed" }, { status: 500 }); }
    },
  };
}

/** The conversation sent is not this person's (the CLI kept another account's): refused before any turn work. */
function mismatch(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "conversation_mismatch";
}
