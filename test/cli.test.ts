// covers: cli/src/run.ts cli/src/commands.ts cli/src/auth.ts cli/src/terminal.ts mcp/src/server.ts mcp/src/terminal.ts src/skills.ts src/agent.ts src/channels.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { z } from "zod";
import { buildCommand } from "@stricli/core";
import { cliProblems, defineCli, runCli, type CliConfig, type CliIO } from "../cli/src/index.ts";
import { signOut, storedProvider } from "../cli/src/auth.ts";
import { terminalServer, mcpServer, type McpServerOptions } from "../mcp/src/index.ts";
import { scriptedModel, respond, call } from "./helpers.ts";
import { createAgent, tool } from "../src/index.ts";

const servers: Server[] = [];
const testDirectory = mkdtempSync(join(tmpdir(), "flow-cli-tests-"));
after(() => servers.forEach((s) => s.close()));
after(() => rmSync(testDirectory, { recursive: true, force: true }));

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
  input: z.object({ status: z.enum(["ready", "making"]).optional(), limit: z.number().int().max(50).optional() }),
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
    directory: mkdtempSync(join(testDirectory, "cli-")),
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

// The old skill smoke test checked only exit status; it cannot protect selective discovery or multi-skill reads.
test("skill lists summaries and reads only selected skills, including the generated CLI guide", async () => {
  const events: any[] = [];
  let connections = 0;
  const files = {
    "AGENTS.md": "Private agent instructions",
    "skills/booking/SKILL.md": "---\nname: booking\ndescription: Move a booking\n---\nOffer three slots.",
    "skills/refunds/SKILL.md": "---\nname: refunds\ndescription: Handle a refund\n---\nCheck the refund policy first.",
  };
  const handle = mcpServer({ name: "acme", version: "1", tools: [listOrders], files, events: [event => { events.push(event); }] });
  const server = `${await listen((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => { if (body && JSON.parse(body).method === "initialize") connections++; });
    void handle.node(req, res);
  })}/mcp`;
  const cli = acme(server);
  cli.commands = {
    ...cli.commands,
    "report local": { command: buildCommand({ docs: { brief: "A handwritten report" }, parameters: {}, func() {} }) },
  };
  const listed = io();
  assert.equal(await runCli(cli, ["skill", "list", "--json"], listed.channel), 0);
  assert.deepEqual(JSON.parse(listed.out), [
    { name: "acme-cli", description: "How to use the acme command line" },
    { name: "booking", description: "Move a booking" },
    { name: "refunds", description: "Handle a refund" },
  ]);
  assert.equal(events.filter(e => e.type === "tool.start").length, 0, "listing never reads skill bodies");
  const defaults = io();
  assert.equal(await runCli(cli, ["skill"], defaults.channel), 0);
  assert.match(defaults.out, /booking +Move a booking/);
  assert.doesNotMatch(defaults.out, /Offer three slots|JSON output schema|order list|Private agent instructions/);
  const got = io();
  connections = 0;
  assert.equal(await runCli(cli, ["skill", "get", "booking", "refunds", "--json"], got.channel), 0);
  assert.equal(connections, 1, "batch reads share one MCP connection");
  const records = JSON.parse(got.out);
  assert.deepEqual(records.map((s: any) => s.name), ["booking", "refunds"]);
  assert.match(records[0].content, /name: booking[\s\S]*Offer three slots/);
  assert.match(records[1].content, /Check the refund policy first/);
  assert.doesNotMatch(got.out, /Private agent instructions|JSON output schema/);
  assert.deepEqual(events.filter(e => e.type === "tool.start").map(e => e.input.name).sort(), ["booking", "refunds"]);
  const guide = io();
  assert.equal(await runCli(cli, ["skill", "get", "acme-cli"], guide.channel), 0);
  assert.match(guide.out, /name: acme-cli/);
  assert.match(guide.out, /### acme report local[\s\S]*A handwritten report/);
  assert.match(guide.out, /acme report local --help/);
  assert.match(guide.out, /MCP tool: `list_orders`/);
  assert.equal(events.filter(e => e.type === "tool.start").length, 2, "the generated guide is local");
  const plain = io();
  assert.equal(await runCli(cli, ["skill", "get", "refunds", "booking"], plain.channel), 0);
  assert.match(plain.out, /# Skill: refunds[\s\S]*Check the refund policy first[\s\S]*# Skill: booking[\s\S]*Offer three slots/);
  const before = events.filter(e => e.type === "tool.start").length;
  for (const args of [["get"], ["list", "booking"], ["unknown"], ["get", "booking", "missing"]]) {
    assert.equal(await runCli(cli, ["skill", ...args], io().channel), 2);
  }
  assert.equal(events.filter(e => e.type === "tool.start").length, before, "an invalid batch is refused before reading any body");
  const folder = mkdtempSync(join(testDirectory, "skills-export-"));
  assert.equal(await runCli(cli, ["skill", "get", "booking", "refunds", "--write", folder], io().channel), 0);
  assert.deepEqual(readdirSync(folder).sort(), ["booking", "refunds"]);
  assert.equal(readFileSync(join(folder, "booking", "SKILL.md"), "utf8"), records[0].content);
  assert.equal(readFileSync(join(folder, "refunds", "SKILL.md"), "utf8"), records[1].content);
  assert.equal(await runCli(cli, ["skill", "--write", folder], io().channel), 0);
  assert.match(readFileSync(join(folder, "acme-cli", "SKILL.md"), "utf8"), /### acme order list/);
});

// New clients must still discover names on older servers, preserve authored overrides, and prevent remote names escaping export folders.
test("skill supports legacy MCP discovery and authored overrides while refusing unsafe export names", async () => {
  const cli = acme(await serve({ tools: [], files: {
    "skills/guide/SKILL.md": "---\nname: acme-cli\ndescription: Our own CLI guide\n---\nUse our custom workflow.",
    "skills/unsafe/SKILL.md": "---\nname: ../outside\ndescription: Unsafe folder name\n---\nInstructions.",
  }, descriptor: (_tool, descriptor) => {
    const _meta = { ...descriptor._meta };
    delete _meta["flow.engineer/skills"];
    return { ...descriptor, _meta };
  } }));
  const listed = io();
  assert.equal(await runCli(cli, ["skill", "list", "--json"], listed.channel), 0);
  assert.deepEqual(JSON.parse(listed.out), [{ name: "../outside", description: "" }, { name: "acme-cli", description: "" }]);
  const read = io();
  assert.equal(await runCli(cli, ["skill", "get", "acme-cli"], read.channel), 0);
  assert.match(read.out, /Use our custom workflow/);
  assert.doesNotMatch(read.out, /## Commands/);
  const folder = mkdtempSync(join(testDirectory, "skills-safe-"));
  const error = io();
  assert.equal(await runCli(cli, ["skill", "get", "acme-cli", "../outside", "--write", folder], error.channel), 2);
  assert.match(error.err, /single folder name/);
  assert.deepEqual(readdirSync(folder), [], "the whole export is validated before any files are written");
  assert.equal(await runCli(cli, ["skill", "--write", folder], io().channel), 0, "legacy export remains the generated guide");
  assert.match(readFileSync(join(folder, "acme-cli", "SKILL.md"), "utf8"), /## Commands/);
});

// A fresh skill may be absent from the cached catalog even when its get invocation parses correctly.
test("skill get refreshes an unknown cached name before reading it", async () => {
  let handle = mcpServer({ name: "acme", version: "1", tools: [], files: { "skills/old/SKILL.md": "---\nname: old\ndescription: Old\n---\nOld instructions." } });
  const server = `${await listen((req, res) => void handle.node(req, res))}/mcp`;
  const cli = acme(server);
  assert.equal(await runCli(cli, ["skill", "list"], io().channel), 0);
  handle = mcpServer({ name: "acme", version: "1", tools: [], files: { "skills/new/SKILL.md": "---\nname: new\ndescription: New\n---\nNew instructions." } });
  const got = io();
  assert.equal(await runCli(cli, ["skill", "get", "new"], got.channel), 0);
  assert.match(got.out, /New instructions/);
});

// Existing command tests check output, but cannot detect extra connections or tools/list requests.
test("discovery survives invocations: cached help, tools and dry runs stay offline; calls connect without listing again", async () => {
  let requests = 0, lists = 0;
  const handle = mcpServer({ name: "acme", version: "1", tools: [listOrders, cancelOrder] });
  const server = `${await listen((req, res) => {
    requests++;
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => { if (body && JSON.parse(body).method === "tools/list") lists++; });
    void handle.node(req, res);
  })}/mcp`;
  const base = acme(server);
  const cli = { ...base, directory: mkdtempSync(join(testDirectory, "flow-cli-discovery-")), commands: {
    ...base.commands,
    local: { command: buildCommand({ docs: { brief: "Local output" }, parameters: {}, func() {} }) },
    proxy: { command: buildCommand({ docs: { brief: "Custom tool call" }, parameters: {}, async func(this: import("../cli/src/commands.ts").CliContext) { this.cli.print(await this.cli.call("list_orders", {}), { json: true }); } }) },
  } };
  assert.equal(await runCli(cli, ["--help"], io().channel), 0);
  assert.equal(lists, 1);
  const before = requests;
  for (const argv of [["--help"], ["order"], ["order", "list", "--help"], ["tools", "--json"], ["skill"], ["local"], ["proxy", "--help"], ["cancel-order", "--order-id", "1", "--dry-run"]]) {
    assert.equal(await runCli({ ...cli }, argv, io().channel), 0);
  }
  assert.equal(requests, before, "a fresh disk cache needs no MCP connection");
  const result = io();
  assert.equal(await runCli(cli, ["order", "list", "--json"], result.channel), 0);
  assert.deepEqual(JSON.parse(result.out), { orders });
  assert.ok(requests > before, "executing a tool still connects");
  assert.equal(lists, 1, "execution reuses discovery");
  const custom = io();
  assert.equal(await runCli(cli, ["proxy"], custom.channel), 0);
  assert.deepEqual(JSON.parse(custom.out), { orders });
  assert.equal(lists, 1, "custom commands also connect lazily without discovery");
  const http = servers.at(-1)!;
  await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
  const offline = io();
  assert.equal(await runCli(cli, ["order", "list", "-h"], offline.channel), 0);
  assert.match(offline.out, /--status/);
  assert.equal(await runCli(cli, ["order", "list"], io().channel), 5, "cached tools do not mask a connection failure");
});

// No existing test exercises discovery freshness, malformed disk state or optional persistence.
test("old discovery is used immediately and refreshed in the background; bypass, corruption and disabled persistence fetch directly", async () => {
  let lists = 0, unavailable = false;
  const handle = mcpServer({ name: "acme", version: "1", tools: [listOrders] });
  const server = `${await listen((req, res) => {
    if (unavailable) { res.writeHead(503).end(); return; }
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => { if (body && JSON.parse(body).method === "tools/list") lists++; });
    void handle.node(req, res);
  })}/mcp`;
  const cli = { ...acme(server), directory: mkdtempSync(join(testDirectory, "flow-cli-discovery-")) };
  const background: Array<() => Promise<void>> = [];
  const run = (config: CliConfig = cli, argv = ["tools", "--json"]) => runCli(config, argv, { ...io().channel, background: work => { background.push(work); } });
  assert.equal(await run(), 0);
  const file = join(cli.directory, "discovery", readdirSync(join(cli.directory, "discovery"))[0]!);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(saved.server, { name: "acme", version: "1" });
  writeFileSync(file, JSON.stringify({ ...saved, at: Date.now() - 5 * 60_000 }));
  assert.equal(await run(), 0);
  assert.equal(lists, 1, "old descriptors render immediately without waiting for discovery");
  assert.equal(background.length, 1);
  assert.equal(await run(), 0);
  assert.equal(background.length, 1, "concurrent commands share one refresh lease");
  await background.shift()!();
  assert.equal(lists, 2);
  assert.equal(await run(cli, ["tools", "--refresh-tools", "--json"]), 0);
  assert.equal(lists, 3);
  writeFileSync(file, "invalid json");
  assert.equal(await run(), 0);
  assert.equal(lists, 4);
  assert.equal(await run({ ...cli, discoveryCache: { maxAgeMs: 0 } }), 0);
  assert.equal(lists, 4);
  await background.shift()!();
  assert.equal(lists, 5);
  assert.equal(await run({ ...cli, discoveryCache: false }), 0);
  assert.equal(await run({ ...cli, discoveryCache: false }), 0);
  assert.equal(lists, 7);
  assert.equal(await run({ ...cli, directory: file }), 0, "a config path that cannot be written does not break discovery");
  assert.equal(lists, 8);
  const latest = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...latest, at: Date.now() - 5 * 60_000, checkedAt: undefined }));
  unavailable = true;
  const offline = io();
  assert.equal(await runCli(cli, ["tools", "--json"], { ...offline.channel, background: work => { background.push(work); } }), 0);
  await background.shift()!();
  assert.equal(offline.err, "", "background failure does not pollute foreground output");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).tools, latest.tools, "the last usable definitions survive refresh failure");
  assert.equal(await run(), 0);
  assert.equal(background.length, 0, "an unavailable server does not cause a refresh process on every command");
});

