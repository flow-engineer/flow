// covers: scripts/new-agent.ts testing/src/new.ts testing/src/cli.ts examples/cafe/src/main.ts examples/cafe/src/mcp.ts src/local.ts examples/cafe/src/agent.ts examples/cafe/src/tools.ts examples/cafe/src/channels.ts examples/cafe/src/name.ts examples/cafe/src/cli.ts coding-agents/skill.md coding-agents/build-agent-skill.md coding-agents/mcp-skill.md coding-agents/cli-design-skill.md
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { newAgent } from "../scripts/new-agent.ts";
import { displayNameOf, initHere, newStandalone, setDisplayName } from "../testing/src/new.ts";
import { choosePort, runningAgent } from "../src/local.ts";

test("npm run new copies the café under its name, renamed, and refuses bad or taken names", () => {
  const agents = mkdtempSync(join(tmpdir(), "flow-agents-"));
  const dir = newAgent("my-agent", { agents });
  assert.equal(dir, join(agents, "my-agent"));
  assert.ok(existsSync(join(dir, "src", "agent.ts")));
  assert.ok(existsSync(join(dir, "agent", "AGENTS.md")));
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name, "my-agent");
  assert.throws(() => newAgent("my-agent", { agents }), /already exists/);
  for (const bad of ["", "My-Agent", "my_agent", "../up", "-x", "a--b"]) assert.throws(() => newAgent(bad, { agents }), /not a usable name/, bad);
});

test("flow new makes an agent of its own: @flow-engineer/flow imports, a package on this version that npm refuses to install on an older Node, and the skills", () => {
  const into = mkdtempSync(join(tmpdir(), "flow-new-"));
  const dir = newStandalone("my-agent", { into });
  assert.equal(dir, join(into, "my-agent"));
  const main = readFileSync(join(dir, "src", "main.ts"), "utf8");
  assert.match(main, /from "@flow-engineer\/flow\/simulators"/);
  assert.match(readFileSync(join(dir, "src", "agent.ts"), "utf8"), /from "@flow-engineer\/flow"/);
  assert.match(readFileSync(join(dir, "src", "mcp.ts"), "utf8"), /from "@flow-engineer\/flow\/mcp"/);
  const cli = readFileSync(join(dir, "src", "cli.ts"), "utf8");
  assert.match(cli, /from "@flow-engineer\/flow\/cli"/);
  assert.doesNotMatch(main + readFileSync(join(dir, "src", "tools.ts"), "utf8"), /\.\.\/\.\.\//);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const own = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "my-agent");
  assert.equal(pkg.dependencies["@flow-engineer/flow"], `^${own.version}`);
  assert.equal(pkg.dependencies["@modelcontextprotocol/server"], own.peerDependencies["@modelcontextprotocol/server"], "the MCP SDK at the version chinwag pins");
  assert.equal(pkg.scripts.test, "flow test");
  assert.deepEqual(pkg.bin, { "my-agent": "src/cli.ts" }, "installed, the CLI is a command of its own");
  assert.equal(pkg.engines.node, own.engines.node);
  assert.equal(readFileSync(join(dir, ".npmrc"), "utf8"), "engine-strict=true\n");
  // The key and each test session's results (.flow/last-session.json) stay out of git.
  assert.deepEqual(readFileSync(join(dir, ".gitignore"), "utf8").split("\n").filter(Boolean), ["node_modules/", ".env", ".flow/", "release/"]);
  assert.equal(JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf8")).extends, undefined);
  for (const skill of ["flow-framework", "flow-framework-build-agent", "flow-framework-mcp", "flow-framework-cli-design", "flow-framework-tools", "flow-framework-tests", "flow-framework-context", "flow-framework-auth"]) assert.ok(existsSync(join(dir, ".claude", "skills", skill, "SKILL.md")), skill);
  assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  assert.ok(existsSync(join(dir, "tests", "scenarios")));
  const env = readFileSync(join(dir, ".env.example"), "utf8");
  for (const key of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "FLOW_KEY", "FLOW_FRAMEWORK_CLOUD_KEY", "FLOW_FRAMEWORK_TRACES_KEY"]) assert.match(env, new RegExp(`^${key}=$`, "m"), key);
  assert.match(env, /^FLOW_FRAMEWORK_CLOUD=https:\/\/flow\.engineer\/observe$/m);
  assert.match(env, /^FLOW_FRAMEWORK_TRACES_URL=https:\/\/flow\.engineer\/observe$/m);
  assert.throws(() => newStandalone("my-agent", { into }), /already exists/);
  assert.throws(() => newStandalone("My_Agent", { into }), /not a usable name/);
});

test("flow init makes the same agent in the folder it runs in, named by --name, else its display name, else the folder, on Flow Messaging when .env has its key, and never over files already there", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "flow-init-")), "My Shop");
  mkdirSync(dir);
  for (const [options, name] of [[{ name: "shop-agent", displayName: "Skycast" }, "shop-agent"], [{ displayName: "Café Skycast" }, "cafe-skycast"]] as const) {
    const here = join(dir, "..", name);
    mkdirSync(here);
    assert.equal(initHere(here, options), name);
    assert.deepEqual(JSON.parse(readFileSync(join(here, "package.json"), "utf8")).bin, { [name]: "src/cli.ts" });
  }
  assert.throws(() => initHere(join(dir, ".."), { name: "Shop Agent" }), /not a usable name/);
  writeFileSync(join(dir, ".gitignore"), "dist/");
  assert.equal(initHere(dir), "my-shop");
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name, "my-shop");
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).displayName, "my shop", "no name given: the folder's in words");
  const main = readFileSync(join(dir, "src", "main.ts"), "utf8");
  assert.match(main, /from "@flow-engineer\/flow\/flow-messaging"/);
  assert.match(main, /process\.env\.FLOW_MESSAGING_KEY \? flowMessaging\(\)/);
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "dist/\nnode_modules/\n.env\n.flow/\nrelease/\n");
  assert.throws(() => initHere(dir), /has package\.json, tsconfig\.json, src, agent, tests/);
});

