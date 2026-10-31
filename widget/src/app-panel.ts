// The web app's panel, in an iframe on the agent's origin (mcp/src/app.ts serves its page), docked
// at the side of the brand's site by embed.js. One chat: terminal chat with each tool it runs shown
// (and the CLI command that does the same), and below it where else the same tools work. The brand's
// look comes from the settings the page carries (theme). Sign-in: the person's refresh token is kept
// here (this origin's storage, never the site's), and a new one comes from the site through embed.js,
// with no page shown.
import { ICONS } from "./app-icons.js";
import { fill } from "./app-fill.js";
import { markdown } from "./markdown.js";

type Colors = { background?: string; surface?: string; text?: string; muted?: string; border?: string };
type Theme = { mode?: "light" | "dark" | "auto"; accent?: string; accentText?: string; colors?: Colors; dark?: Colors; font?: string; fontUrl?: string; monoFont?: string; radius?: number; style?: string; pattern?: string; density?: string; css?: string };
type Settings = {
  title: string; name: string; origin: string; subtitle?: string; logo?: string; greeting?: string; placeholder: string; suggestions?: string[];
  accent: string; accentText?: string; radius: number; font?: string; theme: Theme;
  mcp: string; terminal?: string; url: string; cli?: { name: string; install: string };
  /** Tool results drawn as views (Flow's hosted service), and the brand's site its links open in. */
  views?: boolean; site?: string;
};
type Tool = { name: string; title?: string; annotations?: { readOnlyHint?: boolean } };
type Tokens = { access_token: string; refresh_token?: string; expires_in: number };
type SignInRequest = { nonce: string; returnTo: string; clientId: string; resource: string };
/** One tool the agent ran: ok once it ended; `later` when it went on in the background. */
type Step = { tool: string; ok?: boolean; later?: boolean; input?: unknown; command?: string };
type Item = { role: "me"; text: string } | { role: "agent"; text: string } | { role: "error"; text: string } | { role: "steps"; steps: Step[] } | { role: "view"; tool: string; data: unknown; template?: string; html?: string };

const settings = JSON.parse(document.getElementById("flow-app")!.textContent!) as Settings;
/** Tools that are the agent's own housekeeping, not the person's work. */
const QUIET = new Set(["load_skill", "read_skill", "search_tools", "execute_tool", "feedback"]);
const STORE = `flow-app:${settings.origin}`;

// ---- The embedding site: who is signed in there, and the one-time codes it mints.

