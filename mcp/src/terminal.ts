// A terminal channel beside MCP. Mount fetch wherever the agent's HTTP routes live. A bearer token
// makes the person whoever auth.verify says; without one, a guest chats under the id its CLI keeps.
// `{ reset: true }` instead of a message starts a new chat: the agent no longer sees what came before.
// A streamed turn starts with its id and numbers each event, kept before it is sent: a client whose
// stream was cut asks GET <path>?turn=<id>&after=<n> for the rest, from any instance. One that sends
// `flow-resume: 1` gets a `reconnect` event before a proxy's request timeout instead of a cut.
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { log } from "../../src/events.ts";
import { customUI } from "../../src/channels.ts";
import { START_TERMINAL_TURN, type Agent } from "../../src/agent.ts";
import type { Tool } from "../../src/tools.ts";
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
  /** Guidance for the agent while the person is on this channel. */
  instructions?: string;
  /** The channel's name in traces. Default "cli". */
  traceChannel?: string;
  /** The client draws each tool call as it runs (ChannelInfo.showsTools): the agent then answers once, with no acknowledgement first. Default off. */
  showsTools?: boolean;
  /** @deprecated Give createAgent a group limited to this channel instead (toolGroup); see Channel.tools. */
  tools?: () => Tool[];
  /** Called as each request starts, with the person it is for (key:<key> or guest:<id>), before the agent runs. */
  onRequest?: (person: string) => void;
}

