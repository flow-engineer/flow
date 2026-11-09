// The web app: the agent in the brand's own site, as a chat panel that opens beside the page. The
// site adds one script tag,
//
//   <script async src="https://<agent>/app/embed.js"></script>
//
// which draws a launcher and, when opened, docks /app (an iframe on this origin) at the side of the
// page, moving the page over rather than covering it. The panel is terminal chat with each tool it
// runs shown, and how to use the same tools in Claude, ChatGPT, Cursor, VS Code and the terminal.
// Flow hosts it; the brand's look comes from `theme` here. The person's token lives only in the
// iframe. With the OAuth bridge's `app`, a person signed in on the site is signed in here with no
// page shown: the site's `FlowAppConfig.signIn` mints the code the brand's login page would.

import { commandLine, type CliConfig, type ToolInfo } from "../../cli/src/commands.ts";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { serveScript, scriptFile, widgetFile } from "../../src/web-chat.ts";
import { tool, toolGroup, type Tool, type ToolGroup } from "../../src/tools.ts";
import type { z } from "zod";
import type { McpIdentity } from "./server.ts";

/**
 * Generative views are Flow's hosted service: on with its address (FLOW_APP_SERVICE_URL, which Flow's
 * hosting sets) and the agent's Flow key. Self-hosted, answers are Markdown and nothing is sent anywhere.
 */
/** What the agent is told on the web app's channel when it has UI tools. */
export const UI_INSTRUCTIONS = [
  "This is the brand's own web app. The person sees each tool call as it runs, and you can show part of an answer with a ui_ tool.",
  "Show a UI when it helps, at most ONE per answer: after gathering what you need, call the ui_ tool that best shows the main thing they asked (several things, one thing in detail, an action to take), filled with only what answers them, in their words. A single fact, a yes or no, or a question back to them needs none.",
  "A ui_ tool is part of your answer, not a tool you wait for: call it in the same response as your reply. Never a second ui_ tool in the same answer.",
  "The person reads your view and your words as one answer, and the view is the main way you answer: the things themselves (items, numbers, fields, actions) go in it. Your words, ONE message, complement it: what it means, a caveat, a recommendation, what to do next.",
  "Do not repeat what the view already shows. Before you write, check each name, number and fact: if the view has it, leave it out of your words. Bad: the view lists four areas with their yields and prices, and your words walk through the four areas and their yields again. Good: \"These are gross yields, not returns after costs. **Check service charges and realistic rents before you commit.**\"",
  "In a view, give href (a page on the site where that thing lives, from the pages you know) for what has a page, and ask (a message they can send) for a follow-up; leave both out where neither makes sense.",
  "In your words, bold the one or two things that should catch their eye (the key fact, what to do next) with **…**; the rest plain. No headings or tables.",
  "Every answer about something on the site shows where they can see it there, so they learn the site: through the view's link or button to its page when there is a view, else end your reply with a link to that page, like [View your crawls](/dashboard/crawls). Use only the site's real pages.",
].join("\n");

/**
 * The brand's UIs as the agent's ui_ tools, a group offered only on the web app's channel ("app"; createAgent's
 * `groups`): calling one shows it (the panel draws it from the call). At most one per answer: `answer` starts a
 * person's answer afresh (the web app's chat calls it as each request starts).
 */