let host: { account: string | null; signIn: boolean } | null = null;
let hostKnown: () => void;
const hostReady = new Promise<void>((resolve) => (hostKnown = resolve));
const codes = new Map<string, (code: { code: string; state: string } | null) => void>();
const toHost = (message: object) => parent.postMessage({ flowApp: 1, ...message }, settings.origin);
addEventListener("message", (event) => {
  const message = event.data as { flowApp?: number; type?: string; id?: string; code?: { code: string; state: string } | null; account?: string | null; signIn?: boolean } | null;
  if (event.source !== parent || event.origin !== settings.origin || message?.flowApp !== 1) return;
  if (message.type === "account") {
    const changed = host !== null && host.account !== (message.account ?? null);
    host = { account: message.account ?? null, signIn: !!message.signIn };
    hostKnown();
    if (changed) void signOut(false).then(() => { clearThread(); return signIn(); }).then(drawStatus);
  }
  if (message.type === "signed-in" && message.id) codes.get(message.id)?.(message.code ?? null), codes.delete(message.id);
  if (message.type === "sign-out") void signOut(true).then(() => { clearThread(); drawStatus(); });
  // Where a link from this chat led, once the site has shown it: for the brand's insights.
  if (message.type === "link-result") void authed(`${location.origin}/app/link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: (message as { url?: string }).url, ok: (message as { ok?: boolean }).ok, status: (message as { status?: number }).status, reason: (message as { reason?: string }).reason }) }).catch(() => undefined);
});
toHost({ type: "hello" });
// A site that never answers (embed.js missing, or an old one): signed out after a moment.
setTimeout(() => { host ??= { account: null, signIn: false }; hostKnown(); }, 3000);

function askHost(request: SignInRequest): Promise<{ code: string; state: string } | null> {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    codes.set(id, resolve);
    toHost({ type: "sign-in", id, request });
    setTimeout(() => { if (codes.delete(id)) resolve(null); }, 30_000);
  });
}

// ---- Sign-in: the bridge's /app/session, with the site's code; refreshed from what this origin keeps.

let access: { token: string; until: number } | null = null;
let signing: Promise<boolean> | null = null;

async function session<T>(body: object): Promise<T> {
  const response = await fetch(`${location.origin}/app/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`sign-in ${response.status}`);
  return response.json() as Promise<T>;
}
const saved = (): { account: string | null; refreshToken: string } | null => {
  try { return JSON.parse(localStorage.getItem(STORE) ?? "null"); } catch { return null; }
};
function keep(tokens: Tokens) {
  access = { token: tokens.access_token, until: Date.now() + tokens.expires_in * 1000 - 30_000 };
  if (tokens.refresh_token) localStorage.setItem(STORE, JSON.stringify({ account: host?.account ?? null, refreshToken: tokens.refresh_token }));
}

function signIn(): Promise<boolean> {
  return (signing ??= (async () => {
    await hostReady;
    const kept = saved();
    if (kept && kept.account === host?.account) {
      try { keep(await session<Tokens>({ step: "refresh", refreshToken: kept.refreshToken })); return true; } catch { /* Ended or expired: a new sign-in below. */ }
    }
    localStorage.removeItem(STORE);
    if (!host?.signIn) return false;
    const request = await session<SignInRequest>({ step: "start" });
    const code = await askHost(request);
    if (!code) return false;
    keep(await session<Tokens>({ step: "finish", returnTo: request.returnTo, code: code.code, state: code.state }));
    return true;
  })().catch(() => false).finally(() => (signing = null)));
}

async function signOut(revoke: boolean) {
  const token = saved()?.refreshToken ?? access?.token;
  access = null;
  localStorage.removeItem(STORE);
  if (revoke && token) await session({ step: "revoke", token }).catch(() => undefined);
}

/** A request to this origin as the signed-in person; one new sign-in when the token was refused. */
async function authed(path: string, init: RequestInit, retry = true): Promise<Response> {
  if (!access || access.until < Date.now()) await signIn();
  const headers = new Headers(init.headers);
  if (access) headers.set("authorization", `Bearer ${access.token}`);
  const response = await fetch(path, { ...init, headers });
  if (response.status === 401 && retry && access) {
    access = null;
    if (await signIn()) return authed(path, init, false);
  }
  return response;
}

// ---- The tools' names and kinds, from MCP (Streamable HTTP: JSON or an event stream back).

async function listTools(): Promise<Tool[]> {
  let protocol = "2025-06-18", mcpSession: string | undefined, ids = 0;
  const post = async (message: object) => {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": protocol };
    if (mcpSession) headers["mcp-session-id"] = mcpSession;
    const response = await authed(settings.mcp, { method: "POST", headers, body: JSON.stringify(message) });
    mcpSession = response.headers.get("mcp-session-id") ?? mcpSession;
    return response;
  };
  const send = async <T>(method: string, params: object): Promise<T> => {
    const id = ++ids;
    const response = await post({ jsonrpc: "2.0", id, method, params });
    if (!response.ok) throw new Error(`MCP ${response.status}`);
    const messages: Array<{ id?: number; result?: T; error?: { message: string } }> = (response.headers.get("content-type") ?? "").includes("text/event-stream")
      ? (await response.text()).split(/\r?\n\r?\n/).map((e) => e.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n")).filter(Boolean).map((d) => JSON.parse(d))
      : [await response.json()].flat();
    const reply = messages.find((m) => m.id === id);
    if (!reply?.result) throw new Error(reply?.error?.message ?? "no answer");
    return reply.result;
  };
  protocol = (await send<{ protocolVersion: string }>("initialize", { protocolVersion: protocol, capabilities: {}, clientInfo: { name: "flow-app", version: "1" } })).protocolVersion;
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  return (await send<{ tools: Tool[] }>("tools/list", { _meta: { "flow.engineer/full-tool-catalog": true } })).tools;
}

// ---- Drawing.

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: Array<Node | string | null | undefined | false>): HTMLElementTagNameMap[K] {
  const { class: cls, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (cls) node.className = cls;
  for (const child of children) if (child != null && child !== false) node.append(child);
  return node;
}
const SVG = "http://www.w3.org/2000/svg";
function icon(viewBox: string, d: string, cls = "icon"): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", cls);
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}
const UI = {
  send: "M12 4.5a1 1 0 0 1 .7.3l6 6a1 1 0 1 1-1.4 1.4L13 7.9V19a1 1 0 1 1-2 0V7.9l-4.3 4.3a1 1 0 0 1-1.4-1.4l6-6a1 1 0 0 1 .7-.3z",
  close: "M6.2 6.2a1 1 0 0 1 1.4 0L12 10.6l4.4-4.4a1 1 0 1 1 1.4 1.4L13.4 12l4.4 4.4a1 1 0 0 1-1.4 1.4L12 13.4l-4.4 4.4a1 1 0 0 1-1.4-1.4l4.4-4.4-4.4-4.4a1 1 0 0 1 0-1.4z",
  fresh: "M5 4h9a1 1 0 1 1 0 2H6v12h12v-8a1 1 0 1 1 2 0v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm14.3-.7a1 1 0 0 1 1.4 1.4l-8 8-2.1.7.7-2.1z",
  check: "M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6 11-11-1.4-1.4z",
  cross: "M18 7.4 16.6 6 12 10.6 7.4 6 6 7.4l4.6 4.6L6 16.6 7.4 18l4.6-4.6 4.6 4.6 1.4-1.4-4.6-4.6z",
  arrow: "M13.2 5.3a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.4-1.4l4.3-4.3H4a1 1 0 1 1 0-2h13.5l-4.3-4.3a1 1 0 0 1 0-1.4z",
  chevron: "M9.3 6.3a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.4-1.4l4.3-4.3-4.3-4.3a1 1 0 0 1 0-1.4z",
  chat: "M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.6.5-1.8.2-1.8-.7z",
};
const ui = (name: keyof typeof UI, cls?: string) => icon("0 0 24 24", UI[name], cls);
const md = (text: string, cls = "md") => { const div = h("div", { class: cls }); div.innerHTML = markdown(text); return div; };
const mark = (cls = "mark") => settings.logo ? h("img", { class: cls, src: settings.logo, alt: "" }) : h("span", { class: `${cls} letter`, textContent: settings.title.slice(0, 1).toUpperCase() });
function copyButton(text: string) {
  const button = h("button", { class: "copy", type: "button", textContent: "Copy" });
  button.onclick = async () => {
    try { await navigator.clipboard.writeText(text); button.textContent = "Copied"; } catch { button.textContent = "Select it"; }
    setTimeout(() => (button.textContent = "Copy"), 1500);
  };
  return button;
}
const codeLine = (text: string) => h("div", { class: "line" }, h("code", { textContent: text }), copyButton(text));

document.head.append(h("style", { textContent: css() }));
const theme = settings.theme;
document.documentElement.className = [`mode-${theme.mode ?? "auto"}`, `style-${theme.style ?? "soft"}`, `pattern-${theme.pattern ?? "none"}`, `density-${theme.density ?? "comfortable"}`].join(" ");
if (theme.css) document.head.append(h("style", { textContent: theme.css }));

const status = h("span", { class: "status" });
const freshButton = h("button", { class: "icon-button", type: "button", title: "New chat", ariaLabel: "New chat" }, ui("fresh"));
const closeButton = h("button", { class: "icon-button", type: "button", title: "Close", ariaLabel: "Close" }, ui("close"));
closeButton.onclick = () => toHost({ type: "close" });
addEventListener("keydown", (event) => { if (event.key === "Escape" && sheet.hidden) toHost({ type: "close" }); });
const header = h("header", { class: "head" }, mark(), h("div", { class: "who" }, h("b", { textContent: settings.title }), status), freshButton, closeButton);
const thread = h("main", { class: "thread", ariaLive: "polite" });
const input = h("textarea", { rows: 1, placeholder: settings.placeholder, ariaLabel: settings.placeholder });
const sendButton = h("button", { class: "send", type: "submit", ariaLabel: "Send", disabled: true }, ui("send"));
const composer = h("form", { class: "composer" }, input, sendButton);
const sheet = h("div", { class: "sheet", hidden: true, role: "dialog" });
const scrim = h("div", { class: "scrim", hidden: true });
const elsewhere = h("div", { class: "elsewhere" }, h("span", { textContent: "Use it in" }));
const powered = h("a", { class: "powered", href: `https://flow.engineer/?utm_source=app&utm_medium=powered-by&utm_campaign=${encodeURIComponent(settings.name)}`, target: "_blank", rel: "noopener" }, "Powered by ", icon(ICONS.flow.viewBox, ICONS.flow.d, "flow"), h("b", { textContent: "Flow" }));
document.body.append(h("div", { class: "app" }, header, thread, h("footer", { class: "foot" }, composer, h("div", { class: "meta" }, elsewhere, powered))), scrim, sheet);

function drawStatus() {
  status.textContent = access ? settings.subtitle ?? "Signed in" : host?.signIn === false ? "Sign in on this site to use your account" : settings.subtitle ?? "";
  status.classList.toggle("on", !!access);
}

// ---- The chat: what was said and what ran, kept in this origin's storage across pages.

let tools: Tool[] = [];
let items: Item[] = [];
let conversationId: string | undefined;
let busy = false;
const titleOf = (name: string) => tools.find((t) => t.name === name)?.title ?? name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

function load() {
  try {
    const kept = JSON.parse(localStorage.getItem(`${STORE}:thread`) ?? "null") as { items: Item[]; conversationId?: string } | null;
    items = kept?.items ?? [];
    // A step still running when the page closed is finished or in the background now.
    for (const item of items) if (item.role === "steps") for (const step of item.steps) if (step.ok === undefined) step.later = true;
    conversationId = kept?.conversationId;
  } catch { items = []; }
}
const save = () => localStorage.setItem(`${STORE}:thread`, JSON.stringify({ items: items.slice(-80), conversationId }));
function clearThread() {
  items = [];
  conversationId = undefined;
  localStorage.removeItem(`${STORE}:thread`);
  drawThread();
}
freshButton.onclick = () => { clearThread(); input.focus(); };

function drawThread() {
  thread.replaceChildren(...(items.length ? items.map(drawItem) : [welcome()]));
  thread.scrollTop = thread.scrollHeight;
}
function welcome() {
  const greeting = settings.greeting ?? `Hi! I can look things up and get things done in your ${settings.title} account. What do you need?`;
  const starters = settings.suggestions ?? tools.filter((t) => t.annotations?.readOnlyHint && !QUIET.has(t.name)).slice(0, 4).map((t) => titleOf(t.name));
  return h("div", { class: "welcome" }, mark("mark big"), md(greeting, "md greeting"),
    h("div", { class: "starters" }, ...starters.map((text) => {
      const button = h("button", { type: "button", class: "starter" }, h("span", { textContent: text }), ui("arrow"));
      button.onclick = () => void ask(text);
      return button;
    })));
}
function drawItem(item: Item): HTMLElement {
  if (item.role === "me") return h("div", { class: "msg me" }, h("div", { class: "bubble", textContent: item.text }));
  if (item.role === "agent") return h("div", { class: "msg agent" }, mark("avatar"), h("div", { class: "bubble" }, md(item.text)));
  if (item.role === "error") return h("div", { class: "msg error" }, h("p", { textContent: item.text }));
  if (item.role === "view") return drawView(item);
  return drawSteps(item.steps);
}
/**
 * The view a UI tool shows: a catalog tool's template from the app, filled here with the agent's input,
 * or for ui_create a view Flow's service made now for this answer. Kept in the thread with the chat.
 */
async function drawViewFor(ui: string, input: unknown, question: string, place: (node: HTMLElement) => void) {
  if (!input || typeof input !== "object") return;
  const placeholder = h("div", { class: "view loading" }, h("span", { class: "spinner small" }), h("span", { textContent: ui === "ui_create" ? "Designing a view…" : "Drawing…" }));
  place(placeholder);
  thread.scrollTop = thread.scrollHeight;
  try {
    const response = await authed(`${location.origin}/app/view`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ui, data: input, question }) });
    if (!response.ok) throw new Error();
    const { template, html } = await response.json() as { template?: string; html?: string };
    const item: Item = { role: "view", tool: ui, data: input, ...(template ? { template } : {}), ...(html ? { html } : {}) };
    items.push(item);
    const node = drawView(item);
    placeholder.replaceWith(node);
    thread.scrollTop = thread.scrollHeight;
    save();
  } catch { placeholder.remove(); }
}

