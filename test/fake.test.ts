// covers: testing/src/fake.ts
// `flow test fake <tool>` writes a starter fake from the tool's file that loads as flow test loads
// fakes and answers as the tool file's responses do, and never writes over a fake already there.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadFakes } from "../testing/src/suite.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "testing", "src", "cli.ts");

/** An agent folder with the café's tests/tools, its fakes left out. */
function agent(): string {
  const dir = mkdtempSync(join(tmpdir(), "flow-test-fake-"));
  cpSync(join(root, "examples", "cafe", "tests", "tools"), join(dir, "tests", "tools"), { recursive: true, filter: (src) => !src.endsWith(".fake.ts") });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "cafe", type: "module" }));
  return dir;
}

async function flow(args: string[], dir: string) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });
  const code = await new Promise<number | null>((done) => child.on("close", done));
  return { code, stdout, stderr };
}

test("flow test fake writes a starter that loads and answers as the tool file does, and never writes over a fake", async () => {
  const dir = agent();
  const made = await flow(["test", "fake", "place_order", "--json"], dir);
  assert.equal(made.code, 0, made.stderr);
  assert.deepEqual(JSON.parse(made.stdout), { ok: true, tool: "place_order", file: "tests/tools/place_order.fake.ts", from: "tests/tools/place_order.yaml" });
  const source = readFileSync(join(dir, "tests", "tools", "place_order.fake.ts"), "utf8");
  assert.match(source, /Optional: delete this file/);
  assert.match(source, /given:/);
  assert.match(source, /expect\.state/);
  // As flow test loads it: the type import is erased, so it runs without the package.
  const fake = (await loadFakes(join(dir, "tests"))).get("place_order")!;
  const responses = [
    { when: "usual", latency_ms: 1, input: { name: "Sam" }, output: { order_id: "BL-1040" } },
    { when: "busy", latency_ms: 2, output: { order_id: "BL-1041" } },
    { when: "down", latency_ms: 3, input: { name: "Down" }, error: "Point of sale unavailable" },
  ];
  const call = { world: {}, state: {}, now: "2026-11-05T09:00:00Z", call: 1, responses };
  assert.deepEqual(await fake({ ...call, input: { name: "Sam" } }), { output: { order_id: "BL-1040" } });
  assert.deepEqual(await fake({ ...call, input: { name: "Down" } }), { error: "Point of sale unavailable" });
  assert.deepEqual(await fake({ ...call, input: { name: "Kim" } }), { output: { order_id: "BL-1040" } }, "the usual one for any other input");

  writeFileSync(join(dir, "tests", "tools", "place_order.fake.ts"), "// mine\n");
  const again = await flow(["test", "fake", "place_order", "--json"], dir);
  assert.equal(again.code, 1);
  assert.equal(JSON.parse(again.stdout).error.code, "exists");
  assert.equal(readFileSync(join(dir, "tests", "tools", "place_order.fake.ts"), "utf8"), "// mine\n");
  const none = await flow(["test", "fake", "refund", "--json"], dir);
  assert.equal(none.code, 1);
  assert.equal(JSON.parse(none.stdout).error.code, "no_tool_file");
});
