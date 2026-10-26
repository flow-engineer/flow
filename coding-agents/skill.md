---
name: flow-framework
description: Set up a Flow Framework project, choose its interfaces, and find the guidance for its messaging agent, MCP server or CLI. Load when starting a project or changing its shared layout and names.
---

# Building on Flow Framework

A project shares tools and skills across messaging agents, MCP servers, plugins and CLIs.
Start with the interfaces the owner needs.

## Read the guide for the task

Read only the relevant guides; do not load every skill upfront.

| Task | Skill | Package file |
| --- | --- | --- |
| Build or operate a messaging agent, its playground, phone connection or deployment | `flow-framework-build-agent` | `build-agent-skill.md` |
| Serve MCP tools, configure deferral, build a CLI or package plugins | `flow-framework-mcp` | `mcp-skill.md` |
| Write or change tools and their test files | `flow-framework-tools` | `tools-skill.md` |
| Write or change test scenarios | `flow-framework-tests` | `test-skill.md` |
| Gather the context pack from an existing app, API or database before building tools | `flow-framework-context` | `context-skill.md` |
| Set up verified identity and backend credentials | `flow-framework-auth` | `auth-skill.md` |

The starter installs each at `.claude/skills/<skill-name>/SKILL.md`. If the coding agent cannot
load a skill by name, read that file. Package copies live in
`node_modules/@flow-engineer/flow/coding-agents/<file>`; inside the framework checkout, use
`coding-agents/<file>`.

## Start a new agent

`npx @flow-engineer/flow new <name>` (lowercase letters, digits and dashes) makes `./<name>/` from the café
example: a complete agent with tools and tests that depends on the `@flow-engineer/flow` package and imports
`@flow-engineer/flow` and `@flow-engineer/flow/simulators`, with these skills in `.claude/skills/`. Run `npm install` there.
Build in it, changing the café agent's prompt, skills, tools and tests into yours. A provider key is optional:
`npx @flow-engineer/flow link` (or `setup`) writes `FLOW_KEY`, the agent's one Flow key, into `.env` (never
read or print it), and the agent calls models through Flow with it on $2 of Flow trial credit. A key of the owner's own wins over it, made
at the provider: `OPENROUTER_API_KEY` at https://openrouter.ai/keys,
`OPENAI_API_KEY` at https://platform.openai.com/api-keys, `ANTHROPIC_API_KEY` at
https://console.anthropic.com/settings/keys, or `GEMINI_API_KEY` at https://aistudio.google.com/apikey.
The first one with a value is used, and `MODEL` sets the model id. Then `npm start`
opens the playground; `npm run typecheck` checks the types.

Inside a clone of Flow Framework itself, `npm run new -- <name>` copies the café to `agents/<name>/`
instead (git-ignored, so it never collides with a pull). Its imports of `../../../src/` and
`../../../simulators/src/` stay as they are, so changes to Flow Framework show at once; the key goes in
`agents/<name>/.env`. The companion guides import `@flow-engineer/flow` and `@flow-engineer/flow/simulators`; in a clone's
agent, keep its relative imports.

## Send Flow feedback

When Flow Framework gets in your way (a command fails or prints the wrong `next`, a guide is wrong
or missing, an error does not say what to do) or something works well, tell the Flow team once per
problem. No key is needed; expect `201`:

```sh
curl -sS https://api.flow.engineer/v1/feedback -H 'content-type: application/json' \
  -d '{"feedback": "<what happened, what you expected, how to reproduce>", "kind": "bug", "agent": "<your name>", "flow_version": "<@flow-engineer/flow version>", "about": "<command, API or page>"}'
```

`kind` is `bug`, `docs`, `feature` or `other`; only `feedback` is required (up to 4,000 characters).
Describe Flow's behaviour, never the owner's keys, `.env` values, customers' data or private code,
and tell the owner in one line what you sent. The sender's IP address is kept with it. Fields and
answers: https://docs.flow.engineer/agents#send-flow-feedback.

## Names

Before `new` or `init`, ask the owner what people should call the agent (the machine name follows
from it unless they want another), and tell them where people see each name:

