// covers: testing/src/cli.ts testing/src/conversations.ts testing/src/templates.ts testing/src/deploy.ts testing/src/show.ts testing/src/cloud-call.ts testing/src/pull.ts testing/src/account.ts testing/src/projects.ts testing/src/chat.ts testing/src/check-endpoint.ts testing/src/check.ts
// With --json, stdout carries exactly one JSON document on every failure, as a coding agent parses it
// (json.load(stdout)): a wrong flag, no key, a refused key, a missing route, an unreachable cloud, a
// value that cannot be read; flow test's report too; never text, never two documents. And a long answer reaches the reader
// whole: the CLI exits only once stdout has taken it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../testing/src/cli.ts", import.meta.url));
const FLOW_KEY = "flow_test_k1_flowkeysecret9Az1";
const CI_KEY = "oci_cikeysecretvalue7Qw2";

/** The flow command in dir with nothing from this machine's environment but PATH and HOME; its exit and both streams. */
async function flow(args: string[], dir: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((done) => child.on("close", done));
  return { code, stdout, stderr };
}

/** A cloud that refuses every key, has one conversation route answering 404, no logs or restart route, and a 3 MB conversation. */
async function cloud() {
  const big = { conversation: { id: "cnv_big" }, messages: Array.from({ length: 3000 }, (_, i) => ({ id: `m${i}`, role: "agent", text: "x".repeat(1000), tools: [], grade: null })) };
  const http = createServer((req, res) => {
    const json = (status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const path = req.url!.split("?")[0]!;
    if (path === "/v1/agent/conversations/cnv_big") return json(200, big);
    if (path === "/v1/agent/conversations/cnv_x") return json(404, { error: { code: "not_found", message: "No conversation cnv_x for this agent." } });
    if (path.startsWith("/v1/agent/") || path === "/v1/hosting/deploys") return json(401, { error: { code: "bad_key", message: "not an agent key (a trace key or messaging key does not read here)" } });
    res.writeHead(404, { "content-type": "text/plain" }).end("404 page not found");
  });
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, big, close: () => { http.closeAllConnections(); http.close(); } };
}

/** An address nothing listens on. */
async function closedAddress(): Promise<string> {
  const http = createServer();
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  await new Promise<void>((done) => http.close(() => done()));
  return url;
}

/** An agent's folder with what flow deploy needs, and a .env of `lines`. */
function agentFolder(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "flow-cli-json-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(join(dir, "package-lock.json"), "{}");
  writeFileSync(join(dir, "src", "agent.ts"), "export function buildAgent() {}");
  writeFileSync(join(dir, ".env"), lines.map((l) => `${l}\n`).join(""));
  return dir;
}

