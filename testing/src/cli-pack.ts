// `flow cli pack`: the agent's CLI (src/cli.ts) as one package anyone with Node.js installs. esbuild
// bundles it with every dependency (an optional peer, loaded only here), the given server written
// in place of the CLI file's default, and the files it ships (defineCli({ files })) beside the
// bundle. The bundle must print its help from a fresh folder, started through a link as npm links
// it, before `npm pack` makes <out>/<name>.tgz. Beside it: install.sh (testing/src/install.sh
// filled in for this build) and release.json.

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { httpsUrl, type CliConfig } from "../../cli/src/commands.ts";
import { packageRoot } from "./new.ts";

/** A CLI's command name, as its package, its folder (~/.<name>) and its <NAME>_HOME are named. */
export const CLI_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** What release.json says, and what Flow's hosting is told of a release. */
export interface PackedCli {
  name: string;
  display_name: string;
  version: string;
  sha256: string;
  size: number;
  server: string;
}

export interface PackOptions {
  /** The agent's folder. */
  dir: string;
  /** The MCP server the CLI uses by default. */
  server: string;
  /** Named in the version: staging, production, or custom for a server given by address. */
  label: string;
  /** Where the release is served: update.latest is <base>/cli/version, update.command `curl -fsSL <base> | sh`. */
  base: string;
  /** Written into install.sh (self-hosted); without it the placeholder stays for Flow's hosting to fill. */
  baseUrl?: string;
  out: string;
  say: (line: string) => void;
}

/** Why a pack stopped, and the exit code: 2 for what the folder must change, 1 for a build that failed. */
export class PackError extends Error {
  readonly exit: number;
  constructor(message: string, exit: number) {
    super(message);
    this.exit = exit;
  }
}

