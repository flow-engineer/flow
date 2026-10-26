# Changelog

Every release's changes, and a **Migration notes** section for each ([docs/releasing.md](docs/releasing.md)).

## 0.10.0 (unreleased)

### Changes

- **Terminal chat beside authenticated MCP, with no terminal code.** `mcpServer({ auth, agent })`
  serves `/agent/terminal` on its own origin, checks each request with the same `auth.verify` as
  `/mcp`, lists the path in `paths` (so Flow's hosting mounts it beside `/mcp`), and adds the
  terminal channel to the agent itself. A hosted `mcp(agent, host)` factory passes the agent it
  receives. Signed in only by default; `terminal: { guests: true }` lets a CLI that is not signed
  in chat too, `terminal: false` turns it off, and `terminal: { path, channel }` renames them. With
  `agent` and no `auth`, chat is served only when `terminal` is given (everyone a guest).
- **`agent.addChannel(channel)`** adds a channel after the agent is built; the same channel again
  does nothing and another of that name is refused.
- **Chat on a server without it says so.** A 404 or 405 at the terminal URL prints "This server
  does not serve terminal chat (<url>)." "Is it running?" is kept for a server that cannot be reached.
- **Chat without pi-tui falls back to line chat,** with one line on how to get the full-screen view,
  instead of stopping.
- **Full-screen chat never exits silently.** When the last message failed, the reason is printed
  after the view closes and the exit code is that failure's.
- **No raw SDK warning when a token refresh cannot reach the server;** the CLI's own one line naming
  the server, and exit 5, remain.

### Migration notes

- Nothing changes for an agent that does not pass `agent` to `mcpServer`.
- An agent that mounts `terminalServer` itself and wants the built-in route: remove its
  `terminalServer`, its channel and its route, then pass `agent` to `mcpServer`. Keeping both
  is refused when the server is made ("already has a channel named terminal").

## 0.9.0 (2026-10-26)

### Changes

- **Full-screen CLI chat.** `acme chat` at a terminal opens a full-screen session: the
  conversation above, a composer with a Send button below, Markdown replies, and tool activity that
  updates while the agent works (Ctrl+O shows tool inputs and results, `/help` lists the keys). It
  needs the optional peer `@mariozechner/pi-tui@0.73.1` (`flow new` includes it);
  `defineCli({ chat: { accent: "#b85c00" } })` sets a brand accent. `CliIO.chat` replaces the
  interface; `ChatSession` and `ChatUpdate` are exported from `@flow-engineer/flow/cli`.
- **Live chat activity.** The terminal handler streams `reply`, `activity` and a final `done`
  record when the request accepts `application/x-ndjson`; other requests get the same JSON as
  before. `agent.request()` takes `onReply` and `onActivity` to observe a request while it runs.
- **Chat without sign-in.** `terminalServer`'s `auth` is optional. Without it, or with
  `guests: true` beside it, a CLI that is not signed in chats as a guest: it keeps a random id in
  `chat.json` and sends it as the `flow-guest` header. A guest's conversation stays on the
  terminal channel, is never joined to an account (`ctx.key` is null), and a tool that needs
  sign-in still asks for it. With `auth` and no `guests`, chat still answers 401.
  `agent.request()` takes `guest` instead of `key` for this.
- **The CLI tries chat before asking for sign-in.** `acme chat` no longer stops with "Sign in
  first" when no token is saved; it says so only when the agent answers 401.
- **The playground serves the agent's `routes`,** as Flow's hosting does, so a route such as the
  terminal handler works under `npm start`.
- **The café starter chats.** Its agent mounts `terminalServer` as a route with guests, and its CLI
  file points `chat` at the running agent (`runningAgent`, now exported beside `markRunning`).
- **Full-screen chat colour.** With a brand `chat.accent` and a 24-bit terminal
  (`COLORTERM=truecolor`), sent messages sit on a faint wash of the accent; tool activity is a
  quiet line on an accent rail, and a running tool's name shimmers instead of showing a status mark.

### Migration notes

- `terminalServer` without `auth` used to be a type error; it now lets everyone chat as a guest.
  An agent that passes `auth` keeps requiring sign-in unless it adds `guests: true`.
- An agent built from the café starter: copy the `terminalServer` lines from
  `examples/cafe/src/agent.ts` and the `agent` line from `examples/cafe/src/cli.ts` to get chat.

## 0.8.2 (2026-10-26)

### Changes

- **Typing is kept up for the whole turn.** It was sent once, when the person's message arrived, and
  hidden once they were acknowledged, so in a long turn it lapsed after a few seconds (Telegram's
  indicator lasts about 5 s) and never came back. Now, from their message until the turn ends or
  fails, it is sent again before the platform hides it: `ChannelInfo.typingLastsMs` says how long one
  indicator lasts (`WHATSAPP` 25 s; Flow Messaging's `TELEGRAM` 5 s and `IMESSAGE` 15 s), and typing
  goes again at 80% of it (20 s, 4 s, 12 s). Each message the agent sends hides it, and it shows
  again only when new work starts (a response that calls tools, or the person's next message), never
  just because time passed: typing after the answer would read as more to come. No timer outlives
  the turn. A channel without `typingLastsMs` (a custom UI) gets typing once, as before.
- **A refused typing indicator waits for the agent's next message.** A typing call that rejects
  with `outside_window` (iMessage outside Flow Messaging's 5-minute window for typing) is not tried
  again until the agent's next message of the turn goes out, then is kept up again; it is logged at
  debug (`console.debug`, the channel and conversation id, never text). Any other typing failure
  ends typing for the turn, logged as a warning.
- **Flow Messaging's typing rejects instead of swallowing a refusal**, so the conversation can act on
  it: `outside_window`, or Flow's error type (`invalid_request`, ...). Read receipts are unchanged.

### Migration notes

- **A hand-written channel's `typing()` that rejects now ends typing for that turn, with a warning;**
  before, its failures were ignored and every later call was still made. To have typing tried again
  after the agent's next message, reject with an error whose message starts with `outside_window`.
- **A custom UI whose typing indicator hides itself** can set `info.typingLastsMs` to have it sent
  again while a turn runs. One that shows it until it is turned off needs nothing; it now also gets
  typing again while the tools of an acknowledged turn run.

## 0.8.1 (2026-10-25)

### Changes

- **Playground turns are marked in traces.** A turn that comes through the playground
  (`agent.simulate()`, `agent.simulateVisitor()`, `npm start`'s page, `flow chat`) has
  `chinwag.via` = `"playground"` on its root span, and so do a message the playground person's
  `intercept` or keyword answered and one sent to them outside a turn. A real turn has no
  `chinwag.via`. These turns share their process, and so `chinwag.run_kind` (still "production",
  or "test" under `flow test`), with real conversations; a dashboard keeps them apart by this
  attribute.
- **Flow Messaging's Telegram and iMessage traces name their platform.** `fm.telegram()` and
  `fm.imessage()` are custom channels, and their turns traced as `chinwag.channel` = `web`; they now
  set `traceChannel` (`telegram`, `imessage`). `fm.whatsapp()` and `fm.sms()` already traced as
  `whatsapp` and `sms`.
- **A trace's channel is the same on every span.** The `send <name>` spans' `chinwag.channel` is
  now the platform, as on the root span (`telegram`, `web`, ...), not the channel's own name, which
  stays in the span's name.
- **`flow setup` turns trace content on for a test traces key.** When it writes an `otk_test_`
  traces key (the Staging dashboard), it adds `FLOW_FRAMEWORK_TRACES_CONTENT=1` below it, under a
  comment saying it sends message text there and that 0 sends metadata only, so playground and
  phone chats can be read and graded. Never for a live key, never when `.env` already has the line
  (any value, either name), and only in the run that writes the key.

### Migration notes

- **`send` spans' `chinwag.channel` is the platform, not the channel's name.** A dashboard or query
  that read it as the agent's channel name: read the span name (`send <name>`) instead.
- **`flow setup` with a test traces key now sends message text to the Staging dashboard.** To keep
  traces metadata only, set `FLOW_FRAMEWORK_TRACES_CONTENT=0` in `.env` (setup leaves a line that is
  there alone).

## 0.8.0 (2026-10-25)

### Changes

- Flow Messaging preserves a refusal that arrives over the stream before the send's HTTP
  response: the send rejects with the platform's reason instead of timing out as unconfirmed.
  Failures after a completed send still notify the agent.
- **Coding-agent guidance loads by task.** `flow-framework` (`coding-agents/skill.md`) now covers
  setup, names, layout and routing. Messaging runtime, playground and deployment guidance moves
  to `flow-framework-build-agent` (`build-agent-skill.md`); MCP, CLI and plugin guidance moves to
  `flow-framework-mcp` (`mcp-skill.md`). `flow new` and `flow init` install all three and point the
  coding agent to the relevant guide.
- **MCP tools can be deferred explicitly.** `tool({ ..., mcp: { deferred: true } })` leaves that
  tool out of the upfront MCP list and makes it discoverable through `search_tools`; unmarked
  tools stay upfront. `execute_tool({ name, arguments })` calls the original operation with its
  validation, sign-in, scopes, context, formatting and traces. Both generated tools appear only
  when there are deferred operations, on standalone and plugin MCP endpoints. Chat agents keep
  their normal tools. The CLI and `mcpTools` request the complete catalog.
  `mcpServer({ ..., deferred: [...] })` overrides the tool flags; `deferred: []` puts everything
  upfront. Hosting can choose this list using usage data, but selection stays fixed for each
  server handle. Teams can customize the gateway descriptors or provide their own gateway tools.
- **The agent can wake itself up.** A wake-up is a row in the agent's store, never a timer in
  memory: at its time the agent gets a turn in that person's conversation with its note
  (`[Wake-up you set for yourself, not from the person: <note>]`) and decides what to do: look
  something up, message them, call a tool, or nothing. It never sends anything by itself. It
  survives restarts and deploys and runs once with several runners, through the same claim as
  scheduled messages.
  - The model gets `wake_me_up({ note, in_minutes | at, key? })` and `cancel_wake_up({ id })`
    built in, for its own conversation only, and each turn shows it the wake-ups it set there.
    `createAgent({ wakeUps: false })` takes both tools and that list away; wake-ups set by code
    still run.
  - From code: `context.wakeUps` in a tool (`add({ note, inMs | at, key?, respectQuietHours? })`,
    `cancel(key)`, `list()`), and `agent.wakeUp({ to, ... })`, `agent.cancelWakeUp(key)`,
    `agent.listWakeUps(to)` elsewhere. One active wake-up per key in a conversation: the same key
    again returns it (`status: "exists"`). `cancel(key)` cancels the active ones with that key in
    every conversation, so the seller's answer cancels the reminder set in the buyer's.
  - It keeps the person's rules: due in their quiet hours it waits for them to end (unless
    `respectQuietHours: false`). After their STOP or in a pause it still runs, so the agent can do
    its work (close the question), but its note says so and Flow refuses every send to them in
    that turn (`Not sent: they texted STOP, ...`), until they write. Past WhatsApp's 24-hour window it still runs, and the agent is told only a template
    reaches them (`send_template`); no fallback template goes by itself. Found late after
    downtime, it runs and says when it was due, where a scheduled message is missed.
  - Limits in `WAKE_UP_LIMITS`: 10 active per person, 10,000 per agent, 90 days ahead, notes of
    500 characters and keys of 200. The model gets a plain error past one; code gets
    `{ status: "refused", reason }` at a cap and a throw for a bad time or note.
  - `agent.forgetPerson` deletes them. `agent.outbox(id)` has a new `wakeUps` list, and the
    playground's Person tab shows it beside scheduled messages; moving its clock (or a business
    run's `wait` in `flow test`) brings them due.
- **`agent.cancelNudge(key)` cancels a nudge sent with `at`**, by its idempotency key, while it is
  still to come: nothing goes, and its state is `cancelled` (a new `NudgeStatus`, also in
  `spec/nudges.openapi.yaml`). A nudge that is not waiting to go (it went, or had no `at`) keeps
  its state, which it returns; null for a key no nudge has. A scheduled nudge's schedule now
  carries its key; one scheduled before 0.8 has none, so it is not found and goes as planned.
- Store migration 11 adds the `schedule_key` column to `schedules` (a wake-up's key, a scheduled
  nudge's idempotency key), a unique index on active schedules' keys per conversation, and an
  index on each conversation's schedules (every turn now reads its wake-ups). It runs on the
  agent's first start and changes no existing row.
- `list_scheduled` and `cancel_scheduled` see only scheduled messages, never the agent's
  wake-ups; the 10-a-person cap on scheduled messages counts only them.
- **A tool's own text for people.** `tool({ output, format: (result) => markdown })` makes the
  result readable where people see it: over MCP the text is the result's `content` (structured
  content still carries the data), and the CLI prints it by default, rendered at a terminal by
  `marked-terminal` (new optional peers: `marked@12.0.2`, `marked-terminal@7.3.0`; as written when
  piped, for `NO_COLOR`, or when they are not installed). `--json`, `--fields` and a
  CLI file's `columns` or `view` still show the data. `format` runs on the checked output; if it
  throws, the result goes out as JSON, still a success, and `tool.end` carries `formatError`.
  Chats are unchanged: the model there still reads the data. `flow check` refuses `format`
  without `output`.
- **The CLI's top-level help is easier to scan.** `chat` comes first, as the way to ask for
  anything in plain words; the CLI's own commands (`tools`, `skill`, `auth`, `help`) come last,
  under This CLI; one usage line replaces one per command. At a terminal, headings are bold and
  command names coloured, chat's the most (plain when piped, for `NO_COLOR` or `TERM=dumb`). `defineCli({ sections: { Account:
  ["account", "keys"] } })` lists groups and commands under headings, in order, the rest under
  Other; `flow check` refuses a name that is not a top-level command or group, or one in two
  sections.
- **`<cli> help <words>`** lists the commands whose words or descriptions have every word
  (`acme help invoice`). The CLI's generated SKILL.md mentions it.

### Migration notes

- Existing projects refreshing their coding-agent skills also copy `build-agent-skill.md` and
  `mcp-skill.md` from the package's `coding-agents/` into
  `.claude/skills/flow-framework-build-agent/SKILL.md` and
  `.claude/skills/flow-framework-mcp/SKILL.md`, alongside the updated main skill. No runtime changes
  are needed for the skill split.
- MCP exposure is unchanged until tools are marked deferred or a server supplies a `deferred`
  list. A custom MCP client that needs every original descriptor can send
  `tools/list` with `_meta: { "flow.engineer/full-tool-catalog": true }`. Deferral changes
  discovery, not access control; target permissions still apply to direct and indirect calls.
- **`StoreApi` has three new methods, `addWakeUp`, `cancelWakeUps` and `cancelScheduledNudge`,**
  and `addSchedule` writes the new `key` field. A store of your own that
  forwards each call to a `Store` (as Flow's hosting does) forwards them too. A hosted agent on
  0.8 deploys once Flow's hosting runs 0.8 (until then `flow deploy` refuses it, as for any newer
  line).
- **`ScheduleRow` has a new field, `key`, and new values: `mode` `"wake"`, `origin`
  `"agent"`.** Code that reads `store.schedules(...)` itself and switches on `mode` or `origin`
  handles them, or leaves out rows with `mode === "wake"`.
- **Every agent's model is offered two more built-in tools**, `wake_me_up` and `cancel_wake_up`. An
  agent with a tool of its own by either name renames it, or turns them off with
  `createAgent({ wakeUps: false })`.
- **`NudgeStatus` has a new value, `cancelled`.** Code that switches on a nudge's status
  exhaustively handles it; it comes only from `agent.cancelNudge`.
- **To render a tool's `format` in a terminal**, a CLI's package adds `marked@12.0.2` and
  `marked-terminal@7.3.0`; without them it prints the Markdown as written. Nothing else changes.
- **A CLI file's own `help` command**, like its own `chat`, replaces the CLI's `help <words>`.

## 0.7.0 (2026-10-24)

### Changes

- **The Flow Messaging adapter (`@flow-engineer/flow/flow-messaging`) speaks Flow Messaging's V0
  API:** every call goes to `/v0/...`, and each kind of message goes to its own endpoint
  (`POST /v0/conversations/{id}/basic`, `/buttons`, `/list`, `/carousel`, `/template`, `/reaction`,
  `/typing`, `/read`). V0 sends exactly what it is given or refuses it (`422 unsupported_content`);
  it converts nothing. So the adapter now does each channel's conversions itself:
  - Telegram: the agent's Markdown goes as Telegram's HTML (`telegram.parse_mode: "HTML"`),
    rendered by the same rules Flow Messaging used, so it looks the same as before. A carousel goes
    as its text, then one message per card in order: the card's photo with its text as caption and
    its buttons or link under it (a card with neither is its photo alone).
  - WhatsApp: a list goes as a WhatsApp `list` with the agent's own label (before, every list
    opened with "Choose"). Row titles now take WhatsApp's 24 characters (they were cut to 20), and
    row descriptions are shown (they were dropped). More than 3 buttons also go as a list, under
    "Choose". WhatsApp's own marks (`*bold*`) go as written, as before.
  - iMessage: text is now Markdown, sent as iMessage's own styles (`imessage.styles`: bold, italic,
    underline, strikethrough). `IMESSAGE.formatting` is `"markdown"`, so the agent is told Markdown
    works there, and so is the iMessage platform `flow test` plays (`x-flow-platforms` in
    `spec/agent-endpoint.openapi.yaml`).
  - A message the business starts (a nudge, a scheduled text) goes with `link_preview: false` on
    every channel, not only WhatsApp.
- Typing sends `{}` and nothing when the agent stops typing: no channel clears the indicator on
  request, and it clears itself when the next message goes. iMessage read receipts mark the whole
  conversation (Flow refuses `up_to` there).
- Events are read in both shapes: the V0 one (`content.kind`) and the older one (`content.type`),
  which an app Flow still serves through its bridge to the older API gets.
- A `422 unsupported_content` reaches the agent saying what the channel does not take, on which
  channel and why, for example `unsupported_content (no_mms, param media, on sms): ...`, with
  "don't resend it". `FlowMessagingError` has two new fields, `param` and `channel`.
- iMessage group conversations are passed over, with one warning. The agent never answers in a
  group, and no typing or read receipt goes to one. Before, their events failed, and Flow
  delivered them again.
- **Edits and unsends.** On channels that have them (Telegram and iMessage on Flow Messaging, a
  custom UI with the new `editMessage` / `unsendMessage`) the agent is offered `edit_message`
  (`{ message_id, text }`) and `unsend_message` (`{ message_id }`), as `react` is offered only where
  reactions exist; WhatsApp and SMS offer neither. The send tool's result there names the message
  (`{"delivered":true,"channel":"imessage","message_id":"msg_..."}`), read back from the history
  after a restart. An edit's text passes `beforeSend` (`context.edit` names the message) and the
  content rules like any send. On Flow Messaging an edit is `PATCH /v0/messages/{id}` (the new text
  styled as a send's: Telegram's HTML, iMessage's styles) and an unsend `DELETE /v0/messages/{id}`.
  Flow refuses a late or unsupported one when it is made (`422 unsupported_content`, with
  `edit_window_closed`, `unsend_window_closed`, `first_message_not_editable` or `not_on_sms`), and
  the tool's result is that refusal with Flow's message, which states the limit (`Not edited:
  unsupported_content (edit_window_closed, on imessage): iMessage allows edits within 15 minutes of
  sending; ...`). Nothing is sent instead: the agent writes its own correction if it wants one.
  Flow Framework sets no time limits of its own. One the channel refuses after Flow took it comes
  as Not delivered (`edit of msg_...: <text>`, `unsend of msg_...`). New `ChannelInfo.edits` /
  `unsends`, `Outbound` `{ type: "edit", messageId, text }` / `{ type: "unsend", messageId }`, events
  `message.edited` and `message.unsent`, transcript entries `edit` and `unsend`.
- **Sends return the platform's message id.** `SendReceipt.messageId`: Flow Messaging's sends
  resolve with it (`msg_...`; a carousel sent in parts, its first message's), and so can any
  provider's; `message.out` carries it as `messageId`, and a sent nudge's `NudgeResult.messageId`
  (a prompt nudge's: the agent's first message) when this process sent it. That id is what
  `PATCH` and `DELETE /v0/messages/{id}` take, for an agent's own code.
- The playground, `flow chat` and the test cloud's simulators play edits and unsends: their sends
  resolve with their ids (`a1`, `a2`, ...), the thread shows the message edited or gone (lines
  `edit` and `unsend`), a platform without them refuses them with its error, and `flow show` prints
  them. The cloud's answer to an outbound may carry `messageId` (an older cloud's does not, and its
  runs offer no edits).

### Migration notes

- **The Flow Messaging adapter needs Flow Messaging's V0 API.** 0.7 calls `/v0`, so upgrade once
  Flow Messaging serves V0. Versions before 0.7 call the older `/v1` API. That keeps working only
  while Flow serves your app through its bridge to the older API, and Flow switches you off the
  bridge once you upgrade. To move, bump `@flow-engineer/flow`. The adapter's options, channels and
  exports are unchanged. Code of your own that calls Flow Messaging beside the adapter (`POST
  /v1/conversations/{id}/messages` with `content`) moves to the per-kind endpoints: see Flow
  Messaging's migration guide.
- **iMessage text is Markdown now.** An agent's iMessage replies are read as Markdown and sent with
  iMessage's styles, and the agent is told Markdown works there. `**6pm**` used to show as written;
  now it shows as bold "6pm". An agent whose own instructions said to write plain text on iMessage
  can drop that line. To keep text exactly as written, escape the marks (`\*`).
- **A Telegram carousel card with buttons needs a text.** Flow sends a card's buttons under its
  text, and V0 takes no buttons message without one. A carousel with such a card is refused before
  anything is sent, and the agent is told which card. Before, Flow sent the photo and the buttons
  with no caption.
- **A first message to someone with no conversation yet is text or a template.** When the adapter
  knows no conversation (a nudge, or a send after a restart before the person writes), V0 starts
  one only with a text or a template. A link still goes, as its text with the URL on a line after it.
  Buttons, a list or a carousel are refused before anything is sent, and the reason says to send a
  text first. Before, they started the conversation.
- **A WhatsApp carousel no longer quotes the message it replies to** (V0's carousel has no
  `reply_to`).
- **`Outbound` has two more members, `edit` and `unsend`.** They go only to channels whose info
  says `edits` / `unsends`, so a hand-written channel is never sent one. TypeScript code that
  narrows `Outbound` by what it is not (`Exclude<...>`, or an exhaustive `switch` with a `never`
  check) handles the two (or ignores them, as for `typing`).
- **`PlaygroundSink` may return a `SendReceipt`.** A sink that returns nothing keeps working unchanged.

## 0.6.0 (2026-10-24)

### Changes

- **The agent's own records.** `createAgent({ records: { questions: { people: ["buyer", "seller"],
  fields: ["listing", "status"] } } })` declares collections of small JSON documents the agent keeps
  across days and people, in the same store as its conversations: `context.records` in a tool,
  `agent.records` elsewhere, with `put`, `get`, `query` (equality on declared fields, oldest first,
  pages of up to 100), `delete`, `forgetPerson` and `export`. They behave the same on SQLite,
  Postgres, the playground and Flow's hosting, per agent and environment. `agent.forgetPerson`
  also deletes the records that name the person in a `people` field (by their person key,
  conversation id, any identity, or their number on a phone channel, whatever their key), and a
  tool of theirs still running then can no longer put one. A field added to a collection's
  `people` or `fields` is indexed for the records already kept when the agent next starts, so
  `query` and forgetting find them; the store keeps every field declared for a collection, so an
  older declaration on the same store (a deploy's old revision) takes nothing away and its puts
  index the newer fields too. Limits in `RECORD_LIMITS`: 64 KB a record, 10,000 an agent
  (new records put at the same moment may pass it by up to as many as are put at once), 20
  collections, 8 declared fields each. If anything other than the agent reads the data, it
  belongs in your own database ([docs/agents.md](docs/agents.md#the-agents-own-records)).
- **`flow records export`** prints every record of the agent in the folder (the store its
  `buildAgent` opens) as JSON Lines.
- `mcpServer({ records: agent.records })` gives tools served over MCP the same records.
- **`context.events`: a tool's own agent's business events side.** Once `events.attach(agent)` has
  run, every tool call of that agent has its `flowEvents` as `context.events` (`agent.events` for
  code outside a turn: routes, beforeSend, intercept, context), so a tool watches, mutes or takes
  back a topic for the conversation's person in the state of the agent it runs for
  (`context.events.watch({ address, topic })`, `mute`, `notInterested`, `stopped`, `remember`),
  never through a module variable. Two agents in one process (two test runs, a deploy's overlap)
  each see only their own, when each has its own `flowEvents` (made inside `buildAgent`). It is not
  `createAgent`'s `events` (trace sinks). Absent when no events side is attached; over MCP,
  `mcpServer({ businessEvents: events })` gives it. An agent with its own watch fields reads
  it as `context.events as FlowEvents<MyWatch> | undefined` ([docs/events.md](docs/events.md#watches-raise-a-message)).
- **A tool `flow test` runs for real (`tools: { real: [...] }`) is the agent's own object again.**
  From 0.4.9 to 0.5.3 a business run handed `buildAgent` a copy of it (`{ ...tool, run }`), so code
  that knew its own tool by identity (`t === myTool`, to swap in one that keeps this agent's
  state) no longer matched, and what the tool kept went to module-shared state instead of the
  run's agent: the scenario sent nothing, with no error. `buildAgent` now gets the very object
  it exports, as in production. The tools the cloud simulates are still stand-ins of their own
  (same name, description and input), never `===` the agent's.
- The playground's Records tab, for an agent that declares collections, shows its newest 200
  records, newest first, with each collection's count and how many older ones are not shown.
- Store migration 10 adds the tables `records`, `record_index` and `record_collections` (per
  collection, every field declared on the store and the fields its records are indexed for); it runs on the agent's first start, as every
  migration does, and changes no existing table.
- The `zod` dependency is `^4.6.6` (was `^4.6.5`): zod before 4.6.6 could exhaust memory on an
  oversized input to a constrained collection (GHSA-mrhx-c7xc-m3w5).

### Migration notes

- **`ToolContext` has a new field, `records`.** Flow Framework fills it for every tool call. Code that
  builds a `ToolContext` itself (a unit test calling a tool's `run`) adds it: `records: agent.records`.
- **`StoreApi` has the record methods** (`putRecord`, `getRecord`, `queryRecords`, `deleteRecord`,
  `forgetRecords`, `exportRecords`, `reindexRecords`). A store of your own that forwards each call to a `Store` (as
  Flow's hosting does) forwards them too; a hosted agent on 0.6 deploys once Flow's hosting runs
  0.6 (until then `flow deploy` refuses it, as for any newer line).
- **An agent takes one events side.** `events.attach(agent)` with a second, different `flowEvents`
  on an agent that already has one now throws (they overwrote each other's state already, as
  0.5.0's notes say): mount one. Attaching the same one again changes nothing. One `flowEvents`
  attached to a second agent is no longer the first one's (`agent.events` undefined there): a
  module that builds several agents (`buildAgent`) makes one per agent.
- **From 0.4.9 to 0.5.3, `flow test` gave `buildAgent` copies of the tools it runs for real.** An
  agent that worked around it (matching its tool by name or schema rather than `t === myTool`, or
  routing its tool's run to the agent whose conversation it is) keeps working; the workaround can
  go now. A tool that needs its agent's events state can read `context.events` instead of
  `buildAgent` swapping in a copy bound to that state. On 0.4.9 to 0.5.3, a scenario with
  `tools: { real: [...] }` whose tool keeps per-agent state that way may have passed or failed for
  that reason alone: run it again on 0.6.

## 0.5.3 (2026-10-24)

### Changes

- **A template nudge reaches someone who never wrote.** `agent.nudge({ to: { channel, address }, template })`
  on a phone channel that sends templates (WhatsApp) makes the person and their conversation, as
  their first message would, then sends the template: the way WhatsApp lets a business message a
  number first. The number is read as inbound numbers are (E.164; `defaultCountryCode` on phone
  channels other than WhatsApp) and must look like one (7 to 15 digits; on WhatsApp written in full,
  with `+` or `00`: a national `"(555) 010-0177"` or bare `"5550100177"` is refused `unknown_person`,
  never read as another country's), so their reply lands in
  the same conversation, and a number that is already someone (they wrote on SMS) joins that
  person, their STOP and no-contact rules included. Text and prompt nudges to someone who never
  wrote are still refused `unknown_person`, as is a template on SMS. Declared-template checks,
  idempotency keys and quiet hours work as before. In the playground, the Person panel's template
  to a test person who has not written shows in their thread, never through the provider
  (`recordNudge(input, { via: "playground" })`).
- **A nudge finds the person however the business writes their number.** On a phone channel,
  `"+1 (555) 010-0177"` finds the person who wrote from `"15550100177"` (also when `resolve` keys
  them; on WhatsApp the number is in full, or as WhatsApp writes it), and `agent.contact(to)` finds
  them the same way. When one number is written two ways there (the business's, the provider's) the nudge
  goes where they last wrote from, with that identity's window. Scheduled messages pick that
  identity too. A test person's playground identity never takes a business's nudge from their real
  phone's, nor the Person panel's from the playground.
- **A scheduled prompt nudge due past the WhatsApp window goes as one sent now would.** With a
  `fallbackTemplate`, `nudge({ prompt, at })` that comes due after their 24-hour window closed is
  no longer skipped: the agent is told the window is closed and may send a template that says it
  (`send_template`); otherwise the fallback goes, `template.missing` says what wanted one, and the
  nudge is held until they reply. The run is recorded `skipped`, its reason naming the nudge it
  went on as (`outside_window: went on as nudge n_...`); read that nudge's state for how it ended. Without a
  `fallbackTemplate`, and for scheduled text, it is skipped `outside_window` as before.

### Migration notes

- **A template nudge to an unknown number is sent, not refused.** An agent that relied on
  `unknown_person` to never template a stranger checks first: `if (!(await agent.contact(to))) return;`
  before `agent.nudge({ to, template })`. `agent.reach(to)` before a template is no longer needed.
- **Scheduled prompt nudges past the window now run when the agent has a `fallbackTemplate`.**
  Before, they were skipped `outside_window`. A message that must not go past the window is
  scheduled as `text`, which is still skipped there.

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
