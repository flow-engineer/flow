# Changelog

Every release's changes, and a **Migration notes** section for each ([docs/releasing.md](docs/releasing.md)).

## Unreleased (0.6.0: Store migration 10 needs a new minor, so Flow's hosting runs it first)

### Changes

- **The agent's own records.** `createAgent({ records: { questions: { people: ["buyer", "seller"],
  fields: ["listing", "status"] } } })` declares collections of small JSON documents the agent keeps
  across days and people, in the same store as its conversations: `context.records` in a tool,
  `agent.records` elsewhere, with `put`, `get`, `query` (equality on declared fields, oldest first,
  pages of up to 100), `delete`, `forgetPerson` and `export`. They behave the same on SQLite,
  Postgres, the playground and Flow's hosting, per agent and environment. `agent.forgetPerson`
  also deletes the records that name the person in a `people` field. Limits in `RECORD_LIMITS`:
  64 KB a record, 10,000 an agent, 20 collections, 8 declared fields each. If anything other than
  the agent reads the data, it belongs in your own database ([docs/agents.md](docs/agents.md#the-agents-own-records)).
- **`flow records export`** prints every record of the agent in the folder (the store its
  `buildAgent` opens) as JSON Lines.
- `mcpServer({ records: agent.records })` gives tools served over MCP the same records.
- The playground shows the agent's records.
- Store migration 10 adds the tables `records` and `record_index`; it runs on the agent's first
  start, as every migration does, and changes no existing table.

### Migration notes

- **`ToolContext` has a new field, `records`.** Flow Framework fills it for every tool call. Code that
  builds a `ToolContext` itself (a unit test calling a tool's `run`) adds it: `records: agent.records`.
- **`StoreApi` has the record methods** (`putRecord`, `getRecord`, `queryRecords`, `deleteRecord`,
  `forgetRecords`, `exportRecords`). A store of your own that forwards each call to a `Store` (as
  Flow's hosting does) forwards them too; a hosted agent on 0.6 deploys once Flow's hosting runs
  0.6 (until then `flow deploy` refuses it, as for any newer line).

## 0.5.2 (2026-10-24)

### Changes

- **`skill` lists skills and reads only the ones requested.** `skill` or `skill list` prints names
  and descriptions; `skill get <name> [name...]` reads selected workflows or the generated
  `<cli-name>-cli` guide. `--json` returns named records; `--write <dir>` exports selected SKILL.md
  files. Batch reads share one MCP connection.
- MCP advertises skill summaries on the existing `read_skill` descriptor, without exposing bodies
  during discovery or adding another tool. Older servers still supply names from `read_skill`'s
  schema. The generated CLI guide includes handwritten commands and maps MCP tool names to commands.

### Migration notes

- **Bare `skill` now lists summaries instead of printing the whole CLI guide.** Use
  `skill get <cli-name>-cli` for the previous content. `skill --write <dir>` keeps exporting the
  generated guide unchanged in purpose. Deploy the updated MCP server to include workflow
  descriptions in listings; older servers list names with empty descriptions. Skill definitions
  and the `read_skill` request format do not change.

## 0.5.1 (2026-10-24)

### Changes

- **Generated CLIs use cached MCP definitions immediately and refresh in the background.** The cache
  keeps tools and the server's name/version per endpoint, client and credentials. Background refresh
  runs at most every five minutes; version changes detected before a tool call refresh immediately.
  Unknown commands/arguments refresh and reparse once; server argument errors refresh definitions
  without replaying a tool request. `--refresh-tools` forces discovery; `discoveryCache: false`
  disables caching and `{ maxAgeMs }` changes the background interval. Embedded CLIs can schedule
  refreshes with `CliIO.background`. Handwritten commands work without discovery and take precedence
  over derived names. MCP-backed commands still execute on the server.

### Migration notes

- **CLI tool discovery is cached by default.** Cached commands load immediately and refresh in the
  background. To keep discovery on every invocation, set `discoveryCache: false` in `defineCli`.
  `--refresh-tools` fetches current definitions on demand. The MCP server must still be deployed;
  tool implementations continue to run there. No changes to tool definitions are needed.

## 0.5.0 (2026-10-23)

### Changes

- **The API may change until 1.0, with a migration note every time.** [docs/stability.md](docs/stability.md)
  lists what freezes at 1.0; [docs/releasing.md](docs/releasing.md) is the release checklist.
  New guides: [docs/channels.md](docs/channels.md) (every channel's options and params) and
  [docs/patterns.md](docs/patterns.md) (patterns that worked). The README is rewritten around one
  codebase for every interface: MCP server, plugin, CLI and messaging agent.
- **`flow deploy` checks hosting's Flow Framework release line first.** An agent on a newer
  major.minor than hosting runs (from `package-lock.json`) is refused before anything is sent. A
  cloud that does not say which release it runs deploys as before.
- **`flow inspect <url>`** tests any MCP server as a host does (`tools`, `call`, `auth`,
  `resources`, `prompts`), and `flow setup` checks the agent's own MCP server.
- **The simulators look and behave like the real apps**: WhatsApp's bubbles, ticks, reply buttons,
  lists and carousels; Telegram's keyboards; iMessage's tapbacks and Delivered/Read; photos,
  documents and voice notes; Debug shows each platform's own payloads.
- **The free trial counts people.** `flow setup`, `link` and `status` print the trial as people per
  channel (`3 of 25 people, 2 waiting for a place`); an older cloud's answer still prints messages
  used.
- **Delivery guarantees, written down and checked.** [docs/guarantees.md](docs/guarantees.md) says
  what `send()` resolving means, what is ordered, and where messages are sent once or at least once.
  `npm run test:conformance` runs every channel adapter Flow Framework ships through those
  guarantees (on demand and before each release; not part of `npm test`).
- **Flow Messaging sends resolve once the channel has the message** (`message.sent`), not on Flow's
  `202`: the agent's next message waits for it, its send tool says `delivered` only then, and a
  `message.failed` comes back from that send as Not delivered. New options
  `flowMessaging({ waitFor: "sent" | "delivered" | "queued", waitTimeoutMs })`.
- A send may resolve with a `SendReceipt` (`sent`, `delivered`, `queued`, `unconfirmed`); providers'
  `sendMessage`, `sendCarousel` and `sendTemplate` may return one. A send whose provider gave up
  waiting (`unconfirmed`) emits the new event `message.slow` and is never sent again.
- `ChannelInfo` has `templates` and `typing`. `templates: false` (SMS, Telegram, iMessage) refuses a
  template before it goes, with Flow Messaging's own `content.type` error; `typing: false` (SMS, a
  `whatsapp()` provider with no `typing`) is never sent a typing indicator.
- `flowEvents` keeps its send state in the attached agent's database when that database survives a
  restart: event ids taken (30 days), held sends, caps, watches and what was told. A restart neither
  processes an event id again nor forgets a held send, and an event answered 202 but not yet
  processed when the agent stopped is processed after the restart. New option `persist` (default
  true; false when you pass your own `state`).
- `POST /v1/events` answers 202 once the event is recorded in the database, and 503 when it could
  not be recorded (retry with the same id).
- `events.idle()` also waits for work queued while it waited (a restart's unprocessed events).
- `flow inspect`, `flow cli` and `flow mcp update` run where the MCP client is not installed (from
  `npx --package`, outside an agent's folder) say which package they need and how to get it, and
  exit 1, instead of crashing with `ERR_MODULE_NOT_FOUND`.
- **A generated CLI command whose arguments the server's schema refuses** (a maximum, a pattern)
  exits 2 with one line per field (`--days: Too big: expected number to be <=16`) and the command's
  `--help` hint, as other wrong arguments do. It printed the MCP `ProtocolError` with a stack and
  exited 1. A custom command still gets `cli.call`'s own error to handle; one it lets through is
  reported the same way.
- `guards(...)`, `oncePerChat`, `noRepeats`, `linkAllowlist`, `noWriteButtons`: ready-made checks
  for `beforeSend`, composed in order, the first refusal winning.
- `beforeSend`'s context has `sent`: the texts already sent in the conversation, read from the
  stored history, so guards hold after a restart.
- `agent.resetHistory({ to, note })`: the model's history starts again from a point (nothing is
  deleted); a new event, `history.reset`, when a turn reads it.
- **`flow init --name <name>`**, and without it `init` names the agent after `--display-name`
  (`--display-name "FlatX agent"` is `flatx-agent`), then after the folder as before.
- **Every name in a new agent comes from the name it was given.** The starter's names live in
  `package.json` only: a new file, `src/name.ts`, reads `name` and `displayName` there for
  `src/cli.ts` (the command, `<NAME>_SERVER`, its help examples), `src/mcp.ts` (the MCP server's
  name and the `claude mcp add` line it prints) and `src/main.ts` (the playground's title). A new
  agent no longer names `bean-and-leaf`, `cafe` or `CAFE_*` anywhere, and its package.json
  `description` (which `flow plugin` puts in plugins) no longer says "started from the café
  example". The coding-agent skill lists where people see each name ("Names").
- More Chinwag names become Flow's: the spec's platform table is `x-flow-platforms`, a drafted
  context-pack spec is marked `x-flow-draft`, and `flow plugin` records what it wrote in
  `.flow-skills.json`.
- **`flow test` tells a credit or infrastructure stop from a failure.** Each run's outcome is
  `passed`, `failed`, `credit` or `infra`; credit and infra runs are counted apart and never as
  failed (they still exit 2). With `--runs N` the summary prints each scenario's pass rate per
  channel (`hello (sms): 2/3 passed, flaky`).
- **Seeded history in scenarios.** A scenario's `history:` (`- person: ...` / `- agent: ...`) is
  written into the agent's store before the first message, with no model call and nothing sent
  (new `agent.seedHistory()` and `Conversation.seed()`).
- **One send path.** On a Flow Framework agent, `flow test` checks that every message the agent
  sent went through its channels (`/outbound` against `message.out`); a mismatch fails the session.
- `flow test --json` adds `outcome` per run, `counts.credit` and `counts.infra` (still inside
  `errored`), `scenarios` (each scenario's runs, passed runs, credit and infra) and `sendPath`;
  `.flow/last-session.json` runs get `outcome`. `model.error` events carry `code` and `status` when
  the error has them.

### Migration notes

- **Agents made already keep working unchanged**; the starter changes only what `new` and `init`
  write. To take the new shape, copy `src/name.ts` from a new agent and use its `name`,
  `displayName` and `serverEnv` in place of the names written in `src/cli.ts`, `src/mcp.ts` and
  `src/main.ts`.
- **The starter reads `MODEL`, not `CAFE_MODEL`**, for the model id (`openAICompatible()` reads
  `MODEL` itself). An agent made already still reads `CAFE_MODEL`; a new one ignores it, so move
  the value to `MODEL=` in `.env`.
- **`flow init --display-name` names the package after the display name**, no longer the folder:
  pass `--name <folder's name>` to keep the old name.