/** Packs the CLI; returns what release.json says. */
export async function packCli(options: PackOptions): Promise<PackedCli> {
  const { dir, server, out, say } = options;
  const entry = join(dir, "src", "cli.ts");
  if (!existsSync(entry)) throw new PackError(`No src/cli.ts in ${dir}: flow cli pack packs the agent's CLI file.`, 2);
  const pkg = readJson(join(dir, "package.json")) as { version?: unknown; displayName?: unknown };
  if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+/.test(pkg.version)) throw new PackError(`${join(dir, "package.json")} needs a version (such as 0.1.0): the CLI's version starts with it.`, 2);
  const cli = await loadCli(dir, entry);
  if (!CLI_NAME.test(cli.name)) throw new PackError(`The CLI's name "${cli.name}" must be lowercase letters, digits and -, starting with a letter, at most 40: it names its package, its folder and its <NAME>_HOME.`, 2);
  if (typeof cli.server !== "string") throw new PackError(`src/cli.ts sets no default server (defineCli({ server: process.env.${envName(cli.name)}_SERVER ?? "http://127.0.0.1:8790/mcp" })): pack writes ${server} in its place.`, 2);
  const version = `${pkg.version}-${options.label}.${commit(dir)}`;
  const esbuild = await loadEsbuild();
  const staged = mkdtempSync(join(tmpdir(), "flow-cli-pack-"));
  try {
    const built = await esbuild.build({
      entryPoints: { cli: entry },
      bundle: true,
      // Lazy imports stay in chunks of their own: flattened into one file, a shared module can
      // run before what it needs is initialized.
      splitting: true,
      format: "esm",
      platform: "node",
      target: "node20.19",
      outdir: join(staged, "dist"),
      write: false,
      logLevel: "warning",
      // Bundled CommonJS dependencies still call require().
      banner: { js: "import { createRequire as __flowCreateRequire } from 'node:module'; const require = __flowCreateRequire(import.meta.url);" },
      // defineCli reads it: the version and how to update (commands.ts).
      define: { __FLOW_CLI_RELEASE__: JSON.stringify({ version, update: { command: `curl -fsSL ${options.base} | sh`, latest: `${options.base}/cli/version` } }) },
    }).catch(() => {
      throw new PackError("esbuild could not bundle src/cli.ts (above).", 1);
    });
    const literal = JSON.stringify(cli.server);
    const found = built.outputFiles.reduce((n, file) => n + file.text.split(literal).length - 1, 0);
    if (found !== 1) {
      throw new PackError(`src/cli.ts's default server ${literal} must be written once, as a string, for pack to put ${server} in its place; the bundle has it ${found} times.${found === 0 ? ` Is ${envName(cli.name)}_SERVER set in this shell? Unset it.` : ""}`, 2);
    }
    for (const file of built.outputFiles) {
      let text = file.text.replace(literal, () => JSON.stringify(server));
      if (file.path === join(staged, "dist", "cli.js") && !text.startsWith("#!")) text = `#!/usr/bin/env node\n${text}`;
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, text);
    }
    const shipped = copyFiles(dir, staged, cli.files ?? []);
    const display = cli.brand?.name ?? (typeof pkg.displayName === "string" && pkg.displayName.trim() ? pkg.displayName.trim() : cli.name);
    writeFileSync(join(staged, "package.json"), `${JSON.stringify({
      name: cli.name, version, description: cli.description ?? `The ${display} CLI`, type: "module",
      bin: { [cli.name]: "dist/cli.js" }, files: ["dist", ...shipped], engines: { node: ">=20.19" },
    }, null, 2)}\n`);
    await smokeTest(staged, cli.name);
    mkdirSync(out, { recursive: true });
    const file = execFileSync("npm", ["pack", "--silent", "--pack-destination", staged], { cwd: staged, encoding: "utf8" }).trim().split("\n").at(-1)!;
    const tgz = join(out, `${cli.name}.tgz`);
    renameSync(join(staged, file), tgz);
    const bytes = readFileSync(tgz);
    const release: PackedCli = { name: cli.name, display_name: display, version, sha256: createHash("sha256").update(bytes).digest("hex"), size: statSync(tgz).size, server };
    writeFileSync(join(out, "install.sh"), installer(release, options.baseUrl), { mode: 0o755 });
    writeFileSync(join(out, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
    say(`Packed ${cli.name} ${version} (${(release.size / 1024).toFixed(0)} KB), server ${server}: ${tgz}`);
    return release;
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

/**
 * The server the CLI file names for an environment (defineCli({ servers })), for a pack in place of
 * the hosted address; undefined when it names none.
 */
export async function fixedServer(dir: string, environment: "staging" | "production"): Promise<string | undefined> {
  const url = (await loadCli(dir, join(dir, "src", "cli.ts"))).servers?.[environment];
  if (url !== undefined && !httpsUrl(url)) throw new PackError(`servers.${environment} in src/cli.ts must be an https URL, such as https://cli.acme.com/mcp.`, 2);
  return url;
}

/** The installer for this release; the base URL stays a placeholder unless the release is self-hosted. */
export function installer(release: PackedCli, baseUrl?: string): string {
  const values: Record<string, string> = {
    __FLOW_CLI_NAME__: release.name,
    __FLOW_CLI_ENV__: envName(release.name),
    // In single quotes: a quote is closed, escaped and reopened.
    __FLOW_CLI_DISPLAY_NAME__: release.display_name.replace(/[\x00-\x1f\x7f]/g, "").replaceAll("'", "'\\''"),
    __FLOW_CLI_VERSION__: release.version,
    __FLOW_CLI_SHA256__: release.sha256,
    ...(baseUrl ? { __FLOW_CLI_BASE_URL__: baseUrl.replace(/\/+$/, "") } : {}),
  };
  const template = readFileSync(new URL("./install.sh", import.meta.url), "utf8");
  // One pass, so a display name is never read as a placeholder. <NAME>_HOME is __FLOW_CLI_ENV___HOME.
  return template.replace(new RegExp(Object.keys(values).join("|"), "g"), (key) => values[key]!);
}

/** "my-cli" → "MY_CLI", as its <NAME>_HOME, <NAME>_CLI_URL and <NAME>_SERVER are named. */
function envName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new PackError(`${file} is missing or not JSON.`, 2);
  }
}

