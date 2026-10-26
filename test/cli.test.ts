// covers: cli/src/chat-ui.ts cli/src/run.ts cli/src/commands.ts cli/src/auth.ts cli/src/terminal.ts mcp/src/server.ts mcp/src/terminal.ts src/skills.ts src/agent.ts src/channels.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { ChatView, runChatUI } from "../cli/src/chat-ui.ts";
import type { ChatUpdate } from "../cli/src/terminal.ts";
import { CURSOR_MARKER, TUI, visibleWidth, type Terminal } from "@mariozechner/pi-tui";
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

test("commands include MCP-deferred tools: positionals, flags, --json and --fields", async () => {
  const cli = acme(await serve({ tools: [listOrders, { ...getOrder, mcp: { deferred: true } }, cancelOrder] }));
  const view = io();
  assert.equal(await runCli(cli, ["order", "view", "BL-1042", "--json", "--fields", "order_id,status"], view.channel), 0);
  assert.deepEqual(JSON.parse(view.out), { order_id: "BL-1042", status: "ready" });

  const table = io();
  assert.equal(await runCli(cli, ["orders", "--status", "making"], table.channel), 0);
  assert.equal(table.out, "ORDER_ID  STATUS  TOTAL\nBL-1043   making  9.6\n");
});

test("a tool's format is what people see, rendered at a terminal; --json, --fields and the CLI file's view show its data", async () => {
  const createKey = tool({
    name: "create_key",
    description: "Create an API key.",
    input: z.object({}),
    output: z.object({ key: z.object({ id: z.string(), name: z.string() }), manage_url: z.string() }),
    signIn: "none",
    hints: { destructive: false },
    run: () => ({ key: { id: "key_1", name: "ci" }, manage_url: "https://acme.test/keys" }),
    format: ({ key, manage_url }) => `## Key **${key.name}** created\n\n- ID: \`${key.id}\`\n- [Manage keys](${manage_url})\n`,
  });
  const cli = (view?: string[]) => defineCli({ name: "acme", directory: mkdtempSync(join(testDirectory, "cli-")), server, commands: { "key create": { tool: "create_key", ...(view ? { view } : {}) } } });
  const server = await serve({ tools: [createKey] });
  const run = async (config: CliConfig, argv: string[], terminal = false) => {
    const out = io(terminal);
    assert.equal(await runCli(config, ["key", "create", ...argv], out.channel), 0);
    return out.out;
  };
  assert.equal(await run(cli(), []), "## Key **ci** created\n\n- ID: `key_1`\n- [Manage keys](https://acme.test/keys)\n", "piped: the Markdown as written");
  const styled = (await run(cli(), [], true)).replace(/\u001b\[[0-9;]*m/g, "");
  assert.equal(styled, "Key ci created\n\n    * ID: key_1\n    * Manage keys (https://acme.test/keys)\n", "at a terminal: rendered, no Markdown marks");
  assert.deepEqual(JSON.parse(await run(cli(), ["--json"])), { key: { id: "key_1", name: "ci" }, manage_url: "https://acme.test/keys" });
  assert.equal(await run(cli(), ["--fields", "manage_url"]), "manage_url  https://acme.test/keys\n");
  assert.equal(await run(cli(["key.id", "manage_url"]), []), "key.id      key_1\nmanage_url  https://acme.test/keys\n");
});

test("a group's help lists its subcommands, and the top level lists groups and commands, styled at a terminal", async () => {
  const cli = acme(await serve({ tools: [listOrders, getOrder, cancelOrder] }));
  for (const argv of [["order"], ["order", "-h"]]) {
    const group = io();
    assert.equal(await runCli(cli, argv, group.channel), 0);
    assert.match(group.out, /COMMANDS\n {2}list +Their orders\.|COMMANDS\n {2}list +List orders/);
    assert.match(group.out, /\n {2}view +One order|\n {2}view +Get order/);
  }
  const top = io();
  assert.equal(await runCli(cli, ["--help"], top.channel), 0);
  const headings = (out: string) => out.split("\n").filter((l) => /^[A-Z][A-Z ]+$/.test(l));
  assert.deepEqual(headings(top.out), ["USAGE", "ASK ANYTHING", "COMMANDS", "THIS CLI", "FLAGS"], "chat first, the CLI's own last, each command once");
  assert.match(top.out, /^USAGE\n {2}acme <command> \[flags\]\n {2}acme <command> --help\n\n/, "one usage line, not one per command");
  assert.match(top.out, /ASK ANYTHING\n {2}acme chat "<request>" +Ask for anything/);
  assert.match(top.out, /\n {2}order +list, view\n/, "the group, with its subcommands as its line");
  assert.match(top.out, /\n {2}cancel-order +Cancel order\n/, "a tool the file does not name keeps its own name");
  assert.doesNotMatch(top.out.slice(top.out.indexOf("COMMANDS")), /\n {2}(list|view) /, "subcommands are not listed at the top");
  assert.match(top.out.slice(top.out.indexOf("THIS CLI")), /\n {2}tools .*\n {2}skill .*\n {2}auth .*\n {2}help <words> /);

  const styled = io(true);
  assert.equal(await runCli(cli, ["--help"], { ...styled.channel, env: {} }), 0);
  assert.match(styled.out, /\u001b\[1m\u001b\[36mASK ANYTHING/, "at a terminal, headings and chat stand out");
  assert.equal(styled.out.replace(/\u001b\[[0-9;]*m/g, ""), top.out, "styling adds no text");

  const sectioned = io();
  assert.equal(await runCli({ ...cli, sections: { Orders: ["order"] } }, ["--help"], sectioned.channel), 0);
  assert.deepEqual(headings(sectioned.out), ["USAGE", "ASK ANYTHING", "ORDERS", "OTHER", "THIS CLI", "FLAGS"]);
  assert.match(sectioned.out, /ORDERS\n {2}order +list, view\n\nOTHER\n {2}orders +Same as order list\n {2}cancel-order +Cancel order\n/, "what no section names is under Other");
});

test("help <words> finds commands by their words and descriptions, the CLI's own too", async () => {
  const cli = acme(await serve({ tools: [listOrders, getOrder, cancelOrder] }));
  const found = async (...words: string[]) => {
    const out = io();
    assert.equal(await runCli(cli, ["help", ...words], out.channel), 0);
    return out.out;
  };
  assert.equal(await found("order"), "  acme order list    List orders\n  acme order view    Get order\n  acme cancel-order  Cancel order\n");
  assert.equal(await found("cancel", "order"), "  acme cancel-order  Cancel order\n", "every word must match");
  assert.equal(await found("sign"), "  acme auth  Sign in, sign out, or see who is signed in\n");
  assert.equal(await found("refund"), `No command matches "refund". acme --help lists them all.\n`);
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

// The test above signs in; only a signed-out CLI shows whether an agent without accounts lets people chat.
test("signed out, chat is a guest the agent keeps apart from accounts, unless the agent requires sign-in", async (t) => {
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "flow-guest-"));
  t.after(() => { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; });
  const scripted = scriptedModel();
  let agent: ReturnType<typeof createAgent>;
  let seenKey: string | null | undefined = "unset";
  const terminal = terminalServer({ agent: () => agent });
  const required = terminalServer({ agent: () => agent, auth: { verify: () => null } });
  const whoami = tool({ name: "whoami", description: "Who this is.", input: z.object({}), signIn: "none", run: async (_i, ctx) => { seenKey = ctx.key; return "a guest"; } });
  agent = createAgent({ files: { "AGENTS.md": "Test agent" }, model: scripted.model, channels: [terminal.channel], tools: [whoami], debounceMs: 0, scheduleCheckMs: 0 });
  let handler = terminal;
  const base = await listen(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const result = await handler.fetch(new Request(`${base}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: Buffer.concat(chunks) }));
    res.writeHead(result.status, Object.fromEntries(result.headers)).end(await result.text());
  });
  const cli = defineCli({ name: "guest-test", server: `${base}/mcp` });
  const first = io();
  const chat = runCli(cli, ["chat", "who am I?", "--json"], first.channel);
  (await Promise.race([scripted.nextCall(0), chat.then(code => { throw new Error(`chat finished before model call: ${code} ${first.err}`); })])).answer(respond(call("send_terminal", { text: "Checking." }), call("whoami", {})));
  (await scripted.nextCall(1)).answer(respond(call("send_terminal", { text: "You are a guest." })));
  assert.equal(await chat, 0, first.err);
  assert.equal(seenKey, null, "a guest is never an account");
  const again = io();
  const second = runCli(cli, ["chat", "still me?", "--json"], again.channel);
  (await scripted.nextCall(2)).answer(respond(call("send_terminal", { text: "Yes." })));
  assert.equal(await second, 0, again.err);
  assert.equal(JSON.parse(again.out).conversationId, JSON.parse(first.out).conversationId, "the CLI keeps its guest between runs");
  handler = required;
  const refused = io();
  assert.equal(await runCli(cli, ["chat", "hello", "--json"], refused.channel), 3);
  assert.match(refused.err, /Sign in first: guest-test auth login/);
});

// The tests above mount terminalServer by hand; only this shows an agent with authenticated MCP gets
// chat on the MCP origin with no terminal code, as Flow's hosting serves the server's paths.
test("mcpServer with auth and the agent serves terminal chat on its origin, signed in only, unless turned off", async (t) => {
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "flow-mcp-terminal-"));
  t.after(() => { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; });
  const scripted = scriptedModel();
  let seenKey: string | null = null;
  const mine = tool({ name: "mine", description: "Who this is for.", input: z.object({}), run: async (_i, ctx) => { seenKey = ctx.key; return "yours"; } });
  const agent = createAgent({ files: { "AGENTS.md": "Test agent" }, model: scripted.model, tools: [mine], debounceMs: 0, scheduleCheckMs: 0 });
  const auth = { issuer: "https://login.example", verify: (token: string) => token === "test" ? { key: "user-9" } : null, routes: { paths: ["/oauth"], fetch: async () => new Response("bridge") } };
  const mcp = mcpServer({ name: "t", version: "1", tools: [mine], auth, agent });
  assert.ok(mcp.paths?.includes("/agent/terminal"), "hosting mounts the server's paths");
  assert.equal(agent.channel("terminal")?.traceChannel, "cli");
  const base = await listen((req, res) => void mcp.node(req, res));
  const signedOut = await fetch(`${base}/agent/terminal`, { method: "POST" });
  assert.equal(signedOut.status, 401);
  assert.equal(signedOut.headers.get("www-authenticate"), "Bearer");
  const cli = defineCli({ name: "mcp-terminal-test", server: `${base}/mcp` });
  const out = io();
  const chat = runCli(cli, ["chat", "whose?", "--json", "--token", "test"], out.channel);
  (await Promise.race([scripted.nextCall(0), chat.then(code => { throw new Error(`chat finished before model call: ${code} ${out.err}`); })])).answer(respond(call("send_terminal", { text: "Checking." }), call("mine", {})));
  (await scripted.nextCall(1)).answer(respond(call("send_terminal", { text: "Yours." })));
  assert.equal(await chat, 0, out.err);
  assert.equal(seenKey, "user-9");
  const scoped = mcpServer({ name: "t", version: "1", tools: [mine], auth: { ...auth, scopes: { read: "read", write: "write" }, verify: (token: string) => token === "read-only" ? { key: "user-9", scopes: ["read"] } : null }, agent, terminal: { channel: "terminal-scoped" } });
  assert.equal((await scoped.fetch(new Request("http://127.0.0.1/agent/terminal", { method: "POST", headers: { authorization: "Bearer read-only" }, body: JSON.stringify({ text: "write something" }) }))).status, 401, "chat can reach write tools, so a read-only token cannot chat");
  const off = mcpServer({ name: "t", version: "1", tools: [mine], auth, agent, terminal: false });
  assert.equal(off.paths?.includes("/agent/terminal"), false);
  assert.equal((await off.fetch(new Request("http://127.0.0.1/agent/terminal", { method: "POST" }))).status, 404);
});

// No test above serves a running server without chat, or a full-screen view that is missing or failed;
// each once made a working setup look broken.
test("chat says a running server has no chat, falls back to line chat without pi-tui, and never exits silently", async (t) => {
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "flow-chat-edges-"));
  t.after(() => { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; });
  const base = await listen((_req, res) => void res.writeHead(404).end());
  const cli = defineCli({ name: "edges", server: `${base}/mcp` });
  const env = { TERM: "xterm", NO_COLOR: "1" };
  const single = io();
  assert.equal(await runCli(cli, ["chat", "hi"], single.channel), 5);
  assert.equal(single.err, `This server does not serve terminal chat (${base}/agent/terminal).\n`);
  const missing = io(true);
  let lines = 0;
  Object.assign(missing.channel, { env, chat: async () => { throw Object.assign(new Error("Cannot find package"), { code: "ERR_MODULE_NOT_FOUND" }); }, lines: async function* () { lines++; yield "/exit"; } });
  assert.equal(await runCli(cli, ["chat"], missing.channel), 0);
  assert.equal(lines, 1, "line chat starts");
  assert.match(missing.err, /Install @mariozechner\/pi-tui@0\.73\.1 beside this CLI for the full-screen chat/);
  const failed = io(true);
  Object.assign(failed.channel, { env, chat: async (session: { send(text: string, update: () => void, signal?: AbortSignal): Promise<void> }) => { await session.send("hi", () => {}).catch(() => {}); return 0; } });
  assert.equal(await runCli(cli, ["chat"], failed.channel), 5);
  assert.match(failed.err, /This server does not serve terminal chat/);
  const stopped = io(true);
  Object.assign(stopped.channel, { env, chat: async (session: { send(text: string, update: () => void, signal?: AbortSignal): Promise<void> }) => { await session.send("hi", () => {}, AbortSignal.abort()).catch(() => {}); return 0; } });
  assert.equal(await runCli(cli, ["chat"], stopped.channel), 0, "stopping a wait is not a failure");
  assert.equal(stopped.err, "");
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
  assert.equal(out.out, "\nacme\n  Checking.\n  \n  Here is the answer.\n\n");
  assert.doesNotMatch(out.out, /typing|person-1/);
});

// Existing chat tests cover authentication/presentation; local commands must not reach the agent.
test("chat commands stay local and /new forgets only the terminal reference; replies render Markdown", async () => {
  const references: Array<string | undefined> = [];
  const server = await listen(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    references.push(JSON.parse(Buffer.concat(chunks).toString()).conversationId);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ conversationId: "saved-reference", replies: [{ type: "message", text: "## Your order\n\n**Ready** for pickup.\n\n- Coffee\n- Cake" }] }));
  });
  const directory = mkdtempSync(join(testDirectory, "chat-commands-"));
  const out = io(true); out.channel.env = { TERM: "xterm" };
  out.channel.lines = async function* () {
    yield "/help"; yield "/missing"; yield "hello"; yield "again"; yield "/new";
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "chat.json"), "utf8")), {});
    yield "after reset"; yield "/exit";
  };
  assert.equal(await runCli(defineCli({ name: "acme", server, directory }), ["chat", "--token", "test"], out.channel), 0);
  assert.deepEqual(references, [undefined, "saved-reference", undefined]);
  assert.match(out.err, /Unknown chat command/);
  assert.match(out.err, /Shared person history stays/);
  const plain = out.out.replace(/\u001b\[[0-9;]*m/g, "");
  assert.match(plain, /Your order/); assert.match(plain, /Ready for pickup/);
  assert.doesNotMatch(plain, /##|\*\*/);
  const legacy = io(true); legacy.channel.env = { TERM: "xterm" };
  const received: ChatUpdate[] = [];
  legacy.channel.chat = async session => {
    await session.send("An older JSON-only server", event => received.push(event), new AbortController().signal);
    return 0;
  };
  assert.equal(await runCli(defineCli({ name: "acme", server, directory }), ["chat", "--token", "test"], legacy.channel), 0);
  assert.ok(received.some(event => event.type === "reply" && event.text.includes("Your order")));
  assert.equal(legacy.out + legacy.err, "", "legacy JSON replies also go through the replacement UI");
});


// The line-based tests cannot protect a full-screen viewport, composer or live tool detail toggle.
function fakeChatTerminal(columns = 80, rows = 30) {
  let input: (data: string) => void = () => {};
  let output = "", stopped = false;
  const terminal: Terminal = {
    columns, rows, kittyProtocolActive: false,
    start(onInput) { input = onInput; }, stop() { stopped = true; }, drainInput: async () => {},
    write(data) { output += data; }, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
    clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
  };
  return { terminal, input: (data: string) => input(data), get output() { return output; }, get stopped() { return stopped; } };
}

test("full-screen chat keeps the composer visible at different sizes and expands actual tool details", async () => {
  const fake = fakeChatTerminal(90, 40);
  const tui = new TUI(fake.terminal);
  let update!: (event: ChatUpdate) => void, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const view = new ChatView(tui, { name: "Acme", color: false, reset() {}, send: async (_text, callback) => { update = callback; await gate; } }, () => {});
  tui.addChild(view); tui.setFocus(view);
  const request = view.submit("Check order 1042");
  try {
    update({ type: "activity", event: { type: "tool.start", callId: "1", tool: "order_lookup", input: { order_id: "1042" } } });
    let frame = view.render(90).map(stripVTControlCharacters).join("\n");
    assert.match(frame, /order_lookup.*running/); assert.doesNotMatch(frame, /order_id/);
    update({ type: "activity", event: { type: "tool.end", callId: "1", tool: "order_lookup", ok: true, output: { status: "ready" }, ms: 20 } });
    update({ type: "reply", text: "## Your order\n\n**Ready** for pickup." });
    view.handleInput("\x0f"); // Ctrl+O
    frame = view.render(90).map(stripVTControlCharacters).join("\n");
    assert.match(frame, /order_id/); assert.match(frame, /ready/); assert.match(frame, /Your order/);
    assert.doesNotMatch(frame, /##|\*\*/);
    assert.match(frame, /Check order 1042/);
    assert.doesNotMatch(frame, /╭─ YOU /, "sent messages have no enclosing border");
    assert.match(frame, /▏ order_lookup/, "tool activity sits on its own rail, apart from the reply");
    assert.match(frame, /Send ↑/, "the composer exposes its send action");
    assert.doesNotMatch(frame, /Enter send|Shift\+Enter newline|CHAT.*Ready/);
    const colorful = new ChatView(tui, { name: "Acme", color: true, reset() {}, async send() {} }, () => {});
    const coloredFrame = colorful.render(90).join("\n");
    assert.match(coloredFrame, /\x1b\[39;49m/, "inherits the terminal's foreground and background");
    assert.doesNotMatch(coloredFrame, /(?:38|48);(?:2|5);/, "default theme does not impose its own palette");
    const emptyLines = colorful.render(90).map(stripVTControlCharacters);
    const welcome = emptyLines.findIndex(line => line.includes("What can I help you with?"));
    const composer = emptyLines.findIndex(line => line.includes("╭"));
    assert.ok(welcome > emptyLines.length - 12 && composer - welcome <= 5, "welcome sits directly above the composer");
    const branded = new ChatView(tui, { name: "Acme", color: true, accent: "#b85c00", reset() {}, async send() {} }, () => {});
    const brandedFrame = branded.render(90).join("\n");
    assert.match(brandedFrame, /38;5;130m/, "brand accent is approximated using the portable palette");
    assert.doesNotMatch(brandedFrame, /48;(?:2|5);/, "branding does not change the terminal background");
    view.editor.setText(Array.from({ length: 20 }, (_, i) => `Draft line ${i}`).join("\n"));
    for (const columns of [20, 37, 80, 140]) for (const rows of [9, 24, 40]) {
      Object.assign(fake.terminal, { columns, rows });
      const lines = view.render(columns);
      assert.equal(lines.length, rows);
      assert.ok(lines.some(line => line.includes(CURSOR_MARKER)), "resizing keeps the draft cursor visible");
      assert.ok(lines.every(line => visibleWidth(line) <= columns), `frame fits ${columns} × ${rows}`);
      assert.match(lines.map(stripVTControlCharacters).slice(-10).join("\n"), /Send|Ctrl\+O/, "controls remain beside composer");
    }
  } finally { release(); await request; }
});

test("full-screen chat restores the ordinary terminal on exit", async () => {
  const fake = fakeChatTerminal();
  const run = runChatUI({ name: "Acme", color: false, reset() {}, async send() {} }, fake.terminal);
  fake.input("\x04");
  assert.equal(await run, 0); assert.equal(fake.stopped, true);
  assert.match(fake.output, /^\x1b\[\?1049h/);
  assert.doesNotMatch(fake.output, /\x1b\[\?100[0-6]h/, "the terminal keeps the mouse, so text can be selected and copied");
  assert.match(fake.output, /\x1b\[\?1049l$/, "the alternate screen is restored");
});

// This protects the live transport: a tool and reply must arrive while the turn is still running.
test("full-screen chat streams authenticated tool activity and replies before completion, without model context", async (t) => {
  const scripted = scriptedModel();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const toolStarted = new Promise<void>(resolve => { started = resolve; });
  t.after(release);
  const lookup = tool({ name: "lookup_order", description: "Look up an order", input: z.object({}), signIn: "none", run: async () => { started(); await gate; return { status: "ready" }; } });
  let agent!: ReturnType<typeof createAgent>;
  const handler = terminalServer({ agent: () => agent, auth: { verify: async token => token === "test" ? { key: "one" } : token === "other" ? { key: "two" } : null } });
  agent = createAgent({ files: { "AGENTS.md": "Private model instructions never shown in chat" }, model: scripted.model, channels: [handler.channel], tools: [lookup], debounceMs: 0, scheduleCheckMs: 0 });
  const base = await listen(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    const result = await handler.fetch(new Request(`${base}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: Buffer.concat(chunks) }));
    res.writeHead(result.status, Object.fromEntries(result.headers));
    if (result.body) Readable.fromWeb(result.body as any).pipe(res); else res.end();
  });
  const invalidBrand = io(true); invalidBrand.channel.env = { TERM: "xterm" };
  invalidBrand.channel.chat = async () => { throw new Error("invalid accent must be refused before opening the UI"); };
  assert.equal(await runCli(defineCli({ name: "stream-test", server: base, chat: { accent: "not-a-color" } }), ["chat", "--token", "test"], invalidBrand.channel), 2);
  assert.match(invalidBrand.err, /six-digit hex/);
  const updates: ChatUpdate[] = [];
  let seen!: () => void;
  const live = new Promise<void>(resolve => { seen = resolve; });
  let sawReply = false, sawTool = false;
  const out = io(true);
  out.channel.chat = async session => {
    assert.equal(session.accent, "#b85c00");
    await session.send("check", update => {
      updates.push(update);
      if (update.type === "reply" && update.text === "Checking your order.") sawReply = true;
      if (update.type === "activity" && update.event.type === "tool.start" && update.event.tool === "lookup_order") sawTool = true;
      if (sawReply && sawTool) seen();
    }, new AbortController().signal);
    return 0;
  };
  const running = runCli(defineCli({ name: "stream-test", directory: mkdtempSync(join(testDirectory, "stream-")), server: base, chat: { accent: "#b85c00" } }), ["chat", "--token", "test"], out.channel);
  (await scripted.nextCall(0)).answer(respond(call("send_terminal", { text: "Checking your order." }), call("lookup_order", {})));
  await toolStarted; await live;
  assert.ok(updates.some(event => event.type === "reply" && event.text === "Checking your order."));
  assert.ok(!updates.some(event => event.type === "reply" && event.text === "Ready."));
  const unrelated = handler.fetch(new Request(`${base}/agent/terminal`, { method: "POST", headers: { authorization: "Bearer other", "content-type": "application/json" }, body: JSON.stringify({ text: "Other person's request" }) }));
  (await scripted.nextCall(1)).answer(respond(call("send_terminal", { text: "Other person's private reply." })));
  await unrelated;
  assert.doesNotMatch(JSON.stringify(updates), /Other person's/);
  release();
  (await scripted.nextCall(2)).answer(respond(call("send_terminal", { text: "Ready." })));
  assert.equal(await running, 0);
  assert.ok(updates.some(event => event.type === "activity" && event.event.type === "tool.end" && event.event.tool === "lookup_order"));
  assert.ok(updates.some(event => event.type === "reply" && event.text === "Ready."));
  assert.doesNotMatch(JSON.stringify(updates), /Private model instructions|turn.context|text.hidden/);
  assert.equal(out.out + out.err, "", "transport does not print over the UI");
  const completedCount = updates.length;
  const later = handler.fetch(new Request(`${base}/agent/terminal`, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ text: "Another request" }) }));
  (await scripted.nextCall(3)).answer(respond(call("send_terminal", { text: "Later reply." })));
  await later;
  assert.equal(updates.length, completedCount, "finished request observers are removed");
  const unauthorized = await handler.fetch(new Request(`${base}/agent/terminal`, { method: "POST", headers: { accept: "application/x-ndjson" } }));
  assert.equal(unauthorized.status, 401);
});


