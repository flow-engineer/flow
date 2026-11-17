// covers: src/variant.ts src/agent.ts src/conversation.ts
// The test-only text overrides `flow test compare` uses: they change what the model is told, only in a test run, and say when an edit matched nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { overrideBuiltIn, overrideInstructions, unmatchedEdits, useTestOverrides } from "../src/variant.ts";
import { harness, respond, say } from "./helpers.ts";

const TEST_RUN = { FLOW_FRAMEWORK_RUN_KIND: "test" };

test("text overrides refuse to turn on outside a test run, so a stray setting never reaches a running agent", () => {
  assert.throws(() => useTestOverrides({ builtIn: [{ find: "a", replace: "b" }] }, {}), /test run only/);
  assert.throws(() => useTestOverrides({ builtIn: [{ find: "a", replace: "b" }] }, { FLOW_FRAMEWORK_RUN_KIND: "production" }), /test run only/);
  // Nothing was turned on by the refused calls.
  assert.equal(overrideBuiltIn("a"), "a");
});

test("an override changes the instructions and the built-in lines the model is sent, and names an edit that matched nothing", async () => {
  useTestOverrides({
    instructions: { edits: [{ find: "You are a test agent.", replace: "You are a pirate." }, { find: "never in the file", replace: "x" }] },
    builtIn: [{ find: "Never send a placeholder.", replace: "Send a placeholder." }],
  }, TEST_RUN);
  try {
    const h = harness();
    h.send("c1", "hi");
    const first = (await h.nextCall(0)).request;
    assert.match(first.system, /You are a pirate\./);
    assert.doesNotMatch(first.system, /You are a test agent\./);
    assert.match(first.system, /Send a placeholder\./);
    assert.doesNotMatch(first.system, /Never send a placeholder\./);
    assert.deepEqual(unmatchedEdits().map((e) => e.find), ["never in the file"]);
    (await h.nextCall(0)).answer(respond(say("hello")));
  } finally {
    useTestOverrides({}, TEST_RUN);
  }
});

test("a whole replacement of the instructions comes before the edits, and without an override the files are the same object", () => {
  const files = { "AGENTS.md": "old", "skills/a/SKILL.md": "kept" };
  assert.equal(overrideInstructions(files), files);
  useTestOverrides({ instructions: { text: "new text", edits: [{ find: "new", replace: "newer" }] } }, TEST_RUN);
  try {
    assert.deepEqual(overrideInstructions(files), { "AGENTS.md": "newer text", "skills/a/SKILL.md": "kept" });
    assert.deepEqual(unmatchedEdits(), []);
  } finally {
    useTestOverrides({}, TEST_RUN);
  }
});
