// covers: src/conversation.ts src/channels.ts src/types.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { contentRefusal, SMS } from "../src/channels.ts";
import { createAgent, type FlowEvent, type Outbound, type SendReceipt } from "../src/index.ts";
import { call, gate, respond, say, scriptedModel, WEB } from "./helpers.ts";

/** An agent whose one channel answers each send with the promise `deliver` gives it. */
function agentWith(deliver: (o: Outbound) => Promise<void | SendReceipt> | void) {
  const dir = mkdtempSync(join(tmpdir(), "flow-delivery-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  const events: FlowEvent[] = [];
  const agent = createAgent({ dir, model: scripted.model, deadlineMs: 50, debounceMs: 0, events: [(e) => events.push(e)] });
  return { agent, events, ...scripted, send: (conversation: string, text: string) => agent.receive(conversation, text, deliver, { channel: WEB }) };
}

test("the agent's next message goes to the channel only once the last one's send resolved, and its result says delivered only then", async () => {
  const handed: Array<{ text: string; accept: () => void }> = [];
  const next = [gate(), gate()];
  const h = agentWith((o) => {
    if (o.type !== "message") return;
    const accepted = gate();
    handed.push({ text: o.text, accept: accepted.open });
    next[handed.length - 1]!.open();
    return accepted.promise;
  });
  h.send("d1", "hi");
  (await h.nextCall(0)).answer(respond(say("One"), call("send_chat", { text: "Two", next: "act" })));
  await next[0]!.promise;
  // Let everything that does not wait on the channel run: the second message must still wait.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(handed.map((m) => m.text), ["One"]);
  assert.equal(h.events.filter((e) => e.type === "message.out").length, 0, "not recorded as out before the channel took it");
  handed[0]!.accept();
  await next[1]!.promise;
  assert.deepEqual(handed.map((m) => m.text), ["One", "Two"]);
  handed[1]!.accept();
  await h.agent.conversation("d1")!.whenIdle();
  assert.deepEqual(h.events.filter((e) => e.type === "message.out").map((e) => e.text), ["One", "Two"]);
  assert.equal(h.followUps.length, 1, "both results said delivered");
});

test("a send whose channel gave up waiting for its signal is a message.slow, kept as sent and never sent again", async () => {
  const handed: string[] = [];
  const h = agentWith((o) => {
    if (o.type !== "message") return;
    handed.push(o.text);
    return Promise.resolve({ status: "unconfirmed", waitedMs: 30_000 });
  });
  h.send("d2", "hi");
  (await h.nextCall(0)).answer(respond(say("On its way")));
  await h.agent.conversation("d2")!.whenIdle();
  assert.deepEqual(handed, ["On its way"]);
  const slow = h.events.find((e) => e.type === "message.slow");
  assert.deepEqual(slow && { channel: slow.channel, origin: slow.origin, text: slow.text, waitedMs: slow.waitedMs }, { channel: "chat", origin: "agent", text: "On its way", waitedMs: 30_000 });
  assert.equal(h.events.filter((e) => e.type === "message.out").length, 1);
});

test("a channel that says it has no typing indicator is never sent one", async () => {
  const out: Outbound[] = [];
  const dir = mkdtempSync(join(tmpdir(), "flow-delivery-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  const agent = createAgent({ dir, model: scripted.model, deadlineMs: 50, debounceMs: 0 });
  agent.receive("d3", "hi", (o) => void out.push(o), { channel: { ...WEB, typing: false } });
  (await scripted.nextCall(0)).answer(respond(say("Hello")));
  await agent.conversation("d3")!.whenIdle();
  assert.ok(out.some((o) => o.type === "message"));
  assert.equal(out.filter((o) => o.type === "typing").length, 0);
});

test("a template on a channel with no templates is refused before it goes", () => {
  assert.deepEqual(contentRefusal(SMS, { type: "template", name: "order_update" }), { type: "invalid_request", param: "content.type", message: "SMS has no templates; send a message instead." });
});
