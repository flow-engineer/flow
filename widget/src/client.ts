// The chat box's line to the agent: the session, the history, the event stream (SSE over fetch, or
// long-polling the same endpoint when no hello comes within 3 s) and the visitor's messages, each
// retried under one id so the agent takes it once. No DOM: the panel draws what it emits, and the
// tests drive it against a fake server with their own clock.

export type Button = { id: string; label: string };
export type Link = { label: string; url: string };
export type Choice = { id?: string; title: string };
export type ChatEvent = { seq: number; at: number } & (
  | {
      type: "message"; from: "agent"; id: string; text: string; replyTo?: string; buttons?: Button[];
      list?: { button: string; rows: { id: string; title: string; description?: string }[] }; link?: Link; image?: { url: string };
    }
  | { type: "message"; from: "person"; id: string; text: string; choice?: Choice }
  | { type: "carousel"; id: string; text: string; replyTo?: string; cards: { image: { url: string }; text?: string; buttons?: Button[]; link?: Link }[] }
  | { type: "reaction"; messageId: string; emoji: string }
);
export type Live = { typing: boolean; status: string | null };
export type Update =
  | { kind: "history"; events: ChatEvent[] }
  | { kind: "event"; event: ChatEvent }
  | { kind: "live"; live: Live }
  | { kind: "sent"; id: string }
  /** Not sent: `error` is the agent's code (too_large, rate_limited, ...) or "network", after which `retry(id)` may send it again. */
  | { kind: "failed"; id: string; error: string }
  | { kind: "session"; signedIn: boolean; chars: number };

type KeyValue = { getItem(key: string): string | null; setItem(key: string, value: string): void };
type Meta = { page?: { url: string; title?: string }; context?: unknown };

export interface ClientOptions {
  /** The agent's origin and base: https://agent.example/v1/web-chat. */
  root: string;
  /** Where the visitor credential is kept; may throw (private windows, blocked storage). */
  storage?: () => KeyValue | null;
  /** A signed-in visitor's identity token from the business's backend, or null for an anonymous visitor. */
  identity?: () => Promise<string | null>;
  /** The page and the business's context, sent with each message. */
  meta?: () => Meta;
  fetch?: typeof fetch;
  now?: () => number;
  /** Resolves after `ms`, or at once when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const HELLO_MS = 3000;
const META_BYTES = 1024;

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** The page and context within 1 KB as JSON: the title goes first, then the context, then the URL's query. */
export function fitMeta({ page, context }: Meta): Meta {
  const url = page && new URL(page.url);
  const tries: Meta[] = [{ page, context }];
  if (page && url) tries.push({ page: { url: page.url }, context }, { page }, { page: { url: page.url } }, { page: { url: url.origin + url.pathname } });
  return tries.find((m) => bytes(m) <= META_BYTES) ?? {};
}

/** One SSE frame at a time from a fetch body. */
async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      let event = "message";
      const data: string[] = [];
      for (const line of buffer.slice(0, end).split("\n")) {
        const colon = line.indexOf(":");
        if (colon === 0) continue;
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      buffer = buffer.slice(end + 2);
      if (data.length) yield { event, data: data.join("\n") };
    }
  }
}