export function uiTools(ui: AppUi[], pages?: string[], site?: string): ToolGroup & { answer: (person: string) => void } {
  const shown = new Map<string, number>();
  const tools = ui.map((u) => tool({
    name: `ui_${u.name}`, description: `${u.description} Your words beside it add only what it does not show; never repeat its contents.`, input: u.input, signIn: "none",
    hints: { readOnly: true, destructive: false, openWorld: false },
    run: (input, context) => {
      // A link to a page the site does not have is refused before anything is shown, so the agent fixes it.
      const wrong = pages ? hrefsOf(input).filter((h) => !isPage(h, pages, site)) : [];
      if (wrong.length) return { shown: false, note: `Not shown: these links are not pages on the site: ${wrong.join(", ")}. Use only these pages (a {name} is one value): ${pages!.join(", ")}. A thing with no page of its own: link its list page and say how to find it there. Call the ui_ tool again with fixed links.` };
      if (shown.has(context.person)) return { shown: false, note: "Already showing a view in this answer: one per answer. Put the rest in your reply as Markdown." };
      shown.set(context.person, Date.now());
      if (shown.size > 10_000) shown.delete(shown.keys().next().value!);
      // The reply usually went out with this call: then the answer is complete, and another message would only repeat it.
      return { shown: true, note: "Shown to them. If you sent your reply together with this view, your answer is complete: send nothing more. Only if you have not replied yet, send one message now that adds what the view does not show." };
    },
  }));
  return { ...toolGroup({ name: "views", channels: ["app"], tools }), answer: (person) => void shown.delete(person) };
}

/** Every href in a view's input. */
function hrefsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(hrefsOf);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => (k === "href" || k === "path") && typeof v === "string" ? [v] : hrefsOf(v));
}

