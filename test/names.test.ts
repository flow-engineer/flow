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

const temp = () => mkdtempSync(join(tmpdir(), "flowcore-names-"));

test("a setting is FLOWCORE_<name>, else CHINWAG_<name> from before the rename; the new name wins", () => {
  assert.equal(setting("CLOUD_KEY", { FLOWCORE_CLOUD_KEY: "new" }), "new");
  assert.equal(setting("CLOUD_KEY", { CHINWAG_CLOUD_KEY: "old" }), "old");
  assert.equal(setting("CLOUD_KEY", { FLOWCORE_CLOUD_KEY: "new", CHINWAG_CLOUD_KEY: "old" }), "new");
  assert.equal(setting("CLOUD_KEY", { LAMINAR_FLOW_CLOUD_KEY: "never released" }), undefined);
});

test("config files are written under ~/.config/flowcore and read from ~/.config/chinwag only while flowcore's is missing", () => {
  const env = { XDG_CONFIG_HOME: temp() };
  assert.equal(configDir(env), join(env.XDG_CONFIG_HOME, "flowcore"));
  assert.equal(configFile("credentials.json", env), join(env.XDG_CONFIG_HOME, "flowcore", "credentials.json"));
  mkdirSync(oldConfigDir(env), { recursive: true });
  writeFileSync(join(oldConfigDir(env), "credentials.json"), "{}");
  assert.equal(configFile("credentials.json", env), join(env.XDG_CONFIG_HOME, "chinwag", "credentials.json"));
  mkdirSync(configDir(env), { recursive: true });
  writeFileSync(join(configDir(env), "credentials.json"), "{}");
  assert.equal(configFile("credentials.json", env), join(env.XDG_CONFIG_HOME, "flowcore", "credentials.json"));
});

test("results go to .flowcore/ and .chinwag/ is read only while .flowcore's file is missing", () => {
  const dir = temp();
  assert.equal(resultsFile(dir, "last-session.json"), join(dir, ".flowcore", "last-session.json"));
  mkdirSync(join(dir, ".chinwag"));
  writeFileSync(join(dir, ".chinwag", "last-session.json"), "{}");
  assert.equal(lastSessionIn(dir), join(dir, ".chinwag", "last-session.json"));
  mkdirSync(join(dir, ".flowcore"));
  writeFileSync(join(dir, ".flowcore", "last-session.json"), "{}");
  assert.equal(lastSessionIn(dir), join(dir, ".flowcore", "last-session.json"));
});

test("the chinwag command says it was renamed on stderr, then runs flowcore as it is", () => {
  const run = (file: string) => spawnSync(process.execPath, [fileURLToPath(new URL(`../testing/src/${file}`, import.meta.url)), "--help"], { encoding: "utf8" });
  const old = run("chinwag.ts");
  const now = run("cli.ts");
  assert.equal(old.status, now.status);
  assert.equal(old.stdout, now.stdout);
  assert.equal(old.stderr, `chinwag is now flowcore (Flow Framework): run npx flowcore, and npm i flowcore.\n${now.stderr}`);
});