/** The CLI file's defineCli, imported as flow check imports it: from the agent's folder, where cliFile looks in the source. */
async function loadCli(dir: string, entry: string): Promise<CliConfig> {
  let loaded: { cli?: CliConfig };
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    loaded = await import(pathToFileURL(entry).href);
  } catch (error) {
    throw new PackError(`src/cli.ts did not load: ${(error as Error).message.split("\n")[0]}`, 2);
  } finally {
    process.chdir(cwd);
  }
  if (!loaded.cli || typeof loaded.cli.name !== "string") throw new PackError("src/cli.ts exports no cli (export const cli = defineCli({ ... })).", 2);
  return loaded.cli;
}

/** The folder's git commit, short, with .dirty when tracked files have changed. */
function commit(dir: string): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: dir, encoding: "utf8" }).trim();
    return `${sha}${dirty ? ".dirty" : ""}`;
  } catch {
    throw new PackError(`${dir} has no git commit: a CLI's version names the commit it was packed from. Commit the folder first.`, 2);
  }
}

async function loadEsbuild(): Promise<typeof import("esbuild")> {
  try {
    return await import("esbuild");
  } catch (error) {
    if ((error as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") throw error;
    const pin = (readJson(join(packageRoot(), "package.json")).peerDependencies as Record<string, string>).esbuild;
    throw new PackError(`flow cli pack bundles the CLI with esbuild: npm i -D esbuild@${pin}`, 2);
  }
}

/** Copies defineCli's files into the package at the same paths; returns their top-level names for package.json's files. */
function copyFiles(dir: string, staged: string, files: string[]): string[] {
  const top = new Set<string>();
  for (const name of files) {
    const path = normalize(name);
    const first = path.split(/[\\/]/)[0]!;
    if (isAbsolute(name) || first === ".." || first === "." || ["dist", "package.json", "node_modules"].includes(first)) {
      throw new PackError(`files names ${name}: each is a path inside the agent's folder, not dist, package.json or node_modules.`, 2);
    }
    if (!existsSync(join(dir, path))) throw new PackError(`files names ${name}, which is not in ${dir}.`, 2);
    cpSync(join(dir, path), join(staged, path), { recursive: true });
    top.add(first);
  }
  return [...top];
}

/**
 * The packed CLI's help, from a fresh folder with a fresh config, started through a link as npm
 * links a command: tests of the source cannot see a bundle that fails as it starts.
 */
async function smokeTest(staged: string, name: string): Promise<void> {
  const fresh = mkdtempSync(join(tmpdir(), "flow-cli-smoke-"));
  try {
    mkdirSync(join(fresh, "bin"));
    symlinkSync(join(staged, "dist", "cli.js"), join(fresh, "bin", name));
    let output: string;
    try {
      ({ stdout: output } = await promisify(execFile)(process.execPath, [join(fresh, "bin", name), "--help"], {
        cwd: fresh, encoding: "utf8", timeout: 30_000,
        env: { ...process.env, XDG_CONFIG_HOME: fresh, NO_COLOR: "1", AI_AGENT: "1" },
      }));
    } catch (error) {
      throw new PackError(`The packed CLI did not start: ${String((error as { stderr?: string }).stderr || (error as Error).message).trim().split("\n").slice(-5).join("\n")}`, 1);
    }
    if (!output.includes("USAGE")) {
      throw new PackError(`The packed CLI's --help printed no USAGE${output.trim() ? `: ${output.trim().split("\n").slice(0, 3).join(" / ")}` : " (nothing at all: does src/cli.ts run runCli when started through a link? Compare realpathSync(process.argv[1]) with fileURLToPath(import.meta.url))"}.`, 1);
    }
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}