// Cache-hit tests do not exercise recovery before execution when a deployment changes flags or names.
test("cached parser failures refresh once and run the updated command exactly once", async () => {
  let calls = 0, lists = 0;
  let handle = mcpServer({ name: "acme", version: "1", tools: [listOrders] });
  const server = `${await listen((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => { if (body && JSON.parse(body).method === "tools/list") lists++; });
    void handle.node(req, res);
  })}/mcp`;
  const cli = { ...acme(server), directory: mkdtempSync(join(testDirectory, "flow-cli-recovery-")) };
  assert.equal(await runCli(cli, ["--help"], io().channel), 0);
  const updated = tool({ name: "list_orders", description: "Updated orders", input: z.object({ state: z.enum(["done"]) }), signIn: "none", hints: { readOnly: true }, run: input => { calls++; return input; } });
  // Deliberately keep the version unchanged: parser recovery must not depend on a version bump.
  handle = mcpServer({ name: "acme", version: "1", tools: [updated] });
  const output = io();
  assert.equal(await runCli(cli, ["order", "list", "--state", "done", "--json"], output.channel), 0);
  assert.deepEqual(JSON.parse(output.out), { state: "done" });
  assert.equal(output.err, "", "the stale parser's error is never printed");
  assert.equal(calls, 1);
  assert.equal(lists, 2);
  const newTool = tool({ name: "new_tool", description: "New command", input: z.object({}), signIn: "none", hints: { readOnly: true }, run: () => { calls++; return "new"; } });
  handle = mcpServer({ name: "acme", version: "1", tools: [updated, newTool] });
  assert.equal(await runCli(cli, ["new-tool"], io().channel), 0);
  assert.equal(calls, 2);
  assert.equal(lists, 3);
  assert.equal(await runCli(cli, ["typo"], io().channel), 2);
  assert.equal(lists, 4, "a genuine typo refreshes only once");
  assert.equal(calls, 2);
});

