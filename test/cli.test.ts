// covers: cli/src/run.ts cli/src/commands.ts cli/src/auth.ts cli/src/terminal.ts mcp/src/server.ts mcp/src/terminal.ts src/agent.ts src/channels.ts
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { z } from "zod";
import { defineCli, runCli, type CliConfig, type CliIO } from "../cli/src/index.ts";
import { terminalServer, mcpServer, type McpServerOptions } from "../mcp/src/index.ts";
import { scriptedModel, respond, call } from "./helpers.ts";
import { createAgent, tool } from "../src/index.ts";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function listen(handler: RequestListener): Promise<string> {
  const http = createServer(handler);
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(http.address() as { port: number }).port}`;
}

async function serve(options: Omit<McpServerOptions, "name" | "version">): Promise<string> {
  const handle = mcpServer({ name: "acme", version: "1", ...options });
  return `${await listen((req, res) => void handle.node(req, res))}/mcp`;
}

function io(interactive = false, answer = false) {
  const streams = { out: "", err: "" };
  const channel: CliIO = { write: (t) => void (streams.out += t), writeError: (t) => void (streams.err += t), interactive, confirm: async () => answer };
  return {
    channel,
    get out() {
      return streams.out;
    },
    get err() {
      return streams.err;
    },
  };
}

const orders = [
  { order_id: "BL-1042", status: "ready", total: 4.8, items: ["latte"] },
  { order_id: "BL-1043", status: "making", total: 9.6, items: ["chai", "chai"] },
];
const listOrders = tool({
  name: "list_orders",
  description: "Their orders.",
  input: z.object({ status: z.enum(["ready", "making"]).optional(), limit: z.number().int().optional() }),
  output: z.object({ orders: z.array(z.object({ order_id: z.string(), status: z.string(), total: z.number(), items: z.array(z.string()) })) }),
  signIn: "none",
  hints: { readOnly: true },
  run: ({ status, limit }) => ({ orders: orders.filter((o) => !status || o.status === status).slice(0, limit ?? 10) }),
});
const getOrder = tool({ name: "get_order", description: "One order.", input: z.object({ order_id: z.string() }), signIn: "none", hints: { readOnly: true }, run: ({ order_id }) => orders.find((o) => o.order_id === order_id) ?? null });
let cancelled: string[] = [];
const cancelOrder = tool({ name: "cancel_order", description: "Cancel an order.", input: z.object({ order_id: z.string() }), signIn: "none", run: ({ order_id }) => (cancelled.push(order_id), { cancelled: order_id }) });

const acme = (server: string): CliConfig =>
  defineCli({
    name: "acme",
    server,
    commands: {
      "order list": { tool: "list_orders", columns: ["order_id", "status", "total"], alias: "orders" },
      "order view": { tool: "get_order", args: ["order_id"] },
    },
  });

test("commands come from the CLI file and the tools: positionals, flags, --json and --fields", async () => {
  const cli = acme(await serve({ tools: [listOrders, getOrder, cancelOrder] }));
  const view = io();
  assert.equal(await runCli(cli, ["order", "view", "BL-1042", "--json", "--fields", "order_id,status"], view.channel), 0);
  assert.deepEqual(JSON.parse(view.out), { order_id: "BL-1042", status: "ready" });

  const table = io();
  assert.equal(await runCli(cli, ["orders", "--status", "making"], table.channel), 0);
  assert.equal(table.out, "ORDER_ID  STATUS  TOTAL\nBL-1043   making  9.6\n");
});

test("a group's help lists its subcommands, and the top level lists groups and commands", async () => {
  const cli = acme(await serve({ tools: [listOrders, getOrder, cancelOrder] }));
  for (const argv of [["order"], ["order", "-h"]]) {
    const group = io();
    assert.equal(await runCli(cli, argv, group.channel), 0);
    assert.match(group.out, /COMMANDS\n {2}list +Their orders\.|COMMANDS\n {2}list +List orders/);
    assert.match(group.out, /\n {2}view +One order|\n {2}view +Get order/);
  }
  const top = io();
  assert.equal(await runCli(cli, ["--help"], top.channel), 0);
  assert.match(top.out, /\n {2}order +list, view\n/, "the group, with its subcommands as its line");
  assert.match(top.out, /\n {2}chat +Chat with/);
  assert.doesNotMatch(top.out, /\n {2}ask +/);
  assert.match(top.out, /\n {2}cancel-order +Cancel order\n/, "a tool the file does not name keeps its own name");
  assert.doesNotMatch(top.out.slice(top.out.indexOf("COMMANDS")), /\n {2}(list|view) /, "subcommands are not listed at the top");
});

test("a write shows its call with --dry-run, and one that may delete needs --yes without a terminal", async () => {
  cancelled = [];
  const cli = acme(await serve({ tools: [listOrders, getOrder, cancelOrder] }));
  const dry = io();
  assert.equal(await runCli(cli, ["cancel-order", "--order-id", "BL-1042", "--dry-run", "--json"], dry.channel), 0);
  assert.deepEqual(JSON.parse(dry.out), { dryRun: true, tool: "cancel_order", arguments: { order_id: "BL-1042" } });

  const refused = io();
  assert.equal(await runCli(cli, ["cancel-order", "--order-id", "BL-1042"], refused.channel), 4);
  assert.match(refused.err, /run it again with --yes/);
  const declined = io(true, false);
  assert.equal(await runCli(cli, ["cancel-order", "--order-id", "BL-1042"], declined.channel), 4);
  assert.deepEqual(cancelled, [], "nothing was sent before a yes");

  assert.equal(await runCli(cli, ["cancel-order", "--order-id", "BL-1042", "--yes"], io().channel), 0);
  assert.deepEqual(cancelled, ["BL-1042"]);
});

test("wrong arguments exit 2 with what is wrong and the help to read, before anything is sent", async () => {
  const cli = acme(await serve({ tools: [listOrders, getOrder, cancelOrder] }));
  const unknown = io();
  assert.equal(await runCli(cli, ["order", "list", "--colour", "red"], unknown.channel), 2);
  assert.match(unknown.err, /--colour/);
  assert.match(unknown.err, /Run `acme order list --help`/);
  const missing = io();
  assert.equal(await runCli(cli, ["order", "view"], missing.channel), 2);
  assert.match(missing.err, /order_id/);
  const badEnum = io();
  assert.equal(await runCli(cli, ["orders", "--status", "lost"], badEnum.channel), 2);
  const typo = io();
  assert.equal(await runCli(cli, ["ordr"], typo.channel), 2);
  assert.match(typo.err, /did you mean `order`/);
});

test("auth login signs in on the organization's own login, and the token is kept at mode 600", async () => {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "chinwag-cli-"));
  let issuer = "", registrations = 0;
  issuer = await listen(async (req, res) => {
    const url = new URL(req.url!, issuer);
    const body = await new Promise<string>((resolve) => {
      let b = "";
      req.on("data", (c) => (b += c)).on("end", () => resolve(b));
    });
    const json = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    }
    if (url.pathname === "/register") { registrations++; return json(201, { ...JSON.parse(body), client_id: "cli-1" }); }
    if (url.pathname === "/authorize") {
      // The person signs in on the organization's page; here the page approves at once.
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", "code-1");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      back.searchParams.set("iss", issuer);
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (url.pathname === "/token") return json(200, { access_token: "tok-1", token_type: "Bearer", expires_in: 3600, refresh_token: "ref-1" });
    res.writeHead(404).end();
  });
  const mine = tool({ name: "my_orders", description: "Their orders.", input: z.object({}), hints: { readOnly: true }, run: (_i, ctx) => ({ for: ctx.key }) });
  const server = await serve({ tools: [mine], auth: { issuer, verify: (t) => (t === "tok-1" ? { key: "user-7" } : null) } });
  const cli: CliConfig = {
    ...defineCli({ name: "acme", server }),
    openUrl: async (link) => {
      const page = await fetch(link, { redirect: "manual" });
      await fetch(page.headers.get("location")!);
    },
  };

  const before = io();
  assert.equal(await runCli(cli, ["my-orders"], before.channel), 3, "signed out, a signed-in tool asks for sign-in");
  assert.match(before.err, /acme auth login/);

  assert.equal(await runCli(cli, ["auth", "login"], io().channel), 0);
  assert.equal(statSync(join(process.env.XDG_CONFIG_HOME, "acme", "auth.json")).mode & 0o777, 0o600);
  const after = io();
  assert.equal(await runCli(cli, ["my-orders", "--json"], after.channel), 0);
  assert.deepEqual(JSON.parse(after.out), { for: "user-7" });
  assert.equal(registrations, 1);
  const registered = { ...cli, name: "registered-client", clientId: "known-client" };
  assert.equal(await runCli(registered, ["auth", "login"], io().channel), 0);
  assert.equal(registrations, 1, "an existing provider's registered client never requires DCR");
});

// Tool argument tests cannot prove that the server receives CLI metadata outside arguments.
test("CLI tool calls identify their command without adding metadata to tool arguments", async () => {
  const events: any[] = [];
  const cli = acme(await serve({ tools: [listOrders, getOrder], events: [e => { events.push(e); }] }));
  assert.equal(await runCli(cli, ["order", "view", "BL-1042", "--json"], io().channel), 0);
  const start = events.find(e => e.type === "tool.start");
  assert.equal(start.surface, "cli");
  assert.equal(start.command, "order view");
  assert.equal(start.client, "acme-cli");
  assert.deepEqual(start.input, { order_id: "BL-1042" });
});

// MCP command tests never speak to an agent, so they cannot check auth, identity or chat state.
test("single-message and interactive chat use the authenticated agent terminal, preserve identity and never call MCP", async (t) => {
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "chinwag-terminal-"));
  t.after(() => { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; });
  const scripted = scriptedModel();
  let agent: ReturnType<typeof createAgent>;
  const terminal = terminalServer({ agent: () => agent, auth: { verify: token => token === "test" ? { key: "user-7", credentials: async (name, ctx) => { assert.equal(name, "api"); assert.equal(ctx.key, "user-7"); return "request-bound-backend"; } } : null } });
  let seenKey: string | null = null;
  const mine = tool({ name: "mine", description: "Who this is for.", input: z.object({}), run: async (_i, ctx) => { seenKey = ctx.key; assert.equal(await ctx.credentials!.get("api"), "request-bound-backend"); return "the test person's orders"; } });
  agent = createAgent({ files: { "AGENTS.md": "Test agent" }, model: scripted.model, channels: [terminal.channel], tools: [mine], debounceMs: 0, scheduleCheckMs: 0 });
  const base = await listen(async (req, res) => {
    assert.equal(req.url, "/agent/terminal", "chat must not fetch the MCP tools");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const result = await terminal.fetch(new Request(`${base}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: Buffer.concat(chunks) }));
    res.writeHead(result.status, Object.fromEntries(result.headers)).end(await result.text());
  });
  const cli = defineCli({ name: "terminal-test", server: `${base}/mcp` });
  const refused = io();
  assert.equal(await runCli(cli, ["chat"], refused.channel), 2);
  assert.match(refused.err, /terminal-test chat "<message>"/);
  assert.equal(await runCli(cli, ["chat", "who am I?"], io().channel), 3);
  const out = io();
  const single = runCli(cli, ["chat", "who am I?", "--json", "--token", "test"], out.channel);
  (await Promise.race([scripted.nextCall(0), single.then(code => { throw new Error(`chat finished before model call: ${code} ${out.err}`); })])).answer(respond(call("send_terminal", { text: "Checking." }), call("mine", {})));
  (await scripted.nextCall(1)).answer(respond(call("send_terminal", { text: "Here are your orders." })));
  assert.equal(await single, 0);
  assert.equal(seenKey, "user-7");
  const first = JSON.parse(out.out);
  assert.equal(first.replies.filter((r: any) => r.type === "message").at(-1).text, "Here are your orders.");
  const interactive = io(true);
  interactive.channel.lines = async function* () { yield "one"; yield "two"; yield "three"; yield "/exit"; };
  const chat = runCli(cli, ["chat", "--json", "--token", "test"], interactive.channel);
  for (let n = 0; n < 3; n++) (await scripted.nextCall(n + 2)).answer(respond(call("send_terminal", { text: `reply ${n}` })));
  assert.equal(await chat, 0);
  assert.deepEqual(interactive.out.trim().split("\n").map(line => JSON.parse(line).conversationId), [first.conversationId, first.conversationId, first.conversationId]);
  assert.equal(interactive.err, "Type /exit or press Ctrl-D to leave.\n", "JSON chat has no presentation or progress text");
  assert.equal(statSync(join(process.env.XDG_CONFIG_HOME!, "terminal-test/chat.json")).mode & 0o777, 0o600);
  const other = await terminal.fetch(new Request(`${base}/agent/terminal`, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ text: "stolen", conversationId: "another-person" }) }));
  assert.equal(other.status, 500);
  assert.match((await terminal.fetch(new Request(`${base}/agent/terminal`, { method: "POST" }))).status.toString(), /401/);
});

