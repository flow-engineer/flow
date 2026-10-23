# Flow Messaging channels

Put a Flow Framework (`npm i @flow-engineer/flow`) agent on real WhatsApp, Telegram, iMessage and US SMS
through [Flow Messaging](https://api.flow.engineer) (API version 2026-11-01). `@flow-engineer/flow/flow-messaging` gives you
channels that send through Flow's senders, and two ways to receive Flow's events: the live event
stream, an outbound WebSocket that needs no public URL, and a webhook that checks Flow's
signatures. It needs nothing beyond the framework (it uses `fetch`, Node's `WebSocket` and `node:crypto`).

On a laptop, `npx @flow-engineer/flow link` signs in, writes `FLOW_MESSAGING_KEY` and the Telegram
sender into `.env` and prints the link for your phone, so you can skip step 1 below.

```sh
npm install @flow-engineer/flow
```

Node 22.18 or later. The adapter ships inside `@flow-engineer/flow`; import it from `@flow-engineer/flow/flow-messaging`.

## Quick start

### 1. Get a key

Ask the API for a test key. You don't need an account:

```sh
curl -X POST https://api.flow.engineer/v1/sandbox/keys
```

The answer holds your test key (`key`, `fk_test_...`, shown once) and the sandbox senders (`senders`).
Each sender has an ID (`snd_...`), a link to open on your phone, and a join code to send it.

The sandbox has Telegram today. WhatsApp and iMessage come as they open. A sandbox key lasts 7 days
and covers one contact. Live keys (`fk_live_...`) and your own WhatsApp, Telegram or
SMS senders are set up from the dashboard at https://api.flow.engineer. iMessage lines, Flow's
shared one included, are arranged with the Flow team.

Open the Telegram sandbox sender's link on your phone and send its join code. You are now the
sandbox contact your agent can talk to.

### 2. Run the agent

```ts
// main.ts
import { createAgent } from "@flow-engineer/flow";
import { flowMessaging } from "@flow-engineer/flow/flow-messaging";

const fm = flowMessaging(); // reads FLOW_MESSAGING_KEY (and FLOW_MESSAGING_WEBHOOK_SECRET for a webhook)

const agent = createAgent({
  dir: "./agent", // your agent's folder (AGENTS.md, ...)
  model: yourModel,
  // only the channels you have senders for
  channels: [fm.telegram(), fm.whatsapp(), fm.imessage(), fm.sms()],
});
await agent.resume();

const live = fm.start(agent, { cursorFile: ".flow/flow-messaging-cursor" });
live.stopped.then((why) => console.error(`Flow Messaging refused the stream: ${why.message}`));
```

That's it on a laptop: with no webhook secret, `fm.start` opens the event stream (`fm.stream(agent)`
does only that).

### The event stream

`GET /v1/stream` is a WebSocket the agent opens to Flow, with the key offered as a subprotocol
(Node's `WebSocket` cannot set headers). It asks only for the events the adapter handles and hands
each, in log order, to the same handler as the webhook.

- **Acknowledged once handled.** The stream has no ack frame for events; it resumes from `after`.
  The adapter moves its cursor past an event only once the agent has taken it, so an event that
  fails, or arrives as the socket drops, comes again.
- **Reconnects.** A dropped socket, Flow's `reconnect` frame (it restarts, or a connection reaches
  24 hours) and a failed event reconnect with `after` set to the last handled event: at once the
  first time, then backing off to 30 s, or after Flow's `retry_after` (too many streams for the
  key, Flow busy). An event that fails 5 times in a row is passed over, so it cannot hold up every
  later one; it stays in Flow's log (`GET /v1/events`).
- **Offline messages.** With `cursorFile`, the last handled event's ID is kept on disk, so after a
  restart Flow replays everything that came while the agent was stopped, for as long as your plan
  keeps events (30 days by default). Without it, a dropped stream still resumes, but a restart
  starts from now. A cursor older than Flow's log starts again from now, and says so.
- **Stops for good** on a refused key or request (close codes 4401, 4403, 4400): `stopped`
  resolves with the code, type and Flow's message. `close()` ends the stream.
