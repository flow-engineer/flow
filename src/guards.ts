// Ready-made checks for createAgent's `beforeSend`: compose them with `guards(...)`. Each looks at
// one message; a refusal goes back to the agent with its reason, to fix and send again.

import type { BeforeSend, OutboundMessage, SendContext } from "./types.ts";

type Origin = SendContext["origin"];

/** Which sends a guard checks. Default: only the agent's own (`origin` "agent"), the ones it can fix. */
export interface GuardOptions {
  origins?: Origin[];
}

/** A line or word to match: a string (any case, any spacing) or a regular expression. */
export type Match = string | RegExp;

/**
 * Several guards as one `beforeSend`, run in order: each sees the message as the one before left
 * it (a guard may rewrite it), and the first refusal wins.
 */
export function guards(...checks: BeforeSend[]): BeforeSend {
  return async (message, context) => {
    let current = message;
    let changed = false;
    for (const check of checks) {
      const result = await check(current, context);
      if (!result) continue;
      if ("refuse" in result) return result;
      current = result;
      changed = true;
    }
    return changed ? current : undefined;
  };
}

/**
 * A line sent at most once in a conversation (a disclaimer, "I'm an AI assistant"): when it was
 * already sent, it is taken out of the text and the rest goes. A message that was only that line is
 * refused. It reads what was sent from the conversation's history, so it holds across restarts.
 * Templates are never changed.
 */
export function oncePerChat(lines: Match | Match[], options: GuardOptions = {}): BeforeSend {
  const patterns = [lines].flat().map((m) => pattern(m, false));
  return (message, context) => {
    if (!applies(options, context) || message.type === "template") return;
    const said = context.sent ?? [];
    let text = message.text;
    for (const p of patterns) {
      if (!said.some((s) => p.test(s)) || !p.test(text)) continue;
      text = text.replace(new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g"), "");
    }
    if (text === message.text) return;
    text = tidy(text);
    if (!text) return { refuse: "you already said this earlier in this conversation; say something new, or nothing." };
    return { ...message, text };
  };
}

/**
 * Refuses a message whose text is the same (any case, any spacing) as one of the last `last` sent
 * in this conversation (default 20). Short replies under 20 characters ("Got it.", "Thanks!") may repeat.
 */
export function noRepeats(options: GuardOptions & { last?: number } = {}): BeforeSend {
  const last = options.last ?? 20;
  return (message, context) => {
    if (!applies(options, context) || message.type === "template") return;
    const text = normal(message.text);
    if (text.length < 20) return;
    if ((context.sent ?? []).slice(-last).some((s) => normal(s) === text)) {
      return { refuse: "you already sent this exact message; say something new, or nothing." };
    }
  };
}

/**
 * Refuses a message with a link to a site not allowed: in its text, its link button, its photo, a
 * carousel card's or a template's header. A host string allows that host and its subdomains
 * ("example.com" allows shop.example.com); a regular expression is tested against the host.
 */
export function linkAllowlist(hosts: Match[], options: GuardOptions = {}): BeforeSend {
  const allowed = (host: string) =>
    hosts.some((h) => (typeof h === "string" ? host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`) : h.test(host)));
  return (message, context) => {
    if (!applies(options, context)) return;
    for (const url of urlsOf(message)) {
      let host: string;
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        return { refuse: `${url} is not a valid link; leave it out.` };
      }
      if (!allowed(host)) return { refuse: `it links to ${host}, which is not an allowed site; leave that link out.` };
    }
  };
}

/**
 * Refuses buttons and list rows whose label or id names an action that changes something ("Confirm
 * order", "Pay", "Cancel booking"): one tap must not make it happen. The agent is told to ask in
 * words instead. A string matches whole words, in any case.
 */
export function noWriteButtons(actions: Match | Match[], options: GuardOptions = {}): BeforeSend {
  const patterns = [actions].flat().map((m) => pattern(m, true));
  return (message, context) => {
    if (!applies(options, context) || message.type === "template") return;
    for (const label of choicesOf(message)) {
      if (patterns.some((p) => p.test(label))) {
        return { refuse: `"${label}" would do it with one tap; ask them in words to confirm, and do it when they say so.` };
      }
    }
  };
}

function applies(options: GuardOptions, context: SendContext): boolean {
  return (options.origins ?? ["agent"]).includes(context.origin);
}

function normal(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** A string as a pattern: any case, any run of spaces; `words`: only at word boundaries. */
function pattern(m: Match, words: boolean): RegExp {
  if (m instanceof RegExp) return new RegExp(m.source, m.flags.replace("g", ""));
  const body = m.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  return new RegExp(words ? `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])` : body, "iu");
}

/** What is left after a line is taken out: no blank runs, no stray spaces. */
function tidy(text: string): string {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"')\]]+/gi;

/** URLs written in a text, without the punctuation that ends a sentence. */
function textUrls(text: string): string[] {
  return [...text.matchAll(URL_IN_TEXT)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
}

function urlsOf(message: OutboundMessage): string[] {
  if (message.type === "template") {
    const h = message.header;
    return h && h.kind !== "text" && h.url ? [h.url] : [];
  }
  const urls = textUrls(message.text);
  if (message.type === "carousel") {
    for (const c of message.cards) {
      if ("url" in c.image) urls.push(c.image.url);
      if (c.link) urls.push(c.link.url);
      if (c.text) urls.push(...textUrls(c.text));
    }
    return urls;
  }
  if (message.link) urls.push(message.link.url);
  if (message.image && "url" in message.image) urls.push(message.image.url);
  return urls;
}

/** Every button's and list row's label and id. */
function choicesOf(message: Exclude<OutboundMessage, { type: "template" }>): string[] {
  const of = (b: string | { id: string; label: string }) => (typeof b === "string" ? [b] : [b.label, b.id]);
  if (message.type === "carousel") return message.cards.flatMap((c) => (c.buttons ?? []).flatMap(of));
  return [...(message.buttons ?? []).flatMap(of), ...(message.list?.rows ?? []).flatMap((r) => [r.title, r.id])];
}
