// covers: testing/src/compare.ts testing/src/cli.ts testing/src/variants.ts testing/src/variant-counts.ts testing/src/compare-table.ts
// `flow test compare` against a fake cloud: one `flow test` child per variant, each told what its variant changes, each in a session of its
// own labelled compare/<name>, and one comparison printed from their reports and the events their agents emitted.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../testing/src/cli.ts", import.meta.url));
const variantModule = fileURLToPath(new URL("../src/variant.ts", import.meta.url));

const runResult = { runId: "r1", scenario: "hello", run: 1, channel: "sms", passed: true, checks: [], ended: "goal_met", turns: 1, messagesIn: 1, messagesOut: 1, toolCalls: 0, slowestAckMs: null, agentUsage: { input: 1, output: 1, costUsd: 0.01 }, agentModels: ["m"], testUsage: { input: 0, output: 0, costUsd: 0.01 }, watch: "http://watch/r1" };

/** A cloud that opens every session and plays hello once, passed; `refs` collects the x-chinwag-ref of each open. */
async function fakeCloud() {
  const refs: string[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/api/sessions") {
      req.resume();
      refs.push(String(req.headers["x-chinwag-ref"]));
      req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "http://dash/s" })));
      return;
    }
    if (req.url?.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "run", run: runResult })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "finished", summary: { sessionId: "s", suiteHash: "h", testModel: "m", runs: [runResult], dashboard: "http://dash/s" } })}\n\n`);
      res.end();
      return;
    }
    req.resume();
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, refs, close: () => { server.closeAllConnections(); server.close(); } };
}

/** An agent folder whose agent emits one turn at build time, reporting the built-in text it was given and whether a variant gave it a model. */
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "flow-compare-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "tests", "scenarios"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  writeFileSync(join(dir, "tests", "scenarios", "hello.yaml"), "id: hello\nchannels: [sms]\nperson:\n  persona: a\n  goal: b\nopening:\n  - say: hi\n");
  writeFileSync(join(dir, "src", "agent.ts"), `import { overrideBuiltIn } from ${JSON.stringify(variantModule)};
export const tools = [];
export function buildAgent(options) {
  const id = "sms:tse_s.hello.sms.1";
  const at = Date.now();
  for (const sink of options.events) {
    sink({ type: "status", conversationId: id, at, text: overrideBuiltIn("alpha beta"), modelGiven: Boolean(options.model) });
    sink({ type: "turn.start", conversationId: id, at: at + 1 });
    sink({ type: "model.call", conversationId: id, at: at + 2, ms: 1000, toolCalls: ["send_sms"], usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 } });
    sink({ type: "message.out", conversationId: id, at: at + 3, text: "hello" });
    sink({ type: "turn.end", conversationId: id, at: at + 4 });
  }
  return { channels: () => [], receive: () => "m", reacted: () => {} };
}
`);
  writeFileSync(join(dir, "variants.yaml"), "variants:\n  reworded:\n    builtIn:\n      edits:\n        - { find: alpha, replace: gamma }\n  stale:\n    builtIn:\n      edits:\n        - { find: never-there, replace: x }\n  other-model:\n    model: { id: m2, baseUrl: \"http://127.0.0.1:1/v1\", apiKeyEnv: FIXTURE_KEY }\n");
  return dir;
}

function flow(args: string[], dir: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => child.on("close", (code) => done({ code, stdout, stderr })));
}

test("compare starts one session per variant, labelled by name, applies what each changes, and prints one table that names an edit that did nothing", { timeout: 60_000 }, async () => {
  const cloud = await fakeCloud();
  const dir = agentDir();
  const kept = join(dir, "events");
  try {
    const result = await flow(["test", "compare", "--variants", "variants.yaml", "--cloud", cloud.url, "--runs", "1", "--json", "--save-events", kept], dir, { FIXTURE_KEY: "k" });
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.variants.map((v: { name: string; ran: boolean }) => [v.name, v.ran]), [["current", true], ["reworded", true], ["stale", true], ["other-model", true]]);
    assert.deepEqual(cloud.refs.sort(), ["compare/current", "compare/other-model", "compare/reworded", "compare/stale"]);
    // What each variant changed reached its agent.
    const status = (name: string) => JSON.parse(readFileSync(join(kept, `${name}.events.jsonl`), "utf8").split("\n")[0]!);
    assert.deepEqual([status("current").text, status("reworded").text, status("current").modelGiven, status("other-model").modelGiven], ["alpha beta", "gamma beta", false, true]);
    // Counts come from the events; the warning names the edit that found no text.
    const row = report.rows.find((r: { id: string }) => r.id === "messages_per_turn");
    assert.equal(row.cells.current.value, 1);
    assert.match(report.warnings.join("\n"), /stale: an edit matched no text/);
    assert.equal(report.rows[0].id, "pass_rate");
    assert.match(result.stderr, /\[reworded\] PASS {2}hello #1/);
    assert.match(result.stderr, /session time/);
    // The folder's own last session is left alone.
    assert.equal(existsSync(join(dir, ".flow", "last-session.json")), false);
    assert.match(report.noiseRule, /do not overlap/);
  } finally { cloud.close(); }
});

test("compare refuses what cannot be compared before anything is sent", { timeout: 30_000 }, async () => {
  const dir = agentDir();
  const none = await flow(["test", "compare", "--json"], dir);
  assert.equal(none.code, 1);
  assert.match(JSON.parse(none.stdout).error.message, /Nothing to compare/);
  const mixed = await flow(["test", "compare", "--model", "a", "--instructions", "b.md"], dir);
  assert.equal(mixed.code, 1);
  assert.match(mixed.stderr, /do not go together/);
  const missing = await flow(["test", "compare", "--instructions", "nope.md", "--cloud", "http://127.0.0.1:9", "--json"], dir);
  assert.equal(missing.code, 1);
  assert.match(JSON.parse(missing.stdout).error.message, /instructions file nope\.md does not exist/);
});
