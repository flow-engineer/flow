// The agent's tools and skills as an MCP server, for Claude, ChatGPT or any MCP host: `npm run mcp`.
// The same tools the chat agent uses; no model key needed, since the host brings its own model.

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { mcpServer } from "../../../mcp/src/index.ts";
import { choosePort } from "../../../src/index.ts";
import { displayName, name, serverEnv } from "./name.ts";
import { tools } from "./tools.ts";

export const mcp = mcpServer({
  name,
  version: "1.0.0",
  tools,
  dir: fileURLToPath(new URL("../agent", import.meta.url)),
  // The café has no accounts yet, so every tool answers without sign-in. With accounts, add
  // auth: { issuer, resource, scopes, verify } (the flow-framework-auth skill).
});

// Run as `npm run mcp`; Flow's hosting imports `mcp` and serves it beside the agent.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // MCP_PORT, else 8790 or the next free port above it.
  let port: number;
  try {
    const chosen = await choosePort("MCP_PORT", 8790, { command: "npm run mcp" });
    port = chosen.port;
    if (chosen.note) console.log(`${chosen.note} The CLI then needs ${serverEnv}=http://127.0.0.1:${port}/mcp.`);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  createServer((req, res) => void mcp.node(req, res))
    .once("error", (error) => {
      console.error(`${error.message}. Run: MCP_PORT=<port> npm run mcp`);
      process.exit(1);
    })
    .listen(port, "127.0.0.1", () => {
      console.log(`${displayName}'s MCP server: http://127.0.0.1:${port}/mcp`);
      console.log(`Try it in Claude Code: claude mcp add --transport http ${name} http://127.0.0.1:${port}/mcp`);
    });
}
