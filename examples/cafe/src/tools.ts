// The agent's tools, over a tiny in-memory café. Placing an order is slow on purpose (a real point-of-sale
// takes seconds), so it shows a tool moving to the background.

import { records, tool, z } from "../../../src/index.ts";

const MENU = [
  { item: "Latte", sizes: { small: 4.0, large: 4.8 }, milks: ["whole", "oat", "almond"], allergens: ["dairy (unless plant milk)"] },
  { item: "Flat white", sizes: { small: 4.2 }, milks: ["whole", "oat"], allergens: ["dairy (unless oat)"] },
  { item: "Cold brew", sizes: { small: 4.5, large: 5.2 }, milks: [], allergens: [] },
  { item: "Chai", sizes: { small: 4.0, large: 4.6 }, milks: ["whole", "oat"], allergens: ["dairy (unless oat)"] },
  { item: "Almond croissant", sizes: { one: 4.25 }, milks: [], allergens: ["gluten", "nuts", "dairy", "egg"] },
  { item: "Banana bread", sizes: { slice: 3.75 }, milks: [], allergens: ["gluten", "egg", "walnuts"] },
];

let nextOrder = 1040;
type Item = { item: string; size: string; milk?: string; quantity: number };
type Order = { id: string; person: string; items: Item[]; readyBy: string };
const orders = new Map<string, Order>();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const statusOf = (order: Pick<Order, "readyBy">) => (Date.now() > Date.parse(order.readyBy) ? "ready" : "being made");

/** How one order reads wherever the agent shows it: the framework lays the rows out per channel. */
const myOrders = records<{ order_id: string; status: string; items: string; ready_by: string }>({
  kind: "orders",
  id: (o) => o.order_id,
  title: (o) => `${o.order_id} · ${o.status}`,
  detail: (o) => `${o.items} · ready by ${new Date(o.ready_by).toISOString().slice(11, 16)} UTC`,
  pick: "View order",
});

export const tools = [
  tool({
    name: "get_menu",
    title: "Menu",
    description: "The full menu: items, sizes with prices in USD, milk options and allergens.",
    input: z.object({}),
    output: z.object({
      menu: z.array(z.object({ item: z.string(), sizes: z.record(z.string(), z.number()), milks: z.array(z.string()), allergens: z.array(z.string()) })),
      note: z.string(),
    }),
    signIn: "none",
    hints: { readOnly: true, openWorld: false },
    run: async () => {
      await wait(150);
      return { menu: MENU, note: "This is the whole menu." };
    },
  }),
  tool({
    name: "place_order",
    title: "Place an order",
    description: "Place a confirmed pickup order. Returns the order number and when it will be ready.",
    input: z.object({
      name: z.string().describe("The name for the order"),
      items: z.array(
        z.object({
          item: z.string(),
          size: z.string(),
          milk: z.string().optional(),
          quantity: z.number().int().min(1).max(20).default(1),
        }),
      ),
    }),
    output: z.object({ order_id: z.string(), ready_by: z.string(), pay_at_pickup: z.boolean() }),
    status: { running: "Placing your order…", done: "Order placed" },
    hints: { destructive: false, openWorld: false },
    run: async ({ items }, ctx) => {
      await wait(5_000);
      const id = `BL-${nextOrder++}`;
      const readyBy = new Date(Date.now() + 10 * 60_000).toISOString();
      orders.set(id, { id, person: ctx.person, items, readyBy });
      return { order_id: id, ready_by: readyBy, pay_at_pickup: true };
    },
  }),
  tool({
    name: "order_status",
    description: "Where an order is: received, being made, or ready.",
    input: z.object({ order_id: z.string() }),
    output: z.object({ found: z.boolean(), status: z.enum(["being made", "ready"]).optional(), ready_by: z.string().optional() }),
    hints: { readOnly: true, openWorld: false },
    run: async ({ order_id }) => {
      await wait(200);
      const order = orders.get(order_id);
      if (!order) return { found: false };
      return { found: true, status: statusOf(order), ready_by: order.readyBy };
    },
  }),
  tool({
    name: "my_orders",
    description: "This person's orders today, newest first, to show them (\"my orders\", \"where's my order\").",
    input: z.object({}),
    hints: { readOnly: true, openWorld: false },
    // Under flow test the simulated list of orders comes back as these records too.
    records: myOrders,
    run: async (_input, ctx) => {
      await wait(200);
      const mine = [...orders.values()].filter((o) => o.person === ctx.person).reverse();
      return myOrders.of(mine.map((o) => ({ order_id: o.id, status: statusOf(o), items: o.items.map((i) => `${i.quantity} ${i.size} ${i.item}`).join(", "), ready_by: o.readyBy })));
    },
  }),
];