test("flow init's next steps: npm install, then link (which signs in and writes the model key), then npm start", () => {
  const cli = fileURLToPath(new URL("../testing/src/cli.ts", import.meta.url));
  const init = (env: Record<string, string> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "flow-init-cli-"));
    const result = spawnSync(process.execPath, [cli, "init"], { cwd: dir, env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const none = init();
  assert.match(none, /^ {2}1\. npm install$/m);
  assert.match(none, /^ {2}2\. npx @flow-engineer\/flow link --channel telegram \(or whatsapp, imessage\): signs in, writes the keys$/m);
  assert.match(none, /or put your own model key in \.env/);
  assert.match(none, /^ {2}3\. npm start, and open the link it prints/m);
  assert.doesNotMatch(none, /flow setup|\(Pip\)/, "link runs setup itself");
  assert.match(init({ OPENAI_API_KEY: "sk-shell" }), /your own model key in \.env still wins/);
});

test("the name people call the agent (--display-name) is package.json's displayName: one line, no parentheses, at most 60 characters", () => {
  const into = mkdtempSync(join(tmpdir(), "flow-named-"));
  const dir = newStandalone("flatx", { into, displayName: "  FlatX   agent " });
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).displayName, "FlatX agent");
  assert.equal(displayNameOf("Pip (the café)", "cafe"), "Pip the café");
  assert.equal(displayNameOf("", "my-shop"), "my shop");
  assert.throws(() => displayNameOf("x".repeat(61), "cafe"), /at most 60 characters/);

  const cli = fileURLToPath(new URL("../testing/src/cli.ts", import.meta.url));
  const here = mkdtempSync(join(tmpdir(), "flow-init-named-"));
  const result = spawnSync(process.execPath, [cli, "init", "--display-name", "FlatX agent"], { cwd: here, env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(join(here, "package.json"), "utf8")).displayName, "FlatX agent");
  assert.match(result.stdout, /a phone reaches it with "Hi FlatX agent \(ref <code>\)"/);
});

test("every name in a new agent's code comes from its package.json: the CLI, its variables and examples, and the MCP server", async (t) => {
  // In the clone's own folder, so the agent's relative imports of Flow Framework resolve.
  const agents = mkdtempSync(fileURLToPath(new URL("../.agents-test-", import.meta.url)));
  t.after(() => rmSync(agents, { recursive: true, force: true }));
  const dir = newAgent("skycast-agent", { agents });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).bin, { "skycast-agent": "src/cli.ts" });
  const { cli } = await import(join(dir, "src", "cli.ts"));
  assert.equal(cli.name, "skycast-agent");
  assert.equal(cli.server, "http://127.0.0.1:8790/mcp");
  assert.deepEqual(Object.values(cli.commands).flatMap((c) => (c as { examples?: string[] }).examples ?? []).map((e) => e.split(" ")[0]), ["skycast-agent", "skycast-agent"]);
  assert.equal((await import(join(dir, "src", "name.ts"))).serverEnv, "SKYCAST_AGENT_SERVER");
  const { mcp } = await import(join(dir, "src", "mcp.ts"));
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
  const server = createHttpServer((req, res) => void mcp.node(req, res));
  t.after(() => server.close());
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const answer = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(init) });
  assert.match(await answer.text(), /"serverInfo":\{"name":"skycast-agent"/);
});

