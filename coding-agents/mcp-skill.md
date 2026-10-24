---
name: flow-framework-mcp
description: Build or change a Flow Framework MCP server, CLI, native plugin package, or terminal chat integration. Use for mcpServer, deferred tool discovery, defineCli, plugin endpoints or terminalServer.
---

# MCP servers, CLIs and plugins

Read `flow-framework` (`skill.md`) for project setup, names, layout and trace destination settings.
Read `flow-framework-tools` for tool schemas and metadata, and `flow-framework-auth` when tools
need a verified account. Building the messaging runtime is covered by `flow-framework-build-agent`
(`build-agent-skill.md`); it is needed for terminal conversations, not standalone MCP tool serving.

Read the relevant section:

- [Serve MCP tools](#serve-the-tools-over-mcp)
- [Defer less-used tools](#defer-less-used-mcp-tools)
- [Build the CLI](#a-cli-for-the-organization)
- [Package native plugins](#native-plugins-and-standalone-mcp)
- [Exercise the CLI in a local playground](#local-playground-cli)
- [Terminal conversations](#terminal-conversations)

## Serve the tools over MCP

The same tools and skills go to Claude, ChatGPT and any MCP host as an MCP server. Install the
SDK it runs on (`npm i @modelcontextprotocol/server@2.3.1`, the version Flow Framework pins) and add
`src/mcp.ts`:

```ts
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { mcpServer } from "@flow-engineer/flow/mcp";
import { tools } from "./tools.ts";

export const mcp = mcpServer({
  name: "acme",
  version: "1.0.0",
  tools,
  dir: fileURLToPath(new URL("../agent", import.meta.url)),   // its skills; AGENTS.md is not sent
  // auth: { issuer, resource, scopes, verify }               // sign-in: the flow-framework-auth skill
});
createServer((req, res) => void mcp.node(req, res)).listen(8790);   // Streamable HTTP at /mcp
```

- `mcp.fetch(request)` serves a web-standard `Request` instead (Cloudflare Workers, Deno, Bun), so
  it mounts beside the chat agent in one process or runs on its own: it needs no model, channels
  or store.
- Hosts get the skills as the server's instructions (each one's description) and read one with the
  `read_skill` tool. A skill that tells the chat agent to use `send_*` or `share_updates` makes
  no sense to a host: `flow check` warns about it.
- Every part can be changed: `instructions` replaces the instructions, `descriptor(tool, generated)`
  changes any tool's MCP descriptor, `extend(server)` adds handlers of your own (resources,
  prompts) to the SDK's server, `path` moves the endpoint, `allowedHosts` checks the Host header.
- Run `npx @flow-engineer/flow check` from the agent's folder before serving: it refuses tools that
  cannot be described exactly (the `flow-framework-tools` skill lists the rules).
- Check it yourself, in the chat you are in: never ask the owner to open another coding agent to
  try it (a server added to a coding agent only loads in a new chat). `flow inspect` is an MCP
  client for testing, whether or not the agent has a CLI, and installs nothing into it. Start `npm run mcp` as a
  process that outlives your turn (`mkdir -p .flow && nohup npm run mcp > .flow/mcp.log 2>&1 &`; a
  coding agent's background tasks can be stopped), then, with
  `inspect` standing for `npx -y -p @flow-engineer/flow -p @modelcontextprotocol/client@2.3.1 flow inspect http://127.0.0.1:8790/mcp`:
  `inspect tools` lists what a host sees, schemas included, and `inspect call <tool> '<json>'` calls a
  tool as a host would and prints the raw result (`resources`, `read <uri>`, `prompts` and `prompt <name>` too).
  Tools that need sign-in: run `inspect auth` in the background (it prints what the server
  advertises and the link, then waits), give the owner the link, and once they say they signed in it
  prints the client and the token's scope; then call the tool. `--token <token>` sends an API key or
  test token instead.
- Then give the owner the line for their own host: `claude mcp add --transport http acme http://127.0.0.1:8790/mcp`.

### Defer less-used MCP tools

Mark a tool with `mcp: { deferred: true }` to leave it out of MCP's upfront list. Unmarked tools
stay upfront; with no deferred tools the list stays as it was. This setting changes only MCP
exposure, never the tools a WhatsApp or other chat agent receives.

When any tools are deferred, the MCP endpoint adds `search_tools({ query, limit? })` and
`execute_tool({ name, arguments })`. Search matches deferred tools' names, titles and descriptions
and returns `{ tools: [...], total }` with their full descriptors and schemas (five by default, at
most twenty; `total` counts all matches). Execute validates the target's input and keeps its
authentication, scopes, context, format, structured output and tracing. It runs one named
operation, not generated code.

`mcpServer({ ..., deferred: ["export_report"] })` replaces the tools' flags with that list;
`deferred: []` puts everything upfront. A hosting service can choose that list from usage data
before constructing a server. Selection stays fixed for that handle; Flow does not promote or
demote tools automatically. Calls through execute are traced under the target's name.

Both standalone and plugin MCP endpoints apply deferral. The CLI and `mcpTools` explicitly request
the full catalog, so deferred tools keep their commands and ordinary chat imports. Other clients
can request it with `tools/list` metadata `{ "flow.engineer/full-tool-catalog": true }`; it returns
the endpoint's original tools without generated search/execute wrappers. Deferral is not access
control: known tools remain directly callable with the same authorization requirements.

`descriptor` customizes the generated search/execute descriptors too. Supply a tool named
`search_tools` or `execute_tool` to replace that generated implementation. A generic executor's
host-visible hints are conservative (it may write or delete); its target's permissions are still
enforced per call.

## A CLI for the organization

The same tools as commands, over the organization's MCP server, with the same sign-in and gating.
It runs on Stricli (`@stricli/core`, the framework Sentry's CLI is built on). Every tool is already a
command under its own name (`place_order` is `acme place-order`); a CLI file adds what needs
judgement. Install `@modelcontextprotocol/client@2.3.1` and `@stricli/core@1.3.0`, plus
`marked@12.0.2` and `marked-terminal@7.3.0` to render tools' Markdown in a terminal (the versions
Flow Framework pins), and write `src/cli.ts`:

```ts
#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { defineCli, runCli } from "@flow-engineer/flow/cli";

export const cli = defineCli({
  name: "acme",
  server: process.env.ACME_SERVER ?? "https://acme.example.com/mcp",
  description: "Acme's orders and customers",
  groups: { order: "Place and track orders" },
  sections: { Orders: ["order"] },                 // headings in `acme -h`; the rest go under Other
  commands: {
    "order list": { tool: "list_orders", columns: ["order_id", "status", "total"], alias: "orders" },
    "order view": { tool: "get_order", args: ["order_id"], examples: ["acme order view BL-1042 --json"] },
    "order place": { tool: "place_order" },
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await runCli(cli, process.argv.slice(2)));
```

- Words are groups then a verb: `order` is a **command group**, `list`, `view` and `place` its
  subcommands. `acme order` and `acme order -h` list the group's subcommands, `acme order place -h`
  that command's flags and examples, and `acme -h` the groups and top-level commands. A word is a
  group or a command, never both. `groups` gives each group its line in help.
- `acme -h` puts `chat` first (ask for anything in plain words), then the groups and commands,
  then the CLI's own (`tools`, `skill`, `auth`, `help`). With many groups, `sections` puts them
  under headings in the order given; those no section names are listed under Other. `acme help
  <words>` lists the commands whose words or descriptions have them all (`acme help invoice`).
  A command of the CLI file named `chat` or `help` replaces the CLI's own.
- `args` are the input fields taken as positional arguments, `columns` a list's table, `view` one
  record's fields, `alias` another name, `examples` lines for help. Every other input field is a
  flag (`order_id` is `--order-id`); a list is a repeatable or comma-separated flag; an object or a
  list of objects takes JSON, or `@file.json`, and its help shows the shape
  (`JSON list of {item, size, milk?}`).
- A command of the team's own is any Stricli command: `"report daily": { command: buildCommand({ ... }) }`
  with `buildCommand` from `@stricli/core`; inside it, `this.cli.call(tool, input)` calls the server's
  tools and `this.cli.print(value, { json })` prints like the rest.
- Installed, it is the organization's own command: `"bin": { "acme": "src/cli.ts" }` in its package
  (node runs `.ts` files outside `node_modules`; publish a compiled `.js` bin to npm). While building
  it, run it with `npm run cli -- order -h`: npm takes flags before `--` as its own.
- A tool with `format` prints its own text, rendered at a terminal (as written when piped, for
  `NO_COLOR`, or without `marked`); `--json`, `--fields`, `columns` and `view` show its data.
- Every tool command takes `--json` and `--fields a,b`; one that changes things takes `--dry-run`; one
  that may delete or overwrite asks first in a terminal and needs `--yes` without one. Exit codes: 0
  done, 1 the tool failed, 2 wrong command or arguments (with the help to read), 3 sign-in needed, 4
  needs `--yes`, 5 the server could not be reached. `--server <url>` and `--token <token>` work on
  every command. `acme auth login` signs in on the organization's own login (tokens in
  `~/.config/acme/`, mode 600), `ACME_TOKEN` is for CI, `acme tools` lists every tool and schema, and
  `acme skill list` (or bare `skill`) lists the generated `acme-cli` guide and workflow skill names
  and descriptions. `acme skill get booking refunds` reads only those skills; `--json` returns an
  array of `{ name, description, content }`. `skill get acme-cli` reads the CLI guide, including
  handwritten commands and MCP-tool-to-command mappings. `skill get <names...> --write <dir>` exports
  selected SKILL.md files; `skill --write <dir>` keeps exporting the generated guide. Listings use
  `read_skill` descriptor metadata (`flow.engineer/skills`); older MCP servers supply names with
  empty descriptions. Workflow bodies are fetched through `read_skill` only when selected.
  For any MCP server without a CLI file, `npx @flow-engineer/flow cli --server <url> -h`.
- `npx @flow-engineer/flow check` checks the CLI file against the tools: a command naming a tool that does not
  exist, an `args` field the input lacks, a `columns` or `view` field the output lacks, two commands
  with one name, a word that is both a command and a group, or one of the CLI's own words (`auth`,
  `tools`, `skill`) is an error; a tool no command names is a warning (it keeps its own name).
- MCP-backed commands need a shipped MCP server. Cached definitions (including server name/version)
  load immediately, with background refresh every five minutes, scoped to endpoint, client and
  credentials in the CLI's config directory (`directory` overrides it). Version changes detected
  on connection refresh before a call. Unknown commands/arguments refresh and reparse once; server
  argument errors refresh help without replaying the request. `--refresh-tools` forces discovery.
  Set `discoveryCache: false` to disable caching or `{ maxAgeMs: 60_000 }` for a one-minute background
  interval. Handwritten commands and their help need no discovery; their bodies are never replayed,
  and their names override derived commands. Only explicit `this.cli.call` reaches MCP. Results and
  credentials are never stored in the discovery cache. A custom command declaring its own
  `--refresh-tools` flag keeps that flag; use `tools --refresh-tools` to force framework discovery.


### Native plugins and standalone MCP

The standalone `/mcp` endpoint includes the skills list and `read_skill`. Native plugins
copy the agent's `agent/skills/` folder and connect to `/mcp/plugin`, which serves tools only,
so a host receives each skill once. Both paths share tools, auth and descriptor overrides.
`mcpServer({ ..., plugin: false })` disables the plugin path; `plugin: { path: "/native" }`
moves it. `handle.plugin` exposes its path and descriptors. Your `instructions` override
applies to both endpoints, and `extend` can add SDK handlers on both.

From the agent folder, run:

```sh
flow plugin --server https://agent.example.com/mcp --out plugins
flow check --plugin plugins
```

`plugins/claude/` uses Claude Code's `.claude-plugin/plugin.json` and `.mcp.json` with
`type: "http"`. `plugins/agent-plugins/` uses Agent Plugins 1.0.0 root `plugin.json` and
`mcp.json` with `type: "streamable-http"`; Codex supports this portable format.
Pass `--name` to override the package name. For a custom plugin route, pass its URL ending
in `/plugin`, or edit the generated MCP config. No token is written into either package.
Regenerate after changing a skill or its assets; `check --plugin` compares content hashes.
Generated files remain plain files in your repository: customize manifests and add components
alongside them. Regeneration rewrites manifests and source skill copies; keep hand-written
skills outside those source paths.

Formats checked 18 October 2026: [Agent Plugins 1.0.0](https://agent-plugins.org/specification),
[OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins), and
[Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference).

MCP calls emit `tool.start`/`tool.end` with surface (`mcp`, `mcp-plugin`, `cli`), client name
and version, session, person, duration, outcome and error. CLI calls send command and an
idempotency key in `_meta`; a caller can reuse its key on a retry. `defineCli`'s `version`
sets its client version (default `"1"`). Neither CLI arguments nor trace credentials go in `_meta`.
`mcpServer` uses `FLOW_FRAMEWORK_TRACES_*`, like chat agents, or explicit `traces` options;
`traces: false` disables export without disabling your event sinks. `await handle.flushTraces()`
flushes its bounded background queue. Each tool call is a root trace without a conversation;
arguments and results require `FLOW_FRAMEWORK_TRACES_CONTENT=1`. Legacy clients' initialization
metadata is retained for up to 24 hours in at most 4,096 sessions; bearer tokens are never cached.

### Local playground CLI

To exercise the real CLI on your computer, pass `localCli: { channel: "terminal", config: cli }`
to `play.listen(agent, port, options)` or a locally mounted `play.handler(agent, options)`.
`cli` is the team's existing `defineCli` configuration, with its server URL; the named channel
must exist. This opens an independent CLI session in that tab, with real stdout/stderr, exit
codes, interactive input and confirmation prompts. It does not use the selected test person's
identity. Run `auth login`, open the login link and return, then use commands or `chat` (`/exit`
leaves chat). Reload reconnects. New CLI session discards only this runner's temporary sign-in;
server restart or 30 minutes without browser activity also ends it. Clear output keeps sign-in.
An operation already accepted by the agent may still complete after its client session ends.

Enable this only in local startup code. The runner is off by default, rejects non-loopback or
forwarded connections, and is not part of the hosted test cloud. It calls the actual CLI runner
only locally. Hosted CLI support is deferred pending security review; do not add it to cloud startup
or deployment wiring (that is `flow deploy`). See the hosted CLI TODO in the README. The runner invokes the CLI
without a shell: quoting works, pipelines/expansion do not. The browser cannot override server
or token flags, or use `skill --write` to write onto the developer's computer.
For other embedded clients, `CliConfig.directory` overrides credential/conversation storage;
`CliIO.env` overrides the inherited process environment and `CliIO.signal` cancels sign-in and
terminal HTTP requests. Installed CLI defaults stay unchanged.

### Terminal conversations

`chat` talks directly to the agent, using the same bearer as MCP; it is not an MCP tool. `defineCli({ name: "acme", server, agent: "https://agent.example.com/agent/terminal" })`
overrides the terminal URL; the default is the MCP server's origin plus `/agent/terminal`.
`acme chat "Which orders are ready?" --json` prints one response; `acme chat` reads a TTY until
Ctrl-D or `/exit`. Without a TTY pass a message to `chat` (an interactive chat exits 2); sign-in failures exit 3.
Human chat shows a `You ›` input prompt, a waiting indicator and agent replies under the CLI's
name. `--json` keeps stdout as one JSON response per line, without those labels. Embedded CLIs
can supply `CliIO.lines(prompt?)` and their own output handlers to replace the presentation.
`chat.json` is mode 600 and scoped by terminal endpoint. `--new` forgets the terminal's saved
reference; the agent keeps its one-person history across channels. It does not erase a person's
WhatsApp history. Teams can replace `chat` with their own Stricli command in `commands`.

Mount the optional terminal handler beside MCP (no model or extra dependency in the CLI):

```ts
import { terminalServer } from "@flow-engineer/flow/mcp";
const terminal = terminalServer({ agent: () => agent, auth });
const agent = createAgent({ ...options, channels: [...channels, terminal.channel] });
// Route terminal.path to terminal.fetch(request), and MCP's paths to mcp.fetch(request).
```

`terminalServer` accepts `path` and `channel` overrides. It verifies auth on every POST,
serializes concurrent requests per person, and returns `{ conversationId, replies }` after the
turn settles. The authenticated key becomes the same person that `resolve` returns on other
channels. A body cannot choose its own person; a conversation reference from another person is
refused. Its custom UI uses Markdown and exports turns as channel `cli`.
For your own HTTP adapters, `agent.request({ channel, key, text, conversationId? })` exposes this
without the handler. Supply a verified key and serialize calls for that channel and person.
