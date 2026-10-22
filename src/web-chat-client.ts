// The web chat's browser side, with no UI: it keeps the session, loads the history, long-polls for
// what the agent sends, and posts the visitor's messages, retrying with the same id so each is taken
// once. Your chat box renders what it emits. It imports nothing from Node, for any bundler:
//
//   import { webChatClient } from "@flow-engineer/flow/web-chat";
//   const chat = webChatClient({ url: "https://agent.example" });
//   chat.on((event) => render(event));
//   await chat.start();
//   await chat.send("Is the blue one in stock?", { page: { url: location.href, title: document.title } });

import type { WebChatEvent, WebChatEventBody, WebChatFile, WebChatPage } from "./web-chat.ts";

/** What the client emits: the history (again after the agent restarted), then each event as it comes. */
export type WebChatClientEvent = { type: "history"; messages: Array<WebChatEventBody & { at: number }> } | WebChatEvent;

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };

export interface WebChatClientOptions {
  /** The agent's address: https://agent.example. */
  url: string;
  /** Where the agent's web chat answers. Default "/v1/web-chat". */
  base?: string;
  /** Your server's sign-in token for a visitor who is signed in on your site (webChatSignIn), or null for an anonymous visitor. Asked for each new session. */
  signIn?: () => Promise<string | null> | string | null;
  /** Where an anonymous visitor's session is kept between visits. Default localStorage when there is one. */
  storage?: Storage | null;
  /** How long one poll waits for news, seconds (at most 25). Default 25. */
  waitSeconds?: number;
  fetch?: typeof fetch;
}

export interface WebChatClient {
  /** Calls `listener` with every event; returns the function that stops it. */
  on(listener: (event: WebChatClientEvent) => void): () => void;
  /** Starts the session, emits the history, then keeps polling until close(). */
  start(): Promise<void>;
  /** Sends the visitor's message (or a tap: `choice`); resolves with its id once the agent took it. */
  send(text: string, options?: { choice?: { id?: string; title: string }; page?: WebChatPage; attachments?: Array<{ ref: string } | (WebChatFile & { ref: string })> }): Promise<string>;
  /** Sends the agent a file (a photo, a PDF, a recorded voice note) to attach to a message: pass what it resolves with in `send`'s `attachments`. */
  upload(file: Blob, name?: string): Promise<WebChatFile & { ref: string }>;
  close(): void;
}

