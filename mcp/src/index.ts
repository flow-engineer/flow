// @flow-engineer/flow/mcp: an agent's tools and skills as an MCP server, and other MCP servers' tools as an
// agent's. Serving runs on @modelcontextprotocol/server and using on @modelcontextprotocol/client,
// both dependencies of Flow Framework.

export { mcpServer, type McpAuth, type McpIdentity, type McpServerHandle, type McpServerOptions } from "./server.ts";
export { mcpTools, fingerprint, type McpDescriptor, type McpLock, type McpToolsOptions } from "./client.ts";
export { CONTRACT_META, contractProblems, contractSnapshot, type ContractSnapshot, type McpClientInfo, type McpContractAdapter, type McpContracts, type McpToolAdapter } from "./contracts.ts";
export { describe, titleOf, toolProblems, toolsProblems, type McpToolDescriptor, type Scopes } from "./describe.ts";

export type { AppOnboard, AppPanel, AppPlace, AppUi, McpAppColors, McpAppOptions, McpAppTheme, OnboardAgent } from "./app.ts";
export { uiTools, UI_INSTRUCTIONS } from "./app.ts";
export { terminalServer, type TerminalServerOptions } from "./terminal.ts";
