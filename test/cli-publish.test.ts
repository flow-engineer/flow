// covers: testing/src/deploy.ts testing/src/cli-pack.ts
// `flow cli publish|rollback|status`, and the CLI's part of `flow deploy` and promote, against a
// fake cloud (observe's /v1/hosting/cli routes and the deploy routes): the CLI packed for the
// environment's address, both files PUT to their signed URLs, the release made current, and what a
// deploy does when the CLI does not pack or the hosting serves no CLIs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { cliReleaseCli, deployCli } from "../testing/src/deploy.ts";
import { cliAgentFolder } from "./helpers.ts";

const scratch = mkdtempSync(join(tmpdir(), "flow-cli-publish-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

interface Call {
  method: string;
  path: string;
  auth: string;
  type: string;
  headers: string[];
  body: Record<string, unknown> | null;
  bytes: Buffer;
}

/**
 * The cloud, which also serves the agent's address. `firstDeploy`: no address until a deploy is
 * live. `cli`: what the CLI routes answer (default: as the host does). `stagingServer`: staging
 * serves a release packed for it (else nothing).
 */
async function cloud(options: { firstDeploy?: boolean; cli?: "off" | "version_exists"; stagingServer?: string } = {}) {
  const calls: Call[] = [];
  let live = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    const path = req.url!;
    const type = String(req.headers["content-type"] ?? "");
    calls.push({ method: req.method!, path, auth: String(req.headers.authorization), type, headers: Object.keys(req.headers), body: type.includes("json") && bytes.length ? JSON.parse(bytes.toString()) : null, bytes });
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const route = `${req.method} ${path.split("?")[0]}`;
    const environment = new URL(path, url).searchParams.get("environment") ?? (calls.at(-1)!.body?.environment as string | undefined) ?? "staging";
    const deploy = (status: string) => ({ id: "hdp_1", environment: calls.some((c) => c.path === "/v1/hosting/promote") ? "production" : "staging", status, version: "abc123", error: null, findings: [] });
    if (route === "GET /v1/hosting/address") return options.firstDeploy && !live ? send(404, { error: { code: "not_found", message: "not deployed" } }) : send(200, { url });
    if (route === "POST /v1/hosting/deploys") return send(201, { deploy: deploy("uploading"), upload_url: `${url}/upload/hdp_1` });
    if (route === "PUT /upload/hdp_1") return send(200, {});
    if (route === "POST /v1/hosting/deploys/hdp_1/start" || route === "POST /v1/hosting/promote") return send(201, { deploy: deploy("building") });
    if (route === "GET /v1/hosting/deploys/hdp_1") return (live = true), send(200, { deploy: deploy("live") });
    if (path.startsWith("/v1/hosting/cli/") && options.cli === "off") return send(404, { error: { code: "cli_off", message: "this Flow hosts no CLIs" } });
    const release = (body: Record<string, unknown>, status = "uploading") => ({ ...body, environment, status, created_at: "2026-10-28T12:00:00Z", published_at: status === "published" ? "2026-10-28T12:01:00Z" : null, published_by: status === "published" ? "ci:key_1" : null });
    const made = calls.find((c) => c.path === "/v1/hosting/cli/releases" && c.method === "POST")?.body ?? {};
    if (route === "POST /v1/hosting/cli/releases") {
      if (options.cli === "version_exists") return send(409, { error: { code: "version_exists", message: `${made.version} exists with another sha256` } });
      const { name, display_name, version, sha256, size } = made;
      return send(201, { release: release({ name, display_name, version, sha256, size }), uploads: { tgz: `${url}/upload/tgz`, installer: `${url}/upload/installer` } });
    }
    if (req.method === "PUT" && path.startsWith("/upload/")) return send(200, {});
    if (req.method === "POST" && /^\/v1\/hosting\/cli\/releases\/[^/]+\/publish$/.test(path)) {
      const { name, display_name, version, sha256, size } = made;
      return send(200, { release: release({ name, display_name, version, sha256, size }, "published"), current: { name, display_name, version, sha256, size, tgz: `${name}-${version}.tgz`, installer: `install-${version}.sh`, published_at: "2026-10-28T12:01:00Z", published_by: "ci:key_1", rolled_back_from: null } });
    }
    if (route === "POST /v1/hosting/cli/rollback") return send(200, { current: { name: "acme", display_name: "Acme's Coffee", version: "0.1.0-production.aaa1111", sha256: "ab", size: 1024, tgz: "", installer: "", published_at: "2026-10-27T09:00:00Z", published_by: "user:usr_1", rolled_back_from: "0.1.0-production.bbb2222" } });
    if (route === "GET /v1/hosting/cli/releases") {
      if (environment === "staging") return send(200, { current: options.stagingServer ? { name: "acme", display_name: "Acme's Coffee", version: "0.1.0-staging.aaa1111", sha256: "ab", size: 1024, tgz: "", installer: "", published_at: "2026-10-27T09:00:00Z", published_by: "ci:key_1", rolled_back_from: null, server: options.stagingServer } : null, releases: [] });
      return send(200, {
        current: { name: "acme", display_name: "Acme's Coffee", version: "0.1.0-production.bbb2222", sha256: "cd", size: 2048, tgz: "", installer: "", published_at: "2026-10-28T09:00:00Z", published_by: "ci:key_1", rolled_back_from: null },
        releases: [release({ name: "acme", display_name: "Acme's Coffee", version: "0.1.0-production.bbb2222", sha256: "cd", size: 2048 }, "published"), release({ name: "acme", display_name: "Acme's Coffee", version: "0.1.0-production.aaa1111", sha256: "ab", size: 1024 }, "published")],
      });
    }
    send(404, { error: { code: "not_found", message: "no such route" } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  server.unref();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: url };
  /** The calls in order, as "METHOD /path" without the query; not the packed CLI's own, to /mcp, as its --help is tried. */
  const routes = () => calls.map((c) => `${c.method} ${c.path.split("?")[0]}`).filter((r) => !r.endsWith(" /mcp"));
  return { url, env, calls, routes };
}

/** Runs `flow cli ...` or `flow deploy ...`, keeping stdout and stderr apart. */
async function flow(top: "cli" | "deploy", argv: string[], env: NodeJS.ProcessEnv) {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = top === "cli" ? await cliReleaseCli(argv, env) : await deployCli(argv, env, { pollMs: 1 });
    return { code, stdout: out.join("\n"), printed: [...out, ...err].join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const PUBLISH = ["GET /v1/hosting/address", "GET /v1/hosting/cli/releases", "POST /v1/hosting/cli/releases", "PUT /upload/tgz", "PUT /upload/installer"];

test("flow cli publish packs the CLI for the environment's address, PUTs the package and installer to their signed URLs with no key, and makes it current", async () => {
  const fake = await cloud();
  const dir = cliAgentFolder(scratch);
  const { code, stdout, printed } = await flow("cli", ["publish", "--env", "staging", "--dir", dir, "--json"], fake.env);
  assert.equal(code, 0, printed);
  const answer = JSON.parse(stdout);
  const version = answer.release.version as string;
  assert.match(version, /^0\.1\.0-staging\.[0-9a-f]{7,}$/);
  assert.deepEqual(fake.routes(), [...PUBLISH, `POST /v1/hosting/cli/releases/${version}/publish`]);
  const [, , create, tgz, installer, publish] = fake.calls.filter((c) => c.path !== "/mcp");
  assert.deepEqual(create!.body, { environment: "staging", name: "acme", display_name: "Acme's Coffee", version, sha256: answer.current.sha256, size: tgz!.bytes.length, server: `${fake.url}/mcp` });
  assert.deepEqual(publish!.body, { environment: "staging" });
  assert.ok([fake.calls[0], create, publish].every((c) => c!.auth === "Bearer oci_key"));
  assert.ok([tgz, installer].every((c) => c!.auth === "undefined" && !c!.headers.some((h) => h.startsWith("x-goog"))), "the signed URLs get no key, and no x-goog headers");
  assert.deepEqual([tgz!.type, installer!.type], ["application/gzip", "text/x-shellscript; charset=utf-8"]);
  assert.match(installer!.bytes.toString(), new RegExp(`^SHA256="${answer.current.sha256}"$`, "m"));
  assert.equal(answer.install, `curl -fsSL ${fake.url} | sh`);
  assert.equal(answer.current.rolled_back_from, null);
  assert.match(printed, new RegExp(`Published acme ${version.replaceAll(".", "\\.")} to staging \\(\\d+ KB\\)\\. curl -fsSL ${fake.url} \\| sh`));
});

test("publish says what to do when the version exists with other contents, or when this Flow's hosting serves no CLIs", async () => {
  const dir = cliAgentFolder(scratch);
  const exists = await flow("cli", ["publish", "--env", "production", "--dir", dir, "--json"], (await cloud({ cli: "version_exists" })).env);
  assert.equal(exists.code, 1);
  assert.deepEqual(JSON.parse(exists.stdout).next, "commit the changes and publish again: a new commit is a new version");
  assert.equal(JSON.parse(exists.stdout).error.code, "version_exists");
  const off = await flow("cli", ["publish", "--env", "production", "--dir", dir], (await cloud({ cli: "off" })).env);
  assert.equal(off.code, 1);
  assert.match(off.printed, /^This Flow's hosting serves no CLIs \(cli_off\)\. npx @flow-engineer\/flow cli pack --server <url> --base-url <url> packs one to serve yourself\.$/m);
});

test("rollback serves an earlier version again, saying who is offered it; status shows what each environment serves and its releases", async () => {
  const fake = await cloud();
  const back = await flow("cli", ["rollback", "--env", "production", "0.1.0-production.aaa1111"], fake.env);
  assert.equal(back.code, 0, back.printed);
  assert.deepEqual(fake.calls[0]!.body, { environment: "production", version: "0.1.0-production.aaa1111" });
  assert.match(back.printed, /^production serves acme 0\.1\.0-production\.aaa1111 again, in place of 0\.1\.0-production\.bbb2222: people on 0\.1\.0-production\.bbb2222 are offered 0\.1\.0-production\.aaa1111 by acme update\.$/m);

  const status = await flow("cli", ["status"], fake.env);
  assert.equal(status.code, 0, status.printed);
  assert.deepEqual(fake.routes().slice(1), ["GET /v1/hosting/cli/releases", "GET /v1/hosting/cli/releases"]);
  assert.equal(status.printed.split("\nNext:")[0], [
    "staging: no CLI published.",
    "production: acme 0.1.0-production.bbb2222, published 2026-10-28T09:00:00Z by ci:key_1",
    "  0.1.0-production.bbb2222  2 KB  published 2026-10-28T12:01:00Z  (current)",
    "  0.1.0-production.aaa1111  1 KB  published 2026-10-28T12:01:00Z",
  ].join("\n"));
  const json = JSON.parse((await flow("cli", ["status", "--env", "production", "--json"], fake.env)).stdout);
  assert.deepEqual(Object.keys(json.environments), ["production"]);
  assert.equal(json.environments.production.releases.length, 2);
});

test("flow deploy with a CLI file publishes the CLI once live; before the environment's first deploy it is packed then", async () => {
  const fake = await cloud({ firstDeploy: true });
  const dir = cliAgentFolder(scratch);
  const { code, stdout, printed } = await flow("deploy", ["--dir", dir, "--version", "abc123", "--json"], fake.env);
  assert.equal(code, 0, printed);
  const answer = JSON.parse(stdout);
  assert.deepEqual(fake.routes(), [
    "GET /v1/hosting/address",
    "POST /v1/hosting/deploys", "PUT /upload/hdp_1", "POST /v1/hosting/deploys/hdp_1/start", "GET /v1/hosting/deploys/hdp_1",
    "GET /v1/hosting/address",
    ...PUBLISH, `POST /v1/hosting/cli/releases/${answer.cli.release.version}/publish`,
  ]);
  assert.equal(answer.ok, true);
  assert.equal(answer.cli.published, true);
  assert.equal(answer.cli.install, `curl -fsSL ${fake.url} | sh`);
  assert.match(printed, /Live in staging\.\nURL: .*\n(.*\n)*Published acme .* to staging/);
});

test("a CLI that does not pack stops flow deploy before anything is sent; --no-cli deploys without it", async () => {
  const fake = await cloud();
  const dir = cliAgentFolder(scratch, { agent: "http://127.0.0.1:8790/mcp" });
  const stopped = await flow("deploy", ["--dir", dir, "--version", "abc123"], fake.env);
  assert.equal(stopped.code, 2);
  assert.match(stopped.printed, /^The CLI did not pack, so nothing was sent: src\/cli\.ts's default server .* 2 times\.\nNext: fix it, or add --no-cli$/m);
  assert.deepEqual(fake.routes(), ["GET /v1/hosting/address"]);

  const without = await flow("deploy", ["--dir", dir, "--version", "abc123", "--no-cli", "--json"], fake.env);
  assert.equal(without.code, 0, without.printed);
  assert.equal(JSON.parse(without.stdout).cli, null);
  assert.ok(!fake.routes().some((r) => r.includes("/cli/")));
});

test("on a Flow whose hosting serves no CLIs, flow deploy goes live without publishing it and says so", async () => {
  const fake = await cloud({ cli: "off" });
  const { code, stdout, printed } = await flow("deploy", ["--dir", cliAgentFolder(scratch), "--version", "abc123", "--json"], fake.env);
  assert.equal(code, 0, printed);
  assert.deepEqual(JSON.parse(stdout).cli, { published: false, code: "cli_off", message: "This Flow's hosting serves no CLIs yet: the CLI was not published." });
  assert.match(printed, /This Flow's hosting serves no CLIs yet: the CLI was not published\./);
});

test("promote publishes a production build of the CLI from the folder once live", async () => {
  const fake = await cloud();
  const { code, stdout, printed } = await flow("deploy", ["promote", "--dir", cliAgentFolder(scratch), "--json"], fake.env);
  assert.equal(code, 0, printed);
  const answer = JSON.parse(stdout);
  assert.match(answer.cli.release.version, /^0\.1\.0-production\./);
  assert.equal(fake.calls.find((c) => c.path === "/v1/hosting/cli/releases")!.body!.environment, "production");
  assert.ok(fake.routes().indexOf("POST /v1/hosting/promote") < fake.routes().indexOf("POST /v1/hosting/cli/releases"), "published once production is live");
});

test("publish --server packs for a domain of the agent's own: a custom build, installed from that domain", async () => {
  const fake = await cloud();
  const { code, stdout, printed } = await flow("cli", ["publish", "--env", "production", "--server", "https://cli.acme.example/mcp", "--dir", cliAgentFolder(scratch), "--json"], fake.env);
  assert.equal(code, 0, printed);
  const answer = JSON.parse(stdout);
  assert.match(answer.release.version, /^0\.1\.0-custom\./);
  assert.equal(answer.install, "curl -fsSL https://cli.acme.example | sh");
  assert.ok(!fake.routes().includes("GET /v1/hosting/address"), "the environment's address is not asked");
  assert.equal(fake.calls.find((c) => c.path === "/v1/hosting/cli/releases")!.body!.environment, "production");
});

test("publish refuses a build whose server differs from the one served, since everyone would sign in again; --change-server publishes it, and flow deploy goes on without it", async () => {
  const fake = await cloud({ stagingServer: "https://cli.acme.example/mcp" });
  const dir = cliAgentFolder(scratch);
  const refused = await flow("cli", ["publish", "--env", "staging", "--dir", dir, "--json"], fake.env);
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.stdout).error.code, "server_changed");
  assert.match(refused.printed, new RegExp(`staging's CLI uses https://cli\\.acme\\.example/mcp, and this build ${fake.url}/mcp: everyone who installed it would have to sign in again\\. To keep https://cli\\.acme\\.example/mcp, set defineCli\\(\\{ servers: \\{ staging: "https://cli\\.acme\\.example/mcp" \\} \\}\\) in src/cli\\.ts; to change it on purpose, npx @flow-engineer/flow cli publish --env staging --change-server`));
  assert.ok(!fake.routes().includes("POST /v1/hosting/cli/releases"), "nothing was made");

  const deployed = await flow("deploy", ["--dir", dir, "--version", "abc123", "--json"], fake.env);
  assert.equal(deployed.code, 0, deployed.printed);
  assert.equal(JSON.parse(deployed.stdout).cli.code, "server_changed");
  assert.match(deployed.printed, /^Warning: the CLI was not published\. staging's CLI uses https:\/\/cli\.acme\.example\/mcp/m);

  const changed = await flow("cli", ["publish", "--env", "staging", "--change-server", "--dir", dir], fake.env);
  assert.equal(changed.code, 0, changed.printed);
  assert.ok(fake.routes().includes("POST /v1/hosting/cli/releases"));
});
