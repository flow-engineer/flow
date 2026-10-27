// covers: testing/src/deploy.ts src/traces.ts
// `flow deploy` (testing/src/deploy.ts) against a fake cloud: the CI key from the environment or
// the agent's .env, the folder packed without its secrets or dependencies, a deploy followed until
// live or refused, an agent on a newer Flow Framework than hosting's refused before the upload,
// and secrets sent with their names printed and their values never.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deployCli, logsCli, pack, parseEnv, sinceSeconds } from "../testing/src/deploy.ts";

interface Call {
  method: string;
  path: string;
  auth: string;
  body: Record<string, unknown> | null;
  bytes: number;
}

/** A fake cloud: the routes `flow deploy` calls, a deploy that builds once then ends as `ending`. */
async function cloud(options: { ending?: "live" | "refused"; address?: boolean; refuseSecret?: string; list?: boolean; logs?: boolean; neverDeployed?: boolean; framework?: string } = {}) {
  const calls: Call[] = [];
  let looks = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const path = req.url!;
    const isJson = String(req.headers["content-type"]).includes("json");
    calls.push({ method: req.method!, path, auth: String(req.headers.authorization), body: isJson && raw.length ? JSON.parse(raw.toString()) : null, bytes: raw.length });
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const env = (calls.find((c) => c.path === "/v1/hosting/deploys")?.body?.environment as string) ?? "production";
    const deploy = (status: string, id = "hdp_1") => ({ id, created_at: `2026-10-20T10:0${id.at(-1)}:00Z`, updated_at: `2026-10-20T10:0${id.at(-1)}:30Z`, environment: env, status, version: "abc123", error: null, findings: status === "refused" ? [{ level: "error", code: "ignores_host", message: "buildAgent does not pass host" }] : [{ level: "warning", code: "ignores_host", message: "state in memory" }] });
    if (req.method === "GET" && path === "/v1/hosting/framework" && options.framework) return send(200, { framework: { version: options.framework } });
    if (req.method === "POST" && path === "/v1/hosting/deploys") return send(201, { deploy: deploy("uploading"), upload_url: `${url}/upload/hdp_1` });
    if (req.method === "PUT" && path === "/upload/hdp_1") return send(200, {});
    if (req.method === "POST" && path === "/v1/hosting/deploys/hdp_1/start") return send(200, { deploy: deploy("building") });
    if (req.method === "GET" && path === "/v1/hosting/deploys/hdp_1") return send(200, { deploy: deploy(looks++ === 0 ? "building" : (options.ending ?? "live")) });
    if (req.method === "POST" && path === "/v1/hosting/promote") return send(201, { deploy: deploy("building") });
    if (req.method === "GET" && path.startsWith("/v1/hosting/address")) return options.address ? send(200, { url: "https://agent-staging.example.com" }) : send(404, { error: { code: "not_found", message: "no such route" } });
    if (req.method === "GET" && path.startsWith("/v1/hosting/deploys?")) {
      if (!options.list) return res.writeHead(404, { "content-type": "text/plain" }).end("404 page not found");
      return send(200, { deploys: [deploy("live", "hdp_1"), deploy("building", "hdp_2"), deploy("replaced", "hdp_0")] });
    }
    if (req.method === "GET" && path.startsWith("/v1/hosting/logs?")) {
      if (!options.logs) return res.writeHead(404, { "content-type": "text/plain" }).end("404 page not found");
      const after = new URL(path, url).searchParams.get("after");
      return send(200, after ? { lines: [{ time: "2026-10-20T10:00:02Z", severity: "ERROR", text: "second" }], next: "c2" } : { lines: [{ time: "2026-10-20T10:00:01Z", severity: "INFO", text: "first" }], next: "c1" });
    }
    if (req.method === "PUT" && path.startsWith("/v1/hosting/secrets/")) {
      const name = path.split("/").at(-1)!;
      // As the host: an agent exists once its first deploy is made.
      if (options.neverDeployed && !calls.some((c) => c.method === "POST" && c.path === "/v1/hosting/deploys")) return send(404, { error: { code: "not_found", message: "this agent has never been deployed" } });
      if (name === options.refuseSecret) return send(400, { error: { code: "invalid_request", message: `${name} is set by Flow` } });
      return send(200, { name, last4: "abcd" });
    }
    send(404, { error: { code: "not_found", message: "no such route" } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  server.unref();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls };
}

/** Runs the CLI, keeping stdout and stderr apart. */
async function run(argv: string[], env: NodeJS.ProcessEnv, stdin?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const options = { pollMs: 1, maxPolls: 2, now: () => Date.parse("2026-10-20T11:00:00Z"), readStdin: () => stdin ?? "" };
    const code = argv[0] === "logs" ? await logsCli(argv.slice(1), env, options) : await deployCli(argv, env, options);
    return { code, stdout: out.join("\n"), printed: [...out, ...err].join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function agentFolder(dotEnv?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "flow-deploy-test-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
  mkdirSync(join(dir, ".flow"));
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(join(dir, "package-lock.json"), "{}");
  writeFileSync(join(dir, "src", "agent.ts"), "export function buildAgent() {}");
  writeFileSync(join(dir, "node_modules", "dep", "index.js"), "");
  writeFileSync(join(dir, ".flow", "last-session.json"), "{}");
  writeFileSync(join(dir, ".env.local"), "X=1");
  if (dotEnv !== undefined) writeFileSync(join(dir, ".env"), dotEnv);
  return dir;
}

test("deploy packs the folder, uploads it, starts the build and follows it to live, with a Next line", async () => {
  const fake = await cloud({ address: true });
  const dir = agentFolder();
  const { code, printed } = await run(["--dir", dir, "--version", "abc123"], { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: fake.url });
  assert.equal(code, 0, printed);
  assert.deepEqual(fake.calls.map((c) => `${c.method} ${c.path.split("?")[0]}`), [
    "POST /v1/hosting/deploys",
    "PUT /upload/hdp_1",
    "POST /v1/hosting/deploys/hdp_1/start",
    "GET /v1/hosting/deploys/hdp_1",
    "GET /v1/hosting/deploys/hdp_1",
    "GET /v1/hosting/address",
  ]);
  assert.deepEqual(fake.calls[0]!.body, { environment: "staging", version: "abc123" });
  assert.ok(fake.calls.filter((c) => c.path.startsWith("/v1/")).every((c) => c.auth === "Bearer oci_key"));
  assert.equal(fake.calls[1]!.auth, "undefined", "the signed upload URL gets no key");
  assert.ok(fake.calls[1]!.bytes > 0);
  assert.match(printed, /building…/);
  assert.match(printed, /! ignores_host: state in memory/);
  assert.match(printed, /Live in staging\.\nURL: https:\/\/agent-staging\.example\.com\n/);
  assert.match(printed, /Next: .*npx @flow-engineer\/flow deploy promote/);
  assert.ok(!printed.includes("oci_key"), "the key is never printed");
});

test("deploy --json prints one answer on stdout; a cloud without the address route still works", async () => {
  const fake = await cloud();
  const dir = agentFolder(`FLOW_FRAMEWORK_CLOUD_KEY=oci_dotenv\nFLOW_FRAMEWORK_CLOUD=${fake.url}\n`);
  const { code, stdout } = await run(["--dir", dir, "--env", "production", "--json"], {});
  assert.equal(code, 0);
  const answer = JSON.parse(stdout);
  assert.equal(answer.ok, true);
  assert.equal(answer.deploy.status, "live");
  assert.equal(answer.deploy.environment, "production");
  assert.equal(answer.url, null);
  assert.match(answer.next, /Playground \(Production\)/);
  assert.equal(fake.calls[0]!.auth, "Bearer oci_dotenv", "the CI key from the agent's .env");
});

test("a refused deploy prints the lint's errors and exits 1", async () => {
  const fake = await cloud({ ending: "refused" });
  const { code, printed } = await run(["--dir", agentFolder(), "--env", "production"], { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: fake.url });
  assert.equal(code, 1);
  assert.match(printed, /✗ ignores_host: buildAgent does not pass host/);
  assert.match(printed, /Refused: fix the errors above/);
});

test("promote moves staging's live version to production", async () => {
  const fake = await cloud();
  const { code, printed } = await run(["promote", "--dir", agentFolder()], { CHINWAG_CLOUD_KEY: "oci_old", CHINWAG_CLOUD: fake.url });
  assert.equal(code, 0, printed);
  assert.equal(fake.calls[0]!.path, "/v1/hosting/promote");
  assert.equal(fake.calls[0]!.auth, "Bearer oci_old", "the older names still work");
});

test("no CI key, a missing file or a bad --env stop before any call", async () => {
  const fake = await cloud();
  assert.equal((await run(["--dir", agentFolder()], { FLOW_FRAMEWORK_CLOUD: fake.url })).code, 2);
  const bare = mkdtempSync(join(tmpdir(), "flow-deploy-bare-"));
  const missing = await run(["--dir", bare], { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: fake.url });
  assert.equal(missing.code, 2);
  assert.match(missing.printed, /package\.json is missing/);
  assert.equal((await run(["--env", "prod"], { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: fake.url })).code, 2);
  assert.equal(fake.calls.length, 0);
});

test("the packed folder leaves out node_modules, .git, every .env and .flow", () => {
  const dir = agentFolder("SECRET=1");
  execFileSync("git", ["init", "-q", dir]);
  const bundle = join(mkdtempSync(join(tmpdir(), "flow-deploy-pack-")), "agent.tgz");
  pack(dir, bundle);
  const files = execFileSync("tar", ["-tzf", bundle]).toString().split("\n").filter(Boolean);
  assert.ok(files.includes("./src/agent.ts") && files.includes("./package-lock.json"), files.join(" "));
  for (const left of ["node_modules", ".git", ".env", ".flow"]) assert.ok(!files.some((f) => f.startsWith(`./${left}`)), `${left} is left out: ${files.join(" ")}`);
});

test("secret NAME reads its value from stdin and prints only the last 4", async () => {
  const fake = await cloud();
  const { code, printed } = await run(["secret", "ANTHROPIC_API_KEY", "--env", "production"], { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: fake.url }, "sk-ant-secretvalue\n");
  assert.equal(code, 0, printed);
  assert.deepEqual(fake.calls[0]!.body, { environment: "production", value: "sk-ant-secretvalue" });
  assert.match(printed, /Saved ANTHROPIC_API_KEY \(••••abcd\) for production/);
  assert.ok(!printed.includes("sk-ant-secretvalue"));
  assert.equal((await run(["secret", "lower"], { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: fake.url }, "v")).code, 2);
  assert.equal((await run(["secret", "EMPTY"], { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: fake.url }, "")).code, 2);
});

test("secrets --from-env sends each value once, never the CI key or a name Flow sets, and prints names only", async () => {
  const fake = await cloud({ refuseSecret: "REFUSED_ONE" });
  const dir = agentFolder(
    [
      "# the agent's settings",
      "FLOW_FRAMEWORK_CLOUD_KEY=oci_fromdotenv",
      `FLOW_FRAMEWORK_CLOUD=${fake.url}`,
      'FLOW_MESSAGING_KEY="fk_test_messaging_value"',
      "export ANTHROPIC_API_KEY='sk-ant-value'   # comment",
      'MULTI="line\\nbreak"',
      "EMPTY=",
      "FLOW_STORE_TOKEN=never-sent",
      "FLOW_FRAMEWORK_TRACES_KEY=never-sent",
      "lower_case=never-sent",
      "REFUSED_ONE=refused-value",
    ].join("\n"),
  );
  const { code, printed, stdout } = await run(["secrets", "--from-env", "--dir", dir, "--json"], {});
  assert.equal(code, 1, "a refused one fails the command");
  const puts = fake.calls.filter((c) => c.method === "PUT");
  assert.deepEqual(puts.map((c) => c.path.split("/").at(-1)), ["FLOW_MESSAGING_KEY", "ANTHROPIC_API_KEY", "MULTI", "REFUSED_ONE"]);
  assert.deepEqual(puts.map((c) => c.body!.value), ["fk_test_messaging_value", "sk-ant-value", "line\nbreak", "refused-value"]);
  assert.ok(puts.every((c) => c.body!.environment === "staging" && c.auth === "Bearer oci_fromdotenv"));
  const answer = JSON.parse(stdout);
  assert.deepEqual(answer.saved, ["FLOW_MESSAGING_KEY", "ANTHROPIC_API_KEY", "MULTI"]);
  assert.deepEqual(answer.skipped.map((s: { name: string }) => s.name), ["FLOW_STORE_TOKEN", "FLOW_FRAMEWORK_TRACES_KEY", "lower_case"]);
  assert.equal(answer.refused[0].name, "REFUSED_ONE");
  for (const value of ["oci_fromdotenv", "fk_test_messaging_value", "sk-ant-value", "line\nbreak", "never-sent", "refused-value"]) assert.ok(!printed.includes(value), `${value} is never printed`);
});

test("parseEnv reads quotes, export and comments", () => {
  const env = parseEnv("export A='x # y'\nB=\"1\\n2\"\nC=plain  # note\n# D=no\nbad line");
  assert.deepEqual([...env], [["A", "x # y"], ["B", "1\n2"], ["C", "plain"]]);
});

test("deploy status lists each environment's live deploy, its version, when and its URL", async () => {
  const fake = await cloud({ list: true, address: true });
  const { code, printed } = await run(["status", "--env", "staging", "--dir", agentFolder()], { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: fake.url });
  assert.equal(code, 0, printed);
  assert.match(printed, /staging: live, version abc123, deploy hdp_1, deployed 2026-10-20T10:01:30Z/);
  assert.match(printed, /URL: https:\/\/agent-staging\.example\.com/);
  assert.match(printed, /then hdp_2 \(abc123\): building…/);
  assert.match(printed, /Next: npx @flow-engineer\/flow logs/);
});

test("deploy status on a Flow that lists deploys to members only: the last deploy this folder made", async () => {
  const fake = await cloud();
  const dir = agentFolder();
  const env = { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: fake.url };
  assert.equal((await run(["--dir", dir], env)).code, 0);
  const { code, stdout } = await run(["status", "--dir", dir, "--json"], env);
  assert.equal(code, 0);
  const answer = JSON.parse(stdout);
  assert.equal(answer.environments.staging.deploy.id, "hdp_1");
  assert.equal(answer.environments.staging.from, "this_folder");
  assert.equal(answer.environments.staging.url, null);
  assert.equal(answer.environments.production, null);
  const human = await run(["status", "--dir", dir], env);
  assert.match(human.printed, /URL: not available on this Flow yet/);
  assert.match(human.printed, /production: no deploy known \(this Flow lists deploys to a dashboard member only/);
});

test("logs prints the hosted agent's lines from --since, and --follow asks for the lines after them", async () => {
  const fake = await cloud({ logs: true });
  const env = { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: fake.url };
  const { code, stdout } = await run(["logs", "--since", "15m", "--follow", "--json", "--dir", agentFolder()], env);
  assert.equal(code, 0, stdout);
  assert.deepEqual(stdout.split("\n").map((l) => JSON.parse(l).text), ["first", "second"]);
  const asks = fake.calls.filter((c) => c.path.startsWith("/v1/hosting/logs")).map((c) => new URL(c.path, fake.url).searchParams);
  assert.equal(asks[0]!.get("since"), "2026-10-20T10:45:00.000Z");
  assert.equal(asks[0]!.get("environment"), "staging");
  assert.equal(asks[1]!.get("after"), "c1");
  assert.equal((await run(["logs", "--since", "soon"], env)).code, 2);
  assert.equal(sinceSeconds("2d"), 172800);
});

test("logs on a Flow without the logs route says it is not available yet", async () => {
  const fake = await cloud();
  const { code, stdout, printed } = await run(["logs", "--json", "--dir", agentFolder()], { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: fake.url });
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).error.code, "not_available");
  assert.match(printed, /Logs are not available on this Flow yet/);
});

const route = (calls: Call[]) => calls.map((c) => `${c.method} ${c.path.split("?")[0]}`);

test("a first deploy sends the .env's values as secrets before the build starts, printing names only", async () => {
  const fake = await cloud({ neverDeployed: true });
  const dir = agentFolder("FLOW_FRAMEWORK_CLOUD_KEY=oci_key\nANTHROPIC_API_KEY=sk-ant-secret-value\nFLOW_FRAMEWORK_TRACES_KEY=tk_1\nEMPTY=\n");
  const { code, printed } = await run(["--dir", dir, "--version", "v1"], { FLOW_FRAMEWORK_CLOUD: fake.url });
  assert.equal(code, 0, printed);
  assert.deepEqual(route(fake.calls).slice(0, 4), ["POST /v1/hosting/deploys", "PUT /v1/hosting/secrets/ANTHROPIC_API_KEY", "PUT /upload/hdp_1", "POST /v1/hosting/deploys/hdp_1/start"]);
  assert.deepEqual(fake.calls[1]!.body, { environment: "staging", value: "sk-ant-secret-value" });
  assert.match(printed, /Sent 1 secret from \.env to staging: ANTHROPIC_API_KEY\./);
  assert.ok(!printed.includes("sk-ant-secret-value") && !printed.includes("oci_key"), "no value is printed");
  const kept = readFileSync(join(dir, ".flow", "secrets.json"), "utf8");
  assert.ok(!kept.includes("sk-ant-secret-value") && kept.includes("ANTHROPIC_API_KEY"), "a hash per name, never the value");
  assert.doesNotMatch(printed, /secrets --from-env/);

  // The next deploy sends only what is new or changed.
  const again = await cloud();
  writeFileSync(join(dir, ".env"), "FLOW_FRAMEWORK_CLOUD_KEY=oci_key\nANTHROPIC_API_KEY=sk-ant-secret-value\nNEW_ONE=x\n");
  assert.equal((await run(["--dir", dir, "--version", "v2"], { FLOW_FRAMEWORK_CLOUD: again.url })).code, 0);
  assert.deepEqual(again.calls.filter((c) => c.path.startsWith("/v1/hosting/secrets/")).map((c) => c.path.split("/").at(-1)), ["NEW_ONE"]);
  const third = await cloud();
  writeFileSync(join(dir, ".env"), "FLOW_FRAMEWORK_CLOUD_KEY=oci_key\nANTHROPIC_API_KEY=changed\nNEW_ONE=x\n");
  assert.equal((await run(["--dir", dir, "--version", "v3"], { FLOW_FRAMEWORK_CLOUD: third.url })).code, 0);
  assert.deepEqual(third.calls.filter((c) => c.path.startsWith("/v1/hosting/secrets/")).map((c) => c.path.split("/").at(-1)), ["ANTHROPIC_API_KEY"]);
});

test("deploy --no-secrets sends none; a refused secret stops the deploy before it starts", async () => {
  const fake = await cloud();
  const dir = agentFolder("ANTHROPIC_API_KEY=sk-1\n");
  assert.equal((await run(["--dir", dir, "--no-secrets"], { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: fake.url })).code, 0);
  assert.ok(!fake.calls.some((c) => c.path.startsWith("/v1/hosting/secrets/")));

  const bad = await cloud({ refuseSecret: "OPENAI_API_KEY" });
  const other = agentFolder("OPENAI_API_KEY=sk-2\n");
  const { code, printed } = await run(["--dir", other], { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: bad.url });
  assert.equal(code, 1);
  assert.match(printed, /OPENAI_API_KEY could not be saved as a secret .*did not start/);
  assert.ok(!bad.calls.some((c) => c.path.endsWith("/start")));
  assert.ok(!printed.includes("sk-2"));
});

test("secrets --from-env before any deploy says why on stderr, points at flow deploy and exits 1", async () => {
  const fake = await cloud({ neverDeployed: true });
  const dir = agentFolder("ANTHROPIC_API_KEY=sk-1\n");
  const plain = await run(["secrets", "--from-env", "--dir", dir], { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: fake.url });
  assert.equal(plain.code, 1);
  assert.match(plain.printed, /Refused: this agent has not been deployed yet/);
  assert.match(plain.printed, /Next: npx @flow-engineer\/flow deploy \(it sends/);
  const json = await run(["secrets", "--from-env", "--dir", dir, "--json"], { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: fake.url });
  assert.equal(json.code, 1);
  const answer = JSON.parse(json.stdout);
  assert.equal(answer.ok, false);
  assert.equal(answer.refused[0].name, "ANTHROPIC_API_KEY");
  assert.ok(!json.printed.includes("sk-1"));
});

test("the version is the agent's version, the full commit, with +dirty and a warning when the folder has uncommitted changes", async () => {
  const dir = agentFolder();
  writeFileSync(join(dir, ".gitignore"), "node_modules\n.flow\n.env*\n");
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" }).toString().trim();
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  const sha = git("rev-parse", "HEAD");
  const clean = await cloud();
  assert.equal((await run(["--dir", dir], { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: clean.url })).code, 0);
  assert.equal(clean.calls[0]!.body!.version, sha);
  writeFileSync(join(dir, "src", "agent.ts"), "export function buildAgent() { return 1; }");
  const dirty = await cloud();
  const { printed } = await run(["--dir", dir], { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: dirty.url });
  assert.equal(dirty.calls[0]!.body!.version, `${sha}+dirty`);
  assert.match(printed, /deploying uncommitted changes; commit first so the version names what runs/);
  const named = await cloud();
  await run(["--dir", dir, "--version", "mine"], { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: named.url });
  assert.equal(named.calls[0]!.body!.version, "mine");
});

test("promote sends the .env's new or changed values to production first", async () => {
  const fake = await cloud();
  const dir = agentFolder("ANTHROPIC_API_KEY=sk-1\n");
  assert.equal((await run(["promote", "--dir", dir], { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: fake.url })).code, 0);
  assert.deepEqual(route(fake.calls).slice(0, 2), ["PUT /v1/hosting/secrets/ANTHROPIC_API_KEY", "POST /v1/hosting/promote"]);
  assert.equal(fake.calls[0]!.body!.environment, "production");
});

/** An agent folder whose package-lock.json pins @flow-engineer/flow at `version`. */
function lockedAt(version: string): string {
  const dir = agentFolder();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@flow-engineer/flow": `^${version}` } }));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/@flow-engineer/flow": { version } } }));
  return dir;
}