test("chat preserves a failed message for editing and can stop waiting without claiming to cancel accepted work", async () => {
  const fake = fakeChatTerminal(90, 40);
  const tui = new TUI(fake.terminal);
  let failing = true;
  const view = new ChatView(tui, { name: "Acme", color: false, reset() {}, send: async (_text, _update, signal) => {
    if (failing) throw new Error("The agent could not finish.");
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } }, () => {});
  tui.addChild(view); tui.setFocus(view);
  try {
    await view.submit("Keep my draft");
    assert.equal(view.editor.getText(), "Keep my draft");
    assert.match(view.render(90).map(stripVTControlCharacters).join("\n"), /could not finish/);
    failing = false;
    const pending = view.submit("Try again");
    view.handleInput("\x1b");
    await pending;
    assert.match(view.render(90).map(stripVTControlCharacters).join("\n"), /Work already accepted/);
  } finally { tui.stop(); }
});


// Layout tests never scroll: this protects reading position while the transcript/layout changes.
test("chat wheel (Up/Down) and keyboard scrolling preserve the draft and reading position until returning to latest", async () => {
  const fake = fakeChatTerminal(90, 24);
  const tui = new TUI(fake.terminal);
  let update!: (event: ChatUpdate) => void, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const view = new ChatView(tui, { name: "Acme", color: false, reset() {}, send: async (_text, callback) => { update = callback; await gate; } }, () => {});
  tui.addChild(view); tui.setFocus(view);
  const request = view.submit("Original request");
  const block = (prefix: string, count: number) => "```\n" + Array.from({ length: count }, (_, i) => `${prefix}-${String(i + 1).padStart(3, "0")}`).join("\n") + "\n```";
  const frame = () => view.render(fake.terminal.columns).map(stripVTControlCharacters);
  const firstLine = () => frame().find(line => /line-\d{3}/.test(line));
  try {
    update({ type: "activity", event: { type: "tool.end", callId: "1", tool: "lookup", ok: true, output: Array.from({ length: 50 }, (_, i) => `detail-${i}`).join("\n") } });
    update({ type: "reply", text: block("line", 120) });
    view.editor.setText("Draft stays");
    assert.match(frame().join("\n"), /line-120/);
    for (let i = 0; i < 3; i++) view.handleInput("\x1b[A"); // The wheel, as the terminal sends it.
    const reading = firstLine();
    assert.ok(reading);
    assert.doesNotMatch(frame().join("\n"), /line-120/, "several wheel events accumulate before a redraw");
    update({ type: "reply", text: block("new", 30) });
    assert.equal(firstLine(), reading, "incoming replies leave the top visible line in place");
    view.handleInput("\x0f");
    assert.equal(firstLine(), reading, "expanding an earlier tool preserves the visible message");
    Object.assign(fake.terminal, { columns: 70, rows: 30 });
    assert.equal(firstLine()?.trim(), reading?.trim(), "resize keeps the same message and logical row");
    view.editor.setText("Draft stays\nsecond line\nthird line");
    assert.equal(firstLine()?.trim(), reading?.trim(), "a growing composer does not move the transcript");
    view.handleInput("\x1bOP"); // F1 opens help at its beginning.
    assert.match(frame().slice(2, 5).join("\n"), /Chat shortcuts/);
    view.handleInput("\x1bOP");
    assert.equal(firstLine()?.trim(), reading?.trim(), "closing help restores the reading position");
    const draft = view.editor.getText();
    view.handleInput("\x1b[A");
    assert.equal(firstLine()?.trim(), reading?.trim(), "Up moves within a multi-line draft, not the transcript");
    view.editor.setText("One line");
    view.handleInput("\x1b[A");
    assert.notEqual(firstLine()?.trim(), reading?.trim());
    view.editor.setText(draft);
    view.handleInput("\x1b[1;5H"); // Ctrl+Home.
    const top = frame();
    assert.match(top.join("\n"), /Original request/);
    for (let i = 0; i < 10; i++) view.handleInput("\x1b[5~");
    assert.deepEqual(frame(), top, "scrolling above the start is clamped");
    view.handleInput("\x1b[6~");
    assert.notDeepEqual(frame(), top, "PageDown moves by the conversation viewport");
    view.handleInput("\x1b[1;5F"); // Ctrl+End.
    assert.match(frame().join("\n"), /new-030/);
    update({ type: "reply", text: "latest-message" });
    assert.match(frame().join("\n"), /latest-message/, "returning to latest resumes following replies");
    assert.equal(view.editor.getText(), draft);
    assert.match(frame().slice(-10).join("\n"), /Send ↑/);
  } finally { release(); await request; tui.stop(); }
});

