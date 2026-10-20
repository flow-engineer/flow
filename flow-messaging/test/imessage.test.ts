// covers: flow-messaging/src/index.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent, fitMessage, sqlite, type Database, type FlowEvent } from "../../src/index.ts";
import { call, respond, scriptedModel, users } from "./helpers.ts";
import { fakeFlow, sign, SECRET, type Recorded } from "./fake.ts";
import { flowMessaging, IMESSAGE } from "../src/index.ts";

const IM = { id: "conv_im", channel: "imessage", sender: "snd_IM", contact: "ct_im" };
const post = (path: string) => (r: Recorded) => r.method === "POST" && r.path === path;

/** An agent on Flow's iMessage line (its sender from FLOW_MESSAGING_IMESSAGE_SENDER) and Telegram, its webhook served. */
async function imessageAgent(flow: { url: string }, options: { database?: Database } = {}) {
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
  const agent = createAgent({ dir, model: scripted.model, channels, database: options.database, debounceMs: 0, deadlineMs: 50, scheduleCheckMs: 0, events: [(e) => events.push(e)] });
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
  const message = { id, conversation: IM.id, direction: "in", status: "received", content: { type: "text", text }, livemode: false, created_at: now };
  return { id: `evt_im${++n}`, type: "message.received", created_at: now, app: "app_test", livemode: false, conversation: IM, timing: { received_at: now, stored_at: now }, data: { message } };
}

test("the iMessage channel is plain text up to 9999 characters, with photos, quotes, tapbacks, typing and read receipts, and no buttons or templates", () => {
  const channel = flowMessaging({ apiKey: "fk_test_key" }).imessage({ sender: IM.sender });
  assert.equal(channel.name, "imessage");
  assert.equal(channel.kind, "custom");
  assert.equal(channel.phone, undefined, "a handle may be an email address, so it is not a phone channel");
  assert.deepEqual(channel.info, IMESSAGE);
  assert.equal(IMESSAGE.formatting, "plain");
  assert.equal(IMESSAGE.maxLength, 9999);
  assert.equal(IMESSAGE.buttons, undefined);
  assert.equal(IMESSAGE.lists, undefined);
  assert.equal(IMESSAGE.linkButton, undefined);
  assert.throws(() => channel.send("+15550100100", { type: "template", name: "x" }), /iMessage has no templates/);
});

test("an iMessage message reaches the agent by its sender, and the reply, read receipt and typing go into its Flow conversation as plain Flow content", async (t) => {
  const flow = await fakeFlow();
  const live = await imessageAgent(flow);
  t.after(() => (flow.close(), live.close()));
  flow.contacts.ct_im = { id: "ct_im", channel: "imessage", address: { handle: "+15550100100", phone: "+15550100100" } };

  assert.equal(await live.deliver(received("msg_1", "Are you open today?")), 200);
  const first = await live.nextCall(0);
  assert.equal(users(first.request.messages).at(-1), "[imessage · msg_1] Are you open today?");
  assert.equal(live.events[0]?.channel, "imessage");
  first.answer(respond(call("send_imessage", { text: "Yes, until **6pm**.", reply_to: "msg_1" })));

  const sent = await flow.request(post("/v1/conversations/conv_im/messages"));
  assert.deepEqual(sent.body, { content: { type: "text", text: "Yes, until **6pm**.", format: "plain" }, reply_to: "msg_1" });
  assert.deepEqual((await flow.request(post("/v1/conversations/conv_im/read"))).body, { up_to: "msg_1" });
  assert.deepEqual((await flow.request(post("/v1/conversations/conv_im/typing"))).body, { state: "on" });
  assert.equal(flow.sends("/v1/messages").length, 0, "a reply never starts a new conversation");
  await live.agent.conversation(live.events[0]!.conversationId)!.whenIdle();
});