- **Replies go over HTTP**, with their Idempotency-Keys, so they never wait for the stream.
- The stream cannot send `Flow-Version`, so its events come in the version your app was pinned to.

### Or a webhook

Already have an HTTP server? Hand the raw body and headers to `fm.receive`, or serve `fm.webhook(agent)`
(with a webhook secret set, `fm.start` serves it on `port`, default `PORT` else 8080):

```ts
const { status, body } = await fm.receive(agent, { body: rawBody, headers: req.headers });
```

Flow posts events to a public HTTPS URL. Create a webhook endpoint for it:

```sh
curl https://api.flow.engineer/v1/webhook_endpoints \
  -H "Authorization: Bearer $FLOW_MESSAGING_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-agent.example.com/", "events": ["message.received", "message.sent", "message.failed", "reaction.added", "contact.deleted"]}'
```

`message.sent` lets each send resolve the moment the channel has the message (below); without it a
send reads its message back instead, which takes up to a second longer. With `waitFor: "delivered"`,
add `message.delivered`.

The answer holds the signing secret (`secret`, `whsec_...`), shown once. Save it as
`FLOW_MESSAGING_WEBHOOK_SECRET`.

On a laptop there is no public URL: use the event stream instead.

## Environment

| Variable | What it is |
|---|---|
| `FLOW_MESSAGING_KEY` | Your app's API key, `fk_test_...` or `fk_live_...`. Keep it on your server. |
| `FLOW_MESSAGING_WEBHOOK_SECRET` | The webhook endpoint's signing secret, `whsec_...`. While you rotate it, give both, comma-separated. Without it, `fm.start` uses the event stream. |
| `FLOW_MESSAGING_TELEGRAM_SENDER`, `FLOW_MESSAGING_WHATSAPP_SENDER`, `FLOW_MESSAGING_IMESSAGE_SENDER`, `FLOW_MESSAGING_SMS_SENDER` | Each channel's sender, `snd_...`. Needed to start conversations (nudges, templates) and to tell senders apart. Replies to people who wrote first work without it. |
| `FLOW_MESSAGING_BASE_URL` | Optional. Default `https://api.flow.engineer`. |

Each of these can also be passed in code: `flowMessaging({ apiKey, webhookSecret, baseUrl, waitFor, waitTimeoutMs })`, and
`fm.telegram({ sender, name, instructions })` (the same for `whatsapp`, `imessage` and `sms`).

## What it maps

**Out (agent to person):**

- Text: Markdown on Telegram, plain text on WhatsApp, iMessage and SMS.
- Reply buttons and lists, sent as Flow `buttons`, each with its own id (a button given as a label
  has the label as its id). WhatsApp shows up to 3 reply buttons, or a list
  for 4 to 10. Telegram shows an inline keyboard. iMessage has none, so the agent is not offered them.
  The WhatsApp and Telegram channels' `info.buttonIds` is true: a tap comes back with the button's id.
