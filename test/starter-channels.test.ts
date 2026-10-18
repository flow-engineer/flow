// covers: examples/cafe/src/channels.ts examples/cafe/src/main.ts examples/cafe/src/agent.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model } from "../src/index.ts";
import { flowMessaging } from "../flow-messaging/src/index.ts";
import { buildAgent } from "../examples/cafe/src/agent.ts";
import { channelNames, flowChannels } from "../examples/cafe/src/channels.ts";

const model: Model = { complete: async () => ({ text: null, toolCalls: [] }) };

test("the starter is on Flow Messaging's Telegram always, and on WhatsApp and iMessage when .env names their senders", () => {
  const fm = flowMessaging({ apiKey: "fk_test_key" });
  const names = (env: Record<string, string>) => flowChannels(fm, env).map((c) => c.name);
  assert.deepEqual(names({}), ["telegram"]);
  assert.deepEqual(names({ FLOW_MESSAGING_WHATSAPP_SENDER: "snd_WA" }), ["telegram", "whatsapp"]);
  assert.deepEqual(names({ FLOW_MESSAGING_IMESSAGE_SENDER: "snd_IM" }), ["telegram", "imessage"]);
  assert.deepEqual(names({ FLOW_MESSAGING_WHATSAPP_SENDER: "snd_WA", FLOW_MESSAGING_IMESSAGE_SENDER: "snd_IM", FLOW_MESSAGING_WHATSAPP_SENDER_X: "" }), ["telegram", "whatsapp", "imessage"]);
  assert.deepEqual(names({ FLOW_MESSAGING_WHATSAPP_SENDER: "" }), ["telegram"], "an empty value is not a sender");
  assert.equal(channelNames(flowChannels(fm, { FLOW_MESSAGING_WHATSAPP_SENDER: "snd_WA", FLOW_MESSAGING_IMESSAGE_SENDER: "snd_IM" })), "Telegram, WhatsApp, iMessage");
});

test("Pip builds with every Flow channel: Flow's WhatsApp takes the place of the unconnected one", async () => {
  const fm = flowMessaging({ apiKey: "fk_test_key" });
  const agent = buildAgent({ model, channels: flowChannels(fm, { FLOW_MESSAGING_WHATSAPP_SENDER: "snd_WA", FLOW_MESSAGING_IMESSAGE_SENDER: "snd_IM" }) });
  assert.ok(agent);
  assert.ok(buildAgent({ model }), "and without Flow Messaging, as before");
});
