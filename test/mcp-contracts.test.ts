// covers: mcp/src/contracts.ts mcp/src/server.ts cli/src/run.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { defineCli, runCli, type CliIO } from "../cli/src/index.ts";
import { contractProblems, contractSnapshot, mcpServer, type McpContracts, type McpServerHandle } from "../mcp/src/index.ts";
import { tool } from "../src/index.ts";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

// Contract 3 is the tools as written. Contract 2 called get_order order_status, took { id } and
// answered { order, ok }; had ping, since removed; and answered cancel_order in words, which nothing
// maps to. Contract 1 is no longer served.
const getOrder = tool({
  name: "get_order", description: "One order.", signIn: "none", hints: { readOnly: true },
  input: z.object({ order_id: z.string() }),
  output: z.object({ id: z.string(), status: z.string() }),
  format: (order) => `Order ${order.id} is ${order.status}.`,
  run: ({ order_id }) => ({ id: order_id, status: "ready" }),
});
const cancelOrder = tool({ name: "cancel_order", description: "Cancel an order.", signIn: "none", input: z.object({ order_id: z.string() }), output: z.object({ cancelled: z.string() }), run: ({ order_id }) => ({ cancelled: order_id }) });
const contract2 = {
  tools: {
    get_order: {
      name: "order_status",
      input: z.object({ id: z.string() }),
      mapInput: ({ id }: { id: string }) => ({ order_id: id }),
      output: z.object({ order: z.object({ id: z.string(), status: z.string() }), ok: z.boolean() }),
      mapOutput: (order: unknown) => ({ order, ok: true }),
    },
  },
  legacy: [
    tool({ name: "ping", description: "Ping.", input: z.object({}), signIn: "none", hints: { readOnly: true }, run: () => "pong" }),
    tool({ ...cancelOrder, output: undefined, run: async (input, context) => `Cancelled ${(await cancelOrder.run(input, context) as { cancelled: string }).cancelled}.` }),
  ],
};
const contracts: McpContracts = {
  current: 3,
  supported: { 2: contract2 },
  pick: ({ name, version }) => name !== "acme-cli" ? undefined : version.startsWith("0.1.") ? 2 : version.startsWith("0.0.") ? 1 : undefined,
};

async function serve(handle: McpServerHandle): Promise<string> {
  const http = createServer((req, res) => void handle.node(req, res));
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;
}

async function client(url: string, name: string, version: string): Promise<Client> {
  const c = new Client({ name, version });
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));
  return c;
}

function io(): { channel: CliIO; out: string; err: string } {
  const result = { out: "", err: "", channel: undefined as unknown as CliIO };
  result.channel = { write: (t) => { result.out += t; }, writeError: (t) => { result.err += t; }, interactive: false, env: { NO_COLOR: "1" }, confirm: async () => false };
  return result;
}

const cli = (server: string, settings: { version: string; contract?: number }) =>
  defineCli({ name: "acme", directory: mkdtempSync(join(tmpdir(), "flow-contracts-")), server, update: { command: "true" }, ...settings });

