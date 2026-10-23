// covers: src/conversation.ts src/talk.ts src/types.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent, sqlite, type AgentOptions, type ChannelInfo, type ChatMessage, type Database, type Outbound, type FlowEvent, type SendReceipt } from "../src/index.ts";
import { call, respond, say, scriptedModel } from "./helpers.ts";

/** A channel like iMessage on Flow Messaging: its sends resolve with the platform's id, and it takes edits and unsends. */
const EDITS: ChannelInfo = { reactions: true, status: false, formatting: "plain", maxLength: 9999, edits: true, unsends: true };

/** An agent and the phone it talks to: `refuse` makes the platform refuse an outbound, with its reason. */
function phone(options: { info?: ChannelInfo; dir?: string; database?: Database; beforeSend?: AgentOptions["beforeSend"]; refuse?: (o: Outbound) => string | undefined } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "flow-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  const events: FlowEvent[] = [];
  const agent = createAgent({ dir, model: scripted.model, debounceMs: 0, events: [(e) => events.push(e)], database: options.database ?? sqlite(), beforeSend: options.beforeSend });
  const out: Outbound[] = [];
  let sent = 0;
  const deliver = (o: Outbound): SendReceipt | undefined => {
    const why = options.refuse?.(o);
    if (why) throw new Error(why);
    out.push(o);
    return o.type === "message" ? { status: "sent", messageId: `msg_${++sent}` } : undefined;
  };
  const send = (conversation: string, text: string) => agent.receive(conversation, text, deliver, { channel: options.info ?? EDITS });
  const changes = () => out.filter((o) => o.type === "edit" || o.type === "unsend");
  const results = (request: { messages: ChatMessage[] }) => request.messages.flatMap((m) => (m.role === "tool" ? [m.content] : []));
  return { agent, out, send, changes, events, results, dir, ...scripted };
}

test("on a channel with edits the agent fixes what it sent: its send's result names the message, edit_message and unsend_message change it there, and the transcript keeps both", async () => {
  const p = phone();
  p.send("e1", "what's the top bid?");
  const first = await p.nextCall(0);
  assert.deepEqual(first.request.tools.map((t) => t.name).filter((n) => n === "edit_message" || n === "unsend_message"), ["edit_message", "unsend_message"]);
  first.answer(respond(say("Top bid ₹47,133"), say("Want to bid?")));
  await p.agent.conversation("e1")!.whenIdle();

  p.send("e1", "hm?");
  const second = await p.nextCall(1);
  assert.deepEqual(p.results(second.request).slice(-2), [JSON.stringify({ delivered: true, channel: "chat", message_id: "msg_1" }), JSON.stringify({ delivered: true, channel: "chat", message_id: "msg_2" })]);
  second.answer(respond(call("edit_message", { message_id: "msg_1", text: "Top bid ₹39,500" }), call("unsend_message", { message_id: "msg_2" }), say("Fixed the bid above.")));
  await p.agent.conversation("e1")!.whenIdle();

  assert.deepEqual(p.changes(), [{ type: "edit", messageId: "msg_1", text: "Top bid ₹39,500" }, { type: "unsend", messageId: "msg_2" }]);
  assert.deepEqual(
    p.events.filter((e) => e.type === "message.edited" || e.type === "message.unsent").map(({ type, messageId, text }) => ({ type, messageId, ...(text ? { text } : {}) })),
    [{ type: "message.edited", messageId: "msg_1", text: "Top bid ₹39,500" }, { type: "message.unsent", messageId: "msg_2" }],
  );
  assert.equal(p.events.find((e) => e.type === "message.out")?.messageId, "msg_1", "message.out carries the platform's id");
  const transcript = (await p.agent.transcript("e1")).filter((e) => e.kind !== "in").map(({ at: _at, ...e }) => e);
  assert.deepEqual(transcript, [
    { kind: "out", channel: "chat", text: "Top bid ₹47,133", messageId: "msg_1" },
    { kind: "out", channel: "chat", text: "Want to bid?", messageId: "msg_2" },
    { kind: "edit", channel: "chat", messageId: "msg_1", text: "Top bid ₹39,500" },
    { kind: "unsend", channel: "chat", messageId: "msg_2" },
    { kind: "out", channel: "chat", text: "Fixed the bid above.", messageId: "msg_3" },
  ]);
});

