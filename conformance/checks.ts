// The delivery guarantees (docs/guarantees.md) as checks any channel adapter is run through. A rig
// puts the adapter in front of a platform the checks drive: each message the platform gets waits
// until the check accepts or refuses it, so "send resolves only once the platform has it" is tested,
// not assumed. `npm run test:conformance` runs every rig; it is not part of `npm test`.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { carouselMessages, createAgent, type Carousel, type Channel, type Outbound } from "../src/index.ts";
import { respond, scriptedModel } from "../test/helpers.ts";

/** One message as the platform got it, held until the check settles it. */
export interface Arrival {
  text: string;
  idempotencyKey?: string;
  /** The platform takes it (Flow Messaging: message.sent). */
  accept(): Promise<void> | void;
  /** The platform refuses it, with this reason. */
  refuse(reason: string): Promise<void> | void;
}

export interface Rig {
  channel: Channel;
  /** The person's address on the channel. */
  to: string;
  /** The n-th message (from 0) the platform got, now or once it gets it. */
  arrival(n: number): Promise<Arrival>;
  /** How many messages the platform has got. */
  count(): number;
  close(): Promise<void> | void;
}

/** Lets everything run that does not wait on the platform. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function tracked<T>(promise: Promise<T>) {
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}

const CAROUSEL: Carousel = {
  text: "Two rooms",
  cards: [
    { image: { url: "https://example.com/a.jpg" }, text: "Sea view" },
    { image: { url: "https://example.com/b.jpg" }, text: "Garden" },
  ],
};

/** Runs every guarantee against the adapter a fresh rig from `make` puts in front of its platform. */
export function conformance(name: string, make: () => Promise<Rig>): void {
  const withRig = (title: string, check: (rig: Rig) => Promise<void>) =>
    test(`${name}: ${title}`, async () => {
      const rig = await make();
      try {
        await check(rig);
      } finally {
        await rig.close();
      }
    });

  withRig("send() resolves only once the platform accepted the message", async (rig) => {
    const sending = Promise.resolve(rig.channel.send(rig.to, { type: "message", text: "Hello" }));
    const state = tracked(sending);
    const arrival = await rig.arrival(0);
    assert.equal(arrival.text, "Hello");
    await settle();
    assert.equal(state.settled, false, "resolved before the platform had it");
    await arrival.accept();
    const receipt = await sending;
    if (receipt) assert.ok(["sent", "delivered"].includes(receipt.status), `receipt ${receipt.status}`);
  });

  withRig("send() rejects, with the platform's reason, when the platform refuses the message", async (rig) => {
    const sending = Promise.resolve(rig.channel.send(rig.to, { type: "message", text: "Hello" }));
    await (await rig.arrival(0)).refuse("conformance refusal");
    await assert.rejects(sending, /conformance refusal/);
  });

  withRig("a message the business started carries its idempotency key to the platform", async (rig) => {
    const sending = Promise.resolve(rig.channel.send(rig.to, { type: "message", text: "Your table is ready", idempotencyKey: "nudge:conformance-1" }));
    const arrival = await rig.arrival(0);
    assert.equal(arrival.idempotencyKey, "nudge:conformance-1");
    await arrival.accept();
    await sending;
  });

  withRig("a carousel resolves only once the platform accepted all of it", async (rig) => {
    const parts = rig.channel.info.carousels ? 1 : carouselMessages(rig.channel.info, CAROUSEL).length;
    const sending = Promise.resolve(rig.channel.send(rig.to, { type: "carousel", ...CAROUSEL } satisfies Outbound));
    const state = tracked(sending);
    for (let i = 0; i < parts; i++) {
      const arrival = await rig.arrival(i);
      await settle();
      assert.equal(state.settled, false, `resolved with ${parts - i} part(s) not yet accepted`);
      assert.equal(rig.count(), i + 1, "a part went before the last one was accepted");
      await arrival.accept();
    }
    await sending;
  });

  withRig("an agent's messages reach the platform one at a time, in the order it wrote them", async (rig) => {
    const dir = mkdtempSync(join(tmpdir(), "flow-conformance-"));
    writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
    const scripted = scriptedModel();
    const agent = createAgent({ dir, model: scripted.model, channels: [rig.channel], debounceMs: 0, deadlineMs: 50, scheduleCheckMs: 0 });
    const arrived = await agent.message({ channel: rig.channel.name, from: rig.to, message: "hi" });
    const first = await scripted.nextCall(0);
    const send = first.request.tools.find((t) => t.name.startsWith("send_"))!.name;
    const say = (text: string, id: string) => ({ id, name: send, arguments: JSON.stringify({ text }) });
    first.answer(respond(say("One", "c1"), say("Two", "c2"), say("Three", "c3")));
    for (const [i, text] of ["One", "Two", "Three"].entries()) {
      const arrival = await rig.arrival(i);
      assert.equal(arrival.text, text);
      await settle();
      assert.equal(rig.count(), i + 1, `the message after "${text}" went before the platform accepted "${text}"`);
      await arrival.accept();
    }
    await agent.conversation(arrived!.conversationId)!.whenIdle();
  });
}
