// @flow-engineer/flow/cli: an organization's command line over its MCP server (the same tools, sign-in and
// gating as Claude or ChatGPT get). `defineCli` is the team's CLI file; `runCli` runs it. Needs
// @modelcontextprotocol/client and @stricli/core, optional peers of Flow Framework; marked and
// marked-terminal (also optional peers) render tools' Markdown at a terminal.
// @mariozechner/pi-tui (optional) provides the full-screen human chat interface.

export { cliProblems, command, commandTable, defineCli, derivedName, skillFile, type CliConfig, type CliContext, type CliOption, type CommandBuilder, type CommandConfig, type CustomCommand, type ToolCommand, type ToolInfo, type Welcome } from "./commands.ts";
export { EXIT, processIO, runCli, type CliIO } from "./run.ts";

export type { ChatSession, ChatUpdate } from "./terminal.ts";
