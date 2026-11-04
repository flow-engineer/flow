// place_order in tests, played by this code when a scenario has a given: block (it runs on your
// machine, never in the cloud). Written from place_order.yaml's behaviour; the orders it keeps in
// `state` are what a scenario's expect.state checks at the end of the run.
import type { Fake } from "../../../../testing/src/index.ts";

type Item = { item: string; size: string; milk?: string; quantity?: number };
type Menu = { menu: Array<{ item: string; sizes: Record<string, number>; milks: string[] }> };

const placeOrder: Fake<{ name: string; items: Item[] }> = ({ input, world, state }) => {
  // Fails if an item, size or milk is not on the scenario's menu (given: menu: get_menu.yaml).
  const menu = (world.menu as Menu | undefined)?.menu;
  for (const it of input.items) {
    const found = menu?.find((m) => m.item === it.item);
    if (menu && (!found || !(it.size in found.sizes) || (it.milk && !found.milks.includes(it.milk)))) return { error: `Unknown item: ${it.item}` };
  }
  // Order numbers go up by one per order, from BL-1040; ready about ten minutes after it is placed.
  const orders = (state.orders ??= []) as unknown[];
  const order_id = `BL-${1040 + orders.length}`;
  orders.push({ order_id, name: input.name, items: input.items });
  const what = input.items.map((it) => `${it.quantity ?? 1} ${it.size} ${it.item}${it.milk ? ` (${it.milk})` : ""}`).join(", ");
  return { output: { order_id, ready_by: "{{now + 10m}}", pay_at_pickup: true }, changes: [`order ${order_id} for ${input.name}: ${what}`] };
};

export default placeOrder;
