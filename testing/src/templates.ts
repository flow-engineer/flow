// `flow templates`: the project's WhatsApp templates on Flow's dashboard, read with the agent's Flow
// key (FLOW_KEY), so a coding agent declares them exactly as Meta approved them:
//   GET {cloud}/v1/agent/templates → { templates: [{ name, language, category, status, header?, body,
//     footer?, buttons, values, send_order, ... }], synced_at }
// `--declare` prints the approved ones as createAgent's `templates: [...]`; `flow test` warns when a
// declared template differs from the approved one (templateWarnings). A dashboard without the route
// (404) does not serve templates yet. With --json, stdout is one JSON document: the server's, or
// { ok: false, error, next } when it did not work. Exit status: 0 printed, 1 not read, 2 a wrong flag.

import type { TemplateDefinition } from "../../src/types.ts";
import { access, answerOf, Failed, failed, get, hostedOf, parse, table, usageFailed, USAGE_EXIT, withHosted } from "./conversations.ts";
import { KEYS_HELP, type FoundKey } from "./cloud-call.ts";
import { OBSERVE_URL } from "../../src/traces.ts";

export const TEMPLATES_LINE = `  flow templates [--all] [--declare] [--json]
                            The project's approved WhatsApp templates and the order each send
                            gives its values in; --declare prints them for createAgent`;

const USAGE = `Usage:
  flow templates [--all] [--declare] [--json]

The project's WhatsApp templates on Flow's dashboard: name, language, category, status, and the
order a send gives its values in (header, body[0], body[1], ..., buttons[i]). Before declaring
WhatsApp templates, run flow templates --declare and paste its output. flow test warns when a
declared template differs from the approved one.

Options:
  --all                    Every status (pending, rejected, ...), not only approved
  --declare                The approved templates as createAgent's templates: [...], ready to paste,
                           and one agent.nudge per template with its values in order
  --json                   The server's JSON on stdout, every status (or { ok: false, error, next }
                           when it did not work)
  --env, --environment     Taken and ignored: the templates are the project's, in both
  --cloud <url>            Flow's address (default: FLOW_FRAMEWORK_CLOUD, else ${OBSERVE_URL})
  --dotenv <path>          Read the environment from this file instead of the folder's .env
  --server <url>           Read over a hosted Flow MCP as you (flow mcp login), not with this
                           folder's keys (default: FLOW_MCP_SERVER)
  --agent <id|name>        With --server: which of your agents (default: your only one)
  -h, --help               Show this help

Reads with the agent's Flow key, FLOW_KEY (flow setup writes it into .env); it is never printed.
Exit status: 0 printed, 1 no key, or the server refused or could not be reached, 2 a wrong flag.

${KEYS_HELP}`;

/** A template as the dashboard lists it. */
interface Listed {
  name: string;
  language: string;
  category?: string;
  status?: string;
  header?: { kind: string; text?: string };
  body?: string;
  footer?: string;
  buttons?: Array<{ type: string; text?: string; url?: string; phone?: string }>;
  values?: { header?: string; body?: string[]; buttons?: Array<{ index: number; variable: string }> };
  send_order?: string;
}

const NOT_SERVED = "the dashboard does not serve templates yet";

