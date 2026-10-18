#!/usr/bin/env node
// The `chinwag` command from before the rename, kept for one release: it says so on stderr (stdout
// stays the report's, for --json), then runs the flowcore command (testing/src/cli.ts) as it is.

console.error("chinwag is now flowcore (Flow Framework): run npx flowcore, and npm i flowcore.");
await import("./cli.ts");
