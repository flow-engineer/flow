// covers: examples/cafe/src/channels.ts examples/cafe/src/main.ts examples/cafe/src/agent.ts flow-messaging/src/index.ts src/agent.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { sqlite, Store, type Model } from "../src/index.ts";
import { flowMessaging } from "../flow-messaging/src/index.ts";
import { buildAgent } from "../examples/cafe/src/agent.ts";
import { channelNames } from "../examples/cafe/src/channels.ts";

const model: Model = { complete: async () => ({ text: null, toolCalls: [] }) };
const senders = { FLOW_MESSAGING_WHATSAPP_SENDER: "snd_WA", FLOW_MESSAGING_IMESSAGE_SENDER: "snd_IM" };

test("Flow Messaging's channels: Telegram always, WhatsApp and iMessage when .env names their senders", () => {
  const names = (env: Record<string, string>, except?: string[]) => flowMessaging({ apiKey: "fk_test_key" }).channels({ env, except }).map((c) => c.name);
  assert.deepEqual(names({}), ["telegram"]);
  assert.deepEqual(names({ FLOW_MESSAGING_WHATSAPP_SENDER: "snd_WA" }), ["telegram", "whatsapp"]);
  assert.deepEqual(names({ FLOW_MESSAGING_IMESSAGE_SENDER: "snd_IM" }), ["telegram", "imessage"]);
  assert.deepEqual(names(senders), ["telegram", "whatsapp", "imessage"]);
  assert.deepEqual(names({ FLOW_MESSAGING_WHATSAPP_SENDER: "" }), ["telegram"], "an empty value is not a sender");
  assert.deepEqual(names(senders, ["telegram"]), ["whatsapp", "imessage"], "a channel the agent declares itself is left out");
  assert.equal(channelNames(flowMessaging({ apiKey: "fk_test_key" }).channels({ env: senders })), "Telegram, WhatsApp, iMessage");
});

test("Pip builds with every Flow channel locally: Flow's WhatsApp takes the place of the unconnected one", () => {
  const agent = buildAgent({ model, channels: flowMessaging({ apiKey: "fk_test_key" }).channels({ env: senders }) });
  assert.deepEqual(agent.channels().map((c) => c.name).sort(), ["imessage", "sms", "telegram", "web", "whatsapp"]);
  assert.ok(buildAgent({ model }), "and without Flow Messaging, as before");
});

test("Pip builds as Flow's hosting builds it: its store, and Flow Messaging's channels from host.messaging", () => {
  const saved = { ...process.env };
  Object.assign(process.env, senders);
  try {
    const host = { store: new Store(sqlite(), "hosted"), messaging: flowMessaging({ apiKey: "fk_test_key" }) };
    const agent = buildAgent({ model, host });
    assert.deepEqual(agent.channels().map((c) => c.name), ["telegram", "whatsapp", "imessage"]);
    assert.ok(buildAgent({ model, host: { files: { "AGENTS.md": "# Pip" }, scheduleCheckMs: 0 } }), "and on a host with no file system");
  } finally {
    process.env = saved;
  }
});
