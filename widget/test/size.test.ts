// covers: widget/src/loader.ts widget/src/panel.ts widget/src/client.ts widget/src/markdown.ts widget/src/strings.ts widget/src/styles.ts widget/tsconfig.json
// The budgets are measured on the built files, which are what an agent serves in production
// (dist/widget/src). They are built here with the widget's own tsconfig into a temporary folder,
// so the test needs no prior `npm run build` and never reads a stale dist.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../..", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "flow-widget-"));
after(() => rmSync(out, { recursive: true, force: true }));
const built = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "widget/tsconfig.json"), "--outDir", out], { encoding: "utf8" });
const file = (name: string) => readFileSync(join(out, "src", `${name}.js`), "utf8");
const gzip = (code: string) => gzipSync(code).length;

test("the launcher is at most 4 KB gzip, and the panel with everything its first open loads at most 22 KB", () => {
  assert.equal(built.status, 0, built.stdout + built.stderr);
  assert.ok(gzip(file("loader")) <= 4 * 1024, `widget.js is ${gzip(file("loader"))} bytes gzip`);
  // The panel and every sibling it imports, followed from panel.js.
  const loads = new Set<string>(["panel"]);
  for (const name of loads) for (const [, dep] of file(name).matchAll(/from\s*"\.\/([a-z0-9-]+)\.js"/g)) loads.add(dep);
  assert.deepEqual([...loads].sort(), ["client", "markdown", "panel", "strings", "styles"]);
  const total = [...loads].reduce((sum, name) => sum + gzip(file(name)), 0);
  assert.ok(total <= 22 * 1024, `the panel's first open is ${total} bytes gzip`);
});

test("widget.js is a classic script, built and served from source alike: no import or export statements", () => {
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const source = stripTypeScriptTypes(readFileSync(join(root, "widget/src/loader.ts"), "utf8"));
  // A classic script compiles as a vm.Script; an import or export statement is a syntax error there.
  for (const code of [file("loader"), source]) assert.doesNotThrow(() => new Script(code, { filename: "widget.js" }));
});
