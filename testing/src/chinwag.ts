#!/usr/bin/env node
// The `chinwag` command from before the rename, kept for one release: it says so on stderr (stdout
// stays the report's, for --json), then runs the laminar-flow command (testing/src/cli.ts) as it is.

console.error("chinwag is now laminar-flow (Flow Framework): run npx laminar-flow, and npm i laminar-flow.");
await import("./cli.ts");
