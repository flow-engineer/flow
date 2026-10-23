// The agent's names, kept in one place: package.json. Every file that names the agent imports them
// from here, so renaming it is editing package.json (and the prompt, agent/AGENTS.md).
// - `name` (package.json `name`; keep its `bin` key the same): the package, the CLI command and its
//   <NAME>_SERVER and <NAME>_TOKEN variables, the MCP server's name.
// - `displayName` (package.json `displayName`): what people call the agent; a phone reaches it with
//   "Hi <displayName> (ref <code>)" (`npx @flow-engineer/flow link --display-name <name>` changes it).

import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string; displayName?: string };

export const name = pkg.name.replace(/^@[^/]+\//, "");
export const displayName = pkg.displayName?.trim() || name.replace(/-/g, " ");
/** The variable the CLI reads the MCP server's address from, as the CLI names it (my-agent: MY_AGENT_SERVER). */
export const serverEnv = `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_SERVER`;