test("a published CLI picked by its clientInfo gets its contract's names, inputs and outputs; a CLI naming its contract and hosts get theirs", async () => {
  const url = await serve(mcpServer({ name: "acme", version: "1", tools: [getOrder, cancelOrder], contracts, feedback: false }));

  const old = await client(url, "acme-cli", "0.1.4");
  const listed = await old.listTools();
  assert.deepEqual(listed.tools.map((t) => t.name).sort(), ["cancel_order", "order_status", "ping"]);
  assert.equal(listed._meta?.["flow.engineer/contract"], 2);
  const status = await old.callTool({ name: "order_status", arguments: { id: "A1" } });
  assert.deepEqual(status.structuredContent, { order: { id: "A1", status: "ready" }, ok: true });
  assert.deepEqual(status.content, [{ type: "text", text: "Order A1 is ready." }]);
  assert.deepEqual((await old.callTool({ name: "ping", arguments: {} })).content, [{ type: "text", text: "pong" }]);
  assert.deepEqual((await old.callTool({ name: "cancel_order", arguments: { order_id: "A1" } })).content, [{ type: "text", text: "Cancelled A1." }]);
  await old.close();

  const host = await client(url, "claude-ai", "1");
  assert.deepEqual((await host.listTools()).tools.map((t) => t.name), ["get_order", "cancel_order"]);
  assert.deepEqual((await host.callTool({ name: "cancel_order", arguments: { order_id: "A1" } })).structuredContent, { cancelled: "A1" });
  await host.close();

  const current = io();
  assert.equal(await runCli(cli(url, { version: "0.2.0", contract: 3 }), ["get-order", "--order-id", "A1", "--json"], current.channel), 0, current.err);
  assert.deepEqual(JSON.parse(current.out), { id: "A1", status: "ready" });
  // Named, the contract wins over what the server would pick for the version.
  const named = io();
  assert.equal(await runCli(cli(url, { version: "0.0.1", contract: 2 }), ["order-status", "--id", "A1", "--json"], named.channel), 0, named.err);
  assert.deepEqual(JSON.parse(named.out), { order: { id: "A1", status: "ready" }, ok: true });
});

test("a client older than every contract served is told to update: the CLI in one line, with its update command", async () => {
  const url = await serve(mcpServer({ name: "acme", version: "1", tools: [getOrder, cancelOrder], contracts, feedback: false }));
  const stale = io();
  assert.equal(await runCli(cli(url, { version: "0.0.9" }), ["get-order", "--order-id", "A1"], stale.channel), 1);
  assert.equal(stale.err.trim(), `This acme (0.0.9) is too old for ${url}. Run \`acme update\` to get the newest version.`);
  // Published CLIs know nothing of contracts: the server's own message says what to run.
  const raw = await client(url, "acme-cli", "0.0.9");
  await assert.rejects(raw.listTools(), /acme-cli 0\.0\.9 is too old for acme: it speaks contract 1, which is no longer served\. Run `acme update`/);
  await raw.close();
});

test("a contract's snapshot still holds after additions, and a change that breaks it is named", async () => {
  const calls = [{ tool: "order_status", arguments: { id: "A1" } }];
  const saved = await contractSnapshot(mcpServer({ name: "acme", version: "1", tools: [getOrder, cancelOrder], contracts, feedback: false }), { client: { name: "acme-cli", version: "0.1.4" }, calls });
  assert.equal(saved.contract, 2);
  assert.deepEqual(saved.calls[0]!.result, { order: { id: "A1", status: "ready" }, ok: true });

  // A new tool, a new optional input and a new output field keep every contract.
  const grown = tool({ ...getOrder, input: z.object({ order_id: z.string(), verbose: z.boolean().optional() }), output: z.object({ id: z.string(), status: z.string(), eta: z.string() }), run: ({ order_id }) => ({ id: order_id, status: "ready", eta: "5m" }) });
  const extra = tool({ name: "list_orders", description: "Orders.", input: z.object({}), signIn: "none", run: () => [] });
  const added = mcpServer({ name: "acme", version: "1", tools: [grown, extra], contracts: { ...contracts, supported: { 2: { ...contract2, tools: { get_order: { ...contract2.tools.get_order, output: z.object({ order: z.object({ id: z.string(), status: z.string(), eta: z.string() }), ok: z.boolean() }) } } } } }, feedback: false });
  assert.deepEqual(contractProblems(saved, await contractSnapshot(added, { contract: 2, calls })), []);

  // Reshaping the output without the adapter breaks contract 2.
  const broken = mcpServer({ name: "acme", version: "1", tools: [getOrder], contracts: { ...contracts, supported: { 2: { ...contract2, tools: { get_order: { name: "order_status", input: contract2.tools.get_order.input, mapInput: contract2.tools.get_order.mapInput } } } } }, feedback: false });
  assert.deepEqual(contractProblems(saved, await contractSnapshot(broken, { contract: 2, calls })), ["order_status: output schema changed", "call 1 (order_status): result changed"]);
});
