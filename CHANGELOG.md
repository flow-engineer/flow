# Changelog

Every release's changes, and a **Migration notes** section for each ([docs/releasing.md](docs/releasing.md)).

## 0.5.0 (unreleased)

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
- `guards(...)`, `oncePerChat`, `noRepeats`, `linkAllowlist`, `noWriteButtons`: ready-made checks
  for `beforeSend`, composed in order, the first refusal winning.
- `beforeSend`'s context has `sent`: the texts already sent in the conversation, read from the
  stored history, so guards hold after a restart.
- `agent.resetHistory({ to, note })`: the model's history starts again from a point (nothing is
  deleted); a new event, `history.reset`, when a turn reads it.

### Migration notes

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