test("a channel without edits is offered neither tool, and its sends' results name no message", async () => {
  const p = phone({ info: { reactions: true, status: false } });
  p.send("e2", "hi");
  const first = await p.nextCall(0);
  assert.ok(!first.request.tools.some((t) => t.name === "edit_message" || t.name === "unsend_message"));
  first.answer(respond(say("Hello")));
  await p.agent.conversation("e2")!.whenIdle();
  p.send("e2", "and?");
  assert.deepEqual(p.results((await p.nextCall(1)).request), [JSON.stringify({ delivered: true, channel: "chat" })]);
});

test("an edit the platform refuses (too late), or of a message that is not the agent's, goes back to it with why, and nothing goes instead", async () => {
  const p = phone({ refuse: (o) => (o.type === "edit" ? "edit_window_closed: The message can no longer be edited." : undefined) });
  p.send("e3", "price?");
  (await p.nextCall(0)).answer(respond(say("₹47,133")));
  await p.agent.conversation("e3")!.whenIdle();
  p.send("e3", "sure?");
  (await p.nextCall(1)).answer(respond(call("edit_message", { message_id: "msg_1", text: "₹39,500" }), call("unsend_message", { message_id: "m1" })));
  const told = await p.nextCall(2);
  assert.deepEqual(p.results(told.request).slice(-2), [
    "Not edited: edit_window_closed: The message can no longer be edited.",
    "Not unsent: there is no message m1 of yours. Name one by the message_id its send's result gave.",
  ]);
  told.answer(respond(say("Sorry, it's ₹39,500.")));
  await p.agent.conversation("e3")!.whenIdle();
  assert.deepEqual(p.changes(), []);
  assert.deepEqual(p.out.filter((o) => o.type === "message").map((o) => (o as { text: string }).text), ["₹47,133", "Sorry, it's ₹39,500."], "only the agent's own correction goes");
});

test("an edit's new text passes beforeSend, which is told it is an edit: its rewrite is what goes, its refusal sends nothing", async () => {
  const seen: Array<{ text: string; edit?: string }> = [];
  const p = phone({
    beforeSend: (message, context) => {
      if (message.type !== "message") return;
      seen.push({ text: message.text, ...(context.edit ? { edit: context.edit.messageId } : {}) });
      if (message.text.includes("guaranteed")) return { refuse: "no guarantees" };
      if (context.edit) return { ...message, text: `${message.text} (corrected)` };
    },
  });
  p.send("e4", "price?");
  (await p.nextCall(0)).answer(respond(say("₹47,133")));
  await p.agent.conversation("e4")!.whenIdle();
  p.send("e4", "sure?");
  (await p.nextCall(1)).answer(respond(call("edit_message", { message_id: "msg_1", text: "₹39,500 guaranteed" })));
  const refused = await p.nextCall(2);
  assert.equal(p.results(refused.request).at(-1), "Not edited: no guarantees");
  refused.answer(respond(call("edit_message", { message_id: "msg_1", text: "₹39,500" }), say("Fixed.")));
  await p.agent.conversation("e4")!.whenIdle();
  assert.deepEqual(seen, [{ text: "₹47,133" }, { text: "₹39,500 guaranteed", edit: "msg_1" }, { text: "₹39,500", edit: "msg_1" }, { text: "Fixed." }]);
  assert.deepEqual(p.changes(), [{ type: "edit", messageId: "msg_1", text: "₹39,500 (corrected)" }]);
  assert.deepEqual((await p.agent.transcript("e4")).filter((e) => e.kind === "edit").map((e) => (e as { text: string }).text), ["₹39,500 (corrected)"]);
});

test("after a restart the agent still edits what it sent before: the ids are read back from its history", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "flow-")), "agent.db");
  const before = phone({ database: sqlite(path) });
  await before.agent.resume();
  before.send("e5", "price?");
  (await before.nextCall(0)).answer(respond(say("₹47,133")));
  await before.agent.conversation("e5")!.whenIdle();

  const after = phone({ database: sqlite(path), dir: before.dir });
  await after.agent.resume();
  after.send("e5", "sure?");
  (await after.nextCall(0)).answer(respond(call("edit_message", { message_id: "msg_1", text: "₹39,500" }), say("Fixed.")));
  await after.agent.conversation("e5")!.whenIdle();
  assert.deepEqual(after.changes(), [{ type: "edit", messageId: "msg_1", text: "₹39,500" }]);
});
