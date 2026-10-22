# Show records: orders, bookings, anything a person picks from

A person asks "my orders" and sees the rows exactly as your backend returned them, laid out for
their channel, and can pick one. You say once how a row reads; the model decides when to show
them and which ones, never how to spell an id, a price or a date. From `src/records.ts`,
`src/channels.ts` (`recordsMessages`) and `src/conversation.ts`.

## Define how a row reads, return it from a tool

```ts
import { records, tool, z } from "@flow-engineer/flow";

export const orders = records<Order>({
  kind: "orders",                                   // what the rows are: for the model, events and tests
  id: (o) => o.id,                                  // 1 to 64 bytes, unique in one result
  title: (o) => `#${o.number} · ${o.status}`,
  detail: (o) => `${o.itemCount} items · ${money(o.total)}`,  // optional
  image: (o) => o.photoUrl,                         // optional: cards where every row has one
  pick: "View order",                               // optional: without it the rows are read-only
});

export const myOrders = tool({
  name: "my_orders",
  description: "This person's orders, newest first.",
  input: z.object({}),
  records: orders,                                  // so `flow test` turns a simulated list into these records
  run: async (_in, ctx) => orders.of(await api.orders(ctx.person), { total: 37 }),
});
```

The model reads the rows as the tool returned them, plus a handle line: `records r1: 10 orders,
ids ... To show them, send with show: { records: "r1" }`. Its send tool then offers
`show: { records: "r1", ids? }` (`ids` picks some, in order); an id the tool did not return is
refused back to the model. `show` goes alone, without buttons, a list, a link, an image or a
carousel. Over MCP and the CLI the result is just the rows.

## What the person sees

| Channel | Rows | A page |
|---|---|---|
| WhatsApp (native) | A list: titles (24) and details (72) as rows, the `pick` label on its button | 10 rows, or 9 and "More" |
| WhatsApp on Flow Messaging | A list of titles (20); details numbered in the text | 10, or 9 and "More" |
| Telegram | Numbered lines, a button per row | 10, or 9 and "More" |
| iMessage | Numbered text, "Reply with a number to pick one", "Reply MORE for the next 10" | 10 |
| SMS | Numbered text, at most 3 segments | 5 |
| Rows with photos, on a channel with carousels | Cards, the `pick` label as each card's button | up to the channel's cards |
| Read-only rows (no `pick`) | Numbered text everywhere | as above |
| A custom UI with `info.records: { maxRows }` and `sendRecords(to, page)` | Your UI draws the rows (`RecordsPage`: rows with numbers, page, pages, total) | `maxRows` |

Titles and details are trimmed to fit, then left out; ids never are. Every message goes through
`beforeSend` and the platform's content rules like any other send.

## Picks, numbers and More

- A tap on a row (list row, button, card) comes back as the person's message with
  `choice: { id, title, records: "r1", kind: "orders" }`, and the model gets the row's data with it.
- A message that is only a row's number ("2", "#2", "2.") while the records are the agent's latest
  message on that channel is the same pick. Anything else is passed on as they wrote it.
- "More" (its row or button, or MORE typed) sends the next page with no model call; the model is
  told which page went next turn.
- Handles are kept per conversation: the newest 20, for 7 days, erased with the person. A pick on
  a handle no longer kept still carries its id, and the model is told to look it up.

## HTTP agents (Python, Go, any framework)

Answer a message with a `records` reply ([`spec/response.schema.json`](../spec/response.schema.json)):

```json
{ "type": "records", "text": "Your orders", "kind": "orders",
  "rows": [{ "id": "BL-1041", "title": "BL-1041 · being made", "detail": "1 large Latte" }],
  "pick": { "label": "View order" }, "page": { "number": 1 } }
```

It is rendered for the run's platform as above. A tap comes back as `message.choice.id`; a typed
number or MORE comes back as text, and the More row's tap as `choice.id` `chinwag:more`: answer it
with `page: { number: 2 }`. The Python and Go examples
([`examples/http-agent-python`](../examples/http-agent-python), [`examples/http-agent-go`](../examples/http-agent-go))
show the menu this way.

## Tests

```yaml
opening:
  - say: "my orders?"
  - pick: BL-1041              # a row id or title: tapped where the channel has a list or buttons, else its number typed
expect:
  sent:
    - { records: orders, ids: [BL-1041, BL-1040], count: 2, page: 1, text: "being made" }
```

`records` is the kind (or `true` for any); `ids` the rows on that message's page, exactly, in
order; `count` the rows in all; `page` from 1; `text` the intro or any row's title or detail.
Records items are matched in order among records sends. `flow show` and `flow chat` mark a records
send as `[orders r1, page 1/4 of 37]` and a pick as `[picked BL-1041 from r1]`. A test cloud that
does not check records yet refuses the suite before it plays. The café ([`examples/cafe`](../examples/cafe))
has `my_orders` and `tests/scenarios/my-orders.yaml`.

## Events and traces

`message.out` carries `records: { kind, handle, count, shown, page, pages, deliveredAs, rows }`
(`rows` are the page's, with their numbers). The send's trace span has `chinwag.records.kind`,
`.count`, `.page`, `.pages`, `.delivered_as` and `.shown` (the page's ids); the rows' titles and
details (`chinwag.records.rows`) only with content tracing on. A pick puts `chinwag.records.picked`
(the row's id) on its turn's root span.

## Limits

100 rows per result (the model is told how many there were), 20 handles per conversation for 7
days, 64 KB of a handle's rows as the tool returned them (larger: only id, title and detail).
