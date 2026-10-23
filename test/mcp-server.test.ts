// covers: mcp/src/server.ts mcp/src/describe.ts src/skills.ts src/tools.ts
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { isSpecType } from "@modelcontextprotocol/server";
import { z } from "zod";
import { tools as cafeTools } from "../examples/cafe/src/tools.ts";
import { mcpServer, type McpServerOptions } from "../mcp/src/index.ts";
import { tool, type ToolContext } from "../src/index.ts";

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
    tools: [tool({ name: "account", description: "Read their account.", input: z.object({ claimed_user: z.string() }), run: async (_input, context) => {
      const credential = await context.credentials!.get<string>("api");
      seen.push({ key: context.key, context: JSON.stringify(context), credential });
      return { account: context.key };
    } })],
  });
  const sam = await client(url, "sam"), ria = await client(url, "ria");
  try {
    const calls = Promise.all([sam.callTool({ name: "account", arguments: { claimed_user: "ria" } }), ria.callTool({ name: "account", arguments: { claimed_user: "sam" } })]);
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
  const fails = tool({ name: "fails", description: "Fails.", input: z.object({}), signIn: "none", run: () => { throw new Error("the till is offline"); } });
  const order = z.object({ order_id: z.string() });
  const good = tool({ name: "good", description: "Places.", input: z.object({}), output: order, signIn: "none", run: () => ({ order_id: "BL-1" }) });
  const bad = tool({ name: "bad", description: "Places.", input: z.object({}), output: order, signIn: "none", run: () => ({ id: 1 }) });
  const c = await client(await serve({ name: "cafe", version: "1", tools: [fails, good, bad] }));

  assert.deepEqual(await c.callTool({ name: "fails", arguments: {} }), { isError: true, content: [{ type: "text", text: "the till is offline" }] });
  const placed = await c.callTool({ name: "good", arguments: {} });
  assert.deepEqual(placed.structuredContent, { order_id: "BL-1" });
  assert.equal((await c.callTool({ name: "bad", arguments: {} })).isError, true);
  await c.close();
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
});

// Plugin skills are native files; a host must not also receive their MCP copy.
test("plugin paths deliver tools once, share sign-in, and advertise their own resource", async () => {
  const events: unknown[] = [];
  const status = tool({ name: "status", description: "Status.", input: z.object({}), run: () => "ready" });
  const url = await serve({ name: "cafe", version: "1", tools: [status], files: { "skills/allergens/SKILL.md": "Allergy rules" }, events: [e => { events.push(e); }], auth: { issuer: "https://login.example.com", verify: token => token === "test" ? { key: "person" } : null } });
  const c = await client(`${url}/plugin`, "test");
  assert.deepEqual((await c.listTools()).tools.map(t => t.name), ["status"]);
  assert.equal(c.getInstructions(), undefined);
  await assert.rejects(c.callTool({ name: "read_skill", arguments: { name: "allergens" } }), /No tool named/);
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
