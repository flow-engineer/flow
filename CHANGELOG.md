# Changelog

Every release's changes, and a **Migration notes** section for each ([docs/releasing.md](docs/releasing.md)).

## 0.6.0 (unreleased)

### Changes

- **Show records.** A tool returns rows with `records({ kind, id, title, detail, image, pick }).of(rows)`;
  the model gets the rows and a handle (`r1`) and shows them with its send tool's new
  `show: { records: "r1", ids? }`, offered once a tool returned records. Flow Framework renders
  them per channel (`recordsMessages`): a WhatsApp list (on Flow Messaging, titles in the list and
  details numbered in the text), Telegram numbered lines with a button per row, numbered text on
  iMessage, SMS and for rows nobody picks, cards when every row has a photo and the channel has
  carousels. Pages of 10 (5 on SMS); "More" (its row or button, or MORE typed) sends the next page
  with no model call. A tap on a row, or its number typed while the records are the latest
  message, comes back as `choice: { id, title, records, kind }` with the row's data for the model.
  Ids the tool did not return are refused. `message.out` carries `records` (kind, handle, count,
  shown ids, page, pages, deliveredAs).
- A custom UI may take records itself: `info.records: { maxRows }` with `sendRecords(to, page)`.
- `ChannelInfo.lists.descriptions: false` says a channel's lists show no row descriptions (Flow
  Messaging's WhatsApp).
- Store migration 10: a `records` table (handles per conversation, the newest 20 for 7 days,
  erased with the person).

### Migration notes

- Nothing to do. `beforeSend` gets a records send as the messages it is rendered as; channels
  without `info.records` never get a `records` outbound. A store you pass yourself may add
  `saveRecords`/`loadRecords`; without them handles are kept in memory only.

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
