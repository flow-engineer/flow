// `flow cli pack`: the agent's CLI file (src/cli.ts) as one installable package and the installer
// that installs it, for Flow's hosting (flow deploy, flow cli publish) or any static host:
//
//   release/<name>-<version>.tgz   the bundle (dist/cli.js and its chunks), the files the CLI file
//                                  names in `files`, and a package.json whose bin is <name>
//   release/<name>.tgz             the same file, for a link that always gets the newest
//   release/install.sh             the installer, which downloads the pinned .tgz and checks its sha256
//   release/version.json           { version, sha256, url }: what `<name> update` and its notice read
//
// The bundle is esbuild's, as ES modules with code splitting: flattened into one file, a module's
// top level can run before what it imports is ready (MCP's Zod schemas crashed Olostep's that way).
// Bundled CommonJS packages get a require. The server, the version and how to update are baked in
// (defineCli reads them: cli/src/commands.ts, __FLOW_CLI_PACK__), so the installed CLI needs no
// <NAME>_SERVER. Before packing, the package is installed into a scratch prefix the way the
// installer does it and run through its bin link with a fresh config folder: tests of the source
// never see a bundle that fails as it starts, or a main-module check that a symlinked bin defeats.

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { CliConfig } from "../../cli/src/commands.ts";
import { installScript } from "./cli-install.ts";

export interface PackOptions {
  /** The agent's folder: package.json and src/cli.ts. */
  dir: string;
  /** The MCP server the CLI talks to. */
  server: string;
  /** Where the release's files will be served from: install.sh, the .tgz files and version.json sit there. */
  baseUrl: string;
  /** Which build this is, in its version: staging, production or custom. */
  label: string;
  /** Where to write (default <dir>/release). */
  out?: string;
  /** Progress lines. */
  say?: (line: string) => void;
}

export interface Release {
  name: string;
  displayName: string;
  version: string;
  sha256: string;
  size: number;
  server: string;
  baseUrl: string;
  /** The files written, by role. */
  files: { tgz: string; latest: string; installer: string; versionJson: string };
}

/** Why a pack stopped: a sentence for the person, never a stack. */
export class PackError extends Error {}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const run = promisify(execFile);
const BUNDLE = "dist";

/** The URL a release's file is served at. */
export const fileUrl = (baseUrl: string, file: string) => `${baseUrl.replace(/\/+$/, "")}/${file}`;

/** `<package version>-<label>.<commit>`, `.dirty` when the folder has changes not committed; no commit outside git. */
export function releaseVersion(dir: string, packageVersion: string, label: string): string {
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).toString().trim();
  let commit = "";
  try {
    commit = git("rev-parse", "--short", "HEAD");
    if (git("status", "--porcelain", "--untracked-files=no", "--", ".")) commit += ".dirty";
  } catch {
    // not a repository, or no git
  }
  return `${packageVersion}-${label}${commit ? `.${commit}` : ""}`;
}

/** The oldest Node a package.json's engines allow, as [major, minor]; 22.18 (the framework's) when it does not say. */
export function oldestNode(engines: unknown): [number, number] {
  const range = (engines as { node?: unknown } | undefined)?.node;
  const m = typeof range === "string" ? /(\d+)(?:\.(\d+))?/.exec(range) : null;
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : [22, 18];
}

async function loadCli(file: string): Promise<CliConfig> {
  let loaded: Record<string, unknown>;
  try {
    loaded = await import(pathToFileURL(file).href);
  } catch (error) {
    throw new PackError(`src/cli.ts did not load: ${(error as Error).message.split("\n")[0]}`);
  }
  const cli = loaded.cli as CliConfig | undefined;
  if (!cli || typeof cli.name !== "string") throw new PackError("src/cli.ts exports no cli (export const cli = defineCli({ ... })).");
  return cli;
}

