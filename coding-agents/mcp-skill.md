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
- [Several servers in one deployment](#several-mcp-servers-one-deployment)
- [Exercise the CLI in a local playground](#local-playground-cli)
- [Terminal conversations](#terminal-conversations)

## Serve the tools over MCP

The same tools and skills go to Claude, ChatGPT and any MCP host as an MCP server. The SDK it runs
on, `@modelcontextprotocol/server`, comes with Flow Framework; add `src/mcp.ts`:

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
  or store. A project that is only an MCP server has `src/mcp.ts` and no `src/agent.ts`; it exports
  `tools` beside `mcp` for `flow check`, and `flow deploy` puts it on Flow's hosting
  (`oauth-bridge-skill.md`, "Deploy").
- `await mcp.stdio()` serves the same tools and instructions on stdin and stdout, for a host that
  runs the server as a local command (`claude mcp add acme -- node src/mcp.ts`), until the host
  closes stdin. Nothing but the protocol goes to stdout. There is no sign-in on stdio: the caller is
  anonymous, and tools kept to some clients are not served.
- A tool's `context.cli` is set when the agent's CLI made the call (`{ command: "order place" }`), to
  word a failure for a person at a terminal; it is the client's say-so, never for access.
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
  `inspect` standing for `npx -y @flow-engineer/flow inspect http://127.0.0.1:8790/mcp`:
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

### The feedback tool

Every MCP server, and so every CLI, has a built-in `feedback` tool (`acme feedback --about tooling
--message "..."`): whoever calls it tells the team about the MCP server or CLI itself (`about:
"tooling"`: a tool that failed or is missing, confusing inputs or results) or the product behind it
(`"product"`), with an optional `tool`. It needs no sign-in. Agents are told when to use it: MCP
hosts in the server's instructions; a CLI's help, its skill and every failed command's error name
the exact command. With traces on (always on Flow's
hosting), the call's span carries what was written even when trace content is off, and the Flow
dashboard shows it under Insights → Feedback. `mcpServer({ feedback: false })` leaves it out; a
tool of the team's own named `feedback` replaces it. An agent that imports a Flow MCP server with
`mcpTools` gets that server's `feedback` too unless it is left out of the lock.

### Keep a tool to the brand's own CLI

`mcp: { clients: ["cli"] }` keeps a tool to the CLI built with this agent's `defineCli`, for what
must never reach a third-party host's transcript (revealing an API key or another secret). The CLI
lists and calls it like any tool; every other MCP client (Claude, ChatGPT, Cursor, a raw client)
finds no trace of it: it is not in `tools/list`, the full catalog, or `search_tools`, and calling
it, directly or through `execute_tool`, answers exactly as an unknown tool. Chats ignore it, like
`deferred`, so give the agent and `mcpServer` the same tools; a chat or terminal chat (`acme chat`)
can still use the tool, and what it shows is kept in that conversation and sent to the agent's model.

```ts
export const apiKeysReveal = tool({
  name: "api_keys_reveal",
  description: "Show one API key's value. Only when the person asks for it.",
  input: z.object({ key_id: z.string() }),
  output: z.object({ name: z.string(), key: z.string() }),
  mcp: { clients: ["cli"] },
  run: ({ key_id }, ctx) => backend.revealKey(key_id, ctx),   // the brand's existing call
});
```

The caller is told apart by the OAuth client its token was issued to, never by anything a client
says about itself (MCP's `clientInfo` is not a signal). It needs `mcpServer({ auth })`; without
it no host is told apart, so such a tool reaches only the CLI in the same process
(`defineCli({ server: handle })`).
- **With the OAuth bridge** (`flow-framework-oauth-bridge`), nothing else to write: the bridge
  serves the CLI's Client ID Metadata Document at `<origin>/.well-known/oauth-client/cli`,
  advertises it as `flow_cli_client_id`, notes which client each token went to, and `verify` returns
  `client: { id, kind: "cli" }` for the CLI's tokens. The CLI signs in as that client by itself.
- **With the brand's own OAuth server,** register one public client for the CLI (loopback
  redirects, no secret), set it as `defineCli({ clientId })` (or `clientMetadataUrl`), and return
  `client: { id, kind: "cli" }` from `verify` for tokens issued to it.

A CLI signed in before the server knew its client (it registered itself, as any host does) does
not see these commands until `acme login`; an unknown command then says so. Its cached tool list is never reused for the new sign-in. Other
clients' scopes, sign-in and the brand's own checks still apply: this keeps a tool away from other
hosts, it is not a defence against someone signing in as the CLI with their own account (a public
client), who only gets their own data. `flow check` warns about a tool kept to the CLI when the
agent has no `src/cli.ts`.

## A CLI for the organization

Which commands get short forms (a group's default, positional arguments, short flags) is in
`flow-framework-cli-design` (`cli-design-skill.md`); this section is how each works.

The same tools as commands, over the organization's MCP server, with the same sign-in and gating.
It runs on Stricli (`@stricli/core`, the framework Sentry's CLI is built on). Every tool is already a
command under its own name (`place_order` is `acme place-order`); a CLI file adds what needs
judgement. Stricli and the MCP client SDK come with Flow Framework; install `marked@12.0.2` and `marked-terminal@7.3.0` to
render tools' Markdown in a terminal (the versions Flow Framework pins), and write `src/cli.ts`:

```ts
#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { command, defineCli, runCli } from "@flow-engineer/flow/cli";

export const cli = defineCli({
  name: "acme",
  server: process.env.ACME_SERVER ?? "https://acme.example.com/mcp",
  description: "Acme's orders and customers",
  groups: { order: "Place and track orders" },
  sections: { Orders: ["order"] },                 // headings in `acme -h`; the rest go under Other
  defaultCommands: { order: "view" },              // `acme order BL-1042` runs `order view`
  commands: {
    "order list": { tool: "list_orders", columns: ["order_id", "status", "total"], alias: "orders" },
    "order view": { tool: "get_order", args: ["order_id"], examples: ["acme order view BL-1042 --json"] },
    "order recent": command("list_orders").short("n", "limit").flag("state", "status").default("limit", 5),
    "order place": { tool: "place_order" },
  },
});

// Installed, the command is a link to this file: compare where it leads.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await runCli(cli, process.argv.slice(2)));
```

- `server` may be an `mcpServer(...)` handle instead of a URL: the CLI then calls those tools in the
  same process (no network, no sign-in, the client kind `"cli"`), unless `--server` or `ACME_SERVER`
  (`serverEnv` renames it) names a URL. No discovery cache is kept for it.
- Commands that parse their own arguments use the CLI's connection one level down:
  `const c = await connectCli(cli, { server })` and `await c.call("get_order", { order_id }, { command:
  "order view" })` (the data, or the tool's `ToolError`, or a `CliExit` whose `code` is the exit code).
- Words are groups then a verb: `order` is a **command group**, `list`, `view` and `place` its
  subcommands. `acme order` and `acme order -h` list the group's subcommands, `acme order place -h`
  that command's flags and examples, and `acme -h` the groups and top-level commands. A word is a
  group or a command, never both. `groups` gives each group its line in help. `defaultCommands`
  names a group's default subcommand: words naming none of its subcommands go to it (`acme order
  BL-1042` is `acme order view BL-1042`), bare `acme order` still shows the group's help.
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
- `command(tool)` writes a tool's command as code, one step per choice: `.arg("order_id")`
  positional, `.short("n", "limit")` a one-letter flag (`-n 5`), `.flag("state", "status")` the
  flag's name (`--state`; `--status` still works), `.default("limit", 5)` sent when left out, and
  `.map((input, options) => ({ ...input, ... }))` the team's own code over what is sent, run last
  (throw to refuse: exit 2 with its message); `.hide("source")` no flag for an input (fix it with
  `.default`), `.help("tag", "...")` one flag's help line, `.option("from-file", { help, kind,
  short })` a flag that is not a tool input, read in `map`'s `options`, `.print((result) => "...")`
  the output people see (`--json` still prints data); a list input as the only `.arg` takes every
  word (`<urls...>`); `.columns()`, `.view()`, `.alias()`, `.summary()` and `.examples()` as the
  object's keys. Help, completion, the skill and `flow check` read it like the object form (keys
  `shorthands`, `defaults`, `hidden`, `help`, `options`, `input`, `print`). Keep these in the CLI
  file, or a file it imports: tools never carry CLI choices.
- A command of the team's own is any Stricli command: `"report daily": { command: buildCommand({ ... }) }`
  with `buildCommand` from `@stricli/core`; inside it, `this.cli.call(tool, input)` calls the server's
  tools and `this.cli.print(value, { json })` prints like the rest.
  The CLI has no status command of its own: a team that wants one writes it, named and placed as
  it likes, such as `whoami: { command: buildCommand({ docs: { brief: "Your account" }, parameters: {},
  async func() { this.cli.print(await this.cli.call("account_info", {})); } }) }`.
- `acme login` and `acme logout` sign in and out. `signIn: { login: "auth login", logout: "auth logout" }`
  moves them (into a group of any name, beside the team's own commands there); every message, the
  welcome, the generated skill and the sign-in page say the command as set, and `signInFirst` never
  asks before them. Their words are refused to other commands (`defineCli` throws, `flow check`
  says which), and freed when moved. `signIn.beforeLogout: async ({ server, token }) => { ... }` runs
  the team's own step first, such as revoking the server's session with the stored token; if it
  throws, its message is shown and the person is still signed out on this computer.
  `signIn: false` is for a server with no OAuth (people use a token): `login` and `logout` are left out of
  help, and running them says "This server has no sign-in." Likewise `chat: false` is for a server with no
  terminal chat agent: the `chat` command, its help block, the welcome's chat tips and the skill's chat
  section are left out, and `chat` says "This server has no chat agent." A command of the team's own named
  `login`, `logout` or `chat` stays. Without the opt-outs nothing changes; the CLI does not guess from the server.
  `tools` and `skill` stay the CLI's. The words before 0.14 (`auth login`, `auth logout`, `auth
  status`) still work for a release, hidden from help, each saying what replaces it, unless the
  team's own commands use them.
- `exclude: ["api_keys_reveal"]` gives those tools no command of their own: not in help, completion
  or the CLI's skill. Use it when a command of the team's own wraps a tool (one that copies a key
  without printing it), or a tool has no place on the command line. The tools stay on the server,
  so `this.cli.call` still reaches them; `flow check` refuses a name the server has no tool for.
- `brand: { name, logo, accent }` is set once and read everywhere the CLI shows the brand: the chat,
  the welcome banner and the browser page a sign-in ends on. `name` is how people see it written
  (default the command's name): "Welcome to Acme", the chat's title, "Acme is ready" on the
  sign-in page and the client name a sign-in screen shows, while commands keep the command's name; `logo` an https or `data:image` URL, `accent` a six-digit hex color
  (`chat.accent` is its older name and still works); `flow check` refuses a bad color or logo.
- `acme login` ends on a branded page in the browser: the logo (else the name's initial), the
  accent, and "Head back to your terminal" only once the code is exchanged and the tokens are
  saved, else what went wrong and the command to try again. It tries to close the tab and stays up
  where the browser refuses. `signInPage: ({ status, brand, cli, command, message }) => html` replaces it
  with the team's own; it never gets the code, token or state, and is sent with no caching.
- Run with no command at a terminal, the CLI shows a welcome: its name in block letters (in
  the brand's accent when set), `version`, "Welcome to <name>", `description`, whether the person is signed
  in, and how to start. `welcome: { banner, title, text, tips }` replaces any part (`banner` is the
  team's own ASCII art, `false` for none; `tips` are lines as written); `welcome: false` shows the
  help instead. Coding agents (Claude Code, Codex, Cursor), scripts and pipes always get the help.
- `signInFirst: true` asks a person who is not signed in to Sign in or Exit before any command, then
  runs the command they typed; without a person (agents, CI) the command exits 3 with the sign-in
  command. The sign-in commands, `help`, `update` and `--help` never ask; `signInFirst: { except: ["docs"], message }` lets
  the team's own commands through and words the question. A token in `<NAME>_TOKEN` counts as signed in.
- Installed, it is the organization's own command: `"bin": { "acme": "src/cli.ts" }` in its package
  (node runs `.ts` files outside `node_modules`). While building it, run it with
  `npm run cli -- order -h`: npm takes flags before `--` as its own. To put it on people's
  computers, pack it (Ship the CLI, below).
- `update: { command, latest }` gives the CLI `acme update`, which runs `command` in a shell (the
  team's install script, such as `curl -fsSL https://acme.example/install.sh | sh`, or
  `npm install -g acme@latest`). `latest` is a URL answering JSON with a `version` (npm's
  `https://registry.npmjs.org/acme/latest` does; else publish a `latest.json` beside each build), and
  needs `version` set to the CLI's own (read it from package.json). With it, `acme update` says when
  this is already the newest, and a person at a terminal sees one line after a command when a newer
  one is out, asked at most once a day; never agents, CI or `--json`. Each release must raise the
  version and update `latest`. A command of the team's own named `update` replaces Flow's.
- `contract: <n>` names the server's contract this CLI is built against (`mcpServer({ contracts:
  { current: n } })`), so the server keeps answering it in that shape after its tools change. A
  CLI too old for the server says so in one line and names `acme update`. Renaming, removing or
  reshaping a tool once a CLI is out: `flow-framework-contracts` (`contracts-skill.md`).
- A tool with `format` prints its own text, rendered at a terminal (as written when piped, for
  `NO_COLOR`, or without `marked`); `--json`, `--fields`, `columns` and `view` show its data.
  Every color the CLI shows (help, welcome, chat, Markdown) comes from one palette made from
  `brand.accent`; red is only for failures. A code block is highlighted only when it names its
  language (```` ```json ````). `colors: { accent, muted, success, warning, error, heading, link,
  code, key, string, number, keyword, comment }` replaces any part with a color's name (`"green"`,
  `"gray"`), a six-digit hex color, or `false` for the terminal's own; `flow check` refuses others.
- Every tool command takes `--json` and `--fields a,b`; one that changes things takes `--dry-run`; one
  that may delete or overwrite asks first in a terminal and needs `--yes` without one. Exit codes: 0
  done, 1 the tool failed, 2 wrong command or arguments (with the help to read), 3 sign-in needed, 4
  needs `--yes`, 5 the server could not be reached. A tool that throws `ToolError` fails as a document:
  `--json` prints `{ ok: false, error: { code, message, hint }, next }` on stdout, stderr the message and
  `Next: ...`. `--server <url>` and `--token <token>` work on
  every command; `acme --version` prints the version, with no server or sign-in. `acme login` signs in on the organization's own login (tokens in
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
  exist, an `args`, `shorthands` or `defaults` field the input lacks, a shorthand for a positional
  argument or one of the CLI's own flags (`-h`, `--json`, ...), a `columns` or `view` field the output lacks, two commands
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


### Ship the CLI

On Flow's hosting, `npx @flow-engineer/flow deploy` ships it: with `src/cli.ts` in the folder it packs the CLI for
the environment's address before anything is sent (a CLI that does not pack stops the deploy;
`--no-cli` leaves it out), and once the deploy is live publishes it, so `curl -fsSL <the agent's
URL> | sh` installs it and the CLIs already out there are offered it (`acme update`).
`flow deploy promote` publishes a production build from the folder. On its own: `npx @flow-engineer/flow cli
publish --env staging|production`, `npx @flow-engineer/flow cli status [--env]` (the version served, the last
releases) and `npx @flow-engineer/flow cli rollback --env production <version>` (serves an earlier version again;
people on the one it replaces are offered it). Show the person the install line it prints.
Publishing refuses a build whose server differs from the one served (`server_changed`: everyone
who installed it would sign in again); set `servers.<env>` to the served one, or pass
`--change-server` only when the person means to sign everyone out.