test("every --json failure prints exactly one JSON document on stdout, { ok: false, error: { code, message }, next }, and never a key", { timeout: 120_000 }, async () => {
  const fake = await cloud();
  const nowhere = await closedAddress();
  try {
    const keyed = agentFolder([`FLOW_KEY=${FLOW_KEY}`, `FLOW_FRAMEWORK_CLOUD_KEY=${CI_KEY}`, `FLOW_FRAMEWORK_CLOUD=${fake.url}`]);
    const bare = agentFolder([]);
    const cases: Array<{ args: string[]; dir: string; exit: number; code: string }> = [
      { args: ["conversations", "--bogus", "--json"], dir: keyed, exit: 2, code: "usage" },
      { args: ["conversations", "--json"], dir: bare, exit: 1, code: "no_flow_key" },
      // --env is taken, as every cloud command takes it; the key is refused.
      { args: ["conversations", "--env", "staging", "--json"], dir: keyed, exit: 1, code: "bad_key" },
      { args: ["conversations", "show", "cnv_x", "--env", "staging", "--json"], dir: keyed, exit: 1, code: "not_found" },
      // As a coding agent asked it of 0.15.6, which answered usage text on stdout and exit 0.
      { args: ["conversations", "show", "cnv_x", "--environment", "production", "--json"], dir: keyed, exit: 1, code: "not_found" },
      { args: ["conversations", "show", "cnv_x", "--grade", "wrong", "--json"], dir: keyed, exit: 2, code: "usage" },
      { args: ["conversations", "show", "--json"], dir: keyed, exit: 2, code: "usage" },
      { args: ["conversations", "--json", "--cloud", nowhere], dir: keyed, exit: 1, code: "network" },
      { args: ["issues", "--environment", "production", "--json"], dir: keyed, exit: 1, code: "bad_key" },
      { args: ["templates", "--json"], dir: keyed, exit: 1, code: "bad_key" },
      { args: ["deploy", "status", "--json"], dir: bare, exit: 2, code: "no_ci_key" },
      { args: ["deploy", "status", "--environment", "qa", "--json"], dir: keyed, exit: 2, code: "usage" },
      { args: ["deploy", "status", "--json"], dir: keyed, exit: 1, code: "bad_key" },
      { args: ["deploy", "secret", "TOKEN", "--json"], dir: keyed, exit: 2, code: "usage" },
      { args: ["deploy", "restart", "--env", "production", "--json"], dir: keyed, exit: 1, code: "not_available" },
      { args: ["deploy", "--json", "--cloud", nowhere], dir: keyed, exit: 1, code: "network" },
      { args: ["logs", "--json"], dir: keyed, exit: 1, code: "not_available" },
      { args: ["logs", "--since", "40d", "--json"], dir: keyed, exit: 2, code: "usage" },
      { args: ["logs", "--bogus", "--json"], dir: keyed, exit: 2, code: "usage" },
      { args: ["show", "last", "--json"], dir: keyed, exit: 1, code: "not_shown" },
      // 0.16.0's release candidate: test pull's refusals went to stderr only, stdout empty.
      { args: ["test", "pull", "--dry-run", "--json"], dir: keyed, exit: 1, code: "bad_key" },
      { args: ["test", "pull", "--json"], dir: bare, exit: 1, code: "no_ci_key" },
      { args: ["test", "pull", "extra", "--json"], dir: keyed, exit: 1, code: "usage" },
      { args: ["chat", "--bogus", "--json"], dir: keyed, exit: 1, code: "usage" },
      { args: ["chat", "--json"], dir: keyed, exit: 1, code: "not_built" },
      { args: ["check", "--json"], dir: mkdtempSync(join(tmpdir(), "flow-cli-json-empty-")), exit: 1, code: "no_agent" },
      { args: ["check-endpoint", "--json"], dir: keyed, exit: 1, code: "usage" },
      { args: ["check-endpoint", "--bogus", "--json"], dir: keyed, exit: 1, code: "usage" },
      { args: ["cli", "pack", "--bogus", "--json"], dir: keyed, exit: 2, code: "usage" },
      { args: ["login", "--bogus", "--json"], dir: keyed, exit: 1, code: "usage" },
      { args: ["logout", "--bogus", "--json"], dir: keyed, exit: 1, code: "usage" },
      { args: ["whoami", "--json"], dir: keyed, exit: 1, code: "not_signed_in" },
      { args: ["setup", "--bogus", "--json"], dir: keyed, exit: 1, code: "usage" },
      { args: ["setup", "--json"], dir: keyed, exit: 1, code: "not_signed_in" },
      { args: ["setup", "--live", "--ci", "--json"], dir: keyed, exit: 1, code: "usage" },
      { args: ["link", "--channel", "fax", "--json"], dir: keyed, exit: 1, code: "usage" },
      { args: ["status", "--bogus", "--json"], dir: keyed, exit: 1, code: "usage" },
      { args: ["keys", "--bogus", "--json"], dir: keyed, exit: 1, code: "usage" },
      { args: ["keys", "--json"], dir: keyed, exit: 1, code: "not_signed_in" },
      { args: ["keys", "show", "short", "--json"], dir: keyed, exit: 1, code: "usage" },
      { args: ["keys", "grant", "content", "--json"], dir: bare, exit: 1, code: "no_live_key" },
      { args: ["keys", "revoke", "abcdefghij", "--json"], dir: keyed, exit: 1, code: "not_signed_in" },
      { args: ["projects", "list", "--bogus", "--json"], dir: keyed, exit: 1, code: "usage" },
      { args: ["projects", "delete", "x", "--json"], dir: keyed, exit: 1, code: "not_signed_in" },
      { args: ["issues", "test-case", "--json"], dir: keyed, exit: 2, code: "usage" },
      { args: ["insights", "show", "--json"], dir: keyed, exit: 2, code: "usage" },
    ];
    // Every command the help lists with --json has a case here, so a new one cannot skip the rule.
    const help = await flow(["--help"], bare);
    const listed = new Set(help.stdout.split("\n").map((line) => /^ {2}flow ((?:[a-z-]+)(?: (?:[a-z-]+|--live))?)(?= |$).*--json/.exec(line)?.[1]).filter((c): c is string => Boolean(c)));
    assert.ok(listed.size >= 20, [...listed].join(", "));
    for (const command of listed) assert.ok(cases.some((c) => c.args.join(" ").startsWith(`${command} `) || c.args.join(" ") === command), `no --json failure case for flow ${command}`);
    // Eight at a time: each case is a fresh node process, and one after another passed the minute under a full run's load.
    const runs = new Map<(typeof cases)[number], Awaited<ReturnType<typeof flow>>>();
    for (let i = 0; i < cases.length; i += 8) await Promise.all(cases.slice(i, i + 8).map(async (c) => runs.set(c, await flow(c.args, c.dir))));
    for (const c of cases) {
      const run = runs.get(c)!;
      const what = `flow ${c.args.join(" ")}: ${JSON.stringify(run)}`;
      assert.equal(run.code, c.exit, what);
      assert.equal(run.stdout.trim().split("\n").length, 1, `one line: ${what}`);
      const document = JSON.parse(run.stdout);
      assert.equal(document.ok, false, what);
      assert.equal(document.error.code, c.code, what);
      assert.equal(typeof document.error.message, "string", what);
      assert.ok("next" in document, what);
      assert.ok(!(run.stdout + run.stderr).includes(FLOW_KEY) && !(run.stdout + run.stderr).includes(CI_KEY), `no key printed: ${what}`);
    }
  } finally { fake.close(); }
});

