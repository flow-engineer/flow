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

/** `flow mcp serve` in an agent folder whose .env points at the cloud, with a connected client. */
async function serve(cloud: string) {
  const dir = mkdtempSync(join(tmpdir(), "flow-mcp-serve-"));
  writeFileSync(join(dir, ".env"), `FLOW_KEY=${KEY}\nFLOW_FRAMEWORK_CLOUD_KEY=oci_ci_secretvalue\nFLOW_FRAMEWORK_CLOUD=${cloud}\n`);
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

test("read_logs follows the cursor until it stops moving and keeps the newest lines under its limit", async () => {
  const line = (n: number) => ({ time: `2026-11-04T09:00:0${n}Z`, severity: "INFO", text: `line ${n}` });
  // Page 1 (no after), page 2 (after c1), then the host answers its last cursor again: the end.
  const pages: Record<string, { lines: unknown[]; next: string | null }> = { "": { lines: [line(1), line(2)], next: "c1" }, c1: { lines: [line(3), line(4)], next: "c2" }, c2: { lines: [line(4)], next: "c2" } };
  const cloud = await fakeCloud((req) => ({ status: 200, body: pages[new URL(req.url!, "http://x").searchParams.get("after") ?? ""] }));
  const client = await serve(cloud.url);
  try {
    const result = await client.callTool({ name: "read_logs", arguments: { limit: 3 } });
    const data = result.structuredContent as { lines: Array<{ text: string }>; truncated: boolean };
    assert.deepEqual(data.lines.map((l) => l.text), ["line 2", "line 3", "line 4"]);
    assert.equal(data.truncated, true);
    assert.equal(cloud.seen.length, 3);
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
