# Business events

A business's backend posts what happened (an order shipped, an order is late, an item is back in
stock) to one signed route on the agent, `POST /v1/events`. The agent turns each event into a
WhatsApp message for one person, at the event's delivery level: some go at once, some wait for the
end of quiet hours, some are merged or dropped. Sends go through the agent's `nudge()`, so STOP and
the no-contact rules apply to every one.

`flowEvents` (from `@flow-engineer/flow`) is the engine. What your events mean (which types exist,
their templates and wording, your own rules) stays in your app.

Use [`agent.nudge()`](https://docs.flow.engineer/nudges) for a direct follow-up. Use business
events when your backend publishes a catalog of events with delivery levels, expiry and topic rules.

## The envelope

```json
{
  "id": "evt_01J9Z6",
  "type": "order.shipped",
  "occurredAt": "2026-10-20T14:05:00Z",
  "subject": "order:4821",
  "delivery": "critical",
  "data": {
    "user": { "phone": "+15550001234" },
    "consent": { "whatsappUpdates": true },
    "order": { "number": "4821", "carrier": "Parcelco", "trackingUrl": "https://shop.example/t/4821" }
  }
}
```

| Field | |
|---|---|
| `id` | Required. Unique per event: the same id twice is processed once. |
| `type` | Required. One of your catalog's types, or `notification.cancelled`. Any other is a 400. |
| `occurredAt` | Required. ISO time. |
| `subject` | Required. What it is about, as you name it (`order:4821`, `user:77`). |
| `delivery` | `critical`, `standard` or `optional`. The floor: never sent lower. Default: the type's level. |
| `data` | Required object. Your payload. |
| `sentBy` | You already sent this message yourself: kept as context, never sent (see Copies). |
| `expiresAt` | ISO time: not sent after it. Also read from `data.expiresAt`. |
| `collapseKey` | A newer event with the same key replaces one still held. Also read from `data.collapseKey`. |

By default the person is `data.user.phone` (E.164, required on a notification) and they agreed to
messages when `data.consent.whatsappUpdates === true`; without consent nothing is sent. Change
either with `addressOf(event)` and `consented(event)`. `data.wording: "exact"` always sends the
template, never the agent's words.

To cancel one not yet sent, post `notification.cancelled` with the id in `data.cancels`:

```json
{ "id": "evt_01J9Z7", "type": "notification.cancelled", "occurredAt": "2026-10-20T14:06:00Z",
  "subject": "order:4821", "data": { "cancels": "evt_01J9Z6" } }
```

## Signing

Every POST carries `Flow-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>`, the HMAC of
`t.{t}.{raw body}` with the secret you gave the agent (`whsec_...`). `t` may be at most 5 minutes
off. The header may hold several `v1` values, so a secret can be rotated without dropping events.
`signEvent(secret, body)` makes the header; `verifyEventSignature(secret, header, body)` checks one.

From any Node backend, without the package:

```js
import { createHmac } from "node:crypto";

const body = JSON.stringify(event);
const t = Math.floor(Date.now() / 1000);
const v1 = createHmac("sha256", process.env.FLOW_EVENTS_SECRET).update(`t.${t}.${body}`).digest("hex");
await fetch("https://agent.example/v1/events", {
  method: "POST",
  headers: { "content-type": "application/json", "flow-signature": `t=${t},v1=${v1}` },
  body,
});
```

Sign the exact bytes you send.

## Answers

| Status | Body | When |
|---|---|---|
| 202 | `{"status":"accepted"}` or `{"status":"duplicate"}` | Recorded; processed in order in the background. A duplicate id was already taken. |
| 400 | `{"field","error"}` | Malformed; `field` names what is wrong (`data.user.phone`, `type`, a value your message needs). |
| 401 | `{"error"}` | Bad or missing `Flow-Signature`. |
| 405 | `{"error"}` | Not a POST. |
| 503 | `{"error"}` | The agent has no secret configured. |

On a network error, a 429 or a 5xx, retry with the same `id`: the id dedupes, so a retry never
sends twice. An `Idempotency-Key` header is honoured too.

## Delivery levels

| Level | In quiet hours | Also |
|---|---|---|
| `critical` | Sent at once. | |
| `standard` | Held, sent when they end (on the agent's tick). | |
| `optional` | Held too. | One a day per `collapseKey`; dropped when its topic closes. |

- `liveOnly` on a type: its button acts on something live, so it is dropped once its topic closes,
  whatever the level.
- `collapseKey`: a newer standard or optional event with the same key replaces the one held.
- `expiresAt`: a held one past it is dropped.
- Quiet hours are 22:00 to 08:00 in `timezone` (default UTC); `quietHours: { from, to }` changes
  them, `null` turns them off.

A topic (`topic(event)` on the type, such as `order:4821`) closes with `events.close(topic)`.

### Watches raise a message

When a person asked to be told about a topic (`events.watch({ address, topic, title })`, from one of
your tools), a message about it is raised: an optional one is kept as standard, it is never dropped
when the topic closes and it skips the caps. A watch with `urgent: true` ("tell me as soon as") makes
it critical. A message is never lowered. Watches last `watchDays` (30) and end a day after
`close(topic)`.

## Wording

Outside WhatsApp's 24-hour window the template goes. Inside it the agent phrases the message to fit
the chat; every value and the link are checked by `events.phrasing.check` in `beforeSend`. A
message that drops a value or changes the link is refused, and the template goes instead; if the
template fails, its text goes as a message with a link button (`wording: { linkInText: true }` puts
the link in the text). `data.wording: "exact"` always uses the template.

## Copies

`sentBy` says the business already sent this message itself (allowed only for the names in the
`sentBy` option). It is never sent. It is kept as the agent's context, read with
`events.context(conversationId)`, so the agent can answer when they reply about it. It counts as
already told: an identical message within a day, and a held one with the same `collapseKey`, are
not sent. If the agent has `reach()`, the person's conversation is opened, so the copy is there when
they write.

## Nudges

Messages you start from what people watch (rather than from an event) go through
`events.schedule({ delivery: "nudge", nudge: "<kind>", eventId, address, topic, message, notBefore: Date.now(), exact: false })`.
They are held in quiet hours and capped: `caps: { perDay: 2, perKeyPerDay: 1, perWeek: 5 }` by
default (per person; `perKeyPerDay` per topic). A raised nudge skips the caps.
`events.notInterested(address)` mutes the topic last nudged and ends its watch;
`events.mute(address, topic)` mutes one; `events.stopped(address)` ends their watches and held nudges.

## Test list

Off production, a send the business starts goes only to listed numbers, so a staging copy of real
data never reaches a real customer:

```ts
testList: eventTestList({ testing: false, madeUp: /^\+1555/ })
```

- `FLOW_ENVIRONMENT=production`: no list, everyone.
- Otherwise only `FLOW_TEST_NUMBERS` (comma-separated E.164); none set sends nothing.
- `testing: true` also allows the numbers `madeUp` matches (a test run's made-up numbers).

A stopped send calls `onUnlisted({ event, type, address })`, else it is logged. A held send is
checked again when it comes due. Replies to people who wrote first are never checked.

## App event types

A catalog type with `kind: "event"` sends nothing itself: it is handled in your `onEvent(event, events)`,
in order with the rest. Its `validate(event)` returns `{ field, error }` for a 400, or null.

## What stays in your app

The catalog (each type's level, `message`, `topic`, `liveOnly`), the templates and wording, and your
rules: `rules.notification` (return `"handled"` when you sent or dropped it yourself),
`rules.copy`, `onEvent` and `onTick`.

The engine keeps its state in memory (`createEventState()`); pass your own `state` to keep or share it.

## Mount it

```ts
import { createAgent, eventTestList, flowEvents, whatsapp, type BusinessEvent, type EventCatalog } from "@flow-engineer/flow";

const order = (e: BusinessEvent) => e.data.order ?? {};

const catalog: EventCatalog = {
  "order.shipped": {
    level: "critical",
    topic: (e) => e.subject,
    message: (e) => {
      const o = order(e);
      if (!o.trackingUrl) return { missing: "data.order.trackingUrl" };
      return {
        template: { name: "order_shipped", body: [o.number, o.carrier] },
        text: `Order ${o.number} shipped with ${o.carrier}.`,
        values: [o.number, o.carrier],
        link: { label: "Track it", url: o.trackingUrl },
      };
    },
  },
  "order.delayed": {
    level: "standard",
    liveOnly: true,
    topic: (e) => e.subject,
    message: (e) => {
      const o = order(e);
      if (!o.newDate) return { missing: "data.order.newDate" };
      return {
        template: { name: "order_delayed", body: [o.number, o.newDate] },
        text: `Order ${o.number} is running late; it should arrive ${o.newDate}.`,
        values: [o.number, o.newDate],
        link: { label: "See order", url: `https://shop.example/o/${o.number}` },
      };
    },
  },
  restock: {
    level: "optional", // posted with a collapseKey, such as "restock:sku-19"
    topic: (e) => e.subject,
    message: (e) => ({
      template: { name: "back_in_stock", body: [e.data.item] },
      text: `${e.data.item} is back in stock.`,
      values: [e.data.item],
      link: { label: "Shop now", url: e.data.url },
    }),
  },
};

const events = flowEvents({ secret: process.env.FLOW_EVENTS_SECRET, catalog, timezone: "America/New_York", testList: eventTestList() });

const agent = createAgent({
  // ...dir, model, tools, templates
  channels: [whatsapp(provider)],
  // A phrased notification is checked before it goes; { refuse } sends nothing and tells the agent why.
  beforeSend: (message, { address }) => {
    const why = events.phrasing.check(address, message);
    return why ? { refuse: why } : undefined;
  },
  routes: events.routes,
  onTick: events.onTick,
  context: (conversationId) => events.context(conversationId),
});
events.attach(agent);
```

The agent then answers `POST /v1/events` through `agent.fetch(request)`, and held sends go out on
its tick.