`npx @flow-engineer/flow cli pack --server production` (or `staging`, or an https MCP URL) bundles `src/cli.ts`
with every dependency into one package that needs only Node.js 20.19 or newer, and writes
`release/acme.tgz`, `release/install.sh` and `release/release.json` (`{ name, display_name,
version, sha256, size, server }`). `staging` and `production` are the hosted agent's address
(asked of the cloud with `FLOW_FRAMEWORK_CLOUD_KEY`) plus `/mcp`. The version is package.json's,
the server's name and the git commit: `0.1.3-production.ab12cd3` (`custom` for a URL, `.dirty`
with uncommitted changes), so commit first. It needs esbuild: `npm i -D esbuild@0.28.2` (the
starter has it). Add `release/` to `.gitignore`.

- `servers: { production: "https://cli.acme.com/mcp" }` fixes the server a pack for that
  environment uses, in place of the hosted address (`flow cli pack --server production` and every
  `flow deploy` read it). Set it before the first release when the CLI lives on a domain of its
  own, and never change it.
- Write the default server once, as a string: `server: process.env.ACME_SERVER ?? "http://127.0.0.1:8790/mcp"`.
  Pack puts the release's server in its place (the variable still overrides it) and refuses a
  file where that string is missing or written twice.
- Start `runCli` through `realpathSync(process.argv[1])`, as above: npm installs the command as a
  link, and a CLI that compares `process.argv[1]` itself does nothing when installed. Before it
  packs, pack runs the bundle's `--help` through a link from an empty folder and refuses it
  without `USAGE`.
