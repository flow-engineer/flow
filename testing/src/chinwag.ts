#!/usr/bin/env node
// The `chinwag` command from before the rename, kept for one release: it says so on stderr (stdout
// stays the report's, for --json), then runs the flow command (testing/src/cli.ts) as it is.

console.error("chinwag is now Flow Framework (@flow-engineer/flow): run npx @flow-engineer/flow, and npm i @flow-engineer/flow.");
await import("./cli.ts");
