#!/usr/bin/env node
// The café's command line, over its MCP server (npm run mcp in another terminal):
//   npm run cli -- order -h
//   npm run cli -- order place --name Sam --items '[{"item":"Latte","size":"large","milk":"oat"}]'
//   npm run cli -- order status BL-1040 --json
//   npm run cli -- chat                           (the agent, npm start, in another terminal)
// (npm reads flags before `--` as its own: keep the `--`.) Installed, it is a command of its own,
// named after the agent (src/name.ts). Every tool is already a command under its own name; this
// file adds the words and arguments.

import { fileURLToPath } from "node:url";
import { defineCli, runCli } from "../../../cli/src/index.ts";
import { runningAgent } from "../../../src/index.ts";
import { name, serverEnv } from "./name.ts";

export const cli = defineCli({
  name,
  server: process.env[serverEnv] ?? "http://127.0.0.1:8790/mcp",
  // Chat is the agent itself (npm start, wherever it found a port), not the MCP server; a deployed
  // server answers both on one origin. Not running, chat says to start it.
  agent: process.env[serverEnv] ? undefined : (running => running && `${running.url}/agent/terminal`)(runningAgent(fileURLToPath(new URL("..", import.meta.url)))),
  description: "The menu and pickup orders",
  groups: { order: "Place and track pickup orders" },
  commands: {
    menu: { tool: "get_menu", columns: ["item", "milks", "allergens"] },
    "order place": { tool: "place_order", examples: [`${name} order place --name Sam --items '[{"item":"Latte","size":"large","milk":"oat"}]'`] },
    "order status": { tool: "order_status", args: ["order_id"], view: ["found", "status", "ready_by"], examples: [`${name} order status BL-1040`] },
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await runCli(cli, process.argv.slice(2)));
