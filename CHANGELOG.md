# Changelog

Every release's changes, and a **Migration notes** section for each ([docs/releasing.md](docs/releasing.md)).

## 0.6.0 (unreleased)

### Changes

- **The agent's sends are written ahead, and resumed after a restart.** With a database, the step
  that makes a send is stored with the send, `pending`, before it goes, and each send carries its
  own idempotency key, `send:<conversation>:<turn>:<call>` (a carousel's later parts add `:1`, `:2`).
  A restart that cut a send off after it went sends it again with the same key on a channel whose
  info says `idempotentSends`, before the turn carries on, so the person gets it once (new event
  `send.resumed`, with `key`, `channel`, `outcome`); a send already settled gives the agent its
  result; anything else (another channel, or a send over 24 hours old) is "may or may not", as
  before. A restart before the step was stored sent nothing of it, and the step runs again.
- `ChannelInfo.idempotentSends`: the channel's send honours `idempotencyKey` for at least 24 hours.
  Flow Messaging's channels (WhatsApp, SMS, Telegram, iMessage) set it.
- Sends written ahead are deleted a day after they were made, by the hourly clean-up that deletes
  old provider message ids.
- **Writes are fenced by the lease.** A conversation's writes from a turn (history, sends written
  ahead, the turn's state, inbox rows handled, background tools) carry the runner and the lease's
  epoch, and the store refuses them once another runner has taken the conversation (`StaleRunner`,
  exported). A runner that stalled past its lease then sends nothing of the step it was on and
  stops working on the conversation, instead of writing over the runner that now holds it.
- **flowEvents' saved state is compare-and-set.** Each save names the version it read; when another
  runner saved since (the old and the new revision of a deploy, side by side), its snapshot is
  merged in (what is in memory wins, nothing is added twice) and saved again. Neither runner's
  held sends, caps or watches are lost to the other's save.

### Migration notes

- Store migration 11 adds the `sends` table; it runs by itself at start, like the others (10 is
  reserved for a change not released yet). A store service in front of the database (Flow's
  hosting) must run it, and answer the new store methods `beginSends`, `settleSend`, `sendsFor`
  and `pruneSends`. Until it does, sends go as before, and a restart tells the agent a cut-off send
  may or may not have gone; one warning is logged.
- An agent's replies now carry `idempotencyKey` when the agent has a database. A channel written
  by hand that passes it on to its platform gets it; one that compares outbounds exactly in its
  tests sees the new field.
- Each step that sends waits for its write to the store before the send goes: one write per such
  step (about a millisecond on a local database, one round trip to a store service).
- `Store`'s `appendHistory`, `beginSends`, `updateConversation`, `addTask` and `removeTask` take an
  optional last argument, `{ runner, epoch }`, and `doneInbox` takes `(ids, conversationId, fence)`;
  without it a write is made as before. A store service passes it through as a plain trailing
  argument; one that does not yet (an older one) drops it, and writes are unfenced as in 0.5. To
  fence over a service, it should answer a refused write so the agent's error is named
  `StaleRunner`.
- Store migration 12 adds `event_state.version`. `loadEventState` also returns `version`, and
  `saveEventState` takes it as an optional fifth argument and returns the new version, or null when
  another runner saved since (nothing is written then). A store service that has not run migration
  12, or drops the argument, saves as in 0.5 (last save wins).

## 0.5.0 (unreleased)

### Changes

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
  custom `StoreApi` passes inbox payloads through unchanged; nothing to do.
