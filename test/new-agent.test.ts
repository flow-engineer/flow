// covers: scripts/new-agent.ts testing/src/new.ts testing/src/cli.ts examples/cafe/src/main.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { newAgent } from "../scripts/new-agent.ts";
import { initHere, newStandalone } from "../testing/src/new.ts";

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
  assert.doesNotMatch(main + readFileSync(join(dir, "src", "tools.ts"), "utf8"), /\.\.\/\.\.\//);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const own = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "my-agent");
  assert.equal(pkg.dependencies["@flow-engineer/flow"], `^${own.version}`);
  assert.equal(pkg.scripts.test, "flow test");
  assert.equal(pkg.engines.node, own.engines.node);
  assert.equal(readFileSync(join(dir, ".npmrc"), "utf8"), "engine-strict=true\n");
  // The key and each test session's results (.flow/last-session.json) stay out of git.
  assert.deepEqual(readFileSync(join(dir, ".gitignore"), "utf8").split("\n").filter(Boolean), ["node_modules/", ".env", ".flow/"]);
  assert.equal(JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf8")).extends, undefined);
  for (const skill of ["flow-framework", "flow-framework-tools", "flow-framework-tests"]) assert.ok(existsSync(join(dir, ".claude", "skills", skill, "SKILL.md")), skill);
  assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  assert.ok(existsSync(join(dir, "tests", "scenarios")));
  const env = readFileSync(join(dir, ".env.example"), "utf8");
  for (const key of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "FLOW_FRAMEWORK_CLOUD_KEY", "FLOW_FRAMEWORK_TRACES_KEY"]) assert.match(env, new RegExp(`^${key}=$`, "m"), key);
  assert.match(env, /^FLOW_FRAMEWORK_CLOUD=https:\/\/flow\.engineer\/observe$/m);
  assert.match(env, /^FLOW_FRAMEWORK_TRACES_URL=https:\/\/flow\.engineer\/observe$/m);
  assert.throws(() => newStandalone("my-agent", { into }), /already exists/);
  assert.throws(() => newStandalone("My_Agent", { into }), /not a usable name/);
});

test("flow init makes the same agent in the folder it runs in, named after it, on Flow Messaging when .env has its key, and never over files already there", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "flow-init-")), "My Shop");
  mkdirSync(dir);
  writeFileSync(join(dir, ".gitignore"), "dist/");
  assert.equal(initHere(dir), "my-shop");
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name, "my-shop");
  const main = readFileSync(join(dir, "src", "main.ts"), "utf8");
  assert.match(main, /from "@flow-engineer\/flow\/flow-messaging"/);
  assert.match(main, /process\.env\.FLOW_MESSAGING_KEY \? flowMessaging\(\)/);
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "dist/\nnode_modules/\n.env\n.flow/\n");
  assert.throws(() => initHere(dir), /has package\.json, tsconfig\.json, src, agent, tests/);
});

test("flow init's next steps lead with getting a model key when none is set, and leave that step out when .env or the shell has one", () => {
  const cli = fileURLToPath(new URL("../testing/src/cli.ts", import.meta.url));
  const init = (env: Record<string, string> = {}, dotenv?: string) => {
    const dir = mkdtempSync(join(tmpdir(), "flow-init-cli-"));
    if (dotenv !== undefined) writeFileSync(join(dir, ".env"), dotenv);
    const result = spawnSync(process.execPath, [cli, "init"], { cwd: dir, env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const none = init();
  assert.match(none, /^ {2}2\. Model key: none yet\. Run npx @flow-engineer\/flow setup to get Flow's free trial credit, or add your own key/m);
  assert.match(none, /^ {2}3\. npx @flow-engineer\/flow chat/m);
  assert.match(init({ OPENAI_API_KEY: "sk-shell" }), /^ {2}2\. npx @flow-engineer\/flow chat/m);
  assert.doesNotMatch(init({}, "OPENROUTER_API_KEY=sk-mine\n"), /Model key/);
});
