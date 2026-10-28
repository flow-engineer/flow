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
| `typing?(to, on)` | The typing indicator. Reject with an error whose message starts with `outside_window` when the platform refuses it outside the person's window: Flow Framework tries again after the agent's next message. Any other rejection ends typing for the turn (a warning is logged) |
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
| `typing?(to, on)` | The typing indicator. Reject with an error whose message starts with `outside_window` when the platform refuses it outside the person's window: Flow Framework tries again after the agent's next message. Any other rejection ends typing for the turn (a warning is logged) |
| `markRead?(to, messageIds)` | Read receipts |
| `status?(to, text \| null)` | A short line of what the agent is doing, in your loading indicator; `null` clears it |
| `editMessage?(to, messageId, text)` | New text for a message the agent sent, by the `messageId` your `sendMessage` resolved with (`{ status: "sent", messageId }`). With it the agent is offered `edit_message`; reject to refuse an edit, and the reason goes to the agent |
| `unsendMessage?(to, messageId)` | Takes back a message the agent sent, by that id. With it the agent is offered `unsend_message` |

## `webChat(options?)`

The agent in a chat box on the business's own site, served by the agent itself: no Flow Messaging,
no other service. Add the channel and `createAgent` serves its routes under `/v1/web-chat` (through
`agent.fetch`, beside your own `routes`):

```ts
import { createAgent, webChat } from "@flow-engineer/flow";

export function buildAgent({ events, tools, host } = {}) {
  return createAgent({
    dir, model, events, host, tools: tools ?? myTools,
    // With `host`, Flow Messaging's channels (WhatsApp, Telegram, ...) are added beside it.
    channels: [webChat({ origins: ["https://www.example.com"] })],
  });
}
```

and the site adds one script tag, served by the agent, so it always matches the agent's version
(the site's CSP needs the agent's address in `script-src` and `connect-src`):

```html
<script async src="https://<agent address>/v1/web-chat/widget.js"
  data-title="Ask us" data-context='{"listing":"ps5-disc"}'></script>
```

The agent's send tool is `send_web`; `beforeSend`, content rules, traces (channel `web`) and tests
behave as on every channel, and the playground plays it as its web simulator.

| Option | What it does |
|---|---|
| `origins` | The sites the box may be on: `https://www.example.com`, or `https://*.example.com` for any subdomain (not the bare domain); `http://` only for `localhost` and `127.0.0.1`. Joined with `FLOW_WEB_CHAT_ORIGINS` (comma-separated). None at all: any site may embed the agent and spend its credit, for development only; Flow's hosting refuses it in production (`web_chat_open`) |
| `identityKey` | For signed-in visitors: the key your backend signs their identity tokens with, at least 32 characters, or several while you rotate it. Default `FLOW_WEB_CHAT_IDENTITY_KEY` (comma-separated) |
| `sessionKey` | Signs visitors' sessions and anonymous ids, at least 32 characters. Default `FLOW_WEB_CHAT_SESSION_KEY`, which Flow's hosting sets; without either, a random key per process (sessions and anonymous visitors then end at a restart) |
| `trustProxy` | How many proxies in front of the agent append to `X-Forwarded-For`; the client's address is that many entries from the end. Default `FLOW_TRUST_PROXY` (Flow's hosting sets `1`). Without it, the limits per network address are off |
| `limits` | `WebChatLimits`, below |
| `busy` | `{ text?, link? }`: what a visitor gets once the daily cap is reached, such as your WhatsApp: `{ text: "We're busy, message us on WhatsApp", link: { label: "WhatsApp", url: "https://wa.me/15550100" } }` |
| `name`, `base` | The channel's name (default `web`) and where its routes answer (default `/v1/web-chat`) |
| `info`, `instructions` | What your box can show, over `WEB_CHAT` (narrow it for a box of your own); your guidance for the agent on this channel |

**Who the visitor is.** Anonymous by default: the box gets an id that lasts 30 days (renewed while
they come back), kept in the browser, and the agent knows them as `web:visitor:<id>`. Safari deletes
what a script stored after 7 days without a visit; they then start afresh. To make a signed-in
visitor the same person as on WhatsApp, your backend signs them a short identity token, an HS256
JWT `{ sub, aud: "flow-web-chat", iat, exp }` valid at most 10 minutes, `sub` being the key your
`resolve` gives for them; any JWT library makes it, or in Node:

```ts
import { webChatIdentity } from "@flow-engineer/flow/web-chat";
app.get("/api/flow-chat-identity", requireLogin, (req, res) =>
  res.json({ token: webChatIdentity({ sub: req.user.id, key: process.env.FLOW_WEB_CHAT_IDENTITY_KEY }) }));
```