/** Packs the CLI; see the top of this file. */
export async function packCli(options: PackOptions): Promise<Release> {
  const say = options.say ?? (() => {});
  const dir = resolve(options.dir);
  const entry = join(dir, "src/cli.ts");
  if (!existsSync(entry)) throw new PackError(`No CLI file: ${entry} is missing (export const cli = defineCli({ ... })).`);
  if (!/^https?:\/\//.test(options.server)) throw new PackError(`The server is an address, http(s)://...: ${options.server}`);
  if (!/^https?:\/\//.test(options.baseUrl)) throw new PackError(`--base-url is an address, http(s)://...: ${options.baseUrl}`);
  let pkg: { name?: string; displayName?: string; version?: string; description?: string; engines?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    throw new PackError(`${join(dir, "package.json")} is missing or not JSON.`);
  }
  const cli = await loadCli(entry);
  const name = cli.name;
  if (!NAME.test(name)) throw new PackError(`The CLI's name, ${JSON.stringify(name)}, is not a command name: lowercase letters, digits and dashes.`);
  const displayName = cli.brand?.name ?? pkg.displayName ?? name;
  const files = cli.files ?? [];
  for (const file of files) {
    const at = normalize(file);
    if (isAbsolute(at) || at.startsWith("..") || at === "." || at.split(/[\\/]/)[0] === BUNDLE || at === "package.json") throw new PackError(`files: ${file} is not a path inside the package's folder (and not dist/ or package.json, which the pack writes).`);
    if (!existsSync(join(dir, at))) throw new PackError(`files: ${file} is missing.`);
  }

  let esbuild: typeof import("esbuild");
  try {
    esbuild = await import("esbuild");
  } catch {
    throw new PackError("flow cli pack bundles with esbuild, which is not installed here: npm i -D esbuild");
  }

  const version = releaseVersion(dir, pkg.version ?? "0.0.0", options.label);
  const out = resolve(options.out ?? join(dir, "release"));
  const work = mkdtempSync(join(tmpdir(), "flow-cli-pack-"));
  try {
    const staged = join(work, "package");
    const update = { command: `curl -fsSL ${fileUrl(options.baseUrl, "install.sh")} | sh`, latest: fileUrl(options.baseUrl, "version.json") };
    say(`Bundling ${relative(process.cwd(), entry) || entry} for ${options.server}...`);
    try {
      await esbuild.build({
        entryPoints: { cli: entry },
        bundle: true,
        splitting: true,
        format: "esm",
        platform: "node",
        target: `node${oldestNode(pkg.engines).join(".")}`,
        outdir: join(staged, BUNDLE),
        // Chunks beside cli.js, so import.meta.url points into the same folder from any of them.
        chunkNames: "[name]-[hash]",
        define: { __FLOW_CLI_PACK__: JSON.stringify({ server: options.server, version, update }) },
        banner: { js: "import { createRequire as __flowCreateRequire } from 'node:module'; const require = __flowCreateRequire(import.meta.url);" },
        logLevel: "silent",
      });
    } catch (error) {
      const first = (error as { errors?: Array<{ text: string; location?: { file: string; line: number } | null }> }).errors?.[0];
      throw new PackError(`The bundle failed: ${first ? `${first.location ? `${first.location.file}:${first.location.line}: ` : ""}${first.text}` : (error as Error).message}`);
    }
    // npm's bin link runs the file itself: without a #! line the shell would read it.
    const bundled = join(staged, BUNDLE, "cli.js");
    const code = readFileSync(bundled, "utf8");
    if (!code.startsWith("#!")) writeFileSync(bundled, `#!/usr/bin/env node\n${code}`);
    for (const file of files) {
      mkdirSync(dirname(join(staged, file)), { recursive: true });
      cpSync(join(dir, file), join(staged, file), { recursive: true });
    }
    writeFileSync(
      join(staged, "package.json"),
      `${JSON.stringify(
        {
          name,
          displayName,
          version,
          description: cli.description ?? pkg.description ?? `The ${displayName} CLI`,
          type: "module",
          bin: { [name]: `${BUNDLE}/cli.js` },
          files: [BUNDLE, ...files],
          ...(pkg.engines?.node ? { engines: { node: pkg.engines.node } } : {}),
        },
        null,
        2,
      )}\n`,
    );
    const packed = execFileSync("npm", ["pack", "--silent", "--pack-destination", work], { cwd: staged, encoding: "utf8" }).trim().split("\n").at(-1)!;
    const tgz = join(work, packed);
    await smokeTest(tgz, name, work);

    const bytes = readFileSync(tgz);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const pinned = `${name}-${version}.tgz`;
    mkdirSync(out, { recursive: true });
    const release: Release = {
      name,
      displayName,
      version,
      sha256,
      size: statSync(tgz).size,
      server: options.server,
      baseUrl: options.baseUrl.replace(/\/+$/, ""),
      files: { tgz: join(out, pinned), latest: join(out, `${name}.tgz`), installer: join(out, "install.sh"), versionJson: join(out, "version.json") },
    };
    renameSync(tgz, release.files.tgz);
    copyFileSync(release.files.tgz, release.files.latest);
    writeFileSync(release.files.installer, installScript({ name, displayName, url: fileUrl(options.baseUrl, pinned), sha256, version, node: oldestNode(pkg.engines) }), { mode: 0o755 });
    writeFileSync(release.files.versionJson, `${JSON.stringify({ version, sha256, url: fileUrl(options.baseUrl, pinned) })}\n`);
    return release;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Installs the package into a scratch prefix as install.sh does (npm install --global --prefix) and
 * runs `<name> --help` and `<name> auth status --help` through the bin link, outside the agent's
 * folder, with a fresh config folder and no network the CLI needs.
 */
async function smokeTest(tgz: string, name: string, work: string): Promise<void> {
  const prefix = join(work, "prefix");
  const home = join(work, "home");
  mkdirSync(home);
  try {
    await run("npm", ["install", "--global", "--prefix", prefix, tgz, "--silent", "--no-fund", "--no-audit", "--offline"], { cwd: work, timeout: 120_000 });
  } catch (error) {
    throw new PackError(`npm could not install the package: ${String((error as { stderr?: Buffer }).stderr ?? (error as Error).message).trim().split("\n")[0]}`);
  }
  const bin = join(prefix, "bin", name);
  for (const args of [["--help"], ["auth", "status", "--help"]]) {
    try {
      const { stdout: output } = await run(bin, args, {
        cwd: home,
        timeout: 20_000,
        env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), NO_COLOR: "1", AI_AGENT: "1", CI: "1" },
      });
      if (!output.trim()) throw new PackError(`The packed CLI printed nothing for ${name} ${args.join(" ")}. Does src/cli.ts run runCli when it is the program started (through a symlink, as npm installs it)?`);
    } catch (error) {
      if (error instanceof PackError) throw error;
      const why = String((error as { stderr?: string }).stderr || (error as Error).message).trim().split("\n").slice(0, 3).join("\n");
      throw new PackError(`The packed CLI failed as it started (${name} ${args.join(" ")}):\n${why}`);
    }
  }
}
