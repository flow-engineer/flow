// covers: testing/src/mcp-serve.ts testing/src/cli.ts
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const cli = fileURLToPath(new URL("../testing/src/cli.ts", import.meta.url));
const KEY = "flow_test_k1_secretvalue";

/** A fake Flow cloud answering `answer` to every request; the requests it got. */
async function fakeCloud(answer: (req: IncomingMessage) => { status: number; body: unknown }) {
  const seen: Array<{ url: string; authorization: string | undefined }> = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url!, authorization: req.headers.authorization });
    const { status, body } = answer(req);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise((done) => server.close(done)) };
}

/** `flow mcp serve` in an agent folder whose .env points at the cloud (and has `more` lines), with a connected client. */
async function serve(cloud: string, more = "") {
  const dir = mkdtempSync(join(tmpdir(), "flow-mcp-serve-"));
  writeFileSync(join(dir, ".env"), `FLOW_KEY=${KEY}\nFLOW_FRAMEWORK_CLOUD=${cloud}\n${more}`);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !/^(FLOW_|CHINWAG_)/.test(name)) env[name] = value;
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "serve"], cwd: dir, env, stderr: "ignore" }));
  return client;
}

test("flow mcp serve lists its tools, every one read-only, and says what it is for", async () => {
  const client = await serve("http://127.0.0.1:9");
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["list_conversations", "show_conversation", "list_issues", "list_insights", "insight_conversations", "list_templates", "read_logs", "deploy_status"]);
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);
    assert.deepEqual((tools.find((t) => t.name === "list_issues")!.inputSchema.properties as Record<string, { enum?: string[]; default?: string }>).status, { type: "string", enum: ["open", "resolved", "ignored", "all"], default: "open", description: "Which issues" });
    assert.match(client.getInstructions() ?? "", /Did a tool call fail, or was a reply delivered\?.*show_conversation/);
  } finally {
    await client.close();
  }
});

test("list_conversations reads the cloud with FLOW_KEY and returns the conversations as structured data", async () => {
  const conversation = { id: "cnv_1", environment: "staging", channel: "whatsapp", contact: "Contact 0100", messages: 4, grades: { good: 1, unhelpful: 0, wrong: 2, not_graded: 1 } };
  const cloud = await fakeCloud(() => ({ status: 200, body: { conversations: [conversation], next_cursor: null } }));
  const client = await serve(cloud.url);
  try {
    const result = await client.callTool({ name: "list_conversations", arguments: { environment: "staging", grade: "wrong" } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { conversations: [conversation], next_cursor: null });
    assert.match((result.content as Array<{ text: string }>)[0]!.text, /^1 conversation, 2 replies graded wrong\./);
    assert.deepEqual(cloud.seen, [{ url: "/v1/agent/conversations?environment=staging&grade=wrong&limit=20", authorization: `Bearer ${KEY}` }]);
  } finally {
    await client.close();
    await cloud.close();
  }
});

test("a refused key is a tool error naming the key it read, never its value, and how to get the right one", async () => {
  const cloud = await fakeCloud(() => ({ status: 401, body: { error: { code: "bad_key", message: "This key is not valid." } } }));
  const client = await serve(cloud.url);
  try {
    const result = await client.callTool({ name: "list_issues", arguments: {} });
    assert.equal(result.isError, true);
    const { error } = result.structuredContent as { error: { code: string; message: string } };
    assert.equal(error.code, "bad_key");
    assert.match(error.message, /It found FLOW_KEY=flow_test_…alue in .*\.env\..*\nGet the right one: npx @flow-engineer\/flow setup/s);
    assert.doesNotMatch(JSON.stringify(result), /secretvalue/);
  } finally {
    await client.close();
    await cloud.close();
  }
});

test("production tools read with FLOW_LIVE_KEY when .env has it, staging ones with FLOW_KEY, and each result keeps the text mode Flow sent", async () => {
  const live = "flow_live_FAKElive00_0000FAKE0000live0000R3ad";
  const cloud = await fakeCloud((req) => ({ status: 200, body: req.url!.startsWith("/v1/agent/insights") ? { state: "on", findings: [], text_mode: "deidentified" } : { conversations: [], next_cursor: null, text_mode: "deidentified" } }));
  const client = await serve(cloud.url, `FLOW_LIVE_KEY=${live}\n`);
  try {
    const insights = await client.callTool({ name: "list_insights", arguments: {} });
    assert.equal((insights.structuredContent as { text_mode?: string }).text_mode, "deidentified");
    assert.match((insights.content as Array<{ text: string }>)[0]!.text, /Text: de-identified/);
    await client.callTool({ name: "list_conversations", arguments: { environment: "production" } });
    await client.callTool({ name: "list_conversations", arguments: { environment: "staging" } });
    assert.deepEqual(cloud.seen.map((s) => s.authorization), [`Bearer ${live}`, `Bearer ${live}`, `Bearer ${KEY}`]);
    const { tools } = await client.listTools();
    assert.match(tools.find((t) => t.name === "list_insights")!.description!, /flow setup --live/);
  } finally {
    await client.close();
    await cloud.close();
  }
});