export function webChatClient(options: WebChatClientOptions): WebChatClient {
  const root = options.url.replace(/\/+$/, "") + (options.base ?? "/v1/web-chat").replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const storage = options.storage !== undefined ? options.storage : ((globalThis as { localStorage?: Storage }).localStorage ?? null);
  const storageKey = `flow-web-chat:${root}`;
  const wait = Math.min(25, options.waitSeconds ?? 25);
  const listeners = new Set<(event: WebChatClientEvent) => void>();
  const seen = new Set<string>();
  let session: string | null = null;
  let cursor: string | null = null;
  let closed = false;
  let polling: AbortController | null = null;
  let sent = 0;

  // A file's `src` is a path on the agent: it is made a full URL here, for an <img> or a link.
  const origin = options.url.replace(/\/+$/, "");
  const full = (src?: string) => (src?.startsWith("/") ? origin + src : src);
  const located = <E extends WebChatEventBody>(e: E): E => {
    if (e.type === "message" && e.from === "person" && e.attachments) return { ...e, attachments: e.attachments.map((f) => ({ ...f, src: full(f.src) })) };
    if (e.type === "message" && e.from === "agent" && e.image && "src" in e.image) return { ...e, image: { ...e.image, src: full(e.image.src as string) } };
    if (e.type === "carousel") return { ...e, cards: e.cards.map((c) => ("src" in c.image ? { ...c, image: { ...c.image, src: full(c.image.src as string) } } : c)) };
    return e;
  };

  const emit = (event: WebChatClientEvent) => {
    if (event.type !== "history") event = located(event);
    // The person's own messages are echoed, and a retried one twice: each id is shown once.
    if (event.type === "message" && event.from === "person") {
      if (seen.has(event.id)) return;
      seen.add(event.id);
    }
    for (const listener of listeners) listener(event);
  };

  async function newSession(): Promise<string> {
    const token = options.signIn ? await options.signIn() : null;
    const answer = await doFetch(`${root}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(token ? { token } : {}) });
    if (!answer.ok) throw new Error(`flow web chat: no session (${answer.status}): ${await answer.text()}`);
    const made = (await answer.json()) as { session: string; signed_in: boolean };
    // A signed-in visitor's session stays in memory: their site signs them in again.
    if (!made.signed_in) storage?.setItem(storageKey, made.session);
    return made.session;
  }

  /** A request with the session; a session the agent no longer takes is made again, once. */
  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    session ??= (!options.signIn && storage?.getItem(storageKey)) || (await newSession());
    const go = () => doFetch(`${root}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${session}` } });
    let answer = await go();
    if (answer.status === 401) {
      storage?.removeItem(storageKey);
      session = await newSession();
      answer = await go();
    }
    return answer;
  }

  async function loadHistory(): Promise<void> {
    const answer = await call("/history");
    if (!answer.ok) throw new Error(`flow web chat: history (${answer.status})`);
    const { messages, cursor: from } = (await answer.json()) as { messages: Array<WebChatEventBody & { at: number }>; cursor: string };
    for (const m of messages) if (m.type === "message" && m.from === "person") seen.add(m.id);
    cursor = from;
    for (const listener of listeners) listener({ type: "history", messages: messages.map(located) });
  }

  async function poll(): Promise<void> {
    let failures = 0;
    while (!closed) {
      try {
        polling = new AbortController();
        const answer = await call(`/events?after=${encodeURIComponent(cursor!)}&wait=${wait}`, { signal: polling.signal });
        if (!answer.ok) throw new Error(`flow web chat: events (${answer.status})`);
        const got = (await answer.json()) as { events: WebChatEvent[]; cursor: string } | { reset: true };
        if ("reset" in got) await loadHistory();
        else {
          cursor = got.cursor;
          for (const event of got.events) emit(event);
        }
        failures = 0;
      } catch (error) {
        if (closed) return;
        // Offline, or the agent restarting: try again, waiting longer each time (at most 30 s).
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1000 * 2 ** failures++)));
      }
    }
  }

  return {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start() {
      await loadHistory();
      void poll();
    },
    async send(text, extra = {}) {
      const id = `w${Date.now().toString(36)}${(++sent).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const body = JSON.stringify({ id, text, ...(extra.choice ? { choice: extra.choice } : {}), ...(extra.page ? { page: extra.page } : {}), ...(extra.attachments?.length ? { attachments: extra.attachments.map((a) => ({ ref: a.ref })) } : {}) });
      // Shown at once; the echo with the same id is not shown again.
      const shown = (extra.attachments ?? []).filter((a): a is WebChatFile & { ref: string } => "id" in a).map(({ ref: _ref, ...f }) => f);
      emit({ type: "message", from: "person", id, text, ...(extra.choice ? { choice: extra.choice } : {}), ...(shown.length ? { attachments: shown } : {}), cursor: "", at: Date.now() });
      for (let attempt = 0; ; attempt++) {
        let problem: Error;
        try {
          const answer = await call("/messages", { method: "POST", headers: { "content-type": "application/json" }, body });
          if (answer.status === 202) return id;
          problem = new Error(`flow web chat: message not taken (${answer.status}): ${await answer.text()}`);
          if (answer.status < 500 && answer.status !== 429) throw problem;
        } catch (error) {
          if (error === problem!) throw error;
          problem = error as Error;
        }
        if (attempt >= 4) throw problem;
        // The same id again: the agent takes it once however often it arrives.
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    },
    async upload(file, name) {
      const answer = await call("/files", { method: "POST", headers: { "content-type": file.type || "application/octet-stream", ...(name ? { "x-file-name": encodeURIComponent(name) } : {}) }, body: file });
      if (answer.status !== 201) throw new Error(`flow web chat: file not taken (${answer.status}): ${await answer.text()}`);
      const { file: kept } = (await answer.json()) as { file: WebChatFile & { ref: string } };
      return { ...kept, src: full(kept.src) };
    },
    close() {
      closed = true;
      polling?.abort();
    },
  };
}