test("flow test --json reports an agent that does not load as its one document, and takes --env", { timeout: 30_000 }, async () => {
  const fake = await cloud();
  try {
    const dir = agentFolder([`FLOW_FRAMEWORK_CLOUD_KEY=${CI_KEY}`, `FLOW_FRAMEWORK_CLOUD=${fake.url}`]);
    writeFileSync(join(dir, "src", "agent.ts"), "export const = broken;\n");
    const run = await flow(["test", "--synthetic", "--env", "staging", "--json"], dir);
    assert.equal(run.code, 1, run.stderr);
    assert.equal(run.stdout.trim().split("\n").length, 1);
    const report = JSON.parse(run.stdout);
    assert.equal(report.outcome, "invalid");
    assert.match(report.error.message, /^src\/agent\.ts could not be loaded: /);
  } finally { fake.close(); }
});

test("a refused key's error names the key the command reads, where it was found, by prefix and last 4", { timeout: 15_000 }, async () => {
  const fake = await cloud();
  try {
    const dir = agentFolder([`FLOW_KEY=${FLOW_KEY}`, `FLOW_FRAMEWORK_CLOUD_KEY=${CI_KEY}`, `FLOW_FRAMEWORK_CLOUD=${fake.url}`]);
    const conversations = await flow(["conversations", "--json"], dir);
    assert.match(JSON.parse(conversations.stdout).error.message, /flow conversations reads with the agent's Flow key, FLOW_KEY .*\nIt found FLOW_KEY=flow_test_…9Az1 in \.env in this folder\.\nGet the right one: npx @flow-engineer\/flow setup/s);
    const status = await flow(["deploy", "status"], dir, { FLOW_FRAMEWORK_CLOUD_KEY: CI_KEY });
    assert.match(status.stderr, /flow deploy reads with the agent's CI key, FLOW_FRAMEWORK_CLOUD_KEY \(oci_\.\.\..*\nIt found FLOW_FRAMEWORK_CLOUD_KEY=oci_…7Qw2 in the environment\./s);
  } finally { fake.close(); }
});

test("a long --json answer reaches a pipe whole before the CLI exits", { timeout: 30_000 }, async () => {
  const fake = await cloud();
  try {
    const dir = agentFolder([`FLOW_KEY=${FLOW_KEY}`, `FLOW_FRAMEWORK_CLOUD=${fake.url}`]);
    const run = await flow(["conversations", "show", "cnv_big", "--environment", "production", "--json"], dir);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), fake.big);
  } finally { fake.close(); }
});
