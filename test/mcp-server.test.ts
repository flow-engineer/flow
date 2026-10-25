// covers: mcp/src/server.ts mcp/src/describe.ts src/skills.ts src/tools.ts src/records.ts
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { isSpecType } from "@modelcontextprotocol/server";
import { z } from "zod";
import { tools as cafeTools } from "../examples/cafe/src/tools.ts";
import { mcpServer, type McpServerOptions } from "../mcp/src/index.ts";
import { createAgent, flowEvents, tool, type ToolContext } from "../src/index.ts";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function serve(options: McpServerOptions): Promise<string> {
  const handle = mcpServer(options);
  const http = createServer((req, res) => void handle.node(req, res));
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as { port: number };
  return `http://127.0.0.1:${port}/mcp`;
}

async function client(url: string, token?: string): Promise<Client> {
  const c = new Client({ name: "test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} } }));
  return c;
}

function rpc(url: string, body: unknown, token?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

const call = (name: string, args: unknown = {}) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

test("the café's tools are served as spec-valid MCP tools, every annotation sent explicitly", async () => {
  const url = await serve({ name: "cafe", version: "1.0.0", tools: cafeTools });
  const c = await client(url);
  const listed = await c.listTools();
  assert.ok(isSpecType.ListToolsResult(listed));
  assert.deepEqual(listed.tools.map((t) => t.name), ["get_menu", "place_order", "order_status"]);
  for (const t of listed.tools) assert.ok(isSpecType.Tool(t), `${t.name} is a spec Tool`);
  const place = listed.tools.find((t) => t.name === "place_order")!;
  assert.deepEqual(place.annotations, { title: "Place an order", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  assert.equal(place.inputSchema.type, "object");
  assert.equal(place.outputSchema?.type, "object");
  assert.deepEqual(place._meta, { securitySchemes: [{ type: "oauth2", scopes: [] }], "openai/toolInvocation/invoking": "Placing your order…", "openai/toolInvocation/invoked": "Order placed" });
  const status = listed.tools.find((t) => t.name === "order_status")!;
  assert.equal(status.title, "Order status", "derived from the name when the tool gives none");
  assert.deepEqual(status.annotations, { title: "Order status", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  await c.close();
});

test("only manually deferred tools leave the upfront list, and search returns their executable descriptors", async () => {
  const lookup = tool({ name: "invoice_lookup", description: "Look up an invoice.", input: z.object({ id: z.string() }), output: z.object({ id: z.string() }), mcp: { deferred: true }, signIn: "none", hints: { readOnly: true }, run: ({ id }) => ({ id }) });
  const archive = tool({ name: "invoice_archive", description: "Archive an invoice.", input: z.object({ id: z.string() }), mcp: { deferred: true }, run: () => "done" });
  const c = await client(await serve({ name: "test", version: "1", tools: [cafeTools[0]!, lookup, archive] }));
  try {
    assert.deepEqual((await c.listTools()).tools.map(t => t.name), ["get_menu", "search_tools", "execute_tool"]);
    const found = await c.callTool({ name: "search_tools", arguments: { query: "invoice_lookup", limit: 1 } });
    const matches = (found.structuredContent as { tools: Array<Record<string, unknown>> }).tools;
    assert.deepEqual(matches, [mcpServer({ name: "test", version: "1", tools: [lookup], deferred: [] }).descriptors[0]]);
    assert.deepEqual((await c.callTool({ name: "search_tools", arguments: { query: "get_menu" } })).structuredContent, { tools: [], total: 0 });
    const limited = (await c.callTool({ name: "search_tools", arguments: { query: "invoice", limit: 1 } })).structuredContent as { tools: unknown[]; total: number };
    assert.equal(limited.tools.length, 1);
    assert.equal(limited.total, 2, "a limited result reports that more matching tools exist");
    const full = await c.listTools({ _meta: { "flow.engineer/full-tool-catalog": true } }, { cacheMode: "refresh" });
    assert.deepEqual(full.tools.map(t => t.name), ["get_menu", "invoice_lookup", "invoice_archive"]);
    assert.deepEqual((await c.listTools({}, { cacheMode: "refresh" })).tools.map(t => t.name), ["get_menu", "search_tools", "execute_tool"]);
  } finally { await c.close(); }
});

test("the server can replace manual deferral, including promoting every tool with an empty list", () => {
  const marked = { ...cafeTools[0]!, mcp: { deferred: true } };
  const options = { name: "test", version: "1", tools: [marked, cafeTools[1]!] };
  assert.deepEqual(mcpServer({ ...options, deferred: [] }).descriptors.map(t => t.name), ["get_menu", "place_order"]);
  assert.deepEqual(mcpServer({ ...options, deferred: ["place_order"] }).descriptors.map(t => t.name), ["get_menu", "search_tools", "execute_tool"]);
  assert.throws(() => mcpServer({ ...options, deferred: ["missing"] }), /deferred tool missing does not exist/);
});

test("execute uses the target's validation, formatted result, context and trace name", async () => {
  let runs = 0;
  let seen: ToolContext | undefined;
  const events: Array<Record<string, unknown>> = [];
  const lookup = tool({ name: "invoice_lookup", description: "Look up an invoice.", input: z.object({ id: z.string() }), output: z.object({ id: z.string() }), mcp: { deferred: true }, signIn: "none", hints: { readOnly: true }, run: ({ id }, context) => { runs++; seen = context; return { id }; }, format: ({ id }) => `Invoice **${id}**` });
  const c = await client(await serve({ name: "test", version: "1", tools: [lookup], events: [e => { events.push(e); }] }));
  try {
    const result = await c.callTool({ name: "execute_tool", arguments: { name: "invoice_lookup", arguments: { id: "i1" } }, _meta: { "chinwag/idempotency-key": "request-1" } });
    assert.deepEqual(result, { content: [{ type: "text", text: "Invoice **i1**" }], structuredContent: { id: "i1" }, _meta: { "chinwag/formatted": true } });
    assert.equal(seen?.idempotencyKey, "request-1");
    assert.equal(seen?.channel, "mcp");
    assert.deepEqual(events.filter(e => e.type === "tool.start" || e.type === "tool.end").map(e => e.tool), ["invoice_lookup", "invoice_lookup"]);
    await assert.rejects(c.callTool({ name: "execute_tool", arguments: { name: "invoice_lookup", arguments: { id: 1 } } }), /Invalid arguments for invoice_lookup/);
    await assert.rejects(c.callTool({ name: "execute_tool", arguments: { name: "missing", arguments: {} } }), /No tool named missing/);
    await assert.rejects(c.callTool({ name: "execute_tool", arguments: { name: "execute_tool", arguments: {} } }), /No tool named execute_tool/);
    assert.equal(runs, 1);
  } finally { await c.close(); }
});

test("deferred execution challenges for the target's sign-in and read or write scope", async () => {
  const definition = { input: z.object({}), mcp: { deferred: true }, run: () => "ok" };
  const tools = [
    tool({ ...definition, name: "public", description: "Public.", signIn: "none", hints: { readOnly: true } }),
    tool({ ...definition, name: "read", description: "Read.", hints: { readOnly: true } }),
    tool({ ...definition, name: "write", description: "Write." }),
  ];
  const url = await serve({ name: "test", version: "1", tools, auth: { issuer: "https://login.example.com", scopes: { read: "read", write: "write" }, verify: token => token === "reader" ? { key: "person", scopes: ["read"] } : null } });
  const execute = (name: string) => call("execute_tool", { name, arguments: {} });
  assert.equal((await rpc(url, execute("public"))).status, 200);
  const anonymous = await rpc(url, execute("read"));
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate")!, /scope="read"/);
  assert.equal((await rpc(url, execute("read"), "reader")).status, 200);
  const write = await rpc(url, execute("write"), "reader");
  assert.equal(write.status, 403);
  assert.match(write.headers.get("www-authenticate")!, /insufficient_scope.*scope="read write"/);
});

test("generated discovery and execution descriptors can be renamed, or replaced with a team's tools", async () => {
  const deferred = { ...cafeTools[0]!, mcp: { deferred: true } };
  const c = await client(await serve({ name: "test", version: "1", tools: [deferred], descriptor: (t, d) => ({ ...d, name: t.name === "search_tools" ? "find_operations" : t.name === "execute_tool" ? "run_operation" : d.name }) }));
  try {
    assert.deepEqual((await c.listTools()).tools.map(t => t.name), ["find_operations", "run_operation"]);
    assert.ok((await c.callTool({ name: "find_operations", arguments: { query: "menu" } })).structuredContent);
    assert.equal((await c.callTool({ name: "run_operation", arguments: { name: "get_menu", arguments: {} } })).isError, undefined);
  } finally { await c.close(); }
  const own = ["search_tools", "execute_tool"].map(name => tool({ name, description: "Our own implementation.", input: z.object({}), signIn: "none", run: () => "ours" }));
  const replaced = await client(await serve({ name: "test", version: "1", tools: [deferred, ...own] }));
  try {
    for (const t of own) assert.deepEqual((await replaced.callTool({ name: t.name, arguments: {} })).content, [{ type: "text", text: "ours" }]);
  } finally { await replaced.close(); }
});

test("without a token a signed-in tool gets 401 before the SDK runs, and a signed-out one answers", async () => {
  const menu = tool({ name: "menu", description: "The menu.", input: z.object({}), signIn: "none", hints: { readOnly: true }, run: () => "latte" });
  const orders = tool({ name: "my_orders", description: "Their orders.", input: z.object({}), hints: { readOnly: true }, run: () => [] });
  const url = await serve({ name: "cafe", version: "1", tools: [menu, orders], auth: { issuer: "https://login.example.com", scopes: { read: "orders:read" }, verify: () => null } });

  const denied = await rpc(url, call("my_orders"));
  assert.equal(denied.status, 401);
  const header = denied.headers.get("www-authenticate")!;
  assert.match(header, /^Bearer error="invalid_token"/);
  assert.match(header, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.match(header, /scope="orders:read"/);

  const metadata = await (await fetch(header.match(/resource_metadata="([^"]+)"/)![1]!)).json();
  assert.deepEqual(metadata, { resource: url, authorization_servers: ["https://login.example.com"], bearer_methods_supported: ["header"], scopes_supported: ["orders:read"] });

  const c = await client(url);
  assert.deepEqual((await c.callTool({ name: "menu", arguments: {} })).content, [{ type: "text", text: "latte" }]);
  await c.close();
});

test("a valid token becomes the person, and a token without the write scope gets 403 insufficient_scope", async () => {
  let seen: ToolContext | undefined;
  const status = tool({ name: "status", description: "An order's status.", input: z.object({}), hints: { readOnly: true }, run: (_i, ctx) => ((seen = ctx), "ready") });
  const cancel = tool({ name: "cancel", description: "Cancel an order.", input: z.object({}), run: () => "cancelled" });
  const verify = (token: string) => (token === "sam-read" ? { key: "user-42", scopes: ["read"] } : null);
  const url = await serve({ name: "cafe", version: "1", tools: [status, cancel], auth: { issuer: "https://login.example.com", scopes: { read: "read", write: "write" }, verify } });

  const c = await client(url, "sam-read");
  await c.callTool({ name: "status", arguments: {} });
  assert.equal(seen?.person, "key:user-42");
  assert.equal(seen?.key, "user-42");
  assert.equal(seen?.channel, "mcp");
  await c.close();

  const refused = await rpc(url, call("cancel"), "sam-read");
  assert.equal(refused.status, 403);
  assert.match(refused.headers.get("www-authenticate")!, /error="insufficient_scope".*scope="read write"/);
  assert.equal((await rpc(url, call("status"), "someone-else")).status, 401, "an invalid token is refused whatever it calls");
});

// MCP access tokens identify callers; independent backend access must stay bound to that verified account even when calls overlap.
test("backend credentials are resolved by verified account, isolated across concurrent callers and absent from traces", async () => {
  const events: unknown[] = [];
  const seen: Array<{ key: string | null; context: string; credential: string }> = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let both!: () => void;
  const arrived = new Promise<void>(resolve => { both = resolve; });
  let waiting = 0;
  const backend = async (name: string, context: Readonly<Omit<ToolContext, "credentials">>, proof?: string) => {
      assert.equal(name, "api");
      if (++waiting === 2) both();
      await gate;
      return `private-api-${context.key}${proof ? `-${proof}` : ""}`;
  };
  const url = await serve({
    name: "test", version: "1", events: [e => { events.push(e); }],
    auth: { issuer: "https://login.example.com", verify: token => token === "sam" ? { key: token, credentials: (name, ctx) => backend(name, ctx, "request-proof") } : token === "ria" ? { key: token } : null },
    credentials: backend,
    tools: [tool({ name: "account", description: "Read their account.", input: z.object({ claimed_user: z.string() }), mcp: { deferred: true }, run: async (_input, context) => {
      const credential = await context.credentials!.get<string>("api");
      seen.push({ key: context.key, context: JSON.stringify(context), credential });
      return { account: context.key };
    } })],
  });
  const sam = await client(url, "sam"), ria = await client(url, "ria");
  try {
    const calls = Promise.all([sam.callTool({ name: "execute_tool", arguments: { name: "account", arguments: { claimed_user: "ria" } } }), ria.callTool({ name: "account", arguments: { claimed_user: "sam" } })]);
    await arrived;
    release();
    const results = await calls;
    assert.deepEqual(results.map(r => r.content), [[{ type: "text", text: '{"account":"sam"}' }], [{ type: "text", text: '{"account":"ria"}' }]]);
    assert.deepEqual(seen.map(s => [s.key, s.credential]).sort(), [["ria", "private-api-ria"], ["sam", "private-api-sam-request-proof"]]);
    assert.ok(seen.every(s => !s.context.includes("private-api") && !s.context.includes("credentials")));
    assert.ok(!JSON.stringify(events).includes("private-api"));
  } finally { release(); await Promise.all([sam.close(), ria.close()]); }
});

test("a tool that throws is an isError result, and output is checked and sent as structured content", async () => {
  const fails = tool({ name: "fails", description: "Fails.", input: z.object({}), mcp: { deferred: true }, signIn: "none", run: () => { throw new Error("the till is offline"); } });
  const order = z.object({ order_id: z.string() });
  const good = tool({ name: "good", description: "Places.", input: z.object({}), output: order, signIn: "none", run: () => ({ order_id: "BL-1" }) });
  const bad = tool({ name: "bad", description: "Places.", input: z.object({}), output: order, mcp: { deferred: true }, signIn: "none", run: () => ({ id: 1 }) });
  const c = await client(await serve({ name: "cafe", version: "1", tools: [fails, good, bad] }));

  for (const indirect of [false, true]) {
    const invoke = (name: string) => c.callTool(indirect ? { name: "execute_tool", arguments: { name, arguments: {} } } : { name, arguments: {} });
    assert.deepEqual(await invoke("fails"), { isError: true, content: [{ type: "text", text: "the till is offline" }] });
    assert.equal((await invoke("bad")).isError, true);
  }
  const placed = await c.callTool({ name: "good", arguments: {} });
  assert.deepEqual(placed.structuredContent, { order_id: "BL-1" });
  await c.close();
});

test("a tool's format is the result's text beside its structured content; a format that throws sends JSON, still a success", async () => {
  const events: unknown[] = [];
  const order = z.object({ order_id: z.string() });
  const formatted = tool({ name: "formatted", description: "Places.", input: z.object({}), output: order, signIn: "none", run: () => ({ order_id: "BL-1" }), format: (o) => `**Order ${o.order_id}** placed` });
  const broken = tool({ name: "broken", description: "Places.", input: z.object({}), output: order, signIn: "none", run: () => ({ order_id: "BL-2" }), format: () => { throw new Error("no template"); } });
  const c = await client(await serve({ name: "cafe", version: "1", tools: [formatted, broken], events: [e => { events.push(e); }] }));

  assert.deepEqual(await c.callTool({ name: "formatted", arguments: {} }), { content: [{ type: "text", text: "**Order BL-1** placed" }], structuredContent: { order_id: "BL-1" }, _meta: { "chinwag/formatted": true } });
  assert.deepEqual(await c.callTool({ name: "broken", arguments: {} }), { content: [{ type: "text", text: '{"order_id":"BL-2"}' }], structuredContent: { order_id: "BL-2" } });
  const ended = events.filter((e): e is { type: string; ok: boolean; formatError?: string } => (e as { type: string }).type === "tool.end");
  assert.deepEqual(ended.map(({ ok, formatError }) => ({ ok, formatError })), [{ ok: true, formatError: undefined }, { ok: true, formatError: "no template" }]);
  await c.close();
});

test("a served tool's context.records is the records given to mcpServer; without them its call says how to give them", async () => {
  const agent = createAgent({ files: { "AGENTS.md": "Test." }, model: { complete: () => Promise.reject(new Error("no model")) }, records: { notes: { people: ["about"] } }, scheduleCheckMs: 0 });
  const note = tool({ name: "note", description: "Keeps a note.", input: z.object({ text: z.string() }), signIn: "none", run: async ({ text }, context) => (await context.records.put("notes", "n1", { about: context.person, text }), { kept: true }) });
  const served = await client(await serve({ name: "cafe", version: "1", tools: [note], records: agent.records }));
  assert.equal((await served.callTool({ name: "note", arguments: { text: "oat milk" } })).isError, undefined);
  assert.equal((await agent.records.get<{ text: string }>("notes", "n1"))?.text, "oat milk");
  const without = await client(await serve({ name: "cafe", version: "1", tools: [note] }));
  assert.match(JSON.stringify(await without.callTool({ name: "note", arguments: { text: "x" } })), /not available here: give mcpServer\(\{ records: agent\.records \}\)/);
  await served.close();
  await without.close();
});

test("a served tool's context.events is the events side given to mcpServer, and absent without one", async () => {
  const events = flowEvents({ catalog: {}, log: () => {} });
  const watch = tool({ name: "watch", description: "Watches a topic.", input: z.object({ topic: z.string() }), signIn: "none", run: ({ topic }, context) => context.events?.watch({ address: "+15550100100", topic }).outcome ?? "no events side" });
  const served = await client(await serve({ name: "cafe", version: "1", tools: [watch], businessEvents: events }));
  assert.match(JSON.stringify(await served.callTool({ name: "watch", arguments: { topic: "order:1" } })), /saved/);
  assert.deepEqual(events.state.watches.map((w) => w.topic), ["order:1"]);
  const without = await client(await serve({ name: "cafe", version: "1", tools: [watch] }));
  assert.match(JSON.stringify(await without.callTool({ name: "watch", arguments: { topic: "order:2" } })), /no events side/);
  await served.close();
  await without.close();
});

test("skills are listed in the instructions and read with read_skill", async () => {
  const files = { "AGENTS.md": "# Pip\nThe chat agent's prompt.", "skills/allergens/SKILL.md": "---\nname: allergens\ndescription: questions about allergies\n---\nNever say an item is safe." };
  const c = await client(await serve({ name: "cafe", version: "1", tools: [], files }));
  assert.equal(c.getInstructions(), "This server's skills are rules for one kind of request each. Read a skill with read_skill before doing what it covers.\n- allergens: questions about allergies");
  const descriptor = (await c.listTools()).tools.find(t => t.name === "read_skill")!;
  assert.deepEqual(descriptor._meta?.["flow.engineer/skills"], [{ name: "allergens", description: "questions about allergies" }]);
  assert.ok(!JSON.stringify(descriptor).includes("Never say an item is safe"), "discovery carries summaries, not skill bodies");
  const read = await c.callTool({ name: "read_skill", arguments: { name: "allergens" } });
  assert.deepEqual(read.content, [{ type: "text", text: "Never say an item is safe." }]);
  await c.close();
});

test("a tool that cannot be described exactly is refused when the server is made", () => {
  const dated = tool({ name: "book", description: "Book.", input: z.object({ when: z.date() }), run: () => "ok" });
  assert.throws(() => mcpServer({ name: "x", version: "1", tools: [dated] }), /input has no exact JSON Schema/);
  const unshaped = tool({ name: "place", description: "Place.", input: z.object({}), run: () => "ok", format: () => "Placed" });
  assert.throws(() => mcpServer({ name: "x", version: "1", tools: [unshaped] }), /format needs output/);
});

// Plugin skills are native files; a host must not also receive their MCP copy.
test("plugin paths deliver tools once, share sign-in, and advertise their own resource", async () => {
  const events: unknown[] = [];
  const status = tool({ name: "status", description: "Status.", input: z.object({}), mcp: { deferred: true }, run: () => "ready" });
  const url = await serve({ name: "cafe", version: "1", tools: [status], files: { "skills/allergens/SKILL.md": "Allergy rules" }, events: [e => { events.push(e); }], auth: { issuer: "https://login.example.com", verify: token => token === "test" ? { key: "person" } : null } });
  const c = await client(`${url}/plugin`, "test");
  assert.deepEqual((await c.listTools()).tools.map(t => t.name), ["search_tools", "execute_tool"]);
  assert.equal(c.getInstructions(), undefined);
  await assert.rejects(c.callTool({ name: "read_skill", arguments: { name: "allergens" } }), /No tool named/);
  await assert.rejects(c.callTool({ name: "execute_tool", arguments: { name: "read_skill", arguments: { name: "allergens" } } }), /No tool named/);
  await c.callTool({ name: "status", arguments: {} });
  assert.ok(events.some(e => (e as any).surface === "mcp-plugin"));
  await c.close();
  const denied = await rpc(`${url}/plugin`, call("status"));
  assert.equal(denied.status, 401);
  const metadataUrl = denied.headers.get("www-authenticate")!.match(/resource_metadata="([^"]+)"/)![1]!;
  assert.ok(metadataUrl.endsWith("/mcp/plugin"));
  assert.equal((await (await fetch(metadataUrl)).json()).resource, `${url}/plugin`);
  const standalone = await client(url);
  assert.ok((await standalone.listTools()).tools.some(t => t.name === "read_skill"));
  assert.match(standalone.getInstructions()!, /allergens/);
  await standalone.close();
});

test("plugin routes can be moved or disabled and keep instruction overrides", async () => {
  const handle = mcpServer({ name: "cafe", version: "1", tools: [], plugin: { path: "/native" }, instructions: "Our own rules" });
  assert.equal(handle.plugin?.path, "/native");
  const url = await serve({ name: "cafe", version: "1", tools: [], plugin: { path: "/native" }, instructions: "Our own rules" });
  const c = await client(url.replace(/\/mcp$/, "/native"));
  assert.equal(c.getInstructions(), "Our own rules");
  await c.close();
  const disabled = mcpServer({ name: "cafe", version: "1", tools: [], plugin: false });
  assert.equal(disabled.plugin, undefined);
  assert.equal((await disabled.fetch(new Request("http://127.0.0.1/mcp/plugin"))).status, 404);
});