// A version change can make a previously read-only command destructive; parsing recovery alone cannot protect it.
test("a changed MCP version refreshes approval flags before any tool call", async () => {
  let calls = 0;
  let handle = mcpServer({ name: "acme", version: "1", tools: [getOrder] });
  const server = `${await listen((req, res) => void handle.node(req, res))}/mcp`;
  const cli = { ...acme(server), directory: mkdtempSync(join(testDirectory, "flow-cli-version-")) };
  assert.equal(await runCli(cli, ["--help"], io().channel), 0);
  handle = mcpServer({ name: "acme", version: "2", tools: [{ ...getOrder, hints: { destructive: true }, run: () => { calls++; return "changed"; } }] });
  const denied = io();
  assert.equal(await runCli(cli, ["order", "view", "123"], denied.channel), 4);
  assert.match(denied.err, /--yes/);
  assert.equal(calls, 0);
  assert.equal(await runCli(cli, ["order", "view", "123", "--yes"], io().channel), 0);
  assert.equal(calls, 1);
});

// The server can reject arguments after a successful local parse; that must refresh definitions without replaying the request.
test("server argument errors refresh the cache but never resubmit a tool request", async () => {
  let requests = 0, calls = 0;
  let handle = mcpServer({ name: "acme", version: "1", tools: [getOrder] });
  const server = `${await listen((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => { if (body && JSON.parse(body).method === "tools/call") requests++; });
    void handle.node(req, res);
  })}/mcp`;
  const cli = { ...acme(server), directory: mkdtempSync(join(testDirectory, "flow-cli-rejected-")) };
  assert.equal(await runCli(cli, ["--help"], io().channel), 0);
  const updated = { ...getOrder, input: z.object({ order_id: z.string(), region: z.string() }), run: () => { calls++; return "ok"; } };
  handle = mcpServer({ name: "acme", version: "1", tools: [updated] });
  const rejected = io();
  assert.equal(await runCli(cli, ["order", "view", "123"], rejected.channel), 2);
  assert.match(rejected.err, /--region/);
  assert.equal(requests, 1);
  assert.equal(calls, 0);
  const help = io();
  assert.equal(await runCli(cli, ["order", "view", "--help"], help.channel), 0);
  assert.match(help.out, /--region/);
  assert.equal(await runCli(cli, ["order", "view", "123", "--region", "west"], io().channel), 0);
  assert.equal(requests, 2);
  assert.equal(calls, 1);
});

