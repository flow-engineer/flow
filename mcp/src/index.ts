// @flow-engineer/flow/mcp: an agent's tools and skills as an MCP server, and other MCP servers' tools as an
// agent's. Serving runs on @modelcontextprotocol/server, a dependency of Flow Framework; using needs
// @modelcontextprotocol/client, an optional peer installed only by agents that use MCP servers.

export { mcpServer, type McpAuth, type McpIdentity, type McpServerHandle, type McpServerOptions } from "./server.ts";
export { mcpTools, fingerprint, type McpDescriptor, type McpLock, type McpToolsOptions } from "./client.ts";
export { describe, titleOf, toolProblems, toolsProblems, type McpToolDescriptor, type Scopes } from "./describe.ts";

export { terminalServer, type TerminalServerOptions } from "./terminal.ts";
