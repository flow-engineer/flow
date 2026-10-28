// covers: flow-messaging/src/index.ts src/channels.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent, fitMessage, sqlite, type AgentOptions, type ChatMessage, type Database, type FlowEvent } from "../../src/index.ts";
import { call, respond, scriptedModel, users } from "./helpers.ts";
import { fakeFlow, sign, SECRET, type Recorded } from "./fake.ts";
import { flowMessaging, IMESSAGE } from "../src/index.ts";

const IM = { id: "conv_im", channel: "imessage", sender: "snd_IM", contact: "ct_im" };
const post = (path: string) => (r: Recorded) => r.method === "POST" && r.path === path;

/** An agent on Flow's iMessage line (its sender from FLOW_MESSAGING_IMESSAGE_SENDER) and Telegram, its webhook served. */
async function imessageAgent(flow: { url: string }, options: { database?: Database; beforeSend?: AgentOptions["beforeSend"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "flow-fm-im-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  const events: FlowEvent[] = [];
  const saved = process.env.FLOW_MESSAGING_IMESSAGE_SENDER;
  process.env.FLOW_MESSAGING_IMESSAGE_SENDER = IM.sender;
  const fm = flowMessaging({ apiKey: "fk_test_key", webhookSecret: SECRET, baseUrl: flow.url });
  const channels = [fm.telegram({ sender: "snd_TG" }), fm.imessage()];
  if (saved === undefined) delete process.env.FLOW_MESSAGING_IMESSAGE_SENDER;
  else process.env.FLOW_MESSAGING_IMESSAGE_SENDER = saved;
  const agent = createAgent({ dir, model: scripted.model, channels, database: options.database, debounceMs: 0, deadlineMs: 50, scheduleCheckMs: 0, events: [(e) => events.push(e)], beforeSend: options.beforeSend });
  if (options.database) await agent.resume();
  const server = createServer(fm.webhook(agent));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const hook = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function deliver(event: object): Promise<number> {
    const body = JSON.stringify(event);
    return (await fetch(hook, { method: "POST", headers: { "content-type": "application/json", "flow-signature": sign(body) }, body })).status;
  }
  return { agent, channels, events, deliver, close: () => server.close(), ...scripted };
}

let n = 0;
function received(id: string, text: string) {
  const now = new Date().toISOString();
  const message = { id, conversation: IM.id, direction: "in", status: "received", content: { kind: "basic", text }, livemode: false, created_at: now };
  return { id: `evt_im${++n}`, type: "message.received", created_at: now, app: "app_test", livemode: false, conversation: IM, timing: { received_at: now, stored_at: now }, data: { message } };
}

test("the iMessage channel is Markdown up to 9999 characters (sent as iMessage's styles), with photos, quotes, tapbacks, typing and read receipts, and no buttons or templates", () => {
  const channel = flowMessaging({ apiKey: "fk_test_key" }).imessage({ sender: IM.sender });
  assert.equal(channel.name, "imessage");
  assert.equal(channel.kind, "custom");
  assert.equal(channel.phone, undefined, "a handle may be an email address, so it is not a phone channel");
  assert.deepEqual(channel.info, IMESSAGE);
  assert.equal(IMESSAGE.formatting, "markdown");
  assert.equal(IMESSAGE.maxLength, 9999);
  assert.equal(IMESSAGE.buttons, undefined);
  assert.equal(IMESSAGE.lists, undefined);
  assert.equal(IMESSAGE.linkButton, undefined);
  assert.throws(() => channel.send("+15550100100", { type: "template", name: "x" }), /iMessage has no templates/);
});

test("an iMessage message reaches the agent by its sender, and the reply (its Markdown as styled ranges), read receipt and typing go into its Flow conversation", async (t) => {
  const flow = await fakeFlow();
  const live = await imessageAgent(flow);
  t.after(() => (flow.close(), live.close()));
  flow.contacts.ct_im = { id: "ct_im", channel: "imessage", address: { handle: "+15550100100", phone: "+15550100100" } };

  assert.equal(await live.deliver(received("msg_1", "Are you open today?")), 200);
  const first = await live.nextCall(0);
  assert.equal(users(first.request.messages).at(-1), "[imessage · msg_1] Are you open today?");
  assert.equal(live.events[0]?.channel, "imessage");
  first.answer(respond(call("send_imessage", { text: "Yes, until **6pm**.", reply_to: "msg_1" })));

  const sent = await flow.request(post("/v0/conversations/conv_im/basic"));
  assert.deepEqual(sent.body, { text: "Yes, until 6pm.", imessage: { styles: [{ start: 11, length: 3, style: "bold" }] }, reply_to: "msg_1" });
  // iMessage marks the whole conversation read: Flow refuses up_to there.
  assert.deepEqual((await flow.request(post("/v0/conversations/conv_im/read"))).body, {});
  assert.deepEqual((await flow.request(post("/v0/conversations/conv_im/typing"))).body, {});
  assert.equal(flow.sends("/v0/messages").length, 0, "a reply never starts a new conversation");
  await live.agent.conversation(live.events[0]!.conversationId)!.whenIdle();
});

test("buttons your code adds on iMessage (beforeSend) go as numbered options in the text, never dropped; message.out says so", async (t) => {
  const flow = await fakeFlow();
  const live = await imessageAgent(flow, { beforeSend: (message) => (message.type === "message" ? { ...message, buttons: ["Yes", { id: "later", label: "Another time" }] } : undefined) });
  t.after(() => (flow.close(), live.close()));
  flow.contacts.ct_im = { id: "ct_im", channel: "imessage", address: { handle: "+15550100100", phone: "+15550100100" } };
  assert.equal(await live.deliver(received("msg_b", "A table tonight?")), 200);
  (await live.nextCall(0)).answer(respond(call("send_imessage", { text: "For two at **8pm**?" })));
  const sent = await flow.request(post("/v0/conversations/conv_im/basic"));
  assert.deepEqual(sent.body, { text: "For two at 8pm?\n\n1. Yes\n2. Another time", imessage: { styles: [{ start: 11, length: 3, style: "bold" }] } });
  await live.agent.conversation(live.events[0]!.conversationId)!.whenIdle();
  const out = live.events.find((e) => e.type === "message.out")!;
  assert.deepEqual([out.text, out.buttons, out.fixed], ["For two at **8pm**?\n\n1. Yes\n2. Another time", undefined, ["options_as_text"]]);
});

test("on iMessage the agent fixes a wrong bid by edit_message (its Markdown as iMessage's styles); an edit or unsend Flow refuses at the call (too late, the first message, a message that went by SMS) goes back to the model with Flow's reason, and nothing is sent instead", async (t) => {
  const flow = await fakeFlow();
  const live = await imessageAgent(flow);
  t.after(() => (flow.close(), live.close()));
  flow.contacts.ct_im = { id: "ct_im", channel: "imessage", address: { handle: "+15550100100", phone: "+15550100100" } };
  const results = (r: { request: { messages: ChatMessage[] } }) => r.request.messages.flatMap((m) => (m.role === "tool" ? [m.content] : []));

  await live.deliver(received("msg_1", "Top bid on the Polo?"));
  const first = await live.nextCall(0);
  assert.deepEqual(first.request.tools.map((x) => x.name).filter((name) => name === "edit_message" || name === "unsend_message"), ["edit_message", "unsend_message"], "iMessage offers both tools");
  first.answer(respond(call("send_imessage", { text: "Top bid ₹47,133" }), call("send_imessage", { text: "Want to bid?" }), call("send_imessage", { text: "Ends at 6pm." })));
  await live.agent.conversation(live.events[0]!.conversationId)!.whenIdle();
  const sent = flow.sends("/v0/conversations/conv_im/basic").map((r) => r.body.text);
  assert.deepEqual(sent, ["Top bid ₹47,133", "Want to bid?", "Ends at 6pm."]);

  await live.deliver(received("msg_2", "sure?"));
  const second = await live.nextCall(1);
  assert.deepEqual(results(second).slice(-3).map((r) => JSON.parse(r).message_id), ["msg_out1", "msg_out2", "msg_out3"], "each send's result names its Flow message");
  const refuse = (method: string, id: string, error: object) => flow.queued.push({ match: (r) => r.method === method && r.path === `/v0/messages/${id}`, status: 422, body: { error: { type: "unsupported_content", channel: "imessage", hint: "Send a new message instead.", doc_url: "", ...error } } });
  refuse("PATCH", "msg_out2", { channel_code: "edit_window_closed", message: "iMessage allows edits within 15 minutes of sending; this message was sent 22 minutes ago." });
  refuse("DELETE", "msg_out2", { channel_code: "unsend_window_closed", message: "iMessage allows unsends within 2 minutes of sending; this message was sent 6 minutes ago." });
  refuse("PATCH", "msg_out3", { channel_code: "first_message_not_editable", message: "iMessage cannot edit the message that started the conversation." });
  refuse("DELETE", "msg_out3", { channel_code: "not_on_sms", message: "This message went by SMS, which has no unsend." });
  second.answer(
    respond(
      call("edit_message", { message_id: "msg_out1", text: "Top bid **₹39,500**" }),
      call("edit_message", { message_id: "msg_out2", text: "Bid now?" }),
      call("unsend_message", { message_id: "msg_out2" }),
      call("edit_message", { message_id: "msg_out3", text: "Ends at 7pm." }),
      call("unsend_message", { message_id: "msg_out3" }),
    ),
  );
  const third = await live.nextCall(2);
  assert.deepEqual(results(third).slice(-5), [
    JSON.stringify({ edited: true, channel: "imessage", message_id: "msg_out1" }),
    "Not edited: unsupported_content (edit_window_closed, on imessage): iMessage allows edits within 15 minutes of sending; this message was sent 22 minutes ago.",
    "Not unsent: unsupported_content (unsend_window_closed, on imessage): iMessage allows unsends within 2 minutes of sending; this message was sent 6 minutes ago.",
    "Not edited: unsupported_content (first_message_not_editable, on imessage): iMessage cannot edit the message that started the conversation.",
    "Not unsent: unsupported_content (not_on_sms, on imessage): This message went by SMS, which has no unsend.",
  ]);
  assert.deepEqual((await flow.request((r) => r.method === "PATCH" && r.path === "/v0/messages/msg_out1")).body, { text: "Top bid ₹39,500", imessage: { styles: [{ start: 8, length: 7, style: "bold" }] } });
  third.answer(respond(call("send_imessage", { text: "Correction: the Polo ends at 7pm." })));
  await live.agent.conversation(live.events[0]!.conversationId)!.whenIdle();
  assert.deepEqual(flow.sends("/v0/conversations/conv_im/basic").map((r) => r.body.text), [...sent, "Correction: the Polo ends at 7pm."], "a refusal sends nothing in its place: the agent writes its own correction");
  assert.deepEqual(
    live.events.filter((e) => e.type === "message.edited" || e.type === "message.unsent").map((e) => [e.type, e.messageId]),
    [["message.edited", "msg_out1"]],
    "only the edit Flow took is an event",
  );
});

test("after a restart, a nudge to someone on iMessage starts from the line's sender (FLOW_MESSAGING_IMESSAGE_SENDER), to their email handle", async (t) => {
  const flow = await fakeFlow();
  const database = join(mkdtempSync(join(tmpdir(), "flow-fm-im-db-")), "agent.db");
  flow.contacts.ct_im = { id: "ct_im", channel: "imessage", address: { handle: "maya@example.com" } };
  const before = await imessageAgent(flow, { database: sqlite(database) });
  await before.deliver(received("msg_1", "hi"));
  (await before.nextCall(0)).answer(respond(call("send_imessage", { text: "Hi!" })));
  await flow.request(post("/v0/conversations/conv_im/basic"));
  await before.agent.conversation(before.events[0]!.conversationId)!.whenIdle();
  before.close();

  const after = await imessageAgent(flow, { database: sqlite(database) });
  t.after(() => (flow.close(), after.close()));
  assert.equal((await after.agent.nudge({ to: { channel: "imessage", address: "maya@example.com" }, text: "Your table is ready" })).status, "sent");
  assert.deepEqual((await flow.request(post("/v0/messages"))).body, { sender: "snd_IM", to: { handle: "maya@example.com" }, kind: "basic", text: "Your table is ready" });
});

test("a start to a phone number on iMessage names the phone; a link goes as its URL on its own line, since iMessage has no link buttons", async (t) => {
  const flow = await fakeFlow();
  t.after(() => flow.close());
  const channel = flowMessaging({ apiKey: "fk_test_key", baseUrl: flow.url }).imessage({ sender: IM.sender });
  const link = { label: "Book", url: "https://example.com/book" };
  // The agent fits every message to its channel (fitMessage) before the channel sends it.
  await channel.send("15550100100", { type: "message", ...fitMessage(channel.info, { text: "Book here", link }) });
  assert.deepEqual((await flow.request(post("/v0/messages"))).body, { sender: "snd_IM", to: { phone: "+15550100100" }, kind: "basic", text: "Book here\nhttps://example.com/book" });
  // Sent by hand with a link anyway, the link is left out rather than sent as a button Flow would refuse.
  await channel.send("+15550100100", { type: "message", text: "Or here", link });
  assert.deepEqual((await flow.request((r) => post("/v0/messages")(r) && r.body.text === "Or here")).body, { sender: "snd_IM", to: { phone: "+15550100100" }, kind: "basic", text: "Or here" });
});

test("a read receipt refused outside the window is not logged; typing's refusals reject for the conversation (outside_window, else Flow's type); typing off sends nothing", async (t) => {
  const flow = await fakeFlow();
  t.after(() => flow.close());
  flow.messages.msg_1 = { id: "msg_1", conversation: IM.id, direction: "in", content: { kind: "basic", text: "hi" } };
  const channel = flowMessaging({ apiKey: "fk_test_key", baseUrl: flow.url }).imessage({ sender: IM.sender });
  const warn = t.mock.method(console, "warn", () => {});
  const outside = { error: { type: "outside_window", message: "Outside the conversation window.", hint: "", doc_url: "" } };
  flow.queued.push({ match: post("/v0/conversations/conv_im/read"), status: 409, body: outside });
  flow.queued.push({ match: post("/v0/conversations/conv_im/typing"), status: 409, body: outside });
  await channel.send("+15550100100", { type: "read", messageIds: ["msg_1"] });
  await assert.rejects(async () => channel.send("+15550100100", { type: "typing", on: true }), { message: "outside_window" });
  assert.equal(flow.sends("/v0/conversations/conv_im/read").length, 1);
  assert.equal(flow.sends("/v0/conversations/conv_im/typing").length, 1);
  assert.equal(warn.mock.callCount(), 0, "the conversation logs typing's refusals, the adapter none");

  // No channel clears the indicator on request: it goes when the next message does.
  await channel.send("+15550100100", { type: "typing", on: false });
  assert.equal(flow.sends("/v0/conversations/conv_im/typing").length, 1);

  flow.queued.push({ match: post("/v0/conversations/conv_im/typing"), status: 400, body: { error: { type: "invalid_request", message: "Bad request.", hint: "", doc_url: "" } } });
  await assert.rejects(async () => channel.send("+15550100100", { type: "typing", on: true }), { message: "invalid_request" });
  flow.queued.push({ match: post("/v0/conversations/conv_im/read"), status: 400, body: { error: { type: "invalid_request", message: "Bad request.", hint: "", doc_url: "" } } });
  await channel.send("+15550100100", { type: "read", messageIds: ["msg_1"] });
  assert.deepEqual(warn.mock.calls.map((c) => c.arguments[0]), ["@flow-engineer/flow/flow-messaging: read on imessage failed (invalid_request)"]);
});

test("an iMessage group conversation is passed over, with one warning: nothing reaches the agent, and no typing or read receipt goes to it", async (t) => {
  const flow = await fakeFlow();
  const live = await imessageAgent(flow);
  t.after(() => (flow.close(), live.close()));
  const warn = t.mock.method(console, "warn", () => {});
  const now = new Date().toISOString();
  const group = { id: "conv_group", type: "group", channel: "imessage", sender: IM.sender, group_name: "Book club" };
  const inGroup = (id: string) => ({ id: `evt_${id}`, type: "message.received", created_at: now, app: "app_test", livemode: false, conversation: group, timing: { received_at: now, stored_at: now }, data: { message: { id, conversation: group.id, direction: "in", status: "received", from: "ct_im", content: { kind: "basic", text: "hi all" }, livemode: false, created_at: now } } });
  assert.equal(await live.deliver(inGroup("msg_g1")), 200);
  assert.equal(await live.deliver(inGroup("msg_g2")), 200);
  assert.equal(live.calls.length, 0);
  assert.equal(live.events.length, 0);
  assert.equal(flow.requests.length, 0, "no contact lookup, typing or read receipt");
  assert.deepEqual(warn.mock.calls.map((c) => c.arguments[0]), ["@flow-engineer/flow/flow-messaging: group conversations are not handled; their events are passed over"]);
});