// Generated commands and cached discovery must not replace, block or replay a team's handwritten commands.
test("custom commands work without discovery, override derived names and are never replayed on MCP errors", async () => {
  let localRuns = 0, customRuns = 0, requests = 0, localFlag = false;
  const cli: CliConfig = { name: "acme", server: "http://127.0.0.1:1/mcp", directory: mkdtempSync(join(testDirectory, "flow-cli-custom-")), commands: {
    "list-orders": { command: buildCommand<{ "refresh-tools"?: boolean }>({ docs: { brief: "Local command" }, parameters: { flags: { "refresh-tools": { kind: "boolean", brief: "A local flag", optional: true } } }, func(flags) { localRuns++; localFlag = Boolean(flags["refresh-tools"]); } }) },
    "report show": { command: buildCommand({ docs: { brief: "Local report" }, parameters: {}, func() {} }) },
    proxy: { command: buildCommand({ docs: { brief: "Custom tool call" }, parameters: {}, async func(this: import("../cli/src/commands.ts").CliContext) { customRuns++; await this.cli.call("get_order", {}); } }) },
  } };
  assert.equal(await runCli(cli, ["list-orders"], io().channel), 0, "an unreachable MCP server cannot block a local command");
  assert.equal(await runCli(cli, ["list-orders", "--help"], io().channel), 0);
  assert.equal(await runCli(cli, ["list-orders", "--unknown"], io().channel), 2);
  const group = io();
  assert.equal(await runCli(cli, ["report", "--help"], group.channel), 0);
  assert.match(group.out, /Local report/);
  assert.equal(localRuns, 1);
  assert.equal(await runCli(cli, ["list-orders", "--refresh-tools"], io().channel), 0, "a custom command can own its flags");
  assert.equal(localFlag, true);
  const handle = mcpServer({ name: "acme", version: "1", tools: [listOrders, getOrder] });
  cli.server = `${await listen((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => { if (body && JSON.parse(body).method === "tools/call") requests++; });
    void handle.node(req, res);
  })}/mcp`;
  assert.equal(await runCli(cli, ["tools"], io().channel), 0);
  assert.deepEqual(cliProblems(cli, [{ name: "list_orders", inputSchema: {} }]).errors, [], "custom overrides also pass flow check");
  const help = io();
  assert.equal(await runCli(cli, ["--help"], help.channel), 0);
  assert.match(help.out, /list-orders +Local command/);
  assert.equal(await runCli(cli, ["list-orders"], io().channel), 0);
  assert.equal(localRuns, 3);
  assert.equal(await runCli(cli, ["proxy"], io().channel), 2);
  assert.equal(customRuns, 1);
  assert.equal(requests, 1);
});