- A link: one URL button (WhatsApp's call-to-action button); on iMessage, the URL on its own line.
- A photo (by URL, or a Flow file ID from `POST /v1/files`): a media message with the text as its
  caption; with buttons or a link, the image header of that same message (on Telegram, one photo
  with its keyboard).
- A carousel (WhatsApp and Telegram): Flow `carousel` content, 2 to 10 cards, each a photo, up to 160
  characters and 1 or 2 reply buttons or one link, the same on every card. WhatsApp shows the cards
  side by side; Telegram gets them one by one, in order. On iMessage the agent is not offered one.
- Quotes (`reply_to`), reactions (tapbacks on iMessage), typing, and read receipts (WhatsApp, iMessage).
- Edits and unsends (Telegram, iMessage): the agent's `edit_message` is `PATCH /v1/messages/{id}`,
  its `unsend_message` `DELETE /v1/messages/{id}`, by the id its send resolved with (`SendReceipt.messageId`).
  How late each may come is Flow's and the channel's rule: a refusal (`422`, with Flow's error type and
  message) goes back to the agent as its tool result, and nothing is sent instead. WhatsApp has neither.
- WhatsApp templates, by name or `tpl_` ID, with their header (text, or media by URL or file ID),
  body values (`{{1}}`, `{{2}}`, ...) and button values (URL suffixes, quick-reply payloads).

**In (person to agent):**

- Text.
- Taps on buttons, list rows and template quick replies, as a choice: `{ id, title }`, the button's
  or row's id and its label. A quick reply's payload is its ID.
- Quotes, read from Flow.
- Reactions to the agent's messages.
- Late failures (`message.failed`), told to the agent as "Not delivered" (an edit's or unsend's as `edit of msg_...`, `unsend of msg_...`).
- Photos, voice notes, audio and documents, as attachments. Their bytes are fetched from
  `GET /v1/files/{id}` only when the agent can use them. A voice note Flow already transcribed
  arrives as its transcript.
- A video, a file Flow did not keep, a location or a contact card arrives as a note in the text.

## What it does for you

- **A send resolves once the channel has the message.** Flow answers a send `202` (queued); the
  channel's send then waits for `message.sent` (from the stream or the webhook, else by reading the
  message back), so the agent's next message goes only after it, and a `message.failed` comes back
  to the agent from that send, as Not delivered. `flowMessaging({ waitFor })` changes when a send
  resolves: `"sent"` (the default), `"delivered"` (the person's device has it, where the channel
  reports it; Telegram never does, so there it is `"sent"`), or `"queued"` (on the 202, as before
  0.5.0). `waitTimeoutMs` (default 30,000) is the longest a send waits: past it, it resolves anyway,
  the agent emits `message.slow`, and the message is never sent again. See
  [docs/guarantees.md](../docs/guarantees.md).

- Every send carries its own Idempotency-Key. A 429 or 5xx is tried again with the same key after
  a short Retry-After, so a message never goes out twice. A nudge or a scheduled text keeps one key
  from its id (`nudge:<id>`, `run:<id>`) in every process, so a restart or a second instance does not
  send it again.
- Flow's `409 outside_window` becomes the framework's `outside_window`, so the agent knows to send a
  template.
- A permanent refusal (opted out, no consent, ...) reaches the agent once, with "don't resend it".
- Signatures are checked: HMAC-SHA256, five minutes' tolerance, and any of the secrets you gave.
- An event Flow delivers twice (or by both the stream and a webhook) reaches the agent once. On the
  webhook a failure answers 500, so Flow delivers the event again; on the stream it comes again on
  the next connection.
- `contact.deleted` makes it forget the contact.
- Keys and message text are never logged.

What it remembers (conversations, contacts, event IDs) is kept in memory, except the stream's
`cursorFile`. After a restart, the
first send to someone starts from the channel's sender, and Flow puts it into the open conversation
if there is one.

The framework has no Telegram or iMessage channel kind yet, so both are custom channels. On iMessage
a person is their phone number, or their email address when that is their handle; they are not joined
with the same number on WhatsApp or SMS.

**iMessage replies only.** On Flow's shared iMessage sender (as on WhatsApp after 24 hours) the agent
can only answer someone who wrote first. A nudge or scheduled message to anyone else fails, and
reaches the agent as "Not delivered" (`outside_window`). Ask people to write first with the line's
opt-in link. Text takes up to 9999 characters; there are no buttons, lists or templates.

## Also exported

- `verifySignature(body, header, secrets)`: checks a `Flow-Signature` header yourself.
- `FlowMessagingError`: the API's typed error (`status`, `type`, `channelCode`, `retryAfter`).
- `API_VERSION`: the API version every request asks for, `2026-11-01`.
- `TELEGRAM`, `IMESSAGE`: the Telegram and iMessage channels' limits, as framework `ChannelInfo`s.

## Links

- Flow Messaging: https://api.flow.engineer
- API reference: https://api.flow.engineer/openapi.yaml
- Flow Framework: https://www.npmjs.com/package/flow

## License

Apache-2.0, as the rest of this repository.
