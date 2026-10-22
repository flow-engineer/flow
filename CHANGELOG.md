# Changelog

Every release's changes, and a **Migration notes** section for each ([docs/releasing.md](docs/releasing.md)).

## 0.6.0 (unreleased)

### Changes

- **Web chat.** `webChat({ secret, origins })` is a channel for a chat box on the business's own
  site, served by the agent's own routes (`routes: web.routes`, then `web.attach(agent)`): HTTP
  long-polling, sessions per visitor, sign-in tokens the business's server signs
  (`webChatSignIn`) so a signed-in visitor is one person with their other channels, allowed sites,
  per-visitor limits, history from the store. Its `send()` resolves once the visitor's mailbox kept
  the message (`memoryMailbox()`, or your own `WebChatMailbox` for several runners). The browser
  client is `webChatClient` from the new entry point `@flow-engineer/flow/web-chat`. The playground
  and the test cloud play it in the web simulator; the conformance suite runs it through every
  delivery check. [docs/channels.md](docs/channels.md#webchatoptions)
- **Media stores.** `createAgent({ media })` takes a `MediaStore` (`put`, `get`, `forget`), your own
  storage for the files people send; `memoryMedia()` keeps them in memory for development and tests.
  With one, the web chat takes photos, PDFs and voice notes (`POST {base}/files`, then
  `attachments: [{ ref }]` on a message; `client.upload(blob)`), told by their first bytes, at most
  10 MB and 3 a message, shown back by signed links (`src`) that expire after an hour; without one
  it answers 501. `agent.forgetPerson` erases the person's files (`forget(owner)`). A store's `get`
  may leave out `owner` (the web chat's signed refs already bind a file to its visitor).
- **Sending documents, audio, voice notes and videos.** A message takes `file: { kind, url | fileId,
  name? }`, alone, its text the caption; `ChannelInfo.files` (`{ kinds, captionMax }`) says which
  kinds a channel sends, and only those are offered on the send tool (`file`). Where a channel lacks
  the kind, `fitMessage` sends a voice note as audio, a file by URL as its URL after the text, and
  leaves one by id out with an `attachment.failed` event. Flow Messaging's channels send all four
  (media of that kind; a voice note as `voice` with `fallback: "auto"`; audio's and voice's text
  as a message right after), as does the web chat; `whatsapp()` only with `features.files: true`.
  The content checks refuse a document's or video's caption past 1,024 characters and a non-https
  URL. The conformance suite gains a document send for channels that declare one.
- **Flow's storage, opt in by code: `flowMedia()`** (`@flow-engineer/flow/flow-messaging`) is a
  `MediaStore` over Flow Messaging's files API: uploads by `POST /v1/files` (multipart), downloads
  by `file_...` id. Flow has no delete call yet, so it has no `forget`: files stay until the plan's
  retention (30 days by default), also after `agent.forgetPerson`.
- `agent.message({ ..., key })` takes a person's key your server verified; `agent.conversationOf({ channel, address })`
  gives the conversation an address belongs to.

### Migration notes

- None: nothing an agent uses changed. A hand-written `whatsapp()` provider is offered files only once
  it sets `features.files: true` and sends `Message.file`.

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
