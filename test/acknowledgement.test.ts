// covers: src/conversation.ts src/events.ts
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { format } from "node:util";
import { z } from "zod";
import { tool, type Outbound } from "../src/index.ts";
import { call, gate, harness, last, respond, say, WEB } from "./helpers.ts";

test("typing shows the moment a message arrives, before the reply starts", () => {
  const h = harness();
  h.send("c0", "hi");
  assert.deepEqual(h.out, [{ type: "typing", on: true }]);
  assert.equal(h.calls.length, 0);
});

test("a first response that only calls tools is held until the agent acknowledges", async () => {
  let ran = 0;
  const lookup = tool({ name: "lookup", description: "", input: z.object({}), run: () => (ran++, { next: "Thursday 10am" }) });
  const h = harness([lookup]);
  h.send("c2", "when is my session?");

  (await h.nextCall(0)).answer(respond(call("lookup")));
  const second = await h.nextCall(1);
  assert.equal(ran, 0, "held calls do not run");
  assert.match(last(second.request.messages).content, /have not heard from you/);
  second.answer(respond(say("Checking…"), call("lookup")));

  const third = await h.nextCall(2);
  assert.equal(ran, 1);
  assert.match(last(third.request.messages).content, /Thursday/);
  third.answer(respond(say("Thursday at 10.")));
  await h.agent.conversation("c2")!.whenIdle();
  assert.deepEqual(h.sent(), ["Checking…", "Thursday at 10."]);
  assert.ok(h.events.some((e) => e.type === "ack.required"));
});

/**
 * A person on a channel whose typing indicator lasts 1 s (sent again every 800 ms), with timers
 * faked: every typing call is recorded, then `typing(on)` decides what it does (throw to refuse it). Tools wait 60 s
 * before they move to the background, so only typing's timers are due while the tests tick.
 */