/** Whether a link is one of the site's pages; a follow-up, a copy or a link to another site is not checked. */
export function isPage(href: string, pages: string[], site?: string): boolean {
  if (/^(#|mailto:)/.test(href)) return true;
  let url: URL;
  try { url = new URL(href, "https://site.invalid"); } catch { return false; }
  const own = url.hostname === "site.invalid" || (site !== undefined && url.hostname === new URL(site).hostname);
  if (!own) return true;
  return pages.some((page) => {
    const pattern = page.split(/[?#]/)[0]!.split("/").map((part) => (/^\{[^}]+\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^$()|[\]\\]/g, "\\$&"))).join("/");
    return new RegExp(`^${pattern}/?$`).test(url.pathname);
  });
}

export function appViewsOn(env: NodeJS.ProcessEnv = process.env): { url: string; key: string } | undefined {
  const url = env.FLOW_APP_SERVICE_URL?.trim(), key = env.FLOW_KEY?.trim();
  return url && key ? { url: url.replace(/\/$/, ""), key } : undefined;
}

/** The panel's look, beyond colors: every value has a default that looks finished. */
export interface McpAppTheme {
  /** Light, dark, or the person's own setting. Default "auto". */
  mode?: "light" | "dark" | "auto";
  /** The brand color: the launcher, the person's messages, buttons and links. Default #2457d6. */
  accent?: string;
  /** Text on the accent. Default white or near-black, whichever reads better on it. */
  accentText?: string;
  /** Any of the panel's colors, light; `dark` the same for dark. */
  colors?: McpAppColors;
  dark?: McpAppColors;
  /** A CSS font-family, and the stylesheet that loads it (and monoFont; Google Fonts, say). Default the system font. */
  font?: string;
  fontUrl?: string;
  /** The font for commands and code. Default the system's monospace font. */
  monoFont?: string;
  /** Corner radius in pixels. Default 14. */
  radius?: number;
  /**
   * The panel's design: "soft" (rounded bubbles, airy; the default), "sharp" (square corners, ruled
   * lines), "glass" (frosted header, accent glow) or "minimal" (no bubbles, a document of the chat).
   */
  style?: "soft" | "sharp" | "glass" | "minimal";
  /** Behind the chat: "none" (default), "dots", "grid" or "glow" (a soft accent wash). */
  pattern?: "none" | "dots" | "grid" | "glow";
  density?: "comfortable" | "compact";
  /** The brand's own CSS for the panel, applied last; each part keeps a stable class and `data-part` (AppPanel). */
  css?: string;
}

export interface McpAppColors {
  background?: string;
  surface?: string;
  text?: string;
  muted?: string;
  border?: string;
}

/**
 * The agent's own module for the panel (`McpAppOptions.panel`): it exports any of these, each drawing one
 * part. Each gets the part as the panel drew it and what it shows, and returns the node to show instead:
 * that element restyled, wrapped, or one built anew. A part it does not export stays the panel's own.
 * Every part's root carries `data-part="<name>"` beside its class, for CSS: header (`.head`), message
 * (`.msg.me`, `.msg.agent`, their `.bubble`), typing (`.msg.typing`), background (`.backdrop`) and
 * composer (`.composer`). The row under the composer ("Use it in", "Powered by Flow") is the panel's
 * alone: no module or CSS reaches it.
 */
export interface AppPanel {
  /** The top bar. `status` (the subtitle, or the sign-in state) changes as the person signs in; `newChat` and `close` work wherever they are placed. */
  header(element: HTMLElement, part: { title: string; subtitle?: string; logo?: string; mark: HTMLElement; status: HTMLElement; newChat: HTMLButtonElement; close: HTMLButtonElement }): Node;
  /** A message: the person's (`me`, plain text) or the agent's (`agent`, `body` its Markdown drawn safely). Called for each one drawn. */
  message(element: HTMLElement, part: { role: "me" | "agent"; text: string; body: HTMLElement }): Node;
  /** What shows while the agent answers; removed when it is done. */
  typing(element: HTMLElement, part: { avatar: HTMLElement }): Node;
  /** A layer behind the whole panel (the theme's pattern by default), drawn once; it takes no clicks. */
  background(element: HTMLElement, part: { pattern: string; mode: string }): Node;
  /**
   * The text field and its send button. They keep their behaviour wherever they are placed (Enter sends,
   * Shift+Enter is a new line, both are off while the agent answers); a node without both is not used.
   */
  composer(element: HTMLElement, part: { input: HTMLTextAreaElement; send: HTMLButtonElement; placeholder: string }): Node;
}

/** Where else the tools work, as the panel's "Use it in" row offers them. */
export type AppPlace = "terminal" | "claude" | "chatgpt" | "cursor" | "vscode";
const PLACES: AppPlace[] = ["terminal", "claude", "chatgpt", "cursor", "vscode"];

export interface AppUi {
  /** ui_<name> to the agent: what it shows, short (stat, list, compare). */
  name: string;
  /** What it shows and when to use it. */
  description: string;
  /** What the agent fills in: few, general fields. */
  input: z.ZodObject<Record<string, z.ZodType>>;
  /** Its HTML, with {{field}} placeholders, in the brand's look. */
  template: string;
}

export interface McpAppOptions {
  /** The sites that may embed the app: exact origins, https (http only for localhost). */
  origins: string[];
  /** The panel's name. Default: the server's name. */
  title?: string;
  /** A line under the title, e.g. "Your account, in plain words". */
  subtitle?: string;
  /** The brand's mark (https or data: URL), on the launcher, the header and the agent's messages. */
  logo?: string;
  /** What the panel says first (Markdown). */
  greeting?: string;
  /** The composer's placeholder. Default "Ask <title>…". */
  placeholder?: string;
  /** Questions offered before the first message. Default: the first read-only tools' titles. */
  suggestions?: string[];
  launcher?: {
    /** Default the title. */
    label?: string;
    /** Default "right". */
    position?: "right" | "left";
    /** "pill" (logo and label; default), "circle" (logo only) or "tab" (a slim tab on the page's edge). */
    shape?: "pill" | "circle" | "tab";
  };
  /** The panel's starting width in pixels, 340 to 720; people can drag it wider. Default 420. */
  width?: number;
  theme?: McpAppTheme;
  /**
   * The agent's own module for the panel's parts (AppPanel), served from this process: a file URL
   * (`new URL("./ui/panel.ts", import.meta.url)`) or a path from the working directory. One file with no
   * imports but `import type`; TypeScript has its types stripped, as Node runs it (no enums or namespaces).
   */
  panel?: string | URL;
  /**
   * The "Use it in" row: which places, in this order. Default all of them, the terminal first (only with
   * `cli`). Their addresses are `url` and `cli.install`. The rest of the row is the panel's own.
   */
  places?: AppPlace[];
  /** The brand's site, whose links the app opens in the site itself (https://www.example.com); its own origin when embedded elsewhere, such as locally. */
  site?: string;
  /**
   * The brand's own UIs: views the agent can show an answer with, on Flow's hosting. Each is offered on
   * the web app's channel as the tool ui_<name>: what it shows and when (description), a compact input the
   * agent fills in its own words, and a template (Mustache-style, app-fill.ts) the panel fills with it.
   * The agent uses one only when it fits, at most one per answer; otherwise it answers in text.
   */
  ui?: AppUi[];
  /**
   * The site's real pages, as paths with {placeholders} for one segment each ("/dashboard/monitors/{id}"); a
   * query or hash is allowed after any. With them, a view whose link is not one of them is refused (the agent
   * is told the pages there are), and a link that still is not one opens the nearest page that is.
   */
  pages?: string[];
  /**
   * An "Onboard with AI" button for the site's own pages: the site places `<div data-flow-onboard></div>`
   * (or calls `FlowApp.onboard(element)`) and the embed draws it there. Its main part copies `prompt` for
   * any coding agent; its menu opens it in the chosen assistants and asks the app. In the theme's accent.
   */
  onboard?: AppOnboard;
  /** The MCP URL people add to their assistant. Default: auth.resource, else this origin's MCP path. */
  url?: string;
  /** The agent's CLI: how to install it, and its CLI file, which says the command for each tool the chat runs. */
  cli?: {
    /** The CLI file's configuration (`defineCli`), read for each command's words, arguments and flags. */
    file: CliConfig;
    /** e.g. "curl -fsSL https://cli.example.com | sh". */
    install: string;
  };
}

/** The assistants the onboard button opens its prompt in. */
export type OnboardAgent = "claude" | "chatgpt" | "cursor";
const AGENTS: OnboardAgent[] = ["claude", "chatgpt", "cursor"];

export interface AppOnboard {
  /** The setup prompt it copies and opens: what a coding agent should do to start with the product. */
  prompt: string;
  /** Default "Onboard with AI"; the site may set its own (FlowAppConfig.onboard, data-label). */
  label?: string;
  /** Which assistants its menu opens the prompt in, in this order. Default all. */
  agents?: OnboardAgent[];
  /** The menu's item that opens the app. Default "Ask <title>". */
  askLabel?: string;
  /** The line under it. Default "Questions before you start". */
  askHint?: string;
}

export const APP_PATH = "/app";
/** The files the app serves: the launcher, the panel and what it imports. */
const FILES: Record<string, string> = { "embed.js": "app-embed", "panel.js": "app-panel", "markdown.js": "markdown", "app-icons.js": "app-icons", "app-fill.js": "app-fill" };
/** Where the agent's own module for the panel is served. */
const PARTS = "parts.js";
const LOCAL = ["localhost", "127.0.0.1", "[::1]"];

export function appServer(options: McpAppOptions, server: { name: string; mcpPath: string; resource?: string; terminalPath?: string; tools: ToolInfo[]; chat?: { fetch(request: Request): Promise<Response> }; verify?: (token: string, request: Request) => Promise<McpIdentity | null> }) {
  const views = appViewsOn();
  /** The signed-in person's identity, for the routes that cost or record something. */
  const person = async (request: Request) => {
    const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    return token && server.verify ? server.verify(token, request).catch(() => null) : null;
  };
  const service = (path: string, body: unknown) => fetch(`${views!.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${views!.key}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const origins = options.origins.map((origin) => {
    const url = new URL(origin);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL.includes(url.hostname))) || url.origin !== origin.replace(/\/$/, "")) throw new Error(`@flow-engineer/flow/mcp: app origins are exact origins, https (http only for localhost), not "${origin}"`);
    return url.origin;
  });
  if (!origins.length) throw new Error("@flow-engineer/flow/mcp: give the sites that embed the app as app.origins");
  const theme = options.theme ?? {};
  for (const url of [options.logo, theme.fontUrl]) if (url && !/^(https:|data:image\/)/.test(url)) throw new Error(`@flow-engineer/flow/mcp: app.logo and theme.fontUrl are https (or data:image/) URLs, not "${url}"`);
  for (const place of options.places ?? []) if (!PLACES.includes(place)) throw new Error(`@flow-engineer/flow/mcp: app.places are ${PLACES.join(", ")}, not "${place}"`);
  if (options.places?.includes("terminal") && !options.cli) throw new Error("@flow-engineer/flow/mcp: app.places has terminal, which needs app.cli");
  const places = [...new Set(options.places ?? PLACES.filter((place) => place !== "terminal" || options.cli))];
  const parts = options.panel === undefined ? undefined : panelModule(options.panel);
  const title = options.title ?? server.name;
  const onboard = options.onboard;
  if (onboard && !onboard.prompt?.trim()) throw new Error("@flow-engineer/flow/mcp: app.onboard needs a prompt");
  for (const agent of onboard?.agents ?? []) if (!AGENTS.includes(agent)) throw new Error(`@flow-engineer/flow/mcp: app.onboard.agents are ${AGENTS.join(", ")}, not "${agent}"`);
  const width = Math.min(720, Math.max(340, Math.round(options.width ?? 420)));
  // What the launcher on the site needs before the panel exists.
  const launcher = {
    title,
    label: options.launcher?.label ?? title,
    position: options.launcher?.position ?? "right",
    shape: options.launcher?.shape ?? "pill",
    logo: options.logo,
    accent: theme.accent ?? "#2457d6",
    accentText: theme.accentText,
    radius: theme.radius ?? 14,
    font: theme.font,
    width,
    onboard: onboard && {
      label: onboard.label ?? "Onboard with AI",
      prompt: onboard.prompt,
      agents: [...new Set(onboard.agents ?? AGENTS)],
      askLabel: onboard.askLabel ?? `Ask ${title}`,
      askHint: onboard.askHint ?? "Questions before you start",
    },
  };
  const allowed = (origin: string | null): origin is string => !!origin && origins.includes(origin);
  return {
    paths: [APP_PATH],
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === `${APP_PATH}/chat` && server.chat) return server.chat.fetch(request);
      // A view template for a tool's result, from Flow's service; the panel fills it with the data itself.
      if (url.pathname === `${APP_PATH}/view` || url.pathname === `${APP_PATH}/link`) {
        if (request.method !== "POST" || request.headers.get("origin") !== url.origin || !views) return Response.json({ error: "not_found" }, { status: 404 });
        if (!(await person(request))) return Response.json({ error: "sign_in_required" }, { status: 401 });
        const body = await request.json().catch(() => null) as Record<string, unknown> | null;
        if (!body) return Response.json({ error: "invalid_request" }, { status: 400 });
        if (url.pathname.endsWith("/view")) {
          // A UI the agent called: its template, which the panel fills with the agent's input.
          const found = options.ui?.find((u) => `ui_${u.name}` === body.ui);
          return found ? Response.json({ template: found.template }) : Response.json({ error: "no_view" }, { status: 404 });
        }
        // Where a link the assistant gave led, for the brand's insights.
        if (typeof body.url !== "string") return Response.json({ error: "invalid_request" }, { status: 400 });
        await service("/v1/links", { agent: server.name, url: body.url, ok: body.ok === true, status: body.status, reason: body.reason }).catch(() => null);
        return Response.json({});
      }
      // The CLI line for a step the chat ran; only the app's own page asks.
      if (url.pathname === `${APP_PATH}/command`) {
        if (request.method !== "POST" || request.headers.get("origin") !== url.origin || !options.cli) return Response.json({ error: "not_found" }, { status: 404 });
        const body = await request.json().catch(() => null) as { tool?: unknown; input?: unknown } | null;
        if (typeof body?.tool !== "string" || !body.input || typeof body.input !== "object") return Response.json({ error: "invalid_request" }, { status: 400 });
        return Response.json({ command: commandLine(options.cli.file, server.tools, body.tool, body.input as Record<string, unknown>) ?? null });
      }
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      const origin = url.searchParams.get("origin");
      if (url.pathname === `${APP_PATH}/config`) {
        if (!allowed(origin)) return Response.json({ error: "origin_not_allowed" }, { status: 403 });
        return Response.json(launcher, { headers: { "access-control-allow-origin": origin, vary: "origin", "cache-control": "public, max-age=60" } });
      }
      if (url.pathname === APP_PATH) {
        if (!allowed(origin)) return new Response("This site may not embed the app.", { status: 403 });
        const settings = {
          ...launcher,
          name: server.name,
          origin,
          subtitle: options.subtitle,
          greeting: options.greeting,
          placeholder: options.placeholder ?? `Ask ${title}…`,
          suggestions: options.suggestions,
          theme,
          mcp: server.mcpPath,
          terminal: server.chat ? `${APP_PATH}/chat` : server.terminalPath,
          views: !!views,
          site: options.site,
          pages: options.pages,
          url: options.url ?? server.resource ?? `${url.origin}${server.mcpPath}`,
          cli: options.cli && { name: options.cli.file.name, install: options.cli.install },
          places,
          parts: !!parts,
        };
        const fonts = theme.fontUrl ? " https:" : "";
        return new Response(page(settings, title), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
            "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'${fonts}; font-src 'self' data:${fonts}; img-src 'self' https: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${origins.join(" ")}`,
          },
        });
      }
      if (parts && url.pathname === `${APP_PATH}/${PARTS}`) return serveScript(parts, request, "no-cache");
      const file = url.pathname.startsWith(`${APP_PATH}/`) ? FILES[url.pathname.slice(APP_PATH.length + 1)] : undefined;
      // Checked on every load, so a new version reaches people at once (a 304 when it has not changed).
      if (file) return widgetFile(file, request, "no-cache");
      return new Response("Not found", { status: 404 });
    },
  };
}