export function terminalServer(options: TerminalServerOptions) {
  const path = options.path ?? "/agent/terminal";
  const channel = { ...customUI(options.channel ?? "terminal", { sendMessage: async () => { throw new Error("No terminal request is listening"); }, ...(options.instructions ? { instructions: options.instructions } : {}), ...(options.showsTools ? { info: { showsTools: true } } : {}), ...(options.tools ? { tools: options.tools } : {}) }), traceChannel: options.traceChannel ?? "cli" };
  let inFlight = 0;
  const pending = new Map<string, Promise<unknown>>();
  return {
    path,
    channel,
    async fetch(request: Request): Promise<Response> {
      if (new URL(request.url).pathname !== path) return new Response("Not found", { status: 404 });
      if (request.method !== "POST" && request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "POST, GET" } });
      const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      let identity;
      try { identity = token && options.auth ? await options.auth.verify(token, request) : null; } catch { identity = null; }
      const guest = !token && (options.guests ?? !options.auth) ? request.headers.get("flow-guest") : null;
      if (!identity?.key && !guest) return Response.json({ error: "sign_in_required" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
      if (guest && !/^[A-Za-z0-9_-]{16,128}$/.test(guest)) return Response.json({ error: "invalid_request" }, { status: 400 });
      const person = identity?.key ? { key: identity.key, credentials: identity.credentials } : { guest: guest! };
      const queue = identity?.key ? `key:${identity.key}` : `guest:${guest}`;
      if (request.method === "GET") return resume(request, options.agent().turnLog(channel.name), queue);
      options.onRequest?.(queue);
      let input;
      try { input = await request.json() as { text?: unknown; conversationId?: unknown; reset?: unknown }; } catch { return Response.json({ error: "invalid_request" }, { status: 400 }); }
      // A new chat: the agent stops seeing what came before (kept, not deleted), on this channel's person.
      if (input?.reset === true) {
        const reset = await options.agent().resetHistory({ to: { channel: channel.name, address: identity?.key ?? `guest:${guest}` }, note: "They started a new chat here." });
        return Response.json({ reset: reset.status === "reset" });
      }
      if (!input || typeof input.text !== "string" || !input.text.trim() || input.text.length > 32_768 || (input.conversationId !== undefined && typeof input.conversationId !== "string")) return Response.json({ error: "invalid_request" }, { status: 400 });
      if (inFlight >= 128) return Response.json({ error: "busy" }, { status: 429 });
      const agent = options.agent();
      inFlight++;
      const previous = pending.get(queue) ?? Promise.resolve();
      const run = (callbacks: Partial<Parameters<Agent["request"]>[0]> = {}) => {
        const work = previous.catch(() => undefined).then(() => agent.request({ channel: channel.name, ...person, text: input.text as string, conversationId: input.conversationId as string | undefined, ...callbacks }));
        pending.set(queue, work);
        return work.finally(() => { inFlight--; if (pending.get(queue) === work) pending.delete(queue); });
      };
      // Opt-in streaming leaves the original JSON contract unchanged for scripts and older clients.
      if (request.headers.get("accept")?.includes("application/x-ndjson")) {
        const turn = request.headers.get("flow-resume") === "1" ? randomBytes(16).toString("base64url") : undefined;
        const turns = turn ? agent.turnLog(channel.name) : undefined;
        const encoder = new TextEncoder();
        let disconnect = () => {};
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            let closed = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const detach = () => {
              if (closed) return;
              closed = true;
              clearTimeout(timer);
              request.signal.removeEventListener("abort", end);
            };
            const end = () => { if (!closed) { detach(); controller.close(); } };
            disconnect = detach;
            request.signal.addEventListener("abort", end, { once: true });
            if (request.signal.aborted) end();
            const write = (value: unknown) => { if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`)); };
            // Work may finish after the client leaves. Only persisted events can enter a resumable stream.
            let kept = Promise.resolve();
            let last = 0;
            let retaining = false;
            const push = (value: Record<string, unknown>) => {
              if (!turn || !turns) { write(value); return; }
              return kept = kept.then(async () => {
                if (!retaining) return;
                const seq = await turns.append(turn, value);
                if (seq === null) { retaining = false; end(); return; }
                last = seq;
                write({ ...value, seq });
              }).catch(error => {
                retaining = false;
                log("WARNING", "flow terminal: a turn event was not kept:", error instanceof Error ? error.name : "unknown");
                end();
              });
            };
            if (turn && !closed) timer = setTimeout(() => {
              if (last) write({ type: "reconnect", turn, after: last });
              end();
            }, STREAM_MS);
            void run({
              ...(turn && turns ? { [START_TERMINAL_TURN]: async (conversationId: string) => {
                retaining = await turns.start(turn, queue, conversationId);
                if (!retaining) throw new Error("The conversation was removed before the turn could start.");
                await push({ type: "turn", id: turn });
                if (!retaining) throw new Error("The turn could not be kept.");
              } } : {}),
              onReply: reply => { if (reply.type === "message") void push({ type: "reply", text: reply.text }); },
              onActivity: event => {
                // Deliberately project public activity fields, never a model prompt or hidden text.
                const { type, callId, tool, input, output, ok, ms, skill } = event;
                void push({ type: "activity", event: { type, callId, tool, input, output, ok, ms, skill } });
              },
            }).then(result => push({ type: "done", result }), error => {
              if (!last) write(failure(error));
              else return push(failure(error));
            })
              .finally(() => kept.then(() => { clearTimeout(timer); end(); }));
          },
          // Work already accepted by the agent continues if the client stops watching.
          cancel() { disconnect(); },
        });
        return new Response(body, { headers: NDJSON });
      }
      try { return Response.json(await run()); }
      catch (error) { return mismatch(error) ? Response.json({ error: "conversation_mismatch" }, { status: 409 }) : Response.json({ error: "turn_failed" }, { status: 500 }); }
    },
  };
}

/** A stream ends with `reconnect` before this, under Cloud Run's default 5-minute request timeout. */
const STREAM_MS = 4 * 60_000;
const NDJSON = { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-content-type-options": "nosniff" };

type TurnLog = ReturnType<Agent["turnLog"]>;

function failure(error: unknown): Record<string, unknown> {
  return mismatch(error) ? { type: "error", code: "conversation_mismatch", message: "That conversation is another person's." } : { type: "error", message: "The agent could not finish." };
}

/** The rest of a turn after event `after`: what was kept, then each event as it is kept, until it ends or the stream is due to reconnect. */
async function resume(request: Request, turns: TurnLog, queue: string): Promise<Response> {
  const url = new URL(request.url);
  const turn = url.searchParams.get("turn") ?? "";
  const after = Number(url.searchParams.get("after") ?? "0");
  if (!/^[A-Za-z0-9_-]{22}$/.test(turn) || !Number.isSafeInteger(after) || after < 0) return Response.json({ error: "invalid_request" }, { status: 400 });
  const initial = await turns.after(turn, queue, after, 100);
  if (!initial) return Response.json({ error: "unknown_turn" }, { status: 404 });
  if (initial.expired || after > initial.last) return Response.json({ error: "turn_expired" }, { status: 410 });
  const encoder = new TextEncoder();
  const cancel = new AbortController();
  const signal = AbortSignal.any([request.signal, cancel.signal]);
  let readerCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (value: unknown) => { if (!signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`)); };
      const ends = Date.now() + STREAM_MS;
      let cursor = after;
      let page = initial;
      try {
        // The turn may run on another instance, so its events are read from the store until it ends.
        while (!signal.aborted) {
          for (const { seq, event } of page.events) {
            write({ ...event, seq });
            cursor = seq;
            if (event.type === "done" || event.type === "error") return;
          }
          if (Date.now() >= ends) { write({ type: "reconnect", turn, after: cursor }); return; }
          if (cursor === page.last) await delay(POLL_MS, undefined, { signal });
          if (signal.aborted) return;
          const next = await turns.after(turn, queue, cursor, 100);
          if (!next || next.expired || cursor > next.last) return;
          page = next;
        }
      } catch (error) {
        if (!signal.aborted) log("WARNING", "flow terminal: a resumed turn could not be read:", error instanceof Error ? error.name : "unknown");
      } finally {
        if (!readerCancelled) controller.close();
      }
    },
    cancel() { readerCancelled = true; cancel.abort(); },
  });
  return new Response(body, { headers: NDJSON });
}

/** How often a resumed stream looks for the turn's next events. */
const POLL_MS = 250;

/** The conversation sent is not this person's (the CLI kept another account's): refused before any turn work. */
function mismatch(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "conversation_mismatch";
}