export function createClient(options: ClientOptions) {
  const { root } = options;
  const http = options.fetch ?? fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? wait;
  const key = "flow-chat:" + root;
  const listeners = new Set<(update: Update) => void>();
  const outgoing = new Map<string, string>();
  const sending = new Set<string>();
  let session: { token: string; expires: number } | null = null;
  let making: Promise<string> | null = null;
  let last = 0;
  let live: Live = { typing: false, status: null };
  let needHistory = true;
  let polling = false;
  let connected = false;
  let run = 0;
  let stream: AbortController | null = null;
  let awaiting = false;
  let made = 0;

  const emit = (update: Update) => listeners.forEach((listener) => listener(update));
  const store = (): KeyValue | null => {
    try {
      return options.storage ? options.storage() : localStorage;
    } catch {
      return null;
    }
  };
  const read = () => {
    try {
      return store()?.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  };
  const write = (value: string) => {
    try {
      store()?.setItem(key, value);
    } catch {}
  };

  async function newSession(): Promise<string> {
    let identity: string | null = null;
    try {
      identity = (await options.identity?.()) ?? null;
    } catch {}
    for (;;) {
      const answer = await http(root + "/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(identity ? { identity } : { visitor: read() }),
      });
      if (answer.status === 401 && identity) {
        identity = null; // A bad identity token: carry on as an anonymous visitor.
        continue;
      }
      if (answer.status === 429) {
        await sleep(retryAfter(answer, await answer.clone().json().catch(() => ({}))));
        continue;
      }
      if (!answer.ok) throw new Error(`session ${answer.status}`);
      const got = (await answer.json()) as { session: string; expires_at: number; signed_in: boolean; visitor?: string; limits?: { message_chars?: number } };
      if (got.visitor) write(got.visitor);
      session = { token: got.session, expires: got.expires_at };
      emit({ kind: "session", signedIn: got.signed_in, chars: got.limits?.message_chars ?? 2000 });
      return got.session;
    }
  }

  /** The session, made again a minute before it expires. */
  function token(): Promise<string> {
    if (session && now() < session.expires - 60_000) return Promise.resolve(session.token);
    making ??= newSession().finally(() => (making = null));
    return making;
  }

  /** A call with the session; a 401 makes a new session and tries once more. */
  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const go = async () => http(root + path, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: "Bearer " + (await token()) } });
    const answer = await go();
    if (answer.status !== 401) return answer;
    session = null;
    return go();
  }

  function take(event: ChatEvent) {
    if (event.seq <= last) return;
    last = event.seq;
    if (event.type !== "reaction" && !(event.type === "message" && event.from === "person")) awaiting = false;
    emit({ kind: "event", event });
  }

  function setLive(next: Live) {
    if (next.typing === live.typing && next.status === live.status) return;
    live = next;
    emit({ kind: "live", live });
  }

  async function loadHistory(signal: AbortSignal) {
    const answer = await call("/history", { signal });
    if (!answer.ok) throw new Error(`history ${answer.status}`);
    const got = (await answer.json()) as { messages: ChatEvent[]; cursor: number };
    last = got.cursor;
    needHistory = false;
    emit({ kind: "history", events: got.messages });
  }

  /** One SSE connection; returns when it ends. No hello within 3 s switches this box to long-polling. */
  async function streamOnce(control: AbortController) {
    let heard = false;
    void sleep(HELLO_MS, control.signal).then(() => {
      if (heard || control.signal.aborted) return;
      polling = true;
      control.abort();
    });
    try {
      const answer = await call("/events?after=" + last, { headers: { accept: "text/event-stream" }, signal: control.signal });
      if (!answer.ok || !answer.body) throw new Error(`events ${answer.status}`);
      if (!/^text\/event-stream/.test(answer.headers.get("content-type") ?? "")) {
        polling = true;
        return;
      }
      for await (const frame of frames(answer.body)) {
        const data = JSON.parse(frame.data);
        if (frame.event === "hello") heard = true;
        else if (frame.event === "message") take(data);
        else if (frame.event === "live") setLive(data);
        else if (frame.event === "reset") needHistory = true;
        else if (frame.event === "reconnect") break; // Resumed from the last event shown, which never skips one.
      }
      if (!heard) throw new Error("stream ended before hello");
    } catch (error) {
      if (!polling) throw error;
    } finally {
      control.abort();
    }
  }

  async function pollOnce(control: AbortController) {
    const answer = await call("/events?after=" + last, { headers: { accept: "application/json" }, signal: control.signal });
    if (answer.status === 429) return void (await sleep(retryAfter(answer, await answer.json().catch(() => ({}))), control.signal));
    if (!answer.ok) throw new Error(`events ${answer.status}`);
    const got = (await answer.json()) as { reset?: true; events?: ChatEvent[]; live?: Live };
    if (got.reset) needHistory = true;
    for (const event of got.events ?? []) take(event);
    if (got.live) setLive(got.live);
  }

  async function loop(mine: number) {
    let failures = 0;
    while (mine === run) {
      const control = (stream = new AbortController());
      try {
        if (needHistory) await loadHistory(control.signal);
        else if (polling) await pollOnce(control);
        else await streamOnce(control);
        failures = 0;
      } catch {
        if (mine !== run) return;
        await sleep(Math.min(30_000, 1000 * 2 ** failures++));
      }
    }
  }

  function restart() {
    run++;
    stream?.abort();
    if (connected) void loop(run);
  }

  async function deliver(id: string) {
    if (sending.has(id)) return;
    sending.add(id);
    try {
      await attempts(id);
    } finally {
      sending.delete(id);
    }
  }

  async function attempts(id: string) {
    for (let attempt = 0; outgoing.has(id); attempt++) {
      let answer: Response | null = null;
      try {
        answer = await call("/messages", { method: "POST", headers: { "content-type": "application/json" }, body: outgoing.get(id) });
      } catch {}
      if (answer?.ok) {
        outgoing.delete(id);
        return emit({ kind: "sent", id });
      }
      let delay = Math.min(30_000, 1000 * 2 ** attempt);
      if (answer && answer.status < 500) {
        const body = (await answer.json().catch(() => ({}))) as { error?: string; retry_after?: number };
        delay = retryAfter(answer, body);
        // Only a short rate limit is waited out; any other refusal is final.
        if (answer.status !== 429 || delay > 60_000) return fail(id, body.error ?? "bad_request");
      }
      if (attempt >= 5) return fail(id, "network");
      await sleep(delay);
    }
  }

  function fail(id: string, error: string) {
    if (error !== "network" && error !== "rate_limited") outgoing.delete(id);
    emit({ kind: "failed", id, error });
  }

  return {
    on(listener: (update: Update) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Opens the stream (the history first, once), resuming from the last event shown. */
    connect() {
      if (connected) return;
      connected = true;
      restart();
    },
    disconnect() {
      connected = false;
      restart();
    },
    /** A reply is due: the visitor wrote (or the agent is typing) and nothing from the agent has come since. */
    awaiting: () => awaiting || live.typing,
    /** Sends the visitor's message (or a tap); returns its id, the same on every retry. */
    send(text: string, choice?: Choice): string {
      const id = "w" + now().toString(36) + (++made).toString(36) + Math.random().toString(36).slice(2, 8);
      awaiting = true;
      outgoing.set(id, JSON.stringify({ id, text, ...(choice ? { choice } : {}), ...fitMeta(options.meta?.() ?? {}) }));
      void deliver(id);
      return id;
    },
    /** Sends a failed message again, under the same id. */
    retry(id: string) {
      void deliver(id);
    },
    /** A new session (the visitor signed in or out on the site): the thread is read again. */
    renew() {
      session = null;
      needHistory = true;
      restart();
    },
  };
}

function retryAfter(answer: Response, body: { retry_after?: number }) {
  return 1000 * (Number(body.retry_after ?? answer.headers.get("retry-after")) || 5);
}

export type Client = ReturnType<typeof createClient>;
