// covers: src/names.ts testing/src/chinwag.ts testing/src/show.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { configDir, configFile, oldConfigDir, resultsFile, setting } from "../src/names.ts";
import { lastSessionIn } from "../testing/src/show.ts";

const temp = () => mkdtempSync(join(tmpdir(), "flow-names-"));

test("a setting is FLOW_FRAMEWORK_<name>, else CHINWAG_<name> from before the rename; the new name wins", () => {
  assert.equal(setting("CLOUD_KEY", { FLOW_FRAMEWORK_CLOUD_KEY: "new" }), "new");
  assert.equal(setting("CLOUD_KEY", { CHINWAG_CLOUD_KEY: "old" }), "old");
  assert.equal(setting("CLOUD_KEY", { FLOW_FRAMEWORK_CLOUD_KEY: "new", CHINWAG_CLOUD_KEY: "old" }), "new");
});

test("config files are written under ~/.config/flow-framework and read from ~/.config/chinwag only while Flow Framework's is missing", () => {
  const env = { XDG_CONFIG_HOME: temp() };
  assert.equal(configDir(env), join(env.XDG_CONFIG_HOME, "flow-framework"));
  assert.equal(configFile("credentials.json", env), join(env.XDG_CONFIG_HOME, "flow-framework", "credentials.json"));
  mkdirSync(oldConfigDir(env), { recursive: true });
  writeFileSync(join(oldConfigDir(env), "credentials.json"), "{}");
  assert.equal(configFile("credentials.json", env), join(env.XDG_CONFIG_HOME, "chinwag", "credentials.json"));
  mkdirSync(configDir(env), { recursive: true });
  writeFileSync(join(configDir(env), "credentials.json"), "{}");
  assert.equal(configFile("credentials.json", env), join(env.XDG_CONFIG_HOME, "flow-framework", "credentials.json"));
});

test("results go to .flow/ and .chinwag/ is read only while .flow's file is missing", () => {
  const dir = temp();
  assert.equal(resultsFile(dir, "last-session.json"), join(dir, ".flow", "last-session.json"));
  mkdirSync(join(dir, ".chinwag"));
  writeFileSync(join(dir, ".chinwag", "last-session.json"), "{}");
  assert.equal(lastSessionIn(dir), join(dir, ".chinwag", "last-session.json"));
  mkdirSync(join(dir, ".flow"));
  writeFileSync(join(dir, ".flow", "last-session.json"), "{}");
  assert.equal(lastSessionIn(dir), join(dir, ".flow", "last-session.json"));
});

test("the chinwag command says it was renamed on stderr, then runs flow as it is", () => {
  const run = (file: string) => spawnSync(process.execPath, [fileURLToPath(new URL(`../testing/src/${file}`, import.meta.url)), "--help"], { encoding: "utf8" });
  const old = run("chinwag.ts");
  const now = run("cli.ts");
  assert.equal(old.status, now.status);
  assert.equal(old.stdout, now.stdout);
  assert.equal(old.stderr, `chinwag is now Flow Framework (@flow-engineer/flow): run npx flow, and npm i @flow-engineer/flow.\n${now.stderr}`);
});