and the script tag names that same-origin URL: `data-identity-url="/api/flow-chat-identity"`. The
box exchanges the token for a session; the person is then `key:<sub>`, with all of their
conversation and every tool. An anonymous visitor's chat stays apart from their account when they
sign in.

**The page they wrote from.** Each message carries the page (`url`, `title`) and the site's own
details (`data-context`, or `FlowChat.setContext({...})`), at most 1 KB, the URL on one of the
allowed sites. The agent reads it as one line of data in its turn, never as instructions, and tools
get it as `context.page` (`{ url, title?, context? }`).

**Protection.** The allowed sites stop other websites embedding the agent; they do not stop a
script, which can send any `Origin`. Sessions, limits and the daily cap stop scripts:

| `WebChatLimits` | Default |
|---|---|
| `newVisitorsPerMinute`, `newVisitorsPerDay` | 20 and 300 new visitors per network address (generous: mobile networks put many people behind one address) |
| `messagesPerMinute`, `messagesPerDay` | 8 and 60 per anonymous visitor |
| `signedInMessagesPerMinute`, `signedInMessagesPerDay` | 15 and 300 per signed-in visitor |
| `messagesPerAddressPerMinute` | 60 per network address, all its visitors together |
| `messageChars` | 2,000 characters a message (bodies at most 16 KB) |
| `turnsAtOnce` | 20 web chat turns at once; more wait their turn, with typing shown |
| `messagesPerAgentPerDay` | 5,000 web chat messages a day (UTC), counted in the store; past it each visitor gets the `busy` reply and the agent is not called |

Wrong identity tokens are refused after 10 per address in 15 minutes. The limits are held in the
process's memory (exact on Flow's hosting, which runs one instance per environment; per process
when you run several), but the daily cap. Logs carry ids and counts, never text, addresses or
tokens.

**The HTTP contract**, for a box of your own (all under `/v1/web-chat`, JSON, errors
`{ error, message, retry_after? }`; every call but `session` with `Authorization: Bearer <session>`;
CORS for the allowed sites):

| Call | What it does |
|---|---|
| `POST /session { visitor?, identity? }` | `200 { session, expires_at, signed_in, visitor?, limits }`: a session for 1 hour. Give the stored `visitor` credential to stay the same visitor (the answer has it renewed: store it), or an `identity` token. `401 identity_invalid`, `429 rate_limited` |
| `GET /history` | `200 { messages, cursor }`: the conversation on this channel, oldest first (entries older than the outbox have `seq: 0`), and the newest number |
| `GET /events?after=<seq>` | With `Accept: text/event-stream`: server-sent events `hello { cursor }`, `message` (each event, its number as the SSE `id`), `live { typing, status }`, `reset` (read the history again), `reconnect { cursor }` after 14 minutes, a ping every 15 s. Otherwise a long-poll of up to 25 s: `200 { events, cursor, live }` or `{ reset: true }`. Show each number once |
| `POST /messages { id, text, choice?, page?, context? }` | `202 { id }` once the store has it; the same `id` again is taken once. `202 { id, busy: true }` past the daily cap. `400`, `413`, `429` with `retry_after`, `503` (send it again) |
| `GET /widget.js`, `GET /widget/<name>.js` | The chat box |

An event is `{ seq, at, type }` with `type` `message` (`from: "agent"`: `id`, Markdown `text`,
`replyTo?`, `buttons?`, `list?`, `link?`, `image?`; `from: "person"`: their `id`, `text`, `choice?`),
`carousel` (`id`, `text`, `cards`) or `reaction` (`messageId`, `emoji`). A tap on a button or a
row is sent as `text: <label>, choice: { id, title: <label> }`. Not on the web chat yet: files from
visitors, edits and unsends.

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
| `typing` | `false`: no typing indicator is ever sent |
| `typingLastsMs` | How long the platform shows one typing indicator (`WHATSAPP` 25 s; Flow Messaging's Telegram 5 s and iMessage 15 s). From the person's message until the turn ends, typing is sent again at 80% of it (20 s, 4 s, 12 s); each message the agent sends hides it, and it shows again only when new work starts (a response that calls tools, or the person's next message), never just because time passed. Absent: it is sent once and shows until it is turned off or a message goes |
| `reactions`, `status`, `readReceipts` | Set from the provider's methods |
| `edits`, `unsends` | The agent can change or take back a message it sent (`edit_message`, `unsend_message`, by the id its send's result gave). Telegram and iMessage on Flow Messaging have both; a custom UI sets them from `editMessage` and `unsendMessage`; WhatsApp and SMS have neither. The platform decides how late either may come, and nothing is sent in place of one it refuses: the refusal goes back to the agent as its tool result. Flow Messaging refuses a late or unsupported one when it is made (`422 unsupported_content` with `edit_window_closed`, `unsend_window_closed`, `first_message_not_editable` or `not_on_sms`, its message stating the limit) |
