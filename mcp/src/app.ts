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
import { widgetFile } from "../../src/web-chat.ts";
import { tool, z, type Tool } from "../../src/index.ts";
import type { McpIdentity } from "./server.ts";

/**
 * Generative views are Flow's hosted service: on with its address (FLOW_APP_SERVICE_URL, which Flow's
 * hosting sets) and the agent's Flow key. Self-hosted, answers are Markdown and nothing is sent anywhere.
 */
/** What the agent is told on the web app's channel when its answers are shown with UI tools. */
export const UI_INSTRUCTIONS = [
  "This is the brand's own web app. The person sees each tool call as it runs; you show the answer with a UI tool (ui_…).",
  "First work out what they actually asked, then gather what you need. Then call exactly ONE ui_ tool with only the data that answers them, never every result you looked at. Fill its input from what you learned, in their words. Then reply in one short sentence; never repeat what the view shows, and never write tables.",
  "When no ui_ tool fits, call ui_create with what to show (intent) and exactly that data. For a simple answer (a yes or no, one fact, a question back) show nothing: just reply.",
].join("\n");

/** The brand's UI tools from Flow's service, read again at most every 30 s, and ui_create. */
const catalogs = new Map<string, { at: number; tools: Promise<Array<{ name: string; description: string; input: JsonSchema; template: string }>> }>();
export function catalogOf(service: { url: string; key: string }, agent: string) {
  let known = catalogs.get(agent);
  if (!known || Date.now() - known.at > 30_000) {
    // The service unreachable: keep the catalog read before (this request's own promise would wait on itself).
    const before = known?.tools ?? Promise.resolve([]);
    const tools = fetch(`${service.url}/v1/ui/catalog?${new URLSearchParams({ agent })}`, { headers: { authorization: `Bearer ${service.key}` }, signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`catalog ${r.status}`)))).then((b: { tools?: [] }) => b.tools ?? []).catch(() => before);
    known = { at: Date.now(), tools: tools as never };
    catalogs.set(agent, known);
  }
  return known.tools;
}
let latest: Array<{ name: string; description: string; input: JsonSchema; template: string }> = [];
export function uiTools(service: { url: string; key: string }, agent: string): Tool[] {
  void catalogOf(service, agent).then((tools) => { latest = tools; }, () => undefined);
  const shown = { run: () => ({ shown: true }), signIn: "none" as const, hints: { readOnly: true, destructive: false, openWorld: false } };
  return [
    ...latest.slice(0, 24).map((t) => tool({ name: `ui_${t.name}`, description: t.description, input: zodOf(t.input) as z.ZodObject<Record<string, z.ZodType>>, ...shown })),
    tool({ name: "ui_create", description: "Show the answer in a view made now, when no other ui_ tool fits: what to show, and exactly the data to show.", input: z.object({ intent: z.string().describe("What the view shows, in a few words"), data: z.record(z.string(), z.unknown()).describe("The data to show, and nothing else") }), ...shown }),
  ];
}

type JsonSchema = { type?: string | string[]; enum?: unknown[]; description?: string; items?: JsonSchema; properties?: Record<string, JsonSchema>; required?: string[] };
/** A UI tool's compact input (JSON Schema, from the curator) as a schema the agent validates against; loose where it is unsure. */
function zodOf(schema: JsonSchema = {}): z.ZodType {
  const type = [schema.type].flat().find((t) => t !== "null");
  let value: z.ZodType;
  if (schema.enum?.length && schema.enum.every((v) => typeof v === "string")) value = z.enum(schema.enum as [string, ...string[]]);
  else if (type === "string") value = z.string();
  else if (type === "number" || type === "integer") value = z.number();
  else if (type === "boolean") value = z.boolean();
  else if (type === "array") value = z.array(zodOf(schema.items));
  else if (type === "object" || schema.properties) value = z.object(Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, (schema.required ?? []).includes(k) ? zodOf(v) : zodOf(v).optional()]))).passthrough();
  else value = z.unknown();
  return schema.description ? value.describe(schema.description) : value;
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
  /** The brand's own CSS for the panel, applied last; its parts keep stable class names (`.app`, `.msg`, `.step`...). */
  css?: string;
}

export interface McpAppColors {
  background?: string;
  surface?: string;
  text?: string;
  muted?: string;
  border?: string;
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
  /** The brand's site, whose links the app opens in the site itself (https://www.example.com); its own origin when embedded elsewhere, such as locally. */
  site?: string;
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

export const APP_PATH = "/app";
/** The files the app serves: the launcher, the panel and what it imports. */
const FILES: Record<string, string> = { "embed.js": "app-embed", "panel.js": "app-panel", "markdown.js": "markdown", "app-icons.js": "app-icons", "app-fill.js": "app-fill" };
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
  const title = options.title ?? server.name;
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
          // A UI tool the agent called: ui_create is made now by Flow's service; another is a catalog template the panel fills.
          if (typeof body.ui !== "string" || !body.data || typeof body.data !== "object") return Response.json({ error: "invalid_request" }, { status: 400 });
          if (body.ui === "ui_create") {
            const { intent, data } = body.data as { intent?: unknown; data?: unknown };
            const answer = await service("/v1/ui/create", { agent: server.name, intent, data, question: body.question }).catch(() => null);
            return answer?.ok ? Response.json(await answer.json()) : Response.json({ error: "no_view" }, { status: 502 });
          }
          const found = (await catalogOf(views, server.name)).find((t) => `ui_${t.name}` === body.ui);
          if (!found) return Response.json({ error: "no_view" }, { status: 404 });
          void service("/v1/ui/used", { agent: server.name, name: found.name }).catch(() => null);
          return Response.json({ template: found.template });
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
          url: options.url ?? server.resource ?? `${url.origin}${server.mcpPath}`,
          cli: options.cli && { name: options.cli.file.name, install: options.cli.install },
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
      const file = url.pathname.startsWith(`${APP_PATH}/`) ? FILES[url.pathname.slice(APP_PATH.length + 1)] : undefined;
      // Checked on every load, so a new version reaches people at once (a 304 when it has not changed).
      if (file) return widgetFile(file, request, "no-cache");
      return new Response("Not found", { status: 404 });
    },
  };
}

/** The iframe's page: its settings as JSON (never run as script), the brand's font, and the panel module. */
function page(settings: Record<string, unknown> & { theme: McpAppTheme }, title: string): string {
  const json = JSON.stringify(settings).replace(/</g, "\\u003c");
  const font = settings.theme.fontUrl ? `<link rel="stylesheet" href="${escape(settings.theme.fontUrl)}">` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>${font}` +
    `<script type="application/json" id="flow-app">${json}</script><script type="module" src="${APP_PATH}/panel.js"></script></head><body></body></html>`;
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