/** A view: the template filled with the result's data, in a frame with no scripts, as tall as it is. */
function drawView(item: Item & { role: "view" }): HTMLElement {
  const frame = h("iframe", { class: "view", title: titleOf(item.tool) });
  frame.setAttribute("sandbox", "allow-same-origin");
  const font = settings.theme.fontUrl ? `<link rel="stylesheet" href="${settings.theme.fontUrl.replace(/"/g, "&quot;")}">` : "";
  let body: string;
  try { body = item.html ?? fill(item.template ?? "", item.data); } catch { body = ""; }
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">${font}<style>html,body{margin:0;background:transparent;font-family:${(settings.font ?? "system-ui").replace(/[;{}<>]/g, "")};color:#111827;-webkit-font-smoothing:antialiased}a{cursor:pointer}</style></head><body>${body}</body></html>`;
  frame.onload = () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    const fit = () => { frame.style.height = `${Math.min(doc.documentElement.scrollHeight, 640)}px`; };
    fit();
    new ResizeObserver(fit).observe(doc.body);
    doc.addEventListener("click", (event) => {
      const link = (event.target as Element).closest?.("a[href]");
      if (!link) return;
      event.preventDefault();
      openLink(link.getAttribute("href")!);
    });
  };
  return h("div", { class: "view-box" }, frame);
}

