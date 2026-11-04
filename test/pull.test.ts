// covers: testing/src/pull.ts testing/src/cli.ts testing/src/conversations.ts testing/src/suite.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadSuite } from "../testing/src/suite.ts";

const cli = fileURLToPath(new URL("../testing/src/cli.ts", import.meta.url));
const KEY = "oci_test_pullkey";

/** The flow command in dir, with this machine's cloud settings left out; its exit and both streams. */
async function flow(args: string[], dir: string, env: NodeJS.ProcessEnv = {}) {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["FLOW_FRAMEWORK_CLOUD", "CHINWAG_CLOUD", "FLOW_FRAMEWORK_CLOUD_KEY", "CHINWAG_CLOUD_KEY"]) delete base[name];
  const child = spawn(process.execPath, [cli, ...args], { cwd: dir, env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, stdout, stderr };
}

const yaml = (id: string, title: string, check = "not_checked") => [
  `id: ${id}`, `title: ${title}`, "channels: [whatsapp]", `origin: { from: chat, check: ${check} }`,
  "person:", "  persona: Arjun, short messages.", "  goal: Find out when the order arrives.",
  "opening:", "  - say: order kab aayega?", "max_turns: 8", "expect:", "  judge:", "    - The agent does not ask again for the phone number.", "",
].join("\n");

const drafts = [
  { id: "tdr_a", file: "chat-aaaaaa.yaml", yaml: yaml("chat-aaaaaa", "Asked for the phone number twice"), check: "not_checked", made_on: "2026-11-04", pulled: false },
  { id: "tdr_b", file: "chat-bbbbbb.yaml", yaml: yaml("chat-bbbbbb", "Wrong delivery day", "reproduces_on_bad"), check: "reproduces_on_bad", made_on: "2026-11-04", pulled: false },
  { id: "tdr_c", file: "chat-cccccc.yaml", yaml: yaml("chat-cccccc", "Pulled last week"), check: "not_checked", made_on: "2026-10-28", pulled: true },
  // Not a scenario (no opening), and a file name that is a path: neither is written or marked pulled.
  { id: "tdr_d", file: "chat-dddddd.yaml", yaml: "id: chat-dddddd\nchannels: [whatsapp]\nperson:\n  persona: a\n  goal: b\n", check: "not_checked", made_on: "2026-11-04", pulled: false },
  { id: "tdr_e", file: "../src/agent.yaml", yaml: yaml("chat-eeeeee", "Escapes"), check: "not_checked", made_on: "2026-11-04", pulled: false },
];