- Files the CLI reads at run time (an icon, a JSON catalogue) go in `files: ["context/icon.svg"]`
  and are read with `readFileSync(cliFile("context/icon.svg"))` (`cliFile` from
  `@flow-engineer/flow/cli`): beside the bundle when packed, in the agent's folder from the source.
- A packed CLI's `version` is the release's. Without `update` in the CLI file, `acme update` runs
  `curl -fsSL <base> | sh` and people hear of a newer version from `<base>/cli/version`; `<base>`
  is the hosted agent's address, else `--base-url`, else the server's origin.
- `install.sh` installs into `~/.acme` (`ACME_HOME`) without sudo, checks Node and the package's
  sha256, refuses another `acme` already on PATH, and links the command into a writable PATH
  folder (else `~/.local/bin` and one line in the shell's rc file). `ACME_CLI_URL` installs another
  package, unchecked. Serving it yourself: `--base-url https://get.acme.example` writes the
  address into install.sh; serve it at `/`, the package at `/cli/acme-<version>.tgz` and
  `{ "version": "<version>" }` at `/cli/version`.

Domains, and what never changes once people have the CLI:
- The server URL packed into a shipped CLI never changes. The CLI keeps each person's sign-in by
  server URL, so a build with another one signs everyone out. Choose it before the first release.
- A team whose MCP server people already use can launch only the CLI on a domain of its own,
  such as `cli.acme.com`: add it to the agent as an extra domain (dashboard, Settings → Domains)
  and set `servers: { production: "https://cli.acme.com/mcp" }` in the CLI file once; packs for
  production then use it, whatever the agent's own address. The existing MCP server stays where
  it is.
- Later, `mcp.acme.com` can be added as another extra domain of the same agent; shipped CLIs keep
  `cli.acme.com`. When the MCP server moves there, add its `https://mcp.acme.com/mcp` to the
  OAuth bridge's `resources` (`oauth-bridge-skill.md`), beside the ones already there.
- Changing the sign-in issuer (the OAuth server's origin) signs everyone out, on every surface.

### Several MCP servers, one deployment

One deployment can serve several MCP servers, each its own object (name, tools, auth, contracts),
with the web app and terminal chat, behind one sign-in. `mount` routes by path; each path is its own
protected resource (`<origin><path>`), and one server can be at several paths. `tools` takes plain
tools and tool groups (`toolGroup`; a group's channels are the chat agent's and do not apply here).

```ts
import { mcpServer, mount, webApp } from "@flow-engineer/flow/mcp";
export async function mcp(agent: Agent, host: { oauthStorage?: OAuthStorage }) {   // Flow's hosting calls this
  const bridge = await oauthBridge({ ...options, storage: host.oauthStorage,
    resources: ["https://acme.com/mcp", "https://acme.com/cli/mcp", "https://acme.com/internal/mcp"] });   // every path; the first is the web app's
  const signIn = bridge.auth;                                                        // one sign-in for every server
  const staff = signIn.only((who) => who.email?.endsWith("@acme.com") ?? false);
  const publicMcp = mcpServer({ name: "acme", version, tools: [orders, docs], auth: signIn });
  const cli = mcpServer({ name: "acme-cli", version, tools: [orders, docs, cliOnly], auth: signIn, contracts });
  const internal = mcpServer({ name: "acme-internal", version, tools: [orders, docs, cliOnly, admin], auth: staff });
  return mount({ "/mcp": publicMcp, "/cli/mcp": cli, "/internal/mcp": internal, "/app": webApp({ agent, ...app }) });
}
// The CLI: defineCli({ name: "acme", server: "https://acme.com/cli/mcp" })
```

- **`auth.only(allow)`** keeps a server to some of the people the sign-in signs in: `allow(who, request)`
  gets the verified identity (the brand's `verify` returns `email` beside `key` for this). Everyone
  else is refused whatever they call: 401 without a token, even for a tool that needs no sign-in, and
  403 `access_denied` when signed in. `only` on an `only` keeps both. A sign-in that is not the
  bridge's sets `allow` on its `McpAuth` itself.
- **Each path is its own resource**: list every path's URL in the bridge's `resources`, and the brand's
  token functions get the resource a token is for, so one minted for `/mcp` is not valid at `/internal/mcp`.
  Reached at more than one hostname: the bridge's `origins` (`oauth-bridge-skill.md`, "Deploy").
- **The web app** (`webApp`, at `/app`; the options are mcpServer's `app`, with `agent`, `terminal` and
  `server`) uses the first mounted server, or `server`: the panel calls it, and it is the URL people add.
  It serves terminal chat (`/agent/terminal`) with `agent`. Give the servers no `path`, `agent` or `app`
  of their own: mount sets their paths. A server's plugin endpoint is at `<path>/plugin` unless `plugin: false`.
- `mount(...)` returns `fetch`, `node`, `paths`, `descriptors` and `flushTraces`, the shape Flow's
  hosting takes from the `mcp(agent, host)` factory, so it deploys like one server.

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
identity. Run `login` (or the CLI's `signIn.login`), open the login link and return, then use commands or `chat` (`/exit`
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
Run by a coding agent (`CLAUDECODE`, `CURSOR_AGENT`, `CODEX_CI` or `AI_AGENT` set) or with `--plain`, chat
acts as without a TTY even at a terminal: replies print as written and the interactive view never opens.
Human `chat` opens a dedicated full-screen session with a bottom composer, Markdown replies and
live tool activity. Sent messages have subtle shading when the terminal reports its background. It inherits terminal colors; `defineCli({ ..., brand: { accent: "#b85c00" } })`
sets a hex brand accent, approximated in 256 colors, without changing the background; on a 24-bit terminal sent messages take a faint wash of it. Install optional `@mariozechner/pi-tui@0.73.1` for that interface; `flow new`
includes it. Press Enter to send; Shift+Enter, Alt+Enter or `\` then Enter adds a line. Multiline paste
stays in the draft. Tab completes `/help`, `/details`, `/new` and `/exit`. Ctrl+O expands tool
inputs/results; the mouse wheel/trackpad, Up/Down (outside a multi-line draft) and PageUp/PageDown
scroll the transcript, preserving the reading position during incoming replies. Ctrl+P/Ctrl+N
recall sent messages. Chat leaves the mouse to the terminal, so text selects and copies as usual. Ctrl+Home/Ctrl+End jump to the start/latest reply. Escape stops waiting; accepted work may still finish.
A failed request preserves its message for editing. `/new` clears the view and saved terminal
reference, preserving shared person history. `--json` remains the original response format.
Single-message calls and dumb terminals do not open the full-screen UI. Embedded clients can
supply `CliIO.chat(session)` to replace it, or keep `CliIO.lines(prompt?)` for basic line input.
The session exposes `send(text, update, signal)`, `reset()`, `name`, `color`, `accent` and `signal`.
The terminal endpoint streams when the request accepts `application/x-ndjson`: `activity`, `reply`
and a final `done` record containing `result`; older servers returning JSON still work. Activity
is scoped to the authenticated person's conversation, excluding model context and hidden text.
`chat.json` is mode 600 and scoped by terminal endpoint. `--new` forgets the terminal's saved
reference; the agent keeps its one-person history across channels. It does not erase a person's
WhatsApp history. Teams can replace `chat` with their own Stricli command in `commands`.

With sign-in, give `mcpServer` the agent and it serves chat itself: `/agent/terminal` on the MCP
server's origin, checked with the same `auth.verify` as `/mcp`, listed in `paths` so Flow's hosting
mounts it, and the terminal channel added to the agent (`agent.addChannel`). On Flow's hosting the
`mcp(agent, host)` factory already has the agent:

```ts
export async function mcp(agent, host) {
  const bridge = await oauthBridge({ ...options, storage: host.oauthStorage });
  return mcpServer({ name, version, tools, auth: bridge.auth, agent });   // chat at /agent/terminal, signed in only
}
```

With `auth.scopes`, only a token holding every named scope may chat (a turn can call any tool).
`terminal: { guests: true }` lets a CLI that is not signed in chat too, `terminal: false` turns it
off, and `terminal: { path, channel }` renames them. Do not also mount `terminalServer` for the same
agent: two channels named terminal are refused.

`terminalServer({ ..., showsTools: true })` (and `instructions`, `traceChannel`) is for a client that
draws each tool call as it runs: the agent then answers once, with no acknowledgement first
(build-agent-skill.md, `showsTools`). Terminal chat leaves it off.

### The web app (the tools inside the brand's own site)

For people who use the brand's website, not an assistant or a terminal: the same tools and agent as
a chat panel docked at the side of the site (the page moves over; it never covers it), with each tool
call shown as it runs, the CLI line that does the same, and how to add the tools to Claude, ChatGPT,
Cursor, VS Code and the terminal. The agent's own process serves the panel; the brand styles it. Turn it on with `app`:

```ts
import { cli } from "./cli.ts";
mcpServer({ ..., auth: bridge.auth, agent, app: {
  origins: ["https://www.acme.com"],             // the sites that may embed it: exact origins
  site: "https://www.acme.com",                  // its links to these pages open in the site itself
  title: "Acme", subtitle: "Your orders", logo: "https://www.acme.com/icon.png",
  greeting: "Hi! I can check and change your orders.", suggestions: ["Where is my order?"],
  url: "https://mcp.acme.com/mcp",               // the MCP URL people add to their assistant
  cli: { file: cli, install: "curl -fsSL https://cli.acme.com | sh" },   // each step's CLI line, from the CLI file
  theme: { accent: "#645bff", font: "Geist, system-ui", fontUrl: "https://fonts.googleapis.com/css2?family=Geist", monoFont: "Geist Mono",
           radius: 8, style: "soft", pattern: "dots", density: "compact", colors: { surface: "#F5F7FA" }, css: ".copy{background:#22221f}" },
  panel: new URL("./ui/panel.ts", import.meta.url),   // the panel's parts in code (below)
  places: ["claude", "terminal", "cursor"],      // the "Use it in" row: which, in this order
  ui,                                            // the views the agent can show (below)
  pages: ["/dashboard", "/dashboard/orders"],    // the site's real pages: views link only these
} });
```

The site adds `<script async src="https://<agent>/app/embed.js"></script>` (its CSP must allow the
agent in `script-src`, `frame-src` and `connect-src`). The panel is an iframe on the agent's origin,
so the person's token never reaches the site's page. Its chat is its own channel, `app` at
`/app/chat`, with `showsTools` on.

- **Signed in with the site's session, no page shown.** Give `oauthBridge` `app: true`
  (oauth-bridge-skill.md, "The web app"). On the site, before the tag:
  `window.FlowAppConfig = { account: <the signed-in person's id>, signIn: async (request) => <the code the login page would mint for request>, navigate: (path) => router.push(path), pageFailed: () => <why the page failed, or null> }`.
  `account` changing signs the panel in afresh; `FlowApp.signOut()` when they sign out on the site.
- **Links** to the site's own pages open in the site (`navigate`, else a page load) and are checked
  once shown: an error status, a "not found" page, a redirect elsewhere or `pageFailed()`. A failed
  one is recorded for the brand's insights. Give the agent a skill listing the site's real page URLs
  (which results have a page, which are found from a list page, which have none), so it only links
  pages that exist, and test that list against the live site.
- **Views are Flow's hosted service only.** On Flow's hosting (`FLOW_APP_SERVICE_URL` and the
  agent's `FLOW_KEY`) each of the brand's `ui` (`AppUi`: `name`, `description`, `input` as a Zod
  schema, `template` as HTML) is a `ui_<name>` tool, offered only on the web app's channel
  (`uiTools(ui, pages, site)` is that group, `views` limited to `app`; mcpServer adds it to the agent
  unless the agent already has a `views` group, so an agent can pass it in `groups` itself and test it). The agent fills the input in its own words (never a copy of a tool's response)
  and the panel draws the template in a sandboxed frame. It shows a view when one helps, at most one
  per answer, and its words add only what the view does not show. A view linking a page not in
  `pages` (a `{name}` is one segment, e.g. `/dashboard/orders/{order_id}`) is refused, and the agent
  is told to fix it. Self-hosted, there are no views: the agent answers in Markdown and nothing is
  sent anywhere; everything else works the same.
- **The panel's parts are the team's code.** `panel: new URL("./ui/panel.ts", import.meta.url)` (or a
  path from the working directory) is a browser module, served from the agent's own process at
  `/app/parts.js`: one file that imports only types (TypeScript has its types stripped as Node does, so
  no enums or namespaces; a `.js` file is served as it is). It exports any of `header`, `message`,
  `typing`, `background` and `composer` (`AppPanel` from `@flow-engineer/flow/mcp`); each gets the
  element the panel drew and what it shows, and returns the node to show: that element restyled,
  wrapped, or a new one. A part it does not export, or one that throws, stays the panel's own.

  ```ts
  import type { AppPanel } from "@flow-engineer/flow/mcp";
  export const message: AppPanel["message"] = (element, { role }) => {
    if (role === "agent") element.querySelector<HTMLElement>(".bubble")!.style.border = "1px solid var(--border)";
    return element;
  };
  // The field and its send button keep their behaviour wherever they go (Enter sends, Shift+Enter is
  // a new line, off while the agent answers); a node without both is not used.
  export const composer: AppPanel["composer"] = (element, { input, send }) => {
    const box = document.createElement("div");
    box.className = "my-composer";
    box.append(input, send);
    return box;
  };
  ```

  `header` gets `{ title, subtitle, logo, mark, status, newChat, close }` (`status` changes as the
  person signs in; the buttons work wherever they are placed), `message` `{ role: "me" | "agent", text,
  body }` (`body` is the agent's Markdown, drawn with its HTML escaped), `typing` `{ avatar }`,
  `background` `{ pattern, mode }` (a layer behind the panel that takes no clicks), `composer`
  `{ input, send, placeholder }`. Use `textContent`, or `body`, never `innerHTML` with the text.
- **Part names for CSS.** Each part's root has `data-part="<name>"`, the panel's own and a module's
  alike, beside its class: `header` (`.head`), `message` (`.msg.me`, `.msg.agent`, their `.bubble`),
  `typing` (`.msg.typing`), `background` (`.backdrop`), `composer` (`.composer`, the field `.field`,
  the button `.send`). Also `.thread`, `.welcome`, `.starter`, `.steps`, `.view-box`, `.sheet`.
- **The row under the composer is Flow's.** "Use it in" and "Powered by Flow" are drawn by the panel
  in a closed shadow root on the body, in the top layer; no module or CSS reaches it, and the panel puts
  it back if a script moves or covers it. Only `places` is the team's: which of `"terminal"`,
  `"claude"`, `"chatgpt"`, `"cursor"`, `"vscode"` it offers, in that order (default all, the terminal
  first and only with `cli`); their addresses are `url` and `cli.install`. Its colors follow the
  theme's background, text and muted colors while they read clearly (3:1), else the panel's defaults.
- **An onboard button on the site's pages.** `onboard: { prompt, label?, agents?, askLabel? }` (the
  prompt a coding agent needs to start with the product). The site places `<div data-flow-onboard></div>`
  (or calls `FlowApp.onboard(element, { label, variant })`); the embed draws a pill with the assistants'
  icons that opens the prompt with "Copy prompt" and a button that opens the panel to ask. The prompt is
  also in the page (`[data-flow-onboard-prompt]`, visually hidden) for agents reading it. The site sets its
  own label with `FlowAppConfig.onboard` or `data-label`. `FlowAppConfig.launcher: false` hides the floating
  launcher on a page; the panel still opens from `FlowApp.open()` or the onboard button.
- Everything else generated stays the team's: `theme.css` styles the parts above, and the panel's routes
  (`/app`, `/app/embed.js`, `/app/parts.js`, `/app/chat`, `/app/view`, `/app/link`, `/app/command`) are
  listed in `paths`.

Without sign-in, or to serve chat from the agent's own port, mount the terminal handler as one of
the agent's routes (no model or extra dependency in the CLI). Flow's hosting and the local
playground (`npm start`) both serve an agent's `routes`:

```ts
import { terminalServer } from "@flow-engineer/flow/mcp";
const terminal = terminalServer({ agent: () => agent, auth }); // omit auth: everyone chats as a guest
const agent = createAgent({ ...options, channels: [...channels, terminal.channel], routes: { [terminal.path]: (r) => terminal.fetch(r) } });
```

The CLI's chat goes to the MCP server's origin plus `/agent/terminal` unless `defineCli({ agent })`
names another URL; locally the agent and `npm run mcp` listen on different ports, so the starter's
CLI file reads the running agent's URL with `runningAgent(dir)`.
Without `auth`, or with `guests: true` beside it, a CLI that is not signed in chats as a guest: it
sends a random id it keeps (header `flow-guest`), and the agent keeps that guest's conversation on
this channel only, never joined to an account (`ctx.key` is null), so a tool that needs sign-in
asks for it. With `auth` and no `guests`, chat answers 401 until `acme login`. Guests run turns on
the agent's model key; limit them in front of the route if strangers can reach it.

`terminalServer` accepts `path` and `channel` overrides. It verifies auth on every POST that carries a token,
serializes concurrent requests per person, and returns `{ conversationId, replies }` after the
turn settles. The authenticated key becomes the same person that `resolve` returns on other
channels. A body cannot choose its own person; a conversation reference from another person is
refused. Its custom UI uses Markdown and exports turns as channel `cli`.
For your own HTTP adapters, `agent.request({ channel, key, text, conversationId? })` exposes this
without the handler. Supply a verified key, or `guest` (an id the client keeps) instead of `key`,
and serialize calls for that channel and person.
