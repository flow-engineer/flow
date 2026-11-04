// covers: widget/src/app-panel.ts
// Flow's row ("Use it in", "Powered by Flow") is out of reach of the agent's panel module because the
// panel makes the body a closed shadow host, with the row in it, before that module runs: a module that
// ran first could take the body's shadow itself. That order is checked here on the source; that the row
// stays shown against hostile CSS and scripts needs a browser, which these tests do not run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../src/app-panel.ts", import.meta.url), "utf8");

test("the body's closed shadow and Flow's row in it come before the agent's module is imported", () => {
  const shadow = source.indexOf(`document.body.attachShadow({ mode: "closed" })`);
  const row = source.indexOf("shadow.append(");
  const module = source.indexOf("await import(PARTS)");
  assert.ok(shadow > 0 && row > shadow && module > row, "attachShadow, then the row, then the module");
  assert.equal(source.match(/import\(/g)?.length, 1, "the agent's module is the only one loaded at run time");
});