// An in-process scheduled promise cannot prove refresh survives bins that call process.exit().
test("detached discovery finishes after the CLI exits and refreshes tools even without a server version bump", async t => {
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { arrived = resolve; });
  let hold = false;
  let handle = mcpServer({ name: "acme", version: "1", tools: [listOrders] });
  const server = `${await listen((req, res) => {
    if (hold) { arrived(); void gate.then(() => handle.node(req, res)); }
    else void handle.node(req, res);
  })}/mcp`;
  t.after(release);
  const cli = { ...acme(server), directory: mkdtempSync(join(testDirectory, "flow-cli-detached-")) };
  assert.equal(await runCli(cli, ["--help"], io().channel), 0);
  const dir = join(cli.directory, "discovery");
  const file = join(dir, readdirSync(dir)[0]!);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...saved, at: Date.now() - 5 * 60_000 }));
  handle = mcpServer({ name: "acme", version: "1", tools: [listOrders, getOrder] });
  hold = true;
  const updated = new Promise<void>(resolve => {
    const watcher = watch(dir, () => {
      try { if (JSON.parse(readFileSync(file, "utf8")).tools.length === 2) { watcher.close(); resolve(); } } catch {}
    });
    t.after(() => watcher.close());
  });
  const source = `import { runCli } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../cli/src/run.ts")).href)}; process.exit(await runCli(${JSON.stringify(cli)}, ["--help"]));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: "ignore" });
  const exit = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(await exit, 0, "cached help exits while the MCP server is still gated");
  await started;
  release();
  await updated;
  assert.equal(JSON.parse(readFileSync(file, "utf8")).tools.length, 2);
});

// Shared-directory tests above use one server and identity; they cannot catch cross-credential reuse.
test("discovery is isolated by server, credentials and client version, without storing tokens", async () => {
  let lists = 0;
  const handle = mcpServer({ name: "acme", version: "1", tools: [listOrders] });
  const listener: RequestListener = (req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => { if (body && JSON.parse(body).method === "tools/list") lists++; });
    void handle.node(req, res);
  };
  const server = `${await listen(listener)}/mcp`;
  const cli = { ...acme(server), directory: mkdtempSync(join(testDirectory, "flow-cli-discovery-")) };
  const run = (args: string[] = [], config: CliConfig = cli) => runCli(config, ["tools", ...args], io().channel);
  assert.equal(await run(), 0);
  assert.equal(await run(["--token", "secret-one"]), 0);
  assert.equal(await run(["--token", "secret-two"]), 0);
  assert.equal(lists, 3);
  assert.equal(await run(["--token", "secret-one"]), 0);
  assert.equal(lists, 3);
  assert.equal(await run([], { ...cli, version: "2" }), 0);
  assert.equal(await run(["--server", `${await listen(listener)}/mcp`]), 0);
  assert.equal(lists, 5);
  await storedProvider(cli, server).saveTokens({ access_token: "oauth-secret-one", token_type: "Bearer" });
  assert.equal(await run(), 0);
  await storedProvider(cli, server).saveTokens({ access_token: "oauth-secret-two", token_type: "Bearer" });
  assert.equal(await run(), 0);
  assert.equal(lists, 7, "a different OAuth credential cannot reuse discovery");
  signOut(cli, server);
  assert.equal(await run(), 0);
  assert.equal(lists, 7, "signing out returns to the anonymous discovery cache");
  const cache = join(cli.directory, "discovery");
  assert.equal(readdirSync(cache).length, 7);
  for (const file of readdirSync(cache)) assert.doesNotMatch(file + readFileSync(join(cache, file), "utf8"), /secret-one|secret-two/);
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

test("wrong arguments exit 2 with what is wrong and the help to read, also when the server's schema refuses them", async () => {
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
  const tooMany = io();
  assert.equal(await runCli(cli, ["order", "list", "--limit", "500"], tooMany.channel), 2);
  assert.match(tooMany.err, /^--limit: .*50/m);
  assert.match(tooMany.err, /Run `acme order list --help`/);
  assert.doesNotMatch(tooMany.err, /ProtocolError|\n\s+at /);
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
  // styleText colours by process.stdout and the environment, not the io the CLI is given; FORCE_COLOR=0 keeps this plain in any terminal.
  const oldColor = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = "0";
  t.after(() => { if (oldColor === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = oldColor; });
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