test("after a restart, a nudge to someone on iMessage starts from the line's sender (FLOW_MESSAGING_IMESSAGE_SENDER), to their email handle", async (t) => {
  const flow = await fakeFlow();
  const database = join(mkdtempSync(join(tmpdir(), "flow-fm-im-db-")), "agent.db");
  flow.contacts.ct_im = { id: "ct_im", channel: "imessage", address: { handle: "maya@example.com" } };
  const before = await imessageAgent(flow, { database: sqlite(database) });
  await before.deliver(received("msg_1", "hi"));
  (await before.nextCall(0)).answer(respond(call("send_imessage", { text: "Hi!" })));
  await flow.request(post("/v1/conversations/conv_im/messages"));
  await before.agent.conversation(before.events[0]!.conversationId)!.whenIdle();
  before.close();

  const after = await imessageAgent(flow, { database: sqlite(database) });
  t.after(() => (flow.close(), after.close()));
  assert.equal((await after.agent.nudge({ to: { channel: "imessage", address: "maya@example.com" }, text: "Your table is ready" })).status, "sent");
  assert.deepEqual((await flow.request(post("/v1/messages"))).body, { sender: "snd_IM", to: { handle: "maya@example.com" }, content: { type: "text", text: "Your table is ready", format: "plain" } });
});

test("a start to a phone number on iMessage names the phone; a link goes as its URL on its own line, since iMessage has no link buttons", async (t) => {
  const flow = await fakeFlow();
  t.after(() => flow.close());
  const channel = flowMessaging({ apiKey: "fk_test_key", baseUrl: flow.url }).imessage({ sender: IM.sender });
  const link = { label: "Book", url: "https://example.com/book" };
  // The agent fits every message to its channel (fitMessage) before the channel sends it.
  await channel.send("15550100100", { type: "message", ...fitMessage(channel.info, { text: "Book here", link }) });
  assert.deepEqual((await flow.request(post("/v1/messages"))).body, { sender: "snd_IM", to: { phone: "+15550100100" }, content: { type: "text", text: "Book here\nhttps://example.com/book", format: "plain" } });
  // Sent by hand with a link anyway, the link is left out rather than sent as a button Flow would refuse.
  await channel.send("+15550100100", { type: "message", text: "Or here", link });
  assert.deepEqual((await flow.request((r) => post("/v1/messages")(r) && r.body.content.text === "Or here")).body.content, { type: "text", text: "Or here", format: "plain" });
});

test("a read receipt or typing refused outside the window is expected and not logged; any other courtesy failure is a warning", async (t) => {
  const flow = await fakeFlow();
  t.after(() => flow.close());
  flow.messages.msg_1 = { id: "msg_1", conversation: IM.id, direction: "in", content: { type: "text", text: "hi" } };
  const channel = flowMessaging({ apiKey: "fk_test_key", baseUrl: flow.url }).imessage({ sender: IM.sender });
  const warn = t.mock.method(console, "warn", () => {});
  const outside = { error: { type: "outside_window", message: "Outside the conversation window.", hint: "", doc_url: "" } };
  flow.queued.push({ match: post("/v1/conversations/conv_im/read"), status: 409, body: outside });
  flow.queued.push({ match: post("/v1/conversations/conv_im/typing"), status: 409, body: outside });
  await channel.send("+15550100100", { type: "read", messageIds: ["msg_1"] });
  await channel.send("+15550100100", { type: "typing", on: true });
  assert.equal(flow.sends("/v1/conversations/conv_im/read").length, 1);
  assert.equal(flow.sends("/v1/conversations/conv_im/typing").length, 1);
  assert.equal(warn.mock.callCount(), 0);

  flow.queued.push({ match: post("/v1/conversations/conv_im/typing"), status: 400, body: { error: { type: "invalid_request", message: "Bad state.", hint: "", doc_url: "" } } });
  await channel.send("+15550100100", { type: "typing", on: false });
  assert.deepEqual(warn.mock.calls.map((c) => c.arguments[0]), ["@flow-engineer/flow/flow-messaging: typing on imessage failed (invalid_request)"]);
});
