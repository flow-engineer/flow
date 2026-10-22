# Channels: options and params

Every channel factory and what it takes, from the source types (`src/channels.ts`, `src/types.ts`,
`src/web-chat.ts`, `flow-messaging/src/index.ts`). For how channels and people fit together, see
[Channels and people](../README.md#channels-and-people).

A channel's name is how the agent knows it: its send tool is `send_<name>` (lowercase, other
characters as `_`), and `message({ channel })` names it. `key` and `phone` are reserved.

## `whatsapp(provider, options?)`

`options`:

| Option | What it does |
|---|---|
| `name` | The channel's name. Default `whatsapp` |
| `disable` | Features never offered to the agent, even if the provider has them: any of `buttons`, `lists`, `links`, `images`, `carousels`, `replies`, `reactions`, `typing`, `readReceipts`, `templates` |
| `instructions` | Your guidance for the agent, added to its prompt while the person is on this channel |
| `keywords` | STOP, START and HELP words and replies (default `WHATSAPP_KEYWORDS`: STOP, UNSUBSCRIBE; START): changes to the default, or `false` for none ([README](../README.md#reminders-and-nudges)) |

`provider` (a `WhatsAppProvider`): only `sendMessage` is required. A method left out is a feature the
agent is never offered.

| Member | What it does |
|---|---|
| `sendMessage(to, message)` | Sends one message (see [Message](#message)) |
| `sendCarousel?(to, carousel)` | A media carousel: `{ text, cards, replyTo?, preview?, idempotencyKey? }`, each card `{ image, text?, buttons? \| link? }`. Without it the agent is never offered one |
| `features?` | Which parts of a message the provider can send: `{ buttons?, lists?, replies?, links?, images? }`, each `true` unless set to `false` |
| `react?(to, messageId, emoji)` | Reactions |
| `typing?(to, on)` | The typing indicator |
| `markRead?(to, messageIds)` | Read receipts (blue ticks) |
| `sendTemplate?(to, template, idempotencyKey?)` | Approved templates, for outside the 24-hour window: `{ name, language?, header?, body?, buttons?, variables? }` |

WhatsApp's own limits (`WHATSAPP`): 4,096 characters, 3 reply buttons with labels up to 20, lists of
up to 10 rows (titles up to 24), one link button, captions up to 1,024, carousels of 2 to 10 cards
(`WHATSAPP_CAROUSELS`), a 24-hour reply window.

## `sms(provider, options?)`

`options`: `name` (default `sms`), `instructions`, and `keywords` (default `SMS_KEYWORDS`: STOP;
START; HELP, INFO; `US_CARRIER_KEYWORDS` for the fuller US list; `false` for none).

`provider` (an `SmsProvider`): `sendMessage(to, { text, idempotencyKey? })`. SMS is plain text up to
1,530 characters (`SMS`); a carousel is sent as one text per card.

## `customUI(name, provider)`

Your own web or mobile chat. `name` is the channel's name. `provider` (a `CustomUIProvider`):

| Member | What it does |
|---|---|
| `sendMessage(to, message)` | Sends one message: the [Message](#message) fields plus your params by name |
| `params?` | Extra fields on this channel's send tool, as zod schemas: `{ app_link: z.string().describe("...") }`. The agent may fill each one (they are always optional, an empty value is left out), and `sendMessage` gets them as they are. Describe each one: the description is what the agent reads |
| `instructions?` | Your guidance for the agent on this channel, such as when to fill your params |
| `info?` | What your UI can show (a `ChannelInfo` without `reactions`, `status` and `readReceipts`, which come from the methods below). Default: Markdown, no buttons. See [ChannelInfo](#channelinfo) |
| `sendCarousel?(to, carousel)` | A carousel, when `info.carousels` is set; otherwise the cards go one by one through `sendMessage` |
| `react?(to, messageId, emoji)` | Reactions |
| `typing?(to, on)` | The typing indicator |
| `markRead?(to, messageIds)` | Read receipts |
| `status?(to, text \| null)` | A short line of what the agent is doing, in your loading indicator; `null` clears it |

## `webChat(options)`

The agent in a chat box on your own site, served by the agent itself: no chat backend of yours.

```ts
const web = webChat({ secret: process.env.FLOW_WEB_CHAT_SECRET, origins: ["https://shop.example"] });
const agent = createAgent({ ..., channels: [whatsapp(provider), web], routes: web.routes });
web.attach(agent);
```

| Option | What it does |
|---|---|
| `secret` | At least 32 characters. Signs visitors' sessions, and is the key your server signs sign-in tokens with |
| `origins` | The sites the chat may be embedded on; a browser on any other gets 403. Default: any (local development) |
| `name` | The channel's name. Default `web` (its send tool is `send_web`) |
| `base` | Where its routes answer. Default `/v1/web-chat` |
| `info` | What your chat box shows, over `WEB_CHAT` (Markdown, 10 reply buttons with ids, lists, a link button, photos, carousels, replies, reactions, typing, status lines, read receipts, 8,000 characters, no templates) |
| `instructions` | Your guidance for the agent while the person is on the web chat |
| `mailbox` | Where each visitor's events wait for their browser. Default `memoryMailbox()`, in this process: with several runners, give one on a shared store (`WebChatMailbox`: `append`, `read`, `start`) |
| `limits` | `{ messagesPerMinute: 20, sessionsPerMinute: 30, messageChars: 4000 }` |

`web.page(conversationId)` is the page the person last wrote from (`{ url, title? }`), for your
`context` in your own words. Accepted, for its `send()`, means the visitor's mailbox kept the message
([guarantees](guarantees.md)).

**Signed-in visitors.** Your server, once it knows who the visitor is, signs a short-lived token:
`webChatSignIn(secret, key)` (or any HS256 JWT library: `{ sub: key, aud: "flow-web-chat", exp }`,
expiring within 24 hours). The visitor is then the person `key` names, as `resolve`'s key on your
other channels, so their web chat and WhatsApp are one conversation. Without a token the visitor is
anonymous (`visitor:<id>`); their chat stays apart from any account.

**The HTTP contract** (long-polling: it works through any proxy, CDN or host that buffers a
response). Every call but `session` sends `Authorization: Bearer <session>`; JSON both ways.

| Call | Body or query | Answer |
|---|---|---|
| `POST {base}/session` | `{ token? }` | `200 { session, expires_at, signed_in }` (anonymous: 30 days; signed in: 12 hours) |
| `GET {base}/history` | | `200 { messages, cursor }`: this channel's messages, oldest first |
| `GET {base}/events` | `?after=<cursor>&wait=<seconds, at most 25>` | `200 { events, cursor }` as soon as there is one (else empty after `wait`), or `{ reset: true }`: read the history again |
| `POST {base}/messages` | `{ id, text, choice?: { id?, title }, page?: { url, title? } }` | `202 { id }`. `id` is yours (1 to 64 of letters, digits, `_ . : -`); send the same one on a retry and it is taken once |

An event is `{ cursor, at, type, ... }`: `message` (`from: "agent"` with `text`, `buttons?: [{ id,
label }]`, `list?`, `link?`, `image?`, `replyTo?`, `fields?`; or `from: "person"` with `id`, `text`,
`choice?`, the visitor's own, echoed for their other tabs), `carousel` (`text`, `cards`), `typing`
(`on`), `status` (`text`, null clears it), `read` (`messageIds`), `reaction` (`messageId`, `emoji`).
A tap sends the button's label as `text` and `{ id, title }` as `choice`. Attachments are not taken
yet (400).

**The browser side.** `webChatClient({ url, signIn? })` from `@flow-engineer/flow/web-chat` (no
Node imports, for any bundler) keeps the session, emits the history and each event, retries a send
with the same id, and reads the history again after a `reset`. It has no UI: your chat box renders
what it emits.

The playground and the test cloud play `webChat()` in the web simulator with its `info`; their
replies stay there and never reach a visitor's mailbox.

## Flow Messaging: `fm.whatsapp()`, `fm.telegram()`, `fm.imessage()`, `fm.sms()`

From `const fm = flowMessaging({ apiKey?, webhookSecret?, baseUrl? })`
(`@flow-engineer/flow/flow-messaging`; the defaults come from `FLOW_MESSAGING_KEY`,
`FLOW_MESSAGING_WEBHOOK_SECRET` and `FLOW_MESSAGING_BASE_URL`). Each channel takes:

| Option | What it does |
|---|---|
| `sender` | The Flow sender (`snd_...`) it starts conversations from. Default `FLOW_MESSAGING_<CHANNEL>_SENDER`. Replies to someone who wrote first work without it |
| `name` | The channel's name. Default `whatsapp`, `telegram`, `imessage` or `sms` |
| `instructions` | Your guidance for the agent on this channel |
| `disable` | `fm.whatsapp()` only: as `whatsapp()`'s `disable` |

`fm.channels({ except? })` gives Telegram, plus WhatsApp and iMessage when their sender is set. What
each channel can send, and how it maps to Flow Messaging, is in
[flow-messaging/README.md](../flow-messaging/README.md#what-it-maps); their limits are the exported
`TELEGRAM` and `IMESSAGE`.

## Message

What `sendMessage` gets (`Message`): every field but `text` is optional, and only the ones the channel
offers are ever set.

| Field | What it is |
|---|---|
| `text` | The text, or a photo's caption |
| `replyTo` | The id of the person's message it quotes |
| `buttons` | Reply buttons: a label, or `{ id, label }` |
| `list` | `{ button, rows: [{ id, title, description? }] }`: a list the person picks one row from |
| `link` | `{ label, url }`: one button that opens a page. Never with buttons or a list |
| `image` | `{ url }` or `{ fileId }`: a photo, the text its caption. Never with a list |
| `preview` | `false`: send with link previews off (a message the business started) |
| `idempotencyKey` | Set on a send the business starts (a nudge, a scheduled text), the same in every process: a provider that takes one sends it once |

## ChannelInfo

What a channel can show; Flow Framework offers the agent only what is set, and fits each message to it.

| Field | What it is |
|---|---|
| `formatting` | `plain`, `whatsapp` or `markdown` |
| `maxLength` | The most characters one message can carry |
| `replies` | A message can quote one of the person's |
| `buttons` | `{ max, labelMax }`: reply buttons |
| `buttonIds` | A tap on a `{ id, label }` button comes back with its id |
| `lists` | `{ maxRows, titleMax, buttonMax }` |
| `linkButton` | `{ labelMax }`: one button that opens a page |
| `images` | `{ captionMax }`: photos, the text as caption |
| `carousels` | `{ maxCards, textMax, cardTextMax, buttons, labelMax }` |
| `platform` | `whatsapp`, `telegram`, `imessage` or `sms`: whose content rules (`CONTENT_LIMITS`) every send is checked against |
| `replyWindowHours` | The business may write first only this long after the person's last message |
| `reactions`, `status`, `readReceipts` | Set from the provider's methods |
