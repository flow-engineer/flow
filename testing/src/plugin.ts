// Plugin packages generated from an agent's skills. The two native formats deliver skills once:
// both point at the tools-only MCP endpoint. Teams can edit manifests and add files alongside them.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CHAT_ONLY } from "../../mcp/src/describe.ts";
import { loadSkills, readAgentFolder } from "../../src/skills.ts";

export const PLUGIN_LINE = "  chinwag plugin --server <url> --out <dir>  Write Claude Code and Agent Plugins packages";
const STAMP = ".chinwag-skills.json";

function skillFiles(dir: string): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  const root = join(dir, "agent");
  function visit(path: string) {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Plugin skills cannot copy a symlink: ${child}`);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files[child] = readFileSync(join(root, child));
    }
  }
  if (existsSync(join(root, "skills"))) visit("skills");
  return files;
}

/** Hashes source bytes, rather than mtimes: a checkout cannot make an old plugin look current. */
function hashes(files: Record<string, string | Buffer>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([p, body]) => [p, createHash("sha256").update(body).digest("hex")]));
}

export function pluginProblems(dir: string, out: string): string[] {
  const expected = hashes(skillFiles(dir));
  try {
    const recorded = JSON.parse(readFileSync(join(out, STAMP), "utf8"));
    if (JSON.stringify(recorded) !== JSON.stringify(expected)) return ["plugin skills are stale; run chinwag plugin again"];
    for (const format of ["claude", "agent-plugins"]) {
      if (JSON.stringify(hashes(Object.fromEntries(Object.keys(expected).map((p) => [p, readFileSync(join(out, format, p))])))) !== JSON.stringify(expected)) {
        return [`${format} plugin skills differ from agent/skills; run chinwag plugin again`];
      }
    }
    return [];
  } catch {
    return ["plugin skills are missing or unreadable; run chinwag plugin again"];
  }
}

export function writePlugins(dir: string, server: string, out: string, name?: string): void {
  const pkg = existsSync(join(dir, "package.json")) ? JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) : {};
  const pluginName = name ?? String(pkg.name ?? "agent").replace(/^@[^/]+\//, "");
  if (!/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(pluginName) || pluginName.length > 64) throw new Error("Give --name a plugin name: lowercase letters, numbers, dots and hyphens, up to 64 characters.");
  const url = new URL(server);
  if (url.username || url.password || url.search || url.hash) throw new Error("The server URL must not contain credentials, a query or a fragment.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Use https for remote servers, or http on localhost.");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${url.pathname.replace(/\/+$/, "").endsWith("/plugin") ? "" : "/plugin"}`;
  const files = skillFiles(dir);
  for (const skill of loadSkills(readAgentFolder(join(dir, "agent")))) {
    const named = CHAT_ONLY.exec(skill.body);
    if (named) throw new Error(`skill ${skill.name}: names ${named[1]}, which the plugin's MCP server does not have`);
  }
  const manifest = { name: pluginName, ...(pkg.version ? { version: pkg.version } : {}), ...(pkg.description ? { description: pkg.description } : {}) };
  const json = (path: string, value: unknown) => write(path, `${JSON.stringify(value, null, 2)}\n`);
  function write(path: string, body: string | Buffer) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  // Remove only files this generator previously owned, so deleted source skills do not linger.
  let previous: Record<string, string> = {};
  if (existsSync(join(out, STAMP))) previous = JSON.parse(readFileSync(join(out, STAMP), "utf8"));
  for (const path of Object.keys(previous)) {
    if (!path.startsWith("skills/") || path.split("/").includes("..")) throw new Error("Invalid plugin skills stamp");
    if (!(path in files)) for (const format of ["claude", "agent-plugins"]) rmSync(join(out, format, path), { force: true });
  }
  for (const format of ["claude", "agent-plugins"]) {
    const root = join(out, format);
    for (const [path, body] of Object.entries(files)) write(join(root, path), body);
    if (format === "claude") {
      json(join(root, ".claude-plugin/plugin.json"), manifest);
      json(join(root, ".mcp.json"), { mcpServers: { [pluginName]: { type: "http", url: url.href } } });
    } else {
      json(join(root, "plugin.json"), { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", ...manifest });
      json(join(root, "mcp.json"), { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { [pluginName]: { type: "streamable-http", url: url.href } } });
    }
  }
  json(join(out, STAMP), hashes(files));
}

export function pluginCli(argv: string[], dir = process.cwd()): number {
  try {
    const { values } = parseArgs({ args: argv, options: { server: { type: "string" }, out: { type: "string" }, name: { type: "string" }, help: { type: "boolean", short: "h" } } });
    if (values.help) { console.log(PLUGIN_LINE.trim()); return 0; }
    if (!values.server || !values.out) throw new Error(PLUGIN_LINE.trim());
    writePlugins(dir, values.server, resolve(dir, values.out), values.name);
    console.log(`Wrote ${values.out}/claude and ${values.out}/agent-plugins. Check: chinwag check --plugin ${values.out}`);
    return 0;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}