/** A fake Flow: the drafts for KEY, 204 for each pulled call (recorded), 401 for any other key, and 403 export_blocked when blocked. */
async function fakeFlow(options: { blocked?: boolean } = {}) {
  const pulled: string[] = [];
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: { code: "unauthorized", message: "Unknown key." } });
    if (options.blocked) {
      return send(403, { error: { code: "export_blocked", message: "These test drafts can't be downloaded yet: they stay where they were made. You can read them in the dashboard." } });
    }
    if (req.method === "GET" && req.url === "/v1/agent/test-drafts") return send(200, { drafts });
    const m = /^\/v1\/agent\/test-drafts\/([^/]+)\/pulled$/.exec(req.url ?? "");
    if (req.method === "POST" && m) {
      pulled.push(m[1]!);
      return send(204);
    }
    send(404, { error: { code: "not_found", message: "No such route." } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, pulled, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

const agentDir = () => mkdtempSync(join(tmpdir(), "flow-pull-"));

test("flow test pull writes each new draft to tests/drafts/, tells Flow it was pulled, and names one that does not parse or is not a file name; flow test's suite leaves drafts out", { timeout: 20_000 }, async () => {
  const flowServer = await fakeFlow();
  try {
    const dir = agentDir();
    const { code, stdout, stderr } = await flow(["test", "pull", "--cloud", flowServer.url], dir, { FLOW_FRAMEWORK_CLOUD_KEY: KEY });
    assert.equal(code, 1, stderr); // the draft that does not parse
    assert.deepEqual(readdirSync(join(dir, "tests", "drafts")).sort(), ["chat-aaaaaa.yaml", "chat-bbbbbb.yaml"]);
    assert.equal(readFileSync(join(dir, "tests", "drafts", "chat-aaaaaa.yaml"), "utf8"), drafts[0]!.yaml);
    assert.ok(!existsSync(join(dir, "src")));
    assert.deepEqual(flowServer.pulled, ["tdr_a", "tdr_b"]);
    assert.equal(stdout, [
      "FILE                            STATUS         TITLE",
      "tests/drafts/chat-aaaaaa.yaml   written        Asked for the phone number twice (not yet checked)",
      "tests/drafts/chat-bbbbbb.yaml   written        Wrong delivery day",
      "tests/drafts/chat-cccccc.yaml   pulled before  Pulled last week (not yet checked)",
      "tests/drafts/chat-dddddd.yaml   not written",
      "    tests/drafts/chat-dddddd.yaml:1: opening: missing",
      "tests/drafts/../src/agent.yaml  not written",
      '    not a draft Flow should send (id "tdr_e", file "../src/agent.yaml"): nothing written',
      "",
      "Drafts pulled before are not written again: --force writes them.",
      "Drafts never run or gate: flow test reads only tests/scenarios and tests/tools. Read each one, and move it into tests/scenarios/ to keep it as a test.",
      "",
    ].join("\n"));
    // What flow test sends is scenarios/ and tools/ only.
    mkdirSync(join(dir, "tests", "scenarios"));
    writeFileSync(join(dir, "tests", "scenarios", "kept.yaml"), drafts[1]!.yaml);
    assert.deepEqual(loadSuite(join(dir, "tests")).map((f) => f.path), ["scenarios/kept.yaml"]);
  } finally {
    await flowServer.close();
  }
});

test("flow test pull keeps a file already there unless --force, which also writes drafts pulled before; --dry-run writes and tells nothing; --json reports each", { timeout: 20_000 }, async () => {
  const flowServer = await fakeFlow();
  try {
    const dir = agentDir();
    mkdirSync(join(dir, "tests", "drafts"), { recursive: true });
    writeFileSync(join(dir, "tests", "drafts", "chat-aaaaaa.yaml"), "# my edits\n");
    writeFileSync(join(dir, "tests", "drafts", "chat-bbbbbb.yaml"), drafts[1]!.yaml);
    writeFileSync(join(dir, ".env"), `FLOW_FRAMEWORK_CLOUD=${flowServer.url}\nFLOW_FRAMEWORK_CLOUD_KEY=${KEY}\n`);

    const dry = await flow(["test", "pull", "--dry-run", "--force", "--json"], dir);
    assert.equal(readFileSync(join(dir, "tests", "drafts", "chat-aaaaaa.yaml"), "utf8"), "# my edits\n");
    assert.ok(!existsSync(join(dir, "tests", "drafts", "chat-cccccc.yaml")));
    assert.deepEqual(flowServer.pulled, []);
    const report = JSON.parse(dry.stdout) as { drafts: Array<{ id: string; done: string; check: string | null }> };
    assert.deepEqual(report.drafts.map((d) => [d.id, d.done, d.check]), [
      ["tdr_a", "would_write", "not_checked"], ["tdr_b", "would_write", "reproduces_on_bad"], ["tdr_c", "would_write", "not_checked"], ["tdr_d", "invalid", null], ["tdr_e", "invalid", null],
    ]);
    assert.match(dry.stderr, /^Nothing was written \(--dry-run\)\. Drafts never run or gate/m);

    const kept = await flow(["test", "pull", "--json"], dir);
    assert.equal(readFileSync(join(dir, "tests", "drafts", "chat-aaaaaa.yaml"), "utf8"), "# my edits\n");
    assert.deepEqual((JSON.parse(kept.stdout) as { drafts: Array<{ done: string }> }).drafts.slice(0, 3).map((d) => d.done), ["exists", "unchanged", "pulled_before"]);
    assert.match(kept.stderr, /^A file already in tests\/drafts\/ with other content is kept: --force writes over it\.$/m);
    assert.deepEqual(flowServer.pulled, ["tdr_b"]); // the same file already there counts as pulled

    flowServer.pulled.length = 0;
    const forced = await flow(["test", "pull", "--force"], dir);
    assert.equal(forced.code, 1);
    assert.equal(readFileSync(join(dir, "tests", "drafts", "chat-aaaaaa.yaml"), "utf8"), drafts[0]!.yaml);
    assert.equal(readFileSync(join(dir, "tests", "drafts", "chat-cccccc.yaml"), "utf8"), drafts[2]!.yaml);
    assert.deepEqual(flowServer.pulled, ["tdr_a", "tdr_b"]); // tdr_c was pulled before: not told again
  } finally {
    await flowServer.close();
  }
});

test("flow test pull writes nothing when Flow blocks the export (its message as is) or does not accept the key, and needs a key", { timeout: 20_000 }, async () => {
  const blocked = await fakeFlow({ blocked: true });
  try {
    const dir = agentDir();
    assert.deepEqual(await flow(["test", "pull", "--cloud", blocked.url], dir, { FLOW_FRAMEWORK_CLOUD_KEY: KEY }), {
      code: 1, stdout: "", stderr: "These test drafts can't be downloaded yet: they stay where they were made. You can read them in the dashboard.\n",
    });
    const refused = await flow(["test", "pull", "--cloud", blocked.url], dir, { CHINWAG_CLOUD_KEY: "oci_wrong" });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /^flow test pull: FLOW_FRAMEWORK_CLOUD_KEY was not accepted \(401\): use the agent's CI key/);
    assert.deepEqual(await flow(["test", "pull", "--cloud", blocked.url], dir), {
      code: 1, stdout: "", stderr: "flow test pull reads with the agent's CI key: set FLOW_FRAMEWORK_CLOUD_KEY (flow setup writes it into .env).\n",
    });
    assert.ok(!existsSync(join(dir, "tests")));
    assert.deepEqual(blocked.seen, ["GET /v1/agent/test-drafts", "GET /v1/agent/test-drafts"]);
  } finally {
    await blocked.close();
  }
});