/** A link from the chat: one on the brand's site opens there (the site's own navigation), others in a new tab. */
function openLink(href: string) {
  // A follow-up in a view: sent as the person's next message.
  if (href.startsWith("#ask:")) return void ask(decodeURIComponent(href.slice(5)));
  let url: URL;
  try { url = new URL(href, settings.site ?? settings.origin); } catch { return; }
  const site = settings.site ? new URL(settings.site).origin : settings.origin;
  if (url.origin === site || url.origin === settings.origin) toHost({ type: "navigate", path: `${url.pathname}${url.search}${url.hash}` });
  else window.open(url.href, "_blank", "noopener");
}
thread.addEventListener("click", (event) => {
  const link = (event.target as Element).closest?.(".md a[href]");
  if (!link) return;
  event.preventDefault();
  openLink(link.getAttribute("href")!);
});

function drawSteps(steps: Step[]): HTMLElement {
  const done = steps.every((s) => s.ok !== undefined || s.later);
  const box = h("details", { class: `steps ${done ? "done" : "running"}` });
  const label = !done ? `${titleOf(steps[steps.length - 1].tool)}…` : steps.some((s) => s.later && s.ok === undefined) ? "Still working in the background" : steps.length === 1 ? titleOf(steps[0].tool) : `${steps.length} steps`;
  box.append(h("summary", {}, done ? ui(steps.every((s) => s.ok !== false) ? "check" : "cross", "state") : h("span", { class: "spinner" }),
    h("span", { class: "label", textContent: label }), ui("chevron", "chev")));
  for (const step of steps) {
    const command = step.command;
    box.append(h("div", { class: "step" },
      h("div", { class: "step-head" }, step.ok === undefined ? (step.later ? h("span", { class: "later", textContent: "…" }) : h("span", { class: "spinner small" })) : ui(step.ok ? "check" : "cross", `state ${step.ok ? "ok" : "bad"}`), h("span", { textContent: titleOf(step.tool) + (step.later && step.ok === undefined ? " (in the background)" : "") })),
      command ? h("div", { class: "cli" }, h("small", { textContent: "Run it yourself" }), codeLine(command)) : null));
  }
  return box;
}

