# Channels: options and params

Every channel factory and what it takes, from the source types (`src/channels.ts`, `src/types.ts`,
`flow-messaging/src/index.ts`). For how channels and people fit together, see
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
| `info?` | What your UI can show (a `ChannelInfo` without `reactions`, `status`, `readReceipts`, `edits` and `unsends`, which come from the methods below). Default: Markdown, no buttons. See [ChannelInfo](#channelinfo) |
| `sendCarousel?(to, carousel)` | A carousel, when `info.carousels` is set; otherwise the cards go one by one through `sendMessage` |
| `react?(to, messageId, emoji)` | Reactions |
| `typing?(to, on)` | The typing indicator |
| `markRead?(to, messageIds)` | Read receipts |
| `status?(to, text \| null)` | A short line of what the agent is doing, in your loading indicator; `null` clears it |
| `editMessage?(to, messageId, text)` | New text for a message the agent sent, by the `messageId` your `sendMessage` resolved with (`{ status: "sent", messageId }`). With it the agent is offered `edit_message`; reject to refuse an edit, and the reason goes to the agent |
| `unsendMessage?(to, messageId)` | Takes back a message the agent sent, by that id. With it the agent is offered `unsend_message` |

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
| `edits`, `unsends` | The agent can change or take back a message it sent (`edit_message`, `unsend_message`, by the id its send's result gave). Telegram and iMessage on Flow Messaging have both; a custom UI sets them from `editMessage` and `unsendMessage`; WhatsApp and SMS have neither. The platform decides how late either may come, and nothing is sent in place of one it refuses: the refusal goes back to the agent as its tool result. Flow Messaging refuses a late or unsupported one when it is made (`422 unsupported_content` with `edit_window_closed`, `unsend_window_closed`, `first_message_not_editable` or `not_on_sms`, its message stating the limit) |