/** Runs `flow templates ...`; resolves to the exit status. */
export async function templatesCli(args: string[]): Promise<number> {
  const name = "flow templates";
  const parsed = parse(name, args, { all: { type: "boolean", default: false }, declare: { type: "boolean", default: false } }, USAGE);
  if (!parsed) return USAGE_EXIT;
  const { values, positionals } = parsed;
  const json = values.json === true;
  if (values.help) return console.log(USAGE), 0;
  if (positionals.length) return usageFailed(json, `${name} takes no arguments.`, USAGE);
  if (values.declare && (values.all || json)) return usageFailed(json, `--declare prints the approved templates only: give it alone.`, USAGE);
  const hosted = hostedOf(values);
  if (typeof hosted === "string") return usageFailed(json, hosted, USAGE);
  const where = hosted ? undefined : access(name, values);
  if (where instanceof Failed) return failed(json, where);
  let text: string;
  let body: Record<string, unknown>;
  try {
    // Over a hosted Flow MCP, list_templates says a dashboard without templates in these words itself.
    ({ text, body } = await withHosted(hosted, "templates", async (read) => (read ? answerOf(await read("list_templates", { status: "all" })) : await get(name, where!, "/v1/agent/templates"))));
  } catch (error) {
    if (!(error instanceof Failed)) throw error;
    const notServed = where !== undefined && error.status === 404;
    return failed(json, notServed ? Object.assign(new Failed(`${name}: ${NOT_SERVED} (${where.cloud} answered 404).`, "not_available"), { status: 404 }) : error);
  }
  if (json) return process.stdout.write(text.endsWith("\n") ? text : `${text}\n`), 0;
  const listed = (body.templates as Listed[] | undefined) ?? [];
  const shown = values.all ? listed : listed.filter((t) => t.status === "approved");
  if (values.declare) return console.log(declare(shown).join("\n")), 0;
  if (!shown.length) {
    const others = listed.length ? ` (${listed.length} with another status: flow templates --all)` : "";
    return console.log(`No ${values.all ? "" : "approved "}WhatsApp templates on the dashboard${others}.`), 0;
  }
  const rows = shown.map((t) => [t.name, t.language, t.category ?? "", t.status ?? "", t.send_order || "-"]);
  console.log([...table(["NAME", "LANGUAGE", "CATEGORY", "STATUS", "SEND ORDER"], rows), "", "Declare them: flow templates --declare"].join("\n"));
  return 0;
}

/** A template as createAgent declares it, exactly as the dashboard lists it. */
function definition(t: Listed): TemplateDefinition {
  return {
    name: t.name,
    language: t.language,
    category: t.category as TemplateDefinition["category"],
    ...(t.header ? { header: (t.header.kind === "text" ? { kind: "text", text: t.header.text ?? "" } : { kind: t.header.kind }) as TemplateDefinition["header"] } : {}),
    body: t.body ?? "",
    ...(t.footer ? { footer: t.footer } : {}),
    ...(t.buttons?.length ? { buttons: t.buttons.map(button) as TemplateDefinition["buttons"] } : {}),
  };
}

/** A button with its fields in one order, so two of them compare as text. */
function button({ type, text, url, phone }: { type: string; text?: string; url?: string; phone?: string }) {
  return { type, text, ...(url !== undefined ? { url } : {}), ...(phone !== undefined ? { phone } : {}) };
}

/** A value as TypeScript source: objects on one line, keys unquoted. */
function literal(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  if (value && typeof value === "object") return `{ ${Object.entries(value).map(([k, v]) => `${k}: ${literal(v)}`).join(", ")} }`;
  return JSON.stringify(value);
}

/** A variable as a value to fill in: {{listing}} as "<listing>". */
const fill = (variable: string) => `<${variable.replace(/^\{\{\s*|\s*\}\}$/g, "")}>`;

/** The approved templates as createAgent's templates: [...], then a send of each with its values in order. */
function declare(templates: Listed[]): string[] {
  const seen = new Set<string>();
  const unique = templates.filter((t) => !seen.has(`${t.name}\n${t.language}`) && seen.add(`${t.name}\n${t.language}`));
  if (!unique.length) return ["// No approved WhatsApp templates on the dashboard yet.", "templates: [],"];
  const out = ["// The approved WhatsApp templates, exactly as Meta has them: paste into createAgent({ ... }).", "templates: ["];
  for (const t of unique) {
    out.push("  {", ...Object.entries(definition(t)).map(([k, v]) => `    ${k}: ${literal(v)},`), "  },");
  }
  out.push("],", "", "// A send of each gives its values by position, in this order:");
  for (const t of unique) {
    const v = t.values ?? {};
    const header = v.header ? { kind: "text", text: fill(v.header) } : t.header && t.header.kind !== "text" ? { kind: t.header.kind, url: "https://…" } : undefined;
    const sent = {
      name: t.name,
      language: t.language,
      ...(header ? { header } : {}),
      ...(v.body?.length ? { body: v.body.map(fill) } : {}),
      ...(v.buttons?.length ? { buttons: v.buttons.map((b) => ({ index: b.index, value: fill(b.variable) })) } : {}),
    };
    out.push(`// ${t.name} (${t.language}): ${t.send_order || "takes no values"}`, `// await agent.nudge({ to, template: ${literal(sent)} });`);
  }
  return out;
}