/** The agent's module for the panel, read once at start, so a missing file or one the browser cannot load fails here. */
function panelModule(at: string | URL) {
  const file = typeof at === "string" && !at.startsWith("file:") ? at : new URL(at);
  const where = typeof file === "string" ? file : file.pathname;
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch (error) { throw new Error(`@flow-engineer/flow/mcp: app.panel: cannot read ${where} (${(error as Error).message})`); }
  if (/\.[mc]?ts$/.test(where)) text = stripTypeScriptTypes(text);
  // Served alone at /app/parts.js: anything it imported would not be there.
  if (/^\s*(import\s*[\w{*'"]|export\s[^;]*\bfrom\s*['"])/m.test(text)) throw new Error(`@flow-engineer/flow/mcp: app.panel (${where}) is one file: import only types (import type)`);
  return scriptFile(text);
}

/** The iframe's page: its settings as JSON (never run as script), the brand's font, and the panel module. */
function page(settings: Record<string, unknown> & { theme: McpAppTheme }, title: string): string {
  const json = JSON.stringify(settings).replace(/</g, "\\u003c");
  const font = settings.theme.fontUrl ? `<link rel="stylesheet" href="${escape(settings.theme.fontUrl)}">` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>${font}` +
    `<script type="application/json" id="flow-app">${json}</script><script type="module" src="${APP_PATH}/panel.js"></script></head><body></body></html>`;
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
