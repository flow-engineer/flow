# Delivery guarantees

What Flow Framework promises about the messages an agent sends and receives, and what it does not.
Each promise below is checked against every channel adapter Flow Framework ships by the conformance
suite (`npm run test:conformance`, [below](#the-conformance-suite)).

## What `send()` resolving means

A channel's `send(address, outbound)` (and a provider's `sendMessage`, `sendCarousel`,
`sendTemplate`) **resolves once the platform has accepted the message**, and **rejects when the
platform refused it**, with the platform's reason. Accepted means the platform took it to deliver:

| Channel | Resolves when |
|---|---|
| Flow Messaging (WhatsApp, SMS, Telegram, iMessage) | Flow reports `message.sent`: the channel itself took it (not only Flow's `202`, which means queued). `waitFor: "delivered"` waits for `message.delivered` instead, where the channel reports it. |
| `whatsapp(provider)`, `sms(provider)`, `customUI(name, provider)` | Your provider's `sendMessage` (or `sendCarousel`, `sendTemplate`) resolves. Write it to resolve when your platform's API accepted the message, not before. |
| The playground and the test cloud | The simulator has it. |

A send may resolve with a receipt (`SendReceipt`) saying how far the message got: `sent`,
`delivered`, `queued` (a provider that does not wait, such as Flow Messaging with
`waitFor: "queued"`), or `unconfirmed`. `unconfirmed` means no signal came within the provider's
wait (Flow Messaging's `waitTimeoutMs`, 30 seconds by default): the message may still arrive and is
**never sent again**; the agent emits `message.slow` (with `channel`, `origin`, `text`, `waitedMs`)
and carries on. A send that resolves with nothing counts as accepted.

What follows from it:

- A send tool's result tells the agent `delivered` only once the platform accepted the message.
- `message.out` is emitted, and the message kept in the history and the transcript, only then.
- A rejected send comes back to the agent as a "Not delivered" note with the reason, once
  (`message.undelivered`). A failure Flow reports after the send resolved (a late
  `message.failed`) comes back the same way.
- A carousel the channel sends card by card resolves once the platform accepted its last card.
- Typing indicators, read receipts and status lines are courtesies: their failures are ignored,
  and a channel whose info says `typing: false` is never sent one.

## Ordering

- **One conversation, one message at a time.** An agent's messages to one person go to the channel
  in the order it wrote them, and each goes only once the one before it was accepted. Messages the
  framework sends itself (an acknowledgement, a scheduled text, a nudge) wait for the turn in
  progress and follow the same rule.
- **Inbound, per conversation.** A conversation runs one turn at a time and takes the person's
  messages in the order the channel gave them; double texts fold into the turn in progress.
  Flow Messaging delivers events in order per conversation (stream and webhook alike).
- **Across conversations, nothing is ordered.** Different people's conversations run side by side.
- **Across channels of one person,** each channel is ordered on its own; the agent is told which
  channel each message came on.
- What a platform does after accepting a message is the platform's: Flow Messaging sends one
  message at a time per conversation, in the order accepted; Telegram and WhatsApp deliver in that
  order in practice but promise nothing more.

## Inbound: at least once in, taken once

Platforms deliver at least once: a webhook is retried until it is answered, and Flow Messaging
redelivers events it is not sure arrived. The agent takes each message once:

- Flow Messaging events are dropped when their id was handled before in this process (the last
  10,000), so a redelivery, or the same event by both the stream and a webhook, reaches the agent
  once. A failure to handle an event answers the webhook 500 (or does not move the stream's cursor),
  so Flow delivers it again.
- A message whose id the conversation has already taken is a `message.duplicate` and starts no
  turn. With a database (`sqlite(file)`, `postgres(...)`) that holds across restarts and runners;
  with the default in-memory store it holds until the process stops.

## Outbound: when exactly once is true, and when it is not

- **Messages the business starts** (a nudge, a scheduled text, a template) carry an idempotency key
  made from their id (`nudge:<id>`, `run:<id>`), the same in every process. A provider that honours
  keys, as Flow Messaging does for 24 hours, sends each **once**, even when two runners or a restart
  send it again. A nudge already settled in the store is never sent again.
- **Retries of one send** (Flow Messaging's on a 429 or 5xx) repeat the same key: never a second
  message.
- **The agent's replies** are sent once by the framework: a send that was accepted is in the history
  and never sent again, also after a restart. With a database (`sqlite(file)`, `postgres(...)`), each
  send is **written ahead**: the step that makes it is stored, with the send `pending`, before it
  goes, and it goes with its own idempotency key, `send:<conversation>:<turn>:<call>`. A process that
  stops before that write sent nothing of the step: it runs again. One that stops after the send
  went but before its result was stored:
  - on a channel whose info says `idempotentSends` (Flow Messaging's), the send goes again with the
    same key before the turn carries on, so the person gets it **once** (`send.resumed`). Past 24
    hours it is not sent again (the key may be gone).
  - on any other channel, the agent is told it may or may not have gone, and decides.
  - a send already settled (sent, failed or refused) gives the agent that result, never "may or may not".
- **A send that timed out** (`unconfirmed`) is never sent again, so it is at most once from here; the
  platform may still deliver it.
- **Flow Messaging's own resend.** When a channel took a message but never answered, Flow resends it
  once, so a rare duplicate is possible on Telegram; an outcome still unknown fails with
  `channel_timeout_unknown_outcome` (it may have arrived). Idempotency keys cannot undo that.
- One runner works on a conversation at a time (a lease in the database), so a deploy's overlap
  never answers one message twice.
- A runner that stalled past its lease (another runner took the conversation meanwhile) changes
  nothing more: its writes carry the lease's epoch and are refused, so it sends nothing and stops.

## Writing your own provider

`whatsapp(provider)`, `sms(provider)` and `customUI(name, provider)` keep these guarantees only if the
provider does its part:

- Resolve `sendMessage` when your platform's API has accepted the message, and reject (with a
  readable reason) when it refused it. Never resolve early to go faster: the next message would
  overtake it, and the agent would be told it was delivered.
- Pass `idempotencyKey` on to your platform when it takes one. If your channel's send honours it
  for at least 24 hours (a second send with the same key never reaches the person again), set
  `info.idempotentSends: true`, and a reply a restart cut off goes again with its key.
- If your platform's acceptance can take long, wait at most a bounded time and resolve
  `{ status: "unconfirmed" }` past it, rather than hanging the conversation.

## The conformance suite

`conformance/` runs each adapter through the checks above against a platform the checks hold:
`whatsapp()`, `sms()` and `customUI()` over a provider that waits for the check, and each Flow
Messaging channel with its signal coming by webhook, by the stream and by reading the message back.
For each one it checks that `send()` resolves only after the platform accepted the message, rejects
with the platform's reason, passes idempotency keys on (the business's and an agent's reply written
ahead), resolves a carousel only after its last
part, and that an agent's messages reach the platform one at a time, in order.

It runs on demand and before every release (`npm run test:conformance`, [releasing.md](releasing.md)),
not in `npm test` or on pull requests. To check an adapter of your own, add a rig for it in
`conformance/channels.test.ts`.
