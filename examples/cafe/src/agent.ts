// Builds the agent. The playground (main.ts) and the tests build it the same way; tests pass their own
// model, events and (simulated) tools.

import { fileURLToPath } from "node:url";
import { createAgent, customUI, openAICompatible, sms, whatsapp, type Channel, type EventSink, type HostOptions, type Model, type Tool } from "../../../src/index.ts";
import { tools as cafeTools } from "./tools.ts";

export interface BuildOptions {
  model?: Model;
  events?: EventSink[];
  tools?: Tool[];
  /** Channels that are connected, such as Telegram through Flow Messaging (main.ts adds them when .env has its key); one named whatsapp replaces the unconnected one. */
  channels?: Channel[];
  /** What the place running it supplies (Flow's hosting: its store and Flow Messaging; Cloudflare: files and a database), passed to createAgent as it is. */
  host?: HostOptions;
}

export const tools = cafeTools;

// The café's numbers and web chat are not connected yet, so every provider refuses to send. Test
// people write from the playground, and replies to them go back there, never through these.
const notConnected = async () => {
  throw new Error("not connected yet: only test people in the playground reach the agent for now");
};
const provider = { sendMessage: notConnected, react: notConnected, typing: notConnected, markRead: notConnected, status: notConnected };

export function buildAgent(options: BuildOptions = {}) {
  const connected = options.channels ?? [];
  // Hosted on Flow Messaging, its channels are the real ones (createAgent adds them from host.messaging).
  const unconnected = options.host?.messaging ? [] : [whatsapp(provider), sms(provider), customUI("web", provider)].filter((c) => !connected.some((k) => k.name === c.name));
  return createAgent({
    dir: fileURLToPath(new URL("../agent", import.meta.url)),
    host: options.host,
    model: options.model ?? openAICompatible({ model: process.env.CAFE_MODEL }),
    tools: options.tools ?? cafeTools,
    events: options.events ?? [],
    channels: [...unconnected, ...connected],
    testPeople: [
      { name: "Maria", phone: "+15555550101" },
      { name: "Sam", phone: "+15555550102" },
      { name: "Priya", phone: "+15555550103" },
    ],
    timeZone: "America/New_York",
  });
}