- **A generated CLI command refused by the server's schema exits 2, not 1.** A script that treated
  exit 1 as "bad arguments" checks for 2, the usage code the CLI already used for other wrong arguments.
- **Flow Messaging sends wait for `message.sent`.** A send now takes until the channel accepted it
  (usually well under a second, at most `waitTimeoutMs`, 30 s by default). On a webhook, add
  `message.sent` to the endpoint's `events`, or each send reads its message back and takes up to a
  second longer. To keep 0.4's behaviour: `flowMessaging({ waitFor: "queued" })`.
- **A template on SMS, Telegram or iMessage is refused, not failed.** It used to fail at the send
  (a "Not delivered" note, a nudge `failed`); it is now refused before it goes (`message.refused`, a
  nudge `refused`). Code that watched for the failure watches for the refusal.
- **`Channel.send`, `Deliver` and the providers' send methods return `Promise<void | SendReceipt>`.**
  A provider that returns nothing keeps working unchanged. Code that calls a channel's `send` itself
  and declares its result as `Promise<void>` changes the type to `Promise<void | SendReceipt>`.
- **Store migration 9** (`event_state`, `event_seen`) runs by itself when the agent's store starts.
  A store that forwards calls to a `Store` elsewhere (a `StoreApi` given to `createAgent({ store })`)
  must run the migration there and forward `loadEventState`, `takeEvents` and `saveEventState`; without
  them flowEvents keeps its state in memory, as before.
