// `flow mcp serve`: what `flow conversations`, `issues`, `insights`, `templates`, `logs` and `deploy status` read,
// as an MCP server on stdio for the coding agent working in the agent's folder:
//   claude mcp add flow -- npx @flow-engineer/flow mcp serve
// Flow's read tools in this folder (testing/src/flow-tools.ts: the same keys, waits, retries and
// refusals as the commands) on the framework's mcpServer, on stdio, with no traces and no feedback
// tool. Each call reads the keys again (the environment the server started with wins over the
// folder's .env), so a key fixed in .env works on the next call. Loaded only by `flow mcp serve`.
// It runs on @modelcontextprotocol/server, a dependency of Flow Framework, so
// `npx @flow-engineer/flow mcp serve` works in any folder.

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { mcpServer } from "../../mcp/src/server.ts";
import type { McpToolDescriptor } from "../../mcp/src/describe.ts";
import { ADVISORY } from "./cloud-call.ts";
import { flowReadTools, flowVersion } from "./flow-tools.ts";

export { INSTRUCTIONS } from "./flow-tools.ts";

const MCP_SERVE_USAGE = `Usage:
  flow mcp serve [--dir <folder>] [--cloud <url>]

This agent's conversations, issues, templates, logs and deploys as read-only MCP tools for your
coding agent, served on stdio.

Add it to Claude Code from the agent's folder:
  claude mcp add flow -- npx @flow-engineer/flow mcp serve
Any other MCP host: the command npx, the arguments @flow-engineer/flow mcp serve, run in the
agent's folder (or add --dir <folder>).

Tools (all read-only): list_conversations, show_conversation, list_issues, list_insights,
insight_conversations, list_templates, read_logs, deploy_status. They read what flow
conversations, flow issues, flow insights, flow templates, flow logs and flow deploy status
print, as JSON.

  --dir <folder>   The agent's folder, whose .env holds the keys (default: .)
  --cloud <url>    Flow's address (default: FLOW_FRAMEWORK_CLOUD, else https://flow.engineer/observe)
  -h, --help       Show this help

Keys: each call reads them again, the environment the server started with first, then the
folder's .env, so a key fixed in .env works on the next call without a restart.
  FLOW_KEY                  list_conversations, show_conversation, list_issues, list_templates.
                            flow_test_... reads staging only
  FLOW_LIVE_KEY             The live Flow key, for production reads whenever it is set:
                            list_conversations and show_conversation with environment production,
                            list_insights, insight_conversations (else FLOW_KEY); show_conversation
                            tries it once when FLOW_KEY does not find the id. Text is de-identified
                            unless it was made with --content; flow setup --live makes it.
                            What it may do, by tier (flow keys grant adds one):
                            ${ADVISORY.default}
                            ${ADVISORY.ask_user}
                            ${ADVISORY.critical}
  FLOW_FRAMEWORK_CLOUD_KEY  read_logs, deploy_status: the CI key (oci_...), staging and production
Nothing goes to stdout but the protocol; waits and retries are said on stderr.`;

/** `flow mcp serve`: serves until the host closes stdin; resolves to the exit status. */
export async function mcpServeCli(args: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ args, strict: true, options: { dir: { type: "string", default: "." }, cloud: { type: "string" }, help: { type: "boolean", short: "h" } } }));
  } catch (error) {
    console.error(`flow mcp serve: ${(error as Error).message}\n\n${MCP_SERVE_USAGE}`);
    return 2;
  }
  if (values.help) return console.log(MCP_SERVE_USAGE), 0;
  const { tools, instructions } = flowReadTools({ dir: resolve(values.dir!), cloud: values.cloud, env: { ...process.env } });
  const server = mcpServer({
    name: "flow",
    version: flowVersion(),
    tools,
    instructions,
    feedback: false,
    traces: false,
    // tools/list as before the tools were the framework's: no output schema, no per-tool sign-in note.
    descriptor: (_tool, { outputSchema: _output, _meta: _ignored, ...descriptor }) => descriptor as McpToolDescriptor,
  });
  await server.stdio({ onerror: (error) => console.error(`flow mcp serve: ${error.message}`) });
  return 0;
}
