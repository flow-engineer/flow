// covers: testing/src/variants.ts
// How variants are declared: the file, the flags (names that say what they are), the judged checks added to every scenario, and the model a variant gives.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseScenario } from "../testing/src/suite.ts";
import { readFileSync } from "node:fs";
import { childSpec, CURRENT, eventsSink, readVariantsFile, variantModel, variantsFromFlags, withJudge } from "../testing/src/variants.ts";
import { hashOf } from "../testing/src/suite.ts";

const dir = () => mkdtempSync(join(tmpdir(), "flow-variants-"));
const flags = { model: [], instructions: [], codeRef: [], withoutCurrent: false };

test("a variants file puts the agent as it stands first and names every fault with the file and the field", () => {
  const d = dir();
  writeFileSync(join(d, "v.yaml"), "judge: [Be brief.]\nvariants:\n  b: { model: { id: other/model, reasoning: low } }\n  a: { instructions: { file: x.md } }\n");
  const v = readVariantsFile(join(d, "v.yaml"));
  assert.deepEqual(v.variants.map((x) => x.name), [CURRENT, "b", "a"]);
  assert.deepEqual(v.judge, ["Be brief."]);
  writeFileSync(join(d, "bad.yaml"), "variants:\n  b: { modle: { id: x } }\n");
  assert.throws(() => readVariantsFile(join(d, "bad.yaml")), /bad\.yaml: variants\.b: .*Unrecognized key/s);
  writeFileSync(join(d, "name.yaml"), "variants:\n  Not Valid: {}\n");
  assert.throws(() => readVariantsFile(join(d, "name.yaml")), /variant name "Not Valid"/);
});

test("flags make one variant per value named for it, the baseline first, and refuse to mix kinds", () => {
  const v = variantsFromFlags({ ...flags, model: ["anthropic/claude-sonnet-5", "openai/gpt-6-luna"] });
  assert.deepEqual(v.variants.map((x) => x.name), [CURRENT, "claude-sonnet-5", "gpt-6-luna"]);
  assert.deepEqual(v.variants[1]!.spec, { model: { id: "anthropic/claude-sonnet-5" } });
  assert.deepEqual(variantsFromFlags({ ...flags, instructions: ["agent/AGENTS.short.md"] }).variants.map((x) => x.name), [CURRENT, "agents-short"]);
  assert.deepEqual(variantsFromFlags({ ...flags, codeRef: ["v0.19.0", "feature/x"] }).variants.map((x) => x.name), [CURRENT, "v0-19-0", "x"]);
  assert.deepEqual(variantsFromFlags({ ...flags, model: ["a/m", "b/m"], withoutCurrent: true }).variants.map((x) => x.name), ["m", "m-2"]);
  assert.throws(() => variantsFromFlags({ ...flags, model: ["a"], instructions: ["f"] }), /do not go together/);
  assert.throws(() => variantsFromFlags(flags), /Nothing to compare/);
  assert.throws(() => variantsFromFlags({ ...flags, model: ["a"], withoutCurrent: true }), /at least two variants/);
});

test("the instructions file is read for the child at the project, and a missing one is named", () => {
  const d = dir();
  writeFileSync(join(d, "alt.md"), "# Alt");
  const files = { eventsFile: "e", resultFile: "r" };
  const spec = childSpec({ name: "alt", spec: { instructions: { file: "alt.md", edits: [{ find: "a", replace: "b" }] } } }, d, ["Be brief."], files);
  assert.deepEqual(spec.instructions, { text: "# Alt", edits: [{ find: "a", replace: "b" }] });
  assert.equal(spec.testsDir, join(d, "tests"));
  assert.deepEqual(spec.judge, ["Be brief."]);
  assert.throws(() => childSpec({ name: "alt", spec: { instructions: { file: "none.md" } } }, d, [], files), /instructions file none\.md does not exist/);
});

test("judged checks are added to every scenario's expect.judge and leave tool files and other checks alone", () => {
  const scenario = "id: a\nchannels: [sms]\nperson:\n  persona: p\n  goal: g\nopening:\n  - say: hi\nexpect:\n  judge:\n    - Old check.\n";
  const bare = scenario.replace(/expect:[\s\S]*$/, "");
  const tool = "tool: t\nresponses: []\n";
  const files = [{ path: "scenarios/a.yaml", content: scenario, hash: hashOf(scenario) }, { path: "scenarios/b.yaml", content: bare, hash: hashOf(bare) }, { path: "tools/t.yaml", content: tool, hash: hashOf(tool) }];
  const out = withJudge(files, ["New check."]);
  assert.deepEqual(parseScenario(out[0]!).expect.judge, ["Old check.", "New check."]);
  assert.deepEqual(parseScenario(out[1]!).expect.judge, ["New check."]);
  assert.equal(out[2], files[2]);
  assert.notEqual(out[0]!.hash, files[0]!.hash);
  assert.equal(withJudge(files, []), files);
});

test("a variant's model may use any provider key variable, and names one that is not set instead of falling back to another", () => {
  assert.equal(variantModel(undefined), undefined);
  assert.throws(() => variantModel({ id: "m", baseUrl: "http://localhost:1/v1", apiKeyEnv: "MY_KEY" }, {}), /MY_KEY as its key, and it is not set/);
  const model = variantModel({ id: "m", baseUrl: "http://localhost:1/v1", apiKeyEnv: "MY_KEY", reasoning: "low", promptCaching: false }, { MY_KEY: "k" });
  assert.equal(typeof model!.complete, "function");
});

test("every build of the agent in a session adds to one events file, since each business run builds it again", () => {
  const d = dir();
  const spec = childSpec({ name: "a", spec: {} }, d, [], { eventsFile: join(d, "e.jsonl"), resultFile: join(d, "r.json") });
  const first = eventsSink(spec);
  const second = eventsSink(spec);
  assert.equal(first, second);
  first({ type: "turn.start", conversationId: "c1", at: 1 });
  second({ type: "turn.end", conversationId: "c2", at: 2 });
  assert.equal(readFileSync(spec.eventsFile, "utf8").trim().split("\n").length, 2);
});
