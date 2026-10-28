// covers: testing/src/cli-pack.ts testing/src/cli-install.ts cli/src/commands.ts examples/cafe/src/cli.ts
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mcp } from "../examples/cafe/src/mcp.ts";
import { packCli, PackError } from "../testing/src/cli-pack.ts";

const cafe = fileURLToPath(new URL("../examples/cafe", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "flow-cli-pack-test-"));
const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
  rmSync(work, { recursive: true, force: true });
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test("a packed CLI installs with its install.sh from a clean prefix, with no environment variables, and talks to the server it was packed for", async () => {
  const server = `${await listen((req, res) => void mcp.node(req, res))}/mcp`;
  const out = join(work, "release");
  // A static host for the release folder at /cli/.
  const files = await listen((req, res) => {
    const file = join(out, basename(req.url ?? ""));
    if (!req.url?.startsWith("/cli/") || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200);
    createReadStream(file).pipe(res);
  });
  const release = await packCli({ dir: cafe, server, baseUrl: `${files}/cli`, label: "staging", out });
  assert.match(release.version, /^0\.1\.0-staging(\.[0-9a-f]+(\.dirty\.[0-9a-z]+)?)?$/);
  assert.deepEqual(JSON.parse(readFileSync(release.files.versionJson, "utf8")), { version: release.version, sha256: release.sha256, url: `${files}/cli/cafe-${release.version}.tgz` });

  const home = join(work, "home");
  const bin = join(work, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  // Only a writable folder, node and npm, and the system's tools on PATH; nothing of this checkout's.
  const env = { HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, SHELL: "/bin/zsh" };
  // Piped, as curl | sh runs it; not spawnSync, which would stop this process's file server.
  const installed = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("sh", [], { env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(readFileSync(release.files.installer));
  });
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /Downloading the Pip CLI\.\.\./);
  assert.match(installed.stdout, new RegExp(`Installed the Pip CLI ${release.version.replaceAll(".", "\\.")} in `));
  assert.equal(existsSync(join(home, ".zshrc")), false, "a writable PATH folder needs no rc line");

  const { stdout } = await promisify(execFile)(join(bin, "cafe"), ["menu", "--json"], { cwd: home, env, timeout: 30_000 });
  const menu = JSON.parse(stdout);
  assert.ok(JSON.stringify(menu).includes("Latte"), "the installed CLI read the menu from the server it was packed for");
});

test("a pack refuses what would not run installed: a file it cannot ship, and a CLI that does nothing through npm's bin link", async () => {
  // One folder per case: Node keeps a module it imported, so a rewritten src/cli.ts would not be read again.
  let cases = 0;
  const pack = async (body: string) => {
    const dir = join(work, `agent-${++cases}`);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "acme", version: "1.0.0", type: "module" }));
    writeFileSync(join(dir, "src/cli.ts"), `import { defineCli } from ${JSON.stringify(fileURLToPath(new URL("../cli/src/index.ts", import.meta.url)))};\nexport const cli = defineCli(${body});\n`);
    return packCli({ dir, server: "https://acme.test/mcp", baseUrl: "https://acme.test/cli", label: "custom", out: join(dir, "release") });
  };

  await assert.rejects(pack(`{ name: "acme", files: ["context/catalog.json"] }`), (e: unknown) => e instanceof PackError && /files: context\/catalog\.json is missing/.test(e.message));
  await assert.rejects(pack(`{ name: "acme", files: ["../secrets.json"] }`), (e: unknown) => e instanceof PackError && /not a path inside the package's folder/.test(e.message));
  // Exports a cli but never runs it: installed, the command would print nothing.
  await assert.rejects(pack(`{ name: "acme" }`), (e: unknown) => e instanceof PackError && /printed nothing for acme --help/.test(e.message));
});
