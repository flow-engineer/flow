// covers: testing/src/cli-pack.ts testing/src/install.sh testing/src/deploy.ts cli/src/commands.ts cli/src/run.ts
// `flow cli pack` against a fake cloud: an agent folder's CLI file bundled for the hosted address,
// what the bundle carries (server, version, update, files), the files written beside it, and the
// installer they make, run in a fresh home; then what pack refuses.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { cliReleaseCli } from "../testing/src/deploy.ts";
import { installer, type PackedCli } from "../testing/src/cli-pack.ts";
import { cliAgentFolder } from "./helpers.ts";

const scratch = mkdtempSync(join(tmpdir(), "flow-cli-pack-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** The cloud and the address the hosted agent is served from: one fake for both. */
let base = "";
let latest = "";
const calls: string[] = [];
before(async () => {
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`.trim());
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.url === "/v1/hosting/address?environment=staging") return send(200, { url: base });
    if (req.url === "/cli/version") return send(200, { version: latest, sha256: "", url: "", rolled_back_from: null });
    send(404, { error: { code: "not_found", message: "no such route" } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  server.unref();
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

/** Runs `flow cli ...`, keeping stdout and stderr apart. */
async function flowCli(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = await cliReleaseCli(argv, env);
    return { code, stdout: out.join("\n"), printed: [...out, ...err].join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** One staging pack, shared: packing takes a few seconds. */
let packed: Promise<{ dir: string; out: string; code: number; stdout: string; printed: string }> | undefined;
function packStaging() {
  packed ??= (async () => {
    const dir = cliAgentFolder(scratch);
    const out = join(dir, "release");
    return { dir, out, ...(await flowCli(["pack", "--server", "staging", "--dir", dir, "--json"], { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: base })) };
  })();
  return packed;
}

/** The package, unpacked into a fresh folder. */
function unpack(tgz: string): string {
  const into = mkdtempSync(join(scratch, "unpacked-"));
  execFileSync("tar", ["-xzf", tgz, "-C", into]);
  return join(into, "package");
}

const fresh = () => ({ ...process.env, XDG_CONFIG_HOME: mkdtempSync(join(scratch, "config-")), NO_COLOR: "1", AI_AGENT: "1" });

test("flow cli pack --server staging bundles the CLI for the hosted address: its server, version, update and files, beside install.sh and release.json", async () => {
  const { out, code, stdout, printed } = await packStaging();
  assert.equal(code, 0, printed);
  const answer = JSON.parse(stdout) as { ok: boolean; release: PackedCli; files: Record<string, string> };
  const tgz = join(out, "acme.tgz");
  const bytes = readFileSync(tgz);
  assert.match(answer.release.version, /^0\.1\.0-staging\.[0-9a-f]{7,}$/, "package.json's version, the server's name, the commit");
  assert.deepEqual(answer.release, { name: "acme", display_name: "Acme's Coffee", version: answer.release.version, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, server: `${base}/mcp` });
  assert.deepEqual(answer.files, { tgz, installer: join(out, "install.sh"), release: join(out, "release.json") });
  assert.deepEqual(JSON.parse(readFileSync(join(out, "release.json"), "utf8")), answer.release);
  assert.ok(calls.includes("GET /v1/hosting/address?environment=staging Bearer oci_key"), "the address is asked of the cloud with the CI key");

  const pkg = unpack(tgz);
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  assert.deepEqual([manifest.name, manifest.version, manifest.bin, manifest.files, manifest.engines], ["acme", answer.release.version, { acme: "dist/cli.js" }, ["dist", "context"], { node: ">=20.19" }]);
  assert.match(readFileSync(join(pkg, "dist", "cli.js"), "utf8"), /^#!\/usr\/bin\/env node\nimport \{ createRequire/);
  assert.ok(readdirSync(join(pkg, "dist")).length > 1, "lazy imports stay in chunks of their own");
  // From another folder: the description is read from context/about.txt beside the bundle (cliFile).
  // The fake cloud answers in this process: the CLI runs beside it, not blocking it.
  const run = async (...args: string[]) => (await promisify(execFile)(process.execPath, [join(pkg, "dist", "cli.js"), ...args], { cwd: scratch, env: fresh(), encoding: "utf8" })).stdout;
  const help = await run("--help");
  assert.match(help, /Coffee, ordered from a terminal\./);
  assert.match(help, new RegExp(`Server: ${base}/mcp`), "the hosted address in place of the CLI file's default");
  latest = answer.release.version;
  const update = await run("update");
  assert.equal(update, `acme ${answer.release.version} is the newest version.\n`, "its version is the release's, and update asks <base>/cli/version");
  const updateHelp = await run("update", "--help");
  assert.match(updateHelp, new RegExp(`Runs: curl -fsSL ${base} \\| sh`));

  const script = readFileSync(join(out, "install.sh"), "utf8");
  assert.match(script, /^BASE_URL="__FLOW_CLI_BASE_URL__"$/m, "the base URL is left for Flow's hosting to fill in");
  assert.match(script, new RegExp(`^SHA256="${answer.release.sha256}"$`, "m"));
  assert.match(script, /^DISPLAY_NAME='Acme'\\''s Coffee'$/m);
  assert.match(script, /PREFIX="\$\{ACME_HOME:-\$HOME\/\.\$NAME\}"/);
  assert.doesNotMatch(script, /__FLOW_CLI_(?!BASE_URL__)/);
  execFileSync("sh", ["-n", join(out, "install.sh")]);
});

// Packed, the discovery worker is the bundle's own file, which is also the CLI file: started for a
// background refresh, it must not run a command after the worker.
test("a packed CLI started as its discovery worker runs no command", async () => {
  const { out } = await packStaging();
  // Started by its real path, as the CLI starts it (run.ts).
  const worker = spawnSync(process.execPath, [realpathSync(join(unpack(join(out, "acme.tgz")), "dist", "cli.js")), "--flow-refresh-discovery"], { input: "{}", env: fresh(), encoding: "utf8", timeout: 20_000 });
  assert.deepEqual([worker.status, worker.stdout, worker.stderr], [0, "", ""]);
});

/** A home with the release served from a folder (file://), and a PATH of `bin` (writable), then node's, then the system's. */
function home(release: PackedCli, tgz: string, nodeDir = dirname(process.execPath)) {
  const root = mkdtempSync(join(scratch, "home-"));
  mkdirSync(join(root, "served", "cli"), { recursive: true });
  mkdirSync(join(root, "bin"));
  copyFileSync(tgz, join(root, "served", "cli", `${release.name}-${release.version}.tgz`));
  const script = join(root, "install.sh");
  writeFileSync(script, installer(release, pathToFileURL(join(root, "served")).href));
  const env = { HOME: root, PATH: `${join(root, "bin")}:${nodeDir}:/usr/bin:/bin`, SHELL: "/bin/zsh" };
  const install = () => spawnSync("sh", [script], { env, encoding: "utf8" });
  return { root, env, install };
}

test("install.sh installs the package into ~/.<name>, checked against its checksum, and links the command into a writable PATH folder", async () => {
  const { out } = await packStaging();
  const release = JSON.parse(readFileSync(join(out, "release.json"), "utf8")) as PackedCli;
  const { root, env, install } = home(release, join(out, "acme.tgz"));
  const first = install();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^Downloading the Acme's Coffee CLI\.\.\.\n/);
  assert.match(first.stdout, new RegExp(`Installed acme ${release.version.replaceAll(".", "\\.")} in ${root}/\\.acme/bin\\nNext: acme\\n$`));
  assert.equal(readlinkSync(join(root, "bin", "acme")), join(root, ".acme", "bin", "acme"));
  assert.match((await promisify(execFile)(join(root, "bin", "acme"), ["--help"], { env: { ...env, NO_COLOR: "1", AI_AGENT: "1" }, encoding: "utf8" })).stdout, /USAGE/);
  assert.equal(install().status, 0, "run again, it updates in place");
});

test("install.sh refuses before installing: a Node older than 20.19, a download whose checksum differs, another command of the name on PATH", async () => {
  const { out } = await packStaging();
  const release = JSON.parse(readFileSync(join(out, "release.json"), "utf8")) as PackedCli;
  const tgz = join(out, "acme.tgz");

  const oldNode = home(release, tgz, mkdtempSync(join(scratch, "node-")));
  const fake = join(oldNode.env.PATH.split(":")[1]!, "node");
  writeFileSync(fake, `#!/bin/sh\n[ "$1" = "-v" ] && echo v20.18.0\n[ "$1" = "-e" ] && exit 1\nexit 0\n`);
  chmodSync(fake, 0o755);
  writeFileSync(join(dirname(fake), "npm"), "#!/bin/sh\n");
  chmodSync(join(dirname(fake), "npm"), 0o755);
  const tooOld = oldNode.install();
  assert.equal(tooOld.status, 1);
  assert.match(tooOld.stderr, /^acme install: Node\.js 20\.19 or newer is needed; this is v20\.18\.0\. Update it from https:\/\/nodejs\.org/);

  const tampered = home({ ...release, sha256: "0".repeat(64) }, tgz);
  const differs = tampered.install();
  assert.equal(differs.status, 1);
  assert.match(differs.stderr, /is not acme .* \(its checksum differs\)\. Nothing was installed/);
  assert.ok(!existsSync(join(tampered.root, ".acme")));

  const taken = home(release, tgz);
  writeFileSync(join(taken.root, "bin", "acme"), "#!/bin/sh\n");
  chmodSync(join(taken.root, "bin", "acme"), 0o755);
  const other = taken.install();
  assert.equal(other.status, 1);
  assert.match(other.stderr, new RegExp(`Another acme installation is already on PATH at ${taken.root}/bin/acme`));
});

// The oldest Node the installer takes: the bundle targets it, and the framework's own code runs on it.
const NODE_20 = process.env.FLOW_TEST_NODE_20 ?? "/opt/homebrew/opt/node@20/bin/node";
test("the packed CLI installs and runs on Node 20.19", { skip: !existsSync(NODE_20) && `no Node 20 at ${NODE_20} (FLOW_TEST_NODE_20 names one)` }, async () => {
  const version = execFileSync(NODE_20, ["-v"], { encoding: "utf8" }).trim();
  assert.match(version, /^v20\.(19|[2-9]\d)\./);
  const { out } = await packStaging();
  const release = JSON.parse(readFileSync(join(out, "release.json"), "utf8")) as PackedCli;
  const { root, env, install } = home(release, join(out, "acme.tgz"), dirname(NODE_20));
  const installed = install();
  assert.equal(installed.status, 0, installed.stderr);
  const help = await promisify(execFile)(join(root, "bin", "acme"), ["--help"], { env: { ...env, NO_COLOR: "1", AI_AGENT: "1" }, encoding: "utf8" });
  assert.match(help.stdout, /USAGE[\s\S]*Coffee, ordered from a terminal\./);
});

test("pack refuses a CLI file whose default server the bundle does not have exactly once, and writes nothing", async () => {
  const dir = cliAgentFolder(scratch, { agent: "http://127.0.0.1:8790/mcp" });
  const { code, printed } = await flowCli(["pack", "--server", "https://mcp.acme.example/mcp", "--dir", dir]);
  assert.equal(code, 2);
  assert.match(printed, /src\/cli\.ts's default server "http:\/\/127\.0\.0\.1:8790\/mcp" must be written once, as a string, for pack to put https:\/\/mcp\.acme\.example\/mcp in its place; the bundle has it 2 times\./);
  assert.ok(!existsSync(join(dir, "release")));
});

test("pack refuses a CLI that does not start through a link, as npm installs it", async () => {
  const dir = cliAgentFolder(scratch, { guard: "process.argv[1] === fileURLToPath(import.meta.url)" });
  const { code, printed } = await flowCli(["pack", "--server", "https://mcp.acme.example/mcp", "--dir", dir]);
  assert.equal(code, 1);
  assert.match(printed, /The packed CLI's --help printed no USAGE \(nothing at all: does src\/cli\.ts run runCli when started through a link\? Compare realpathSync\(process\.argv\[1\]\)/);
});

test("an https --server makes a custom build; --base-url, where it is served from yourself, is written into install.sh", async () => {
  const dir = cliAgentFolder(scratch);
  const out = mkdtempSync(join(scratch, "out-"));
  const { code, stdout, printed } = await flowCli(["pack", "--server", "https://mcp.acme.example/mcp", "--base-url", "https://get.acme.example/", "--out", out, "--dir", dir, "--json"]);
  assert.equal(code, 0, printed);
  const { release } = JSON.parse(stdout) as { release: PackedCli };
  assert.match(release.version, /^0\.1\.0-custom\.[0-9a-f]{7,}$/);
  assert.equal(release.server, "https://mcp.acme.example/mcp");
  assert.match(readFileSync(join(out, "install.sh"), "utf8"), /^BASE_URL="https:\/\/get\.acme\.example"$/m);
  const help = execFileSync(process.execPath, [join(unpack(join(out, "acme.tgz")), "dist", "cli.js"), "update", "--help"], { env: fresh(), encoding: "utf8" });
  assert.match(help, /Runs: curl -fsSL https:\/\/get\.acme\.example \| sh/);
});

test("defineCli({ servers }) is what a pack for that environment uses, with no address asked; without a brand name the release is named by package.json's displayName", async () => {
  const dir = cliAgentFolder(scratch, { servers: { production: "https://cli.acme.example/mcp" }, brand: false });
  const before = calls.length;
  const { code, stdout, printed } = await flowCli(["pack", "--server", "production", "--dir", dir, "--json"], { FLOW_FRAMEWORK_CLOUD: base });
  assert.equal(code, 0, printed);
  const { release } = JSON.parse(stdout) as { release: PackedCli };
  assert.equal(release.server, "https://cli.acme.example/mcp");
  assert.match(release.version, /^0\.1\.0-production\./);
  assert.equal(release.display_name, "Acme Coffee");
  assert.equal(calls.length, before, "no CI key needed, no address asked");
});
