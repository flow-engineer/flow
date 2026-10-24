# Flow Framework

**Build once. Ship to every chat.**

One open-source TypeScript framework to bring your product to Claude, ChatGPT, the terminal,
WhatsApp, iMessage, Telegram and your own app. Write your tools and skills once; use them as
an MCP server, a plugin, a CLI and a messaging agent.

We're building Flow for a chat-first world: people should be able to use a product by asking for
what they need, where they already chat. Moving a booking or placing an order should happen in
the conversation—not end with a link to a form. Whether someone texts your business or asks their
own assistant, the same product capabilities should be available to them.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE) ![Node 22.18+](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen.svg) ![TypeScript](https://img.shields.io/badge/TypeScript-yes-3178c6.svg)

[Documentation](https://docs.flow.engineer/framework) · [Quickstart](https://docs.flow.engineer/framework/quickstart) · [For coding agents](https://docs.flow.engineer/agents) · [Website](https://flow.engineer)

## One codebase, every interface

| Build | Reach |
| --- | --- |
| [MCP server](https://docs.flow.engineer/framework/mcp) | Claude, ChatGPT and other MCP clients |
| [Plugin](https://docs.flow.engineer/plugins) | Hosts that load native skills and an MCP connection |
| [CLI](https://docs.flow.engineer/cli) | People, scripts, Claude Code, Codex and other coding agents |
| [Messaging agent](https://docs.flow.engineer/conversations) | WhatsApp, iMessage, Telegram, SMS and your own web or app chat |

Tools are typed TypeScript functions that call your APIs. Skills teach the workflows around them.
Flow exposes the same capabilities through each interface, with authentication hooks for your
users and room to customize the generated tools, commands and handlers.

In Claude and ChatGPT, the host's model uses your MCP tools. In messaging, Flow runs the
conversation with your model, handling double texts, acknowledgements, background tools,
channel rules, reminders, persistent history and the agent's own records. Start with whichever
interface you need.

## Quick start

Node 22.18 or later. Create a project from the café example:

```sh
npx @flow-engineer/flow new my-agent --display-name "My agent"
cd my-agent
npm install
```

The starter includes the same tools in an MCP server, a CLI and a messaging agent.

### MCP and CLI

Start the server:

```sh
npm run mcp
```

It prints the MCP URL and a command to connect Claude Code. In another terminal, try the CLI:

```sh
npm run cli -- --help
npm run cli -- menu --json
```

To test any MCP server from the current chat, use `npx @flow-engineer/flow inspect <url> tools`
with the URL the server prints. `call`, `auth`, `resources` and `prompts` exercise its tools,
sign-in and other capabilities as a host does, without requiring a CLI configuration.

These tool calls need no model key. To reach Claude or ChatGPT remotely, host the MCP server over
HTTPS and connect it in the host. [MCP and sign-in](https://docs.flow.engineer/framework/mcp) · [Plugin packages](https://docs.flow.engineer/plugins)

### Messaging and the playground

```sh
npx @flow-engineer/flow link --channel telegram
npm start
```

`link` signs in, sets up the trial keys and prints a phone link. Use `--channel whatsapp` or
`--channel imessage` for those platforms when available. Open the playground URL from `npm start`
to try the agent locally, then text it from your phone while it runs. You can also use your own
model key and messaging provider. [Full setup and trial details](https://docs.flow.engineer/framework/quickstart)

## Build with your coding agent

`flow new` includes coding-agent skills and an `AGENTS.md` pointing to them. Give Claude Code,
Codex or another coding agent your product's codebase and tell it which interfaces to build.
Replace the café tools with calls to your APIs and teach your workflows through skills.

Read the [coding-agent guide](https://docs.flow.engineer/agents), or explore the [café example](examples/cafe).

## Test, host and observe

Check tools, skills and CLI configuration with `npx @flow-engineer/flow check`. Test the messaging
agent with simulated conversations, inspect traces, and deploy on your own infrastructure or
Flow Cloud. The playground simulators follow each app’s behavior, including channel-specific
controls, media and voice notes; Debug mode shows the underlying platform payloads. Flow Messaging
provides channels through one API; you can also bring your own providers.

[Deployment](https://docs.flow.engineer/hosting) · [Self-hosting](https://docs.flow.engineer/self-hosting) · [Testing](https://docs.flow.engineer/testing) · [Traces](https://docs.flow.engineer/traces)

## Documentation

The [documentation site](https://docs.flow.engineer) covers the Framework and the
[Unified Messaging API](https://docs.flow.engineer/unified-messaging-api). Its source lives in the
private `flow-engineer/docs` repository. Public behavior changes update the relevant guide there
for people and coding agents; see [AGENTS.md](AGENTS.md).

[Tools](https://docs.flow.engineer/build-agent) · [Skills](https://docs.flow.engineer/skills) · [Models and options](https://docs.flow.engineer/reference)

In this repository: [channel options](docs/channels.md) · [patterns that worked](docs/patterns.md) (enforce what matters in `beforeSend`, keep prompts for judgement, render in code, refuse with a reason the model can act on, test a long chat).

A channel's `sendMessage` resolves when your platform accepted the message and rejects when it
refused it: the agent's next message waits for it, and a rejection reaches the agent as Not
delivered. What is ordered, what is sent once and what `send()` resolving means:
[docs/guarantees.md](docs/guarantees.md).

Ready-made `beforeSend` checks compose with `guards(...)`, the first refusal winning:
`oncePerChat(line)` (a disclaimer at most once per conversation), `noRepeats()`,
`linkAllowlist(hosts)` and `noWriteButtons(actions)`; they read what was sent from the stored
history (`context.sent`), so they hold after a restart. `agent.resetHistory({ to, note })` starts
the history the model is sent again from now (nothing is deleted). Each model call carries at most
24,000 tokens of history, or 60% of the model's `contextTokens` when that is less
(`createAgent({ history: { maxTokens } })` to change it).

What the agent must remember across days and people (a buyer's question waiting for the
seller's answer) it keeps as records: small JSON documents in collections declared on
`createAgent({ records })`, read by id or matched on a few declared fields, in the same store as its
conversations, so they survive restarts and deploys and work the same in the playground,
self-hosted and on Flow's hosting. Forgetting a person deletes the records that name them, and
`flow records export` prints them all. The rule: if anything other than the agent reads it, it
belongs in your own database. [docs/agents.md](docs/agents.md#the-agents-own-records)

## Stability

Flow Framework is 0.x: until 1.0 its API (exports, options, file formats, the CLI's commands,
`--json` fields and exit codes) may change between releases. Every release's notes call out each
breaking change with a migration note saying what to change. The API freezes at 1.0. Pin the exact
version in `package.json` for production, and read the notes before you move it. What freezes at
1.0: [docs/stability.md](docs/stability.md).

## License

[Apache-2.0](LICENSE)