function typingHarness(t: TestContext, typing: (on: boolean) => void = () => {}, tools: ReturnType<typeof tool>[] = [], followUps: "auto" | "manual" = "auto") {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(tools, 60_000, WEB, followUps);
  const deliver = (o: Outbound) => {
    h.out.push(o);
    if (o.type === "typing") typing(o.on);
  };
  const send = (conversation: string, text: string) => h.agent.receive(conversation, text, deliver, { channel: { ...WEB, typingLastsMs: 1000 } });
  /** Typing calls so far (`true` on, `false` off). */
  const typed = () => h.out.flatMap((o) => (o.type === "typing" ? [o.on] : []));
  /** Moves the fake clock on, then lets what it started settle (a typing call's result arms the next one). */
  const tick = async (ms: number) => {
    t.mock.timers.tick(ms);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { ...h, send, typed, tick };
}

test("typing is sent again just before the channel's indicator lapses, until the turn ends; no timer is left after it", async (t) => {
  const h = typingHarness(t);
  h.send("t1", "plan my week");
  await h.tick(0);
  const first = await h.nextCall(0);
  await h.tick(799);
  assert.deepEqual(h.typed(), [true]);
  await h.tick(1);
  assert.deepEqual(h.typed(), [true, true]);
  await h.tick(800);
  assert.deepEqual(h.typed(), [true, true, true]);
  first.answer(respond(say("Here is your week.")));
  await h.agent.conversation("t1")!.whenIdle();
  assert.deepEqual(h.typed(), [true, true, true, false]);
  await h.tick(60_000);
  assert.deepEqual(h.typed(), [true, true, true, false], "nothing more once the turn is over");
});

test("a message hides typing; while the tools it went with run, typing shows again at once and is kept up", async (t) => {
  const done = gate<string>();
  const lookup = tool({ name: "lookup", description: "", input: z.object({}), run: () => done.promise });
  const h = typingHarness(t, () => {}, [lookup]);
  h.send("t2", "check please");
  await h.tick(0);
  (await h.nextCall(0)).answer(respond(call("react", { message_id: "m1", emoji: "👌" }), call("lookup")));
  await h.tick(0);
  const afterReaction = () => h.out.slice(h.out.findIndex((o) => o.type === "reaction") + 1).flatMap((o) => (o.type === "typing" ? [o.on] : []));
  assert.deepEqual(afterReaction(), [false, true]);
  await h.tick(800);
  assert.deepEqual(afterReaction(), [false, true, true]);
  done.open("ok");
  (await h.nextCall(1)).answer(respond(say("All good.")));
  await h.agent.conversation("t2")!.whenIdle();
  assert.deepEqual(afterReaction(), [false, true, true, false]);
});

test("after a reply with no tools, typing stays hidden through a slow last model step", async (t) => {
  const h = typingHarness(t, () => {}, [], "manual");
  h.send("t6", "what time do you open?");
  await h.tick(0);
  (await h.nextCall(0)).answer(respond(say("We open at 9.")));
  // The step Flow Framework adds after a reply that used no tool: slower than the 800 ms interval.
  const last = await h.nextCall(1);
  await h.tick(5_000);
  assert.deepEqual(h.typed(), [true, false], "hidden by the answer, and not shown again");
  last.answer(respond());
  await h.agent.conversation("t6")!.whenIdle();
  await h.tick(60_000);
  assert.deepEqual(h.typed(), [true, false]);
});

test("typing refused outside the window waits for the agent's next message, then is kept up again; the refusal is logged at debug", async (t) => {
  const debug = t.mock.method(console, "debug", () => {});
  let open = false;
  const done = gate<string>();
  const lookup = tool({ name: "lookup", description: "", input: z.object({}), run: () => done.promise });
  const h = typingHarness(t, (on) => {
    if (on && !open) throw new Error("outside_window");
  }, [lookup]);
  h.send("t3", "where is my order?");
  await h.tick(0);
  const first = await h.nextCall(0);
  await h.tick(5_000);
  assert.deepEqual(h.typed(), [true], "tried once, not again while refused");
  assert.equal(debug.mock.callCount(), 1);
  const line = format(...debug.mock.calls[0].arguments);
  assert.equal(line, "flow: typing on chat in conversation t3: outside_window; tried again after the agent's next message", "the channel and conversation, never the message's text");

  open = true; // the agent's message opens it (iMessage)
  first.answer(respond(say("Looking it up."), call("lookup")));
  await h.tick(0);
  assert.deepEqual(h.typed(), [true, true], "shown again once the message went, while the tool runs");
  await h.tick(800);
  assert.deepEqual(h.typed(), [true, true, true]);
  done.open("shipped");
  (await h.nextCall(1)).answer(respond(say("It has shipped.")));
  await h.agent.conversation("t3")!.whenIdle();
  await h.tick(60_000);
  assert.deepEqual(h.typed(), [true, true, true, false]);
});

test("any other typing failure ends typing for the turn, with a warning; the next turn types again", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  let broken = true;
  const h = typingHarness(t, (on) => {
    if (on && broken) throw new Error("invalid_request");
  });
  h.send("t4", "hi");
  await h.tick(0);
  const first = await h.nextCall(0);
  await h.tick(5_000);
  first.answer(respond(say("Hello!")));
  await h.agent.conversation("t4")!.whenIdle();
  await h.tick(5_000);
  assert.deepEqual(h.typed(), [true]);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(format(...warn.mock.calls[0].arguments), /^flow: typing on chat in conversation t4 failed, so no more typing this turn: invalid_request$/);

  broken = false;
  h.send("t4", "thanks");
  assert.deepEqual(h.typed(), [true, true]);
  await h.tick(0);
  (await h.nextCall(1)).answer(respond(say("Any time.")));
  await h.agent.conversation("t4")!.whenIdle();
});

test("typing stops when the turn fails", async (t) => {
  const h = typingHarness(t);
  h.send("t5", "hi");
  await h.tick(0);
  (await h.nextCall(0)).fail(new Error("model down"));
  await h.agent.conversation("t5")!.whenIdle();
  await h.tick(60_000);
  assert.deepEqual(h.typed(), [true, false]);
  assert.ok(h.sent().length === 1, "they are told something went wrong");
});

test("plain text from the model is never shown, and the agent is reminded to reply", async () => {
  const h = harness();
  h.send("c10", "hey");
  (await h.nextCall(0)).answer({ text: "Hello!", toolCalls: [] });
  const second = await h.nextCall(1);
  assert.match(last(second.request.messages).content, /^\[Chinwag\] INTERNAL MESSAGE, not from them: your text above never reached them\. Reply with send_chat, without mentioning this note, that text or any delay\./);
  second.answer(respond(say("Hey! How can I help?")));
  await h.agent.conversation("c10")!.whenIdle();
  assert.deepEqual(h.sent(), ["Hey! How can I help?"]);
});