async function commandFor(step: Step) {
  try {
    const response = await fetch(`${location.origin}/app/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: step.tool, input: step.input }) });
    const { command } = await response.json() as { command: string | null };
    if (command) step.command = command;
  } catch { /* No line: the step shows without one. */ }
}

function push(item: Item) {
  items.push(item);
  thread.querySelector(".welcome")?.remove();
  thread.append(drawItem(item));
  thread.scrollTop = thread.scrollHeight;
  save();
}

input.oninput = () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  sendButton.disabled = busy || !input.value.trim();
};
input.onkeydown = (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); composer.requestSubmit(); } };
composer.onsubmit = (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = "";
  input.dispatchEvent(new Event("input"));
  void ask(text);
};

async function ask(text: string, again = false) {
  if (!settings.terminal) return push({ role: "error", text: "Chat is not on for this server." });
  if (busy) return;
  busy = true;
  sendButton.disabled = true;
  if (!again) push({ role: "me", text });
  const typing = h("div", { class: "msg agent typing" }, mark("avatar"), h("div", { class: "bubble" }, h("i"), h("i"), h("i")));
  thread.append(typing);
  thread.scrollTop = thread.scrollHeight;
  // Each group of tool steps is drawn where its first tool started; a tool that ends after a reply
  // still finishes in its own group, found by its call.
  type Group = { item: Item & { role: "steps" }; node: HTMLElement; tail?: HTMLElement };
  let open: Group | null = null;
  const calls = new Map<string, { step: Step; group: Group }>();
  const redraw = (group: Group) => { const node = drawSteps(group.item.steps); group.node.replaceWith(node); group.node = node; };
  /** The tool's result drawn under its steps, by its view template from Flow's service. */
  try {
    const response = await authed(settings.terminal, { method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" }, body: JSON.stringify({ text, ...(conversationId ? { conversationId } : {}) }) });
    if (response.status === 401) throw new Error(`Sign in to ${settings.title} on this site to chat.`);
    if (response.status === 409) { conversationId = undefined; busy = false; typing.remove(); return void ask(text, true); }
    if (!response.ok || !response.body) throw new Error("The assistant could not answer. Try again.");
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines.filter(Boolean)) {
        const event = JSON.parse(line) as { type: string; text?: string; message?: string; event?: { type: string; callId?: string; tool?: string; ok?: boolean; input?: unknown }; result?: { conversationId: string } };
        const activity = event.event;
        // A UI tool is the agent showing its answer: drawn as a view where it is, never a step.
        if (event.type === "activity" && activity?.type === "tool.start" && activity.tool?.startsWith("ui_") && settings.views) {
          open = null;
          void drawViewFor(activity.tool, activity.input, text, (node) => thread.insertBefore(node, typing));
          continue;
        }
        if (event.type === "activity" && activity?.tool?.startsWith("ui_")) continue;
        if (event.type === "activity" && activity?.tool && activity.callId && !QUIET.has(activity.tool)) {
          if (activity.type === "tool.start") {
            const step: Step = { tool: activity.tool, input: activity.input };
            // The CLI line for it, from the CLI file on the server (positional arguments, flag names).
            if (settings.cli && activity.input && typeof activity.input === "object") void commandFor(step).then(() => { const call = calls.get(activity.callId!); if (call) { redraw(call.group); save(); } });
            if (!open) {
              const item = { role: "steps" as const, steps: [step] };
              open = { item, node: drawSteps(item.steps) };
              items.push(item);
              thread.insertBefore(open.node, typing);
            } else open.item.steps.push(step);
            calls.set(activity.callId, { step, group: open });
            redraw(open);
          }
          // A tool that outlasts the turn goes on as a task (tool.detached) and ends with task.done.
          const call = calls.get(activity.callId);
          if (call && (activity.type === "tool.end" || activity.type === "task.done")) {
            call.step.ok = activity.ok !== false;
            redraw(call.group);
          }
          if (call && activity.type === "tool.detached") { call.step.later = true; redraw(call.group); }
        }
        if (event.type === "reply" && event.text) {
          open = null; // Tools that start after a reply are a new group.
          const item: Item = { role: "agent", text: event.text };
          items.push(item);
          thread.insertBefore(drawItem(item), typing);
        }
        if (event.type === "done" && event.result) conversationId = event.result.conversationId;
        if (event.type === "error") throw new Error(event.message ?? "The assistant could not finish.");
        thread.scrollTop = thread.scrollHeight;
      }
    }
  } catch (error) {
    typing.remove();
    push({ role: "error", text: (error as Error).message || "Something went wrong. Try again." });
  } finally {
    typing.remove();
    busy = false;
    sendButton.disabled = !input.value.trim();
    save();
  }
}

// ---- Use it elsewhere: the same tools in an assistant, an editor or the terminal.

const PLACES: Array<{ id: keyof typeof ICONS; name: string; body: () => Node[] }> = [
  { id: "claude", name: "Claude", body: () => [
    h("p", { textContent: "In Claude (web or desktop): Settings → Connectors → Add custom connector, and paste:" }), codeLine(settings.url),
    h("p", { textContent: "In Claude Code:" }), codeLine(`claude mcp add --transport http ${settings.name} ${settings.url}`)] },
  { id: "chatgpt", name: "ChatGPT", body: () => [h("p", { textContent: "In ChatGPT: Settings → Apps → Create app (developer mode), and paste:" }), codeLine(settings.url)] },
  { id: "cursor", name: "Cursor", body: () => [
    h("a", { class: "primary", target: "_top", href: `cursor://anysphere.cursor-deeplink/mcp/install?${new URLSearchParams({ name: settings.name, config: btoa(JSON.stringify({ url: settings.url })) })}`, textContent: "Add to Cursor" }),
    h("p", { textContent: "Or add this MCP server URL in Cursor's settings:" }), codeLine(settings.url)] },
  { id: "vscode", name: "VS Code", body: () => [
    h("a", { class: "primary", target: "_top", href: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: settings.name, type: "http", url: settings.url }))}`, textContent: "Add to VS Code" }),
    h("p", { textContent: "Or run MCP: Add Server and paste:" }), codeLine(settings.url)] },
  ...(settings.cli ? [{ id: "terminal" as const, name: "Terminal", body: () => [
    h("p", { textContent: "Install the CLI, and sign in once:" }), codeLine(settings.cli!.install), codeLine(`${settings.cli!.name} login`),
    h("p", { textContent: "Every step in this chat shows the command that does the same." })] }] : []),
];
for (const place of PLACES) {
  const button = h("button", { type: "button", class: `place ${place.id}`, title: place.name, ariaLabel: `Use it in ${place.name}` }, icon(ICONS[place.id].viewBox, ICONS[place.id].d));
  button.onclick = () => openSheet(place);
  elsewhere.append(button);
}
function openSheet(place: (typeof PLACES)[number]) {
  const close = h("button", { class: "icon-button", type: "button", ariaLabel: "Close" }, ui("close"));
  close.onclick = closeSheet;
  sheet.replaceChildren(h("div", { class: "sheet-head" }, icon(ICONS[place.id].viewBox, ICONS[place.id].d, `icon brand ${place.id}`), h("b", { textContent: `${settings.title} in ${place.name}` }), close),
    h("p", { class: "muted", textContent: `The same tools as this chat, signed in as you.` }), ...place.body());
  sheet.hidden = scrim.hidden = false;
  requestAnimationFrame(() => document.body.classList.add("sheet-open"));
  close.focus();
}
function closeSheet() {
  document.body.classList.remove("sheet-open");
  setTimeout(() => { sheet.hidden = scrim.hidden = true; }, 200);
}
scrim.onclick = closeSheet;
addEventListener("keydown", (event) => { if (event.key === "Escape" && !sheet.hidden) closeSheet(); });

// ---- Start: what was said before, a quiet sign-in, then the tools' names.

load();
drawThread();
drawStatus();
void (async () => {
  await signIn();
  drawStatus();
  try { tools = (await listTools()).filter((t) => !QUIET.has(t.name)); } catch { /* Names stay as the tools' own. */ }
  drawThread();
})();
input.focus();

// ---- The look: the brand's colors, font and design over a finished default.

function css(): string {
  const t = settings.theme;
  const clean = (v: string | undefined) => v?.replace(/[;{}<>]/g, "");
  const accent = clean(settings.accent)!;
  const light = { background: "#ffffff", surface: "#f4f5f7", text: "#16181d", muted: "#656c78", border: "#e4e7eb", ...t.colors };
  const dark = { background: "#121418", surface: "#1d2026", text: "#eceef2", muted: "#9aa2ae", border: "#2b3038", ...t.dark };
  const vars = (c: Colors) => Object.entries(c).map(([k, v]) => `--${k}:${clean(v)};`).join("");
  const r = Math.max(0, Math.min(28, settings.radius));
  return `
:root{--accent:${accent};--on-accent:${clean(settings.accentText) ?? "#fff"};--r:${r}px;--font:${clean(settings.font) ?? 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif'};--mono:${clean(t.monoFont) ?? "ui-monospace,SFMono-Regular,Menlo,monospace"};--gap:14px;${vars(light)}color-scheme:light}
:root.mode-dark{${vars(dark)}color-scheme:dark}
@media(prefers-color-scheme:dark){:root.mode-auto{${vars(dark)}color-scheme:dark}}
:root.density-compact{--gap:9px}
*{box-sizing:border-box}[hidden]{display:none!important}
html,body{height:100%;margin:0}
body{background:var(--background);color:var(--text);font:14.5px/1.5 var(--font);-webkit-font-smoothing:antialiased;overflow:hidden}
button{font:inherit;color:inherit;cursor:pointer}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.icon{width:18px;height:18px;fill:currentColor;flex:none}
.app{height:100%;display:flex;flex-direction:column;position:relative}
.head{display:flex;align-items:center;gap:10px;padding:12px 10px 12px 16px;border-bottom:1px solid var(--border);background:var(--background);position:relative;z-index:2}
.mark{width:30px;height:30px;border-radius:calc(var(--r) * .6);object-fit:cover;flex:none}
.letter{display:grid;place-items:center;background:var(--accent);color:var(--on-accent);font-weight:700}
.who{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.25}.who b{font-size:15px;font-weight:650}
.status{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.status.on::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#22a05a;margin:0 6px 1px 0}
.icon-button{border:0;background:none;width:34px;height:34px;border-radius:calc(var(--r) * .6);display:grid;place-items:center;color:var(--muted);flex:none}.icon-button:hover{background:var(--surface);color:var(--text)}
.thread{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:18px 16px 8px;display:flex;flex-direction:column;gap:var(--gap)}
.welcome{margin:auto 0 0;display:flex;flex-direction:column;gap:12px;padding:8px 2px}
.mark.big{width:44px;height:44px;border-radius:calc(var(--r) * .8);font-size:20px}
.greeting{font-size:17px;line-height:1.45;font-weight:500}
.starters{display:flex;flex-direction:column;gap:7px;margin-top:4px}
.starter{display:flex;align-items:center;justify-content:space-between;gap:10px;text-align:left;border:1px solid var(--border);background:var(--background);border-radius:var(--r);padding:11px 14px}.starter .icon{width:16px;height:16px;color:var(--muted);transition:transform .15s}
.starter:hover{border-color:var(--accent)}.starter:hover .icon{transform:translateX(2px);color:var(--accent)}
.msg{display:flex;gap:9px;align-items:flex-start;max-width:100%}
.avatar{width:24px;height:24px;border-radius:calc(var(--r) * .45);object-fit:cover;flex:none;margin-top:2px;font-size:12px}
.bubble{min-width:0;overflow-wrap:anywhere}
.me{justify-content:flex-end}.me .bubble{background:var(--accent);color:var(--on-accent);padding:9px 14px;border-radius:var(--r) var(--r) calc(var(--r) * .3) var(--r);max-width:85%;white-space:pre-wrap}
.agent .bubble{background:var(--surface);padding:10px 14px;border-radius:calc(var(--r) * .3) var(--r) var(--r) var(--r);max-width:calc(100% - 33px)}
.error p{margin:0;color:#c0362c;font-size:13.5px;padding:8px 12px;border-radius:var(--r);background:#c0362c14}
.md p{margin:0 0 8px}.md>:last-child{margin-bottom:0}.md a{color:var(--accent)}.md ul,.md ol{margin:4px 0;padding-left:20px}
.md code{font:12.5px var(--mono);background:color-mix(in srgb,var(--text) 8%,transparent);padding:1px 5px;border-radius:5px}.md pre{white-space:pre-wrap;margin:6px 0}.md pre code{display:block;padding:8px 10px}
.typing .bubble{display:flex;gap:4px;padding:13px 14px}.typing i{width:6px;height:6px;border-radius:50%;background:var(--muted);animation:b 1.2s infinite ease-in-out}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}
@keyframes b{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
.steps{margin-left:33px;border:1px solid var(--border);border-radius:var(--r);background:var(--background);font-size:13px}
.steps summary{list-style:none;display:flex;align-items:center;gap:8px;padding:7px 11px;color:var(--muted);cursor:pointer}.steps summary::-webkit-details-marker{display:none}
.steps summary .label{flex:1}.steps summary:focus-visible{outline-offset:-2px;border-radius:var(--r)}.chev{width:14px;height:14px;transition:transform .15s}.steps[open] .chev{transform:rotate(90deg)}
.state{width:15px;height:15px}.state.ok,.done>summary .state{fill:#22a05a}.state.bad{fill:#c0362c}
.step{padding:6px 11px 9px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:6px}.step-head{display:flex;align-items:center;gap:8px;font-weight:550}
.later{width:12px;text-align:center;color:var(--muted)}.view-box{margin-left:33px}.view{display:block;width:100%;border:0;min-height:40px;background:transparent}.view.loading{display:flex;align-items:center;gap:8px;margin-left:33px;color:var(--muted);font-size:12.5px;padding:6px 2px}.style-minimal .view-box,.style-minimal .view.loading{margin-left:0}
.cli small{color:var(--muted);font-size:11.5px}
.spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--border);border-top-color:var(--accent);animation:s .7s linear infinite;flex:none}.spinner.small{width:12px;height:12px}
@keyframes s{to{transform:rotate(360deg)}}
.line{display:flex;align-items:center;gap:6px;background:var(--surface);border:1px solid var(--border);border-radius:calc(var(--r) * .6);padding:5px 5px 5px 10px}
.line code{flex:1;min-width:0;overflow-x:auto;white-space:nowrap;font:12px var(--mono);scrollbar-width:none}
.copy{border:1px solid var(--border);background:var(--background);border-radius:calc(var(--r) * .45);padding:3px 9px;font-size:12px;flex:none}
.foot{padding:10px 14px 10px;background:var(--background)}
.composer{display:flex;align-items:flex-end;gap:8px;border:1px solid var(--border);border-radius:calc(var(--r) * 1.1);padding:6px 6px 6px 14px;background:var(--background);box-shadow:0 1px 2px #0000000a;transition:border-color .15s,box-shadow .15s}
.composer:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
.composer textarea{flex:1;border:0;outline:0;resize:none;background:none;color:inherit;font:inherit;padding:6px 0;max-height:160px}
.send{width:34px;height:34px;border:0;border-radius:calc(var(--r) * .8);background:var(--accent);color:var(--on-accent);display:grid;place-items:center;flex:none;transition:opacity .15s}.send:disabled{opacity:.35;cursor:default}
.meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:9px;font-size:12px;color:var(--muted)}
.elsewhere{display:flex;align-items:center;gap:2px}.elsewhere span{margin-right:4px}
.place{border:0;background:none;width:28px;height:28px;border-radius:8px;display:grid;place-items:center;color:var(--muted);transition:color .15s,background .15s}
.place .icon{width:16px;height:16px}.place:hover{background:var(--surface)}
.place.claude:hover,.brand.claude{color:#d97757}.place.chatgpt:hover,.brand.chatgpt{color:var(--text)}.place.cursor:hover,.brand.cursor{color:var(--text)}.place.vscode:hover,.brand.vscode{color:#0a7acc}.place.terminal:hover,.brand.terminal{color:var(--text)}
.powered{display:flex;align-items:center;gap:4px;color:var(--muted);text-decoration:none}.powered:hover{color:var(--text)}.powered b{font-weight:650}
.powered .flow{width:13px;height:13px;fill:currentColor}
.scrim{position:fixed;inset:0;background:#0003;opacity:0;transition:opacity .2s;z-index:5}.sheet-open .scrim{opacity:1}
.sheet{position:fixed;left:0;right:0;bottom:0;z-index:6;background:var(--background);border-radius:calc(var(--r) * 1.2) calc(var(--r) * 1.2) 0 0;padding:16px 16px 20px;box-shadow:0 -10px 40px -10px #0004;display:flex;flex-direction:column;gap:9px;transform:translateY(100%);transition:transform .22s cubic-bezier(.2,.8,.2,1);max-height:85%;overflow-y:auto}
.sheet-open .sheet{transform:none}.sheet p{margin:2px 0 0;font-size:13.5px}.muted{color:var(--muted)}
.sheet-head{display:flex;align-items:center;gap:10px}.sheet-head b{flex:1;font-size:15px}.brand{width:22px;height:22px}
.primary{display:block;text-align:center;background:var(--accent);color:var(--on-accent);text-decoration:none;font-weight:600;border-radius:calc(var(--r) * .8);padding:10px}
/* Designs */
.style-sharp{--r:4px}.style-sharp .head{border-bottom-width:2px}.style-sharp .me .bubble,.style-sharp .agent .bubble{border-radius:var(--r)}.style-sharp .agent .bubble{background:none;border:1px solid var(--border)}.style-sharp .starter{border-width:1px 1px 1px 3px;border-left-color:var(--accent)}
.style-glass body{background:linear-gradient(180deg,color-mix(in srgb,var(--accent) 10%,var(--background)),var(--background) 40%)}.style-glass .head{background:color-mix(in srgb,var(--background) 70%,transparent);backdrop-filter:blur(14px);border-bottom-color:transparent;box-shadow:0 1px 0 color-mix(in srgb,var(--text) 6%,transparent)}
.style-glass .foot{background:transparent}.style-glass .agent .bubble{background:color-mix(in srgb,var(--background) 65%,transparent);backdrop-filter:blur(10px);border:1px solid color-mix(in srgb,var(--text) 7%,transparent)}.style-glass .me .bubble{background:linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent) 70%,#000));box-shadow:0 6px 18px -8px var(--accent)}
.style-glass .composer{background:color-mix(in srgb,var(--background) 80%,transparent);backdrop-filter:blur(10px);box-shadow:0 8px 30px -12px #0003}
.style-minimal .head{border-bottom:0}.style-minimal .agent .bubble{background:none;padding:2px 0}.style-minimal .me .bubble{background:var(--surface);color:var(--text)}.style-minimal .avatar{display:none}.style-minimal .steps{margin-left:0}.style-minimal .starter{border:0;background:var(--surface)}
/* Backdrops */
.pattern-dots .thread{background-image:radial-gradient(color-mix(in srgb,var(--text) 9%,transparent) 1px,transparent 1px);background-size:16px 16px}
.pattern-grid .thread{background-image:linear-gradient(color-mix(in srgb,var(--text) 5%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--text) 5%,transparent) 1px,transparent 1px);background-size:22px 22px}
.pattern-glow .thread{background:radial-gradient(120% 60% at 100% 0%,color-mix(in srgb,var(--accent) 16%,transparent),transparent 60%),radial-gradient(90% 50% at 0% 100%,color-mix(in srgb,var(--accent) 10%,transparent),transparent 60%)}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;
}
