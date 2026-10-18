# Flow Messaging channels

Put a Flow Framework (`npm i @flow-engineer/flow`) agent on real WhatsApp, Telegram and US SMS
through [Flow Messaging](https://api.flow.engineer) (API version 2026-11-01). `@flow-engineer/flow/flow-messaging` gives you
channels that send through Flow's senders, and a webhook that checks Flow's signed events and hands
them to the agent. It needs nothing beyond the framework (it uses `fetch` and `node:crypto`).

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
SMS senders are set up from the dashboard at https://api.flow.engineer.

Open the Telegram sandbox sender's link on your phone and send its join code. You are now the
sandbox contact your agent can talk to.

### 2. Run the agent

```ts
// main.ts
import { createServer } from "node:http";
import { createAgent } from "@flow-engineer/flow";
import { flowMessaging } from "@flow-engineer/flow/flow-messaging";

const fm = flowMessaging(); // reads FLOW_MESSAGING_KEY and FLOW_MESSAGING_WEBHOOK_SECRET

const agent = createAgent({
  dir: "./agent", // your agent's folder (AGENTS.md, ...)
  model: yourModel,
  // only the channels you have senders for
  channels: [fm.telegram(), fm.whatsapp(), fm.sms()],
});
await agent.resume();

createServer(fm.webhook(agent)).listen(Number(process.env.PORT ?? 8080));
```

Already have an HTTP server? Hand the raw body and headers to `fm.receive` instead:

```ts
const { status, body } = await fm.receive(agent, { body: rawBody, headers: req.headers });
```

### 3. Point Flow's webhook at it

Flow posts events to a public HTTPS URL. Create a webhook endpoint for it:

```sh
curl https://api.flow.engineer/v1/webhook_endpoints \
  -H "Authorization: Bearer $FLOW_MESSAGING_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-agent.example.com/", "events": ["message.received", "message.failed", "reaction.added", "contact.deleted"]}'
```

The answer holds the signing secret (`secret`, `whsec_...`), shown once. Save it as
`FLOW_MESSAGING_WEBHOOK_SECRET`.

On a laptop there is no public URL. Run a tunnel to the port (for example
`cloudflared tunnel --url http://localhost:8080`) and register that URL.

## Environment

| Variable | What it is |
|---|---|
| `FLOW_MESSAGING_KEY` | Your app's API key, `fk_test_...` or `fk_live_...`. Keep it on your server. |
| `FLOW_MESSAGING_WEBHOOK_SECRET` | The webhook endpoint's signing secret, `whsec_...`. While you rotate it, give both, comma-separated. |
| `FLOW_MESSAGING_TELEGRAM_SENDER`, `FLOW_MESSAGING_WHATSAPP_SENDER`, `FLOW_MESSAGING_SMS_SENDER` | Each channel's sender, `snd_...`. Needed to start conversations (nudges, templates) and to tell senders apart. Replies to people who wrote first work without it. |
| `FLOW_MESSAGING_BASE_URL` | Optional. Default `https://api.flow.engineer`. |

Each of these can also be passed in code: `flowMessaging({ apiKey, webhookSecret, baseUrl })`, and
`fm.telegram({ sender, name, instructions })` (the same for `whatsapp` and `sms`).

## What it maps

**Out (agent to person):**

- Text: Markdown on Telegram, plain text on WhatsApp and SMS.
- Reply buttons and lists, sent as Flow `buttons`. WhatsApp shows up to 3 reply buttons, or a list
  for 4 to 10. Telegram shows an inline keyboard.
- A link: one URL button (WhatsApp's call-to-action button).
- A photo: a media message with the text as its caption. Flow's button messages have no image
  header, so a photo with buttons or a link goes just before them.
- Quotes (`reply_to`), reactions, typing, and read receipts (WhatsApp).
- WhatsApp templates, by name or `tpl_` ID, with their header (text, or media by URL or file ID),
  body values (`{{1}}`, `{{2}}`, ...) and button values (URL suffixes, quick-reply payloads).

**In (person to agent):**

- Text.
- Taps on buttons, list rows and template quick replies, as a choice. A quick reply's payload is
  its ID.
- Quotes, read from Flow.
- Reactions to the agent's messages.
- Late failures (`message.failed`), told to the agent as "Not delivered".
- Photos, voice notes, audio and documents, as attachments. Their bytes are fetched from
  `GET /v1/files/{id}` only when the agent can use them. A voice note Flow already transcribed
  arrives as its transcript.
- A video, a file Flow did not keep, a location or a contact card arrives as a note in the text.

## What it does for you

- Every send carries its own Idempotency-Key. A 429 or 5xx is tried again with the same key after
  a short Retry-After, so a message never goes out twice.
- Flow's `409 outside_window` becomes the framework's `outside_window`, so the agent knows to send a
  template.
- A permanent refusal (opted out, no consent, ...) reaches the agent once, with "don't resend it".
- Signatures are checked: HMAC-SHA256, five minutes' tolerance, and any of the secrets you gave.
- An event Flow delivers twice reaches the agent once. A failure answers 500, so Flow delivers the
  event again.
- `contact.deleted` makes it forget the contact.
- Keys and message text are never logged.

What it remembers (conversations, contacts, event IDs) is kept in memory. After a restart, the
first send to someone starts from the channel's sender, and Flow puts it into the open conversation
if there is one.

The framework has no Telegram channel kind yet, so Telegram is a custom channel. iMessage is not in this
package yet.

## Also exported

- `verifySignature(body, header, secrets)`: checks a `Flow-Signature` header yourself.
- `FlowMessagingError`: the API's typed error (`status`, `type`, `channelCode`, `retryAfter`).
- `API_VERSION`: the API version every request asks for, `2026-11-01`.
- `TELEGRAM`: the Telegram channel's limits, as a framework `ChannelInfo`.

## Links

- Flow Messaging: https://api.flow.engineer
- API reference: https://api.flow.engineer/openapi.yaml
- Flow Framework: https://www.npmjs.com/package/flow

## License

Apache-2.0, as the rest of this repository.