/** What differs between a declared template and the dashboard's, one phrase each. */
function differences(declared: TemplateDefinition, approved: TemplateDefinition): string[] {
  const out: string[] = [];
  const quoted = (s: string | undefined) => (s === undefined ? "none" : JSON.stringify(s));
  if (declared.category !== approved.category) out.push(`category: declared ${declared.category}, approved ${approved.category}`);
  const [dh, ah] = [declared.header, approved.header];
  if ((dh?.kind ?? "none") !== (ah?.kind ?? "none")) out.push(`header: declared ${dh?.kind ?? "none"}, approved ${ah?.kind ?? "none"}`);
  else if (dh?.kind === "text" && ah?.kind === "text" && dh.text !== ah.text) out.push(`header text: declared ${quoted(dh.text)}, approved ${quoted(ah.text)}`);
  if (declared.body !== approved.body) out.push(`body: declared ${quoted(declared.body)}, approved ${quoted(approved.body)}`);
  if (declared.footer !== approved.footer) out.push(`footer: declared ${quoted(declared.footer)}, approved ${quoted(approved.footer)}`);
  const [db, ab] = [literal(declared.buttons ?? []), literal(approved.buttons ?? [])];
  if (db !== ab) out.push(`buttons: declared ${db}, approved ${ab}`);
  return out;
}

/** Each declared template that is missing from the dashboard, not approved, or differs from the approved one. */
export function templateDifferences(declared: TemplateDefinition[], listed: Listed[]): string[] {
  const out: string[] = [];
  for (const d of declared) {
    const same = listed.filter((t) => t.name === d.name && t.language === d.language);
    const approved = same.find((t) => t.status === "approved");
    const at = `${d.name} (${d.language})`;
    if (!same.length) out.push(`${at}: missing, not on the dashboard`);
    else if (!approved) out.push(`${at}: ${same[0]!.status ?? "not approved"}, not approved: its sends fail until Meta approves it`);
    else out.push(...differences({ ...d, buttons: d.buttons?.map(button) as TemplateDefinition["buttons"] }, definition(approved)).map((what) => `${at}: ${what}`));
  }
  return out;
}

/**
 * The lines `flow test` prints when the agent's declared templates are not the approved ones: none
 * when it declares none, has no key, or the dashboard does not serve templates. Never throws.
 */
export async function templateWarnings(declared: TemplateDefinition[], cloud: string, key: FoundKey | undefined): Promise<string[]> {
  if (!declared.length || !key) return [];
  let body: Record<string, unknown>;
  try {
    ({ body } = await get("flow test", { cloud: cloud.replace(/\/+$/, ""), key }, "/v1/agent/templates"));
  } catch (error) {
    if (error instanceof Failed && error.status === 404) return [];
    return [`Could not compare the declared WhatsApp templates with the dashboard's: ${(error as Error).message.replace(/^flow test: /, "")}`];
  }
  if (!Array.isArray(body.templates)) return [];
  const found = templateDifferences(declared, body.templates as Listed[]);
  if (!found.length) return [];
  return ["Declared WhatsApp templates that are not the approved ones (warning; flow templates --declare prints the approved ones to paste):", ...found.map((line) => `  ${line}`)];
}