- **`name`**, the machine name (`skycast-agent`: lowercase letters, digits and dashes). `flow new
  <name>` takes it; `flow init --name <name>` too, else it is `--display-name` in lowercase and
  dashes, else the folder's name. People see it as:
  - the CLI command they type (package.json's `bin` key), in its help and every hint it prints
    (`skycast-agent auth login`), and as the speaker in `skycast-agent chat`;
  - the CLI's variables `SKYCAST_AGENT_SERVER` and `SKYCAST_AGENT_TOKEN`, and its folder
    `~/.config/skycast-agent/`;
  - the CLI's sign-in: it registers itself with the login server as "skycast-agent CLI", which a
    consent screen may show, and the browser page after sign-in says "go back to skycast-agent";
  - the MCP server's own name (`serverInfo.name`), which hosts that show a server's name show, and
    the name in the `claude mcp add` line `npm run mcp` prints, which Claude Code lists (in Claude's
    and ChatGPT's connector settings the person types a name of their own);
  - the plugins `flow plugin` makes: the plugin's name and its MCP server's (`--name` overrides),
    with package.json's `description` as the plugin's description.
- **`displayName`**, what people call the agent (`Skycast`): `--display-name`. People see it as:
  - the message their phone sends to reach it, `Hi Skycast (ref <code>)`, filled in by the link
    `link` prints and by its /try page;
  - the name the agent gives itself in chats, from its prompt `agent/AGENTS.md`.
  The owner also sees it on the playground and in what `npm start` and `npm run mcp` print.

Both live in `package.json` and nowhere else in the code: `src/name.ts` reads them for `src/cli.ts`,
`src/mcp.ts` and `src/main.ts`. To rename the agent, change `name` and the `bin` key to the same
new name; to change the display name, run `npx @flow-engineer/flow link --display-name "<name>"`,
which changes `displayName` and the name in `agent/AGENTS.md`. Flow's account knows the agent by
`name` once `link` or `setup` ran: a new `name` is a new agent there while the keys already in
`.env` stay the old one's, so rename before the first `link` when you can.

## Layout

```
my-agent/
  agent/AGENTS.md              the agent's prompt (the model reads it every turn)
  agent/skills/<name>/SKILL.md skills the agent loads when it needs them
  src/tools.ts                 the agent's tools (see tools-skill.md)
  src/agent.ts                 buildAgent(): the one place the agent is built
  src/main.ts                  runs it in the playground
  src/name.ts                  the agent's names, read from package.json (see "Names")
  src/mcp.ts                   optional: the tools as an MCP server (mcp-skill.md)
  src/cli.ts                   optional: the CLI file (mcp-skill.md)
  context/                     optional: the context pack the tools are written from (context-skill.md)
  mcp.lock.json                optional: the tools of other MCP servers the agent uses (tools-skill.md)
  tests/tools/*.yaml           how each tool behaves in tests (see tools-skill.md)
  tests/scenarios/*.yaml       the tests (see test-skill.md)
```

`agent/AGENTS.md` is the agent's prompt, not instructions for coding agents. Keep it short: what
the agent is for, what it may and may not do. Don't explain messaging in it: Flow Framework adds how to
talk to the person (send_<channel>, react, edit_message and unsend_message where the channel has
them, acknowledging first, channel formatting) on its own.

A skill's `SKILL.md` starts with `name` and `description`; the agent sees every description and
loads the full skill only when it decides it needs it. Put rules for one kind of request in a
skill, not in AGENTS.md.

## Send traces to a dashboard

Every turn can go to a traces endpoint as an OTLP/JSON trace, posted to `<url>/v1/traces`, so
playground and real chats show up in a dashboard and can be graded. No code: set these in the
agent's environment. The address is https://flow.engineer/observe unless `FLOW_FRAMEWORK_TRACES_URL`
names another; the trace key is made on that same site (never print it):

```sh
FLOW_FRAMEWORK_TRACES_KEY=...
FLOW_FRAMEWORK_TRACES_URL=https://flow.engineer/observe  # the default; set it only to send them elsewhere
FLOW_FRAMEWORK_TRACES_CONTENT=1                          # send what was written; without it, metadata only
```

Without `FLOW_FRAMEWORK_TRACES_CONTENT=1` the dashboard
gets ids, timing, model calls and tool names but no messages, so nothing to show or grade. `setup`
writes it (with a comment saying so) when the traces key it adds is a test key (`otk_test_`, the
Staging dashboard) and `.env` does not set it already; set it to 0 for metadata only. Or in
code: `createAgent({ ..., traces: { url, key, content: true, version: "v3" } })`. Traces are sent in the
background after each turn and a failed send is dropped (logged once), so a dashboard outage never
touches a chat; call `await agent.flushTraces()` before the process exits. Tests run under
`node --test` never send from the environment. Under `flow test` the traces say they are a test's
(`chinwag.run_kind` is "test", else "production", and each turn names the test session as
`chinwag.test.session`), so the dashboard keeps them apart from real conversations. Playground
turns (`npm start`'s page, `flow chat`) run in the same process as real ones, so their root span
says so instead: `chinwag.via` is "playground", and a real turn has no `chinwag.via`. Each trace's
`chinwag.channel` is the platform (`whatsapp`, `sms`, `telegram`, `imessage`, `web` for a custom UI,
`cli` for the terminal), the same on the root span and its send spans; a custom channel of your own
can name its platform with `traceChannel` (one of these; any other name traces as `other`).