test("chat restores the ordinary screen even when terminal shutdown fails", async () => {
  const fake = fakeChatTerminal();
  fake.terminal.stop = () => { throw new Error("shutdown failed"); };
  const running = runChatUI({ name: "Acme", color: false, reset() {}, async send() {} }, fake.terminal);
  fake.input("\x04");
  await assert.rejects(running, /shutdown failed/);
  assert.match(fake.output, /\x1b\[\?1049l$/);
});

test("chat shades sent messages using the reported terminal background without recoloring replies", async () => {
  const fake = fakeChatTerminal(90, 24);
  const tui = new TUI(fake.terminal);
  const view = new ChatView(tui, { name: "Acme", color: true, reset() {}, async send(_text, update) { update({ type: "reply", text: "Assistant reply" }); } }, () => {});
  await view.submit("Sent message");
  for (const [rgb, shade] of [["ffff/ffff/ffff", 255], ["0000/0000/0000", 233]] as const) {
    view.handleInput(`\x1b]11;rgb:${rgb}\x07`);
    const lines = view.render(90);
    assert.ok(lines.find(line => line.includes("Sent message") && !line.includes("Acme"))!.includes(`\x1b[48;5;${shade}m`));
    assert.doesNotMatch(lines.find(line => line.includes("Assistant reply"))!, /48;5;/);
    assert.equal(view.editor.getText(), "", "terminal responses never enter the draft");
  }
  tui.stop();
});