test("the display name takes Pip's place in the agent's prompt, no other file of a new agent names Pip or the café's identifiers, and renaming later replaces it again (whole words only)", () => {
  const into = mkdtempSync(join(tmpdir(), "flow-named-prompt-"));
  const dir = newStandalone("juniper", { into, displayName: "Juniper" });
  const prompt = readFileSync(join(dir, "agent", "AGENTS.md"), "utf8");
  assert.match(prompt, /^# Juniper$/m);
  assert.match(prompt, /^You are Juniper, the ordering assistant/m);
  assert.doesNotMatch(prompt, /\bPip\b/);
  // Nor anywhere else a coding agent reads: the template's code and comments, the skills.
  const named = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => statSync(join(dir, f)).isFile() && /\bPip\b/.test(readFileSync(join(dir, f), "utf8")));
  assert.deepEqual(named, [], "no file in a new agent names the café's Pip");
  // Nor its machine names (the café's menu and prompt are the example, and stay until replaced).
  const code = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => !f.startsWith(".claude") && statSync(join(dir, f)).isFile() && /bean-and-leaf|CAFE_|\bcafe\b|chinwag/i.test(readFileSync(join(dir, f), "utf8")));
  assert.deepEqual(code, [], "no file in a new agent names the café's package, CLI, variables or MCP server");
  // The playground and the MCP server read the name from package.json, so they never say Pip.
  for (const file of ["main.ts", "mcp.ts"]) assert.match(readFileSync(join(dir, "src", file), "utf8"), /displayName/, file);
  assert.deepEqual(setDisplayName(dir, "Pip Jr"), { displayName: "Pip Jr", prompt: true });
  assert.match(readFileSync(join(dir, "agent", "AGENTS.md"), "utf8"), /^You are Pip Jr, the ordering/m, "one pass: the new name is not renamed again");
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(pkg).slice(0, 2), ["name", "displayName"]);
  assert.equal(pkg.displayName, "Pip Jr");
  writeFileSync(join(dir, "agent", "AGENTS.md"), "# Someone\n");
  assert.deepEqual(setDisplayName(dir, "Ash"), { displayName: "Ash", prompt: false }, "a prompt that names neither is left as it is");
});

/** A port taken on 127.0.0.1 for the test; resolves to it and its closer. */
async function takePort(port = 0): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((done) => server.close(() => done())) };
}

test("choosePort: an unset port moves to the next free one and says so; a port set and taken is one line naming a free one", async () => {
  const taken = await takePort();
  try {
    const moved = await choosePort("PORT", taken.port, { command: "npm start", env: {} });
    assert.ok(moved.port > taken.port, "a free port above it");
    assert.equal(moved.note, `Port ${taken.port} is in use, so this runs on ${moved.port} (PORT=<port> picks one).`);
    assert.deepEqual(await choosePort("MCP_PORT", moved.port, { command: "npm run mcp", env: {} }), { port: moved.port }, "a free default is used as it is");
    await assert.rejects(choosePort("PORT", 8788, { command: "npm start", env: { PORT: String(taken.port) } }), { message: `Port ${taken.port} is in use. Run: PORT=${moved.port} npm start` });
    await assert.rejects(choosePort("MCP_PORT", 8790, { command: "npm run mcp", env: { MCP_PORT: "web" } }), /MCP_PORT must be a port number/);
  } finally {
    await taken.close();
  }
});

test("npm start on a taken PORT prints one line and exits 1, no stack; on a free one it prints the name from package.json and marks itself running for flow link", async (t) => {
  const main = fileURLToPath(new URL("../examples/cafe/src/main.ts", import.meta.url));
  const cwd = mkdtempSync(join(tmpdir(), "flow-start-"));
  // NODE_NO_WARNINGS: Node 22 prints an ExperimentalWarning for SQLite on stderr.
  const env = { PATH: process.env.PATH, OPENROUTER_API_KEY: "sk-test-not-used", NODE_NO_WARNINGS: "1" };
  const taken = await takePort();
  t.after(taken.close);
  const refused = spawnSync(process.execPath, [main], { cwd, env: { ...env, PORT: String(taken.port) }, encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(`^Port ${taken.port} is in use\\. Run: PORT=\\d+ npm start\\n$`));

  const child = spawn(process.execPath, [main], { cwd, env: { ...env, PORT: "0" } });
  t.after(() => child.kill());
  const line = await new Promise<string>((done) => {
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
      const found = /^Pip's playground: (\S+)\/$/m.exec(out);
      if (found) done(found[1]!);
    });
  });
  assert.deepEqual(runningAgent(cwd), { pid: child.pid, url: line });
});