// Auth/state coverage above checks JSON only; it cannot catch an unlabeled human transcript.
test("human chat distinguishes input, waiting and agent replies", async (t) => {
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "chinwag-chat-presentation-"));
  t.after(() => { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; });
  let received!: () => void, release!: () => void;
  const requested = new Promise<void>(resolve => { received = resolve; });
  const response = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  const base = await listen(async (req, res) => {
    assert.equal(req.url, "/agent/terminal");
    assert.equal(req.headers.authorization, "Bearer test");
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    assert.equal(JSON.parse(Buffer.concat(chunks).toString()).text, "hello");
    received();
    await response;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ conversationId: "person-1", replies: [{ type: "typing", on: true }, { type: "message", text: "Checking." }, { type: "message", text: "Here is the answer." }] }));
  });
  const out = io(true);
  let prompt: string | undefined;
  out.channel.lines = async function* (value) { prompt = value; yield "hello"; yield "/exit"; };
  const chat = runCli(defineCli({ name: "acme", server: `${base}/mcp` }), ["chat", "--token", "test"], out.channel);
  await requested;
  assert.match(prompt!, /You.*› /);
  assert.match(out.err, /acme chat/);
  assert.match(out.err, /Waiting for reply/);
  assert.equal(out.out, "", "a reply is not printed before the server answers");
  release();
  assert.equal(await chat, 0);
  assert.equal(out.out, "\nacme\nChecking.\n\nHere is the answer.\n\n");
  assert.doesNotMatch(out.out, /typing|person-1/);
});