test("an agent locked to a newer Flow Framework line than hosting's is refused before anything is sent", async () => {
  const fake = await cloud({ framework: "0.4.11" });
  const dir = lockedAt("0.5.0");
  writeFileSync(join(dir, ".env"), "OPENROUTER_API_KEY=sk-or-1");
  const { code, stdout, printed } = await run(["--dir", dir, "--json"], { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: fake.url });
  assert.equal(code, 1, printed);
  assert.deepEqual(fake.calls.map((c) => `${c.method} ${c.path}`), ["GET /v1/hosting/framework"], "no deploy, secret or upload");
  const answer = JSON.parse(stdout);
  assert.equal(answer.error.code, "chinwag_too_new");
  assert.match(answer.error.message, /@flow-engineer\/flow 0\.5\.0; Flow hosts Flow Framework 0\.4\.x \(0\.4\.11\)/);
  assert.match(answer.next, /npm install @flow-engineer\/flow@0\.4\.11, then npx @flow-engineer\/flow deploy/);
});

test("the framework check deploys as before on the same line, or when the cloud does not say", async () => {
  for (const [framework, locked] of [["0.4.11", "0.4.12"], [undefined, "0.5.0"]] as const) {
    const fake = await cloud({ framework });
    const { code, printed } = await run(["--dir", lockedAt(locked), "--version", "abc123"], { FLOW_FRAMEWORK_CLOUD_KEY: "oci_key", FLOW_FRAMEWORK_CLOUD: fake.url });
    assert.equal(code, 0, printed);
    assert.deepEqual(fake.calls.slice(0, 2).map((c) => `${c.method} ${c.path}`), ["GET /v1/hosting/framework", "POST /v1/hosting/deploys"]);
  }
});