- **flowEvents state is now one per agent in the database.** Two flowEvents mounted on the same agent
  and database, or one agent's events side on two runners at once, overwrite each other's state: run
  one. To keep the old in-memory behaviour, pass `persist: false`.
- **The default history budget is smaller.** An agent without `history.maxTokens` now sends each
  model call at most 24,000 tokens of history, or 60% of the model's `contextTokens` when that is
  less (before: 60% of `contextTokens`, else 50,000). Long chats leave older messages out sooner
  (`history.trimmed`). To keep the old behaviour: `createAgent({ history: { maxTokens: 50_000 } })`
  (or `Math.floor(contextTokens * 0.6)`).
- **A new event type, `history.reset`.** An event sink that switches on event types sees it. A
  custom `StoreApi` passes inbox payloads through unchanged; nothing to do. The same goes for
  `message.slow` (a send whose provider gave up waiting; it is never sent again).
- **`POST /v1/events` may answer 503.** It answers 202 only once the event is recorded. A system
  that sends business events retries a 503 with the same event id (taken once).
- **`flow deploy` may refuse a newer release line.** Once Flow's hosting says which Flow Framework
  it runs, an agent on a newer major.minor (0.5.x against hosting's 0.4.x) is refused before
  anything is sent: stay on the line hosting runs until it moves.
- **The free trial line is worded in people.** `flow setup`, `link` and `status` print
  `3 of 25 people, 2 waiting for a place` instead of messages used; scripts read `--json`.
- **Chinwag names renamed, the old ones still read for now.** `spec/agent-endpoint.openapi.yaml`'s
  platform table is `x-flow-platforms`; `x-chinwag-platforms` is kept beside it as the same table,
  deprecated, and goes in 0.6: code that reads it from the package reads `x-flow-platforms`.
  `flow plugin` writes `.flow-skills.json` and removes `.chinwag-skills.json`; `flow check --plugin`
  still accepts a package with only the old file, so nothing to do but commit the renamed file after
  the next `flow plugin`. The context skill now marks a drafted spec `x-flow-draft: true`; nothing in
  Flow Framework reads the marker, and `x-chinwag-draft` in an existing pack means the same.
- **`flow test`'s printed summary is worded differently.** `N errored (...)` is now
  `N hit an infrastructure error (...)` or `N stopped for credit (...)`, and `K failed a check` is
  `F failed`. Scripts that read the printed summary read `--json` instead (its fields are only
  added to).
