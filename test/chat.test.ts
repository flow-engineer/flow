// covers: testing/src/chat.ts testing/src/cli.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../testing/src/cli.ts", import.meta.url));
const framework = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** An agent folder whose model answers each message with "You said: <it>", on one web channel. */
function agentFolder(testPeople: string): string {
  const dir = mkdtempSync(join(tmpdir(), "flow-chat-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "agent"));
  writeFileSync(join(dir, "agent", "AGENTS.md"), "You are a test agent.");
  writeFileSync(join(dir, "src", "agent.ts"), `
import { createAgent, customUI } from ${JSON.stringify(framework)};
const echo = {
  async complete(request) {
    const last = request.messages.at(-1);
    if (last?.role !== "user") return { text: null, toolCalls: [] };
    const said = String(last.content).replace(/^\\[[^\\]]*\\] /, "");
    return { text: null, toolCalls: [{ id: "c" + request.messages.length, name: "send_web", arguments: JSON.stringify({ text: "You said: " + said }) }] };
  },
};
const provider = { sendMessage: async () => { throw new Error("not connected"); } };
export function buildAgent({ events = [] } = {}) {
  return createAgent({ dir: new URL("../agent", import.meta.url).pathname, model: echo, events, debounceMs: 0, channels: [customUI("web", provider)], testPeople: ${testPeople} });
}
`);
  return dir;
}

function chat(cwd: string, input: string, args: string[] = []) {
  const child = spawn(process.execPath, [cli, "chat", ...args], { cwd, env: { PATH: process.env.PATH } });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { err += c; });
  child.stdin.end(input);
  return new Promise<{ code: number | null; out: string; err: string }>((done) => child.on("close", (code) => done({ code, out, err })));
}

test("flow chat reads one message per line, as the agent's first test person, and prints each reply once its turn is over", async () => {
  const dir = agentFolder(`[{ name: "Maria", phone: "+15555550101" }]`);
  const result = await chat(dir, "hello\n\nA latte please\n");
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, "agent: You said: hello\nagent: You said: A latte please\n");
  assert.match(result.err, /on web as Maria/);
  const json = await chat(dir, "hi\n", ["--json"]);
  assert.deepEqual(JSON.parse(json.out), { channel: "web", type: "message", text: "You said: hi" });
});

test("flow chat on a channel with edits gives the agent's messages ids it can edit by, and prints the edit", async () => {
  const dir = agentFolder(`[{ name: "Maria", phone: "+15555550101" }]`);
  writeFileSync(join(dir, "src", "agent.ts"), `
import { createAgent, customUI } from ${JSON.stringify(framework)};
const model = {
  async complete(request) {
    const last = request.messages.at(-1);
    if (last?.role !== "user") return { text: null, toolCalls: [] };
    const sent = request.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content).message_id);
    const n = request.messages.length;
    if (!sent.length) return { text: null, toolCalls: [{ id: "s" + n, name: "send_web", arguments: JSON.stringify({ text: "Top bid ₹47,133" }) }] };
    return { text: null, toolCalls: [{ id: "e" + n, name: "edit_message", arguments: JSON.stringify({ message_id: sent[0], text: "Top bid ₹39,500" }) }, { id: "s" + n, name: "send_web", arguments: JSON.stringify({ text: "Fixed it." }) }] };
  },
};
const provider = { sendMessage: async () => { throw new Error("not connected"); }, editMessage: async () => {} };
export function buildAgent({ events = [] } = {}) {
  return createAgent({ dir: new URL("../agent", import.meta.url).pathname, model, events, debounceMs: 0, channels: [customUI("web", provider)], testPeople: [{ name: "Maria", phone: "+15555550101" }] });
}
`);
  const result = await chat(dir, "top bid?\nsure?\n");
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, "agent: Top bid ₹47,133\nagent edited a message: Top bid ₹39,500\nagent: Fixed it.\n");
  const json = await chat(dir, "top bid?\n", ["--json"]);
  assert.deepEqual(JSON.parse(json.out), { channel: "web", type: "message", text: "Top bid ₹47,133", id: "a1" });
});

test("flow chat with no test people, or outside an agent's folder, says what is missing and exits 1", async () => {
  const none = await chat(agentFolder("[]"), "hello\n");
  assert.equal(none.code, 1);
  assert.match(none.err, /no testPeople; declare them in createAgent/);
  const empty = await chat(mkdtempSync(join(tmpdir(), "flow-chat-")), "hello\n");
  assert.equal(empty.code, 1);
  assert.match(empty.err, /no src\/agent\.ts here[^]*Next: npx @flow-engineer\/flow init/);
});

test("flow chat with no model key says so in one sentence with the next step; --json gives it as an error object", async () => {
  const dir = agentFolder("[]");
  writeFileSync(join(dir, "src", "agent.ts"), `import { createAgent, openAICompatible } from ${JSON.stringify(framework)};
export function buildAgent() { return createAgent({ dir: new URL("../agent", import.meta.url).pathname, model: openAICompatible() }); }
`);
  const human = await chat(dir, "hi\n");
  assert.equal(human.code, 1);
  assert.match(human.err, /^flow chat: This agent has no model key: npx @flow-engineer\/flow setup writes FLOW_KEY, the agent's Flow key \(with the account's free trial model credit\), into \.env/);
  assert.match(human.err, /\nNext: run npx @flow-engineer\/flow setup to get Flow's free trial credit, or add your own key\.\n$/);
  const json = await chat(dir, "hi\n", ["--json"]);
  assert.equal(json.code, 1);
  const { error } = JSON.parse(json.out);
  assert.equal(error.code, "no_model_key");
  assert.equal(error.next, "npx @flow-engineer/flow setup");
  assert.match(error.message, /^This agent has no model key/);
});
