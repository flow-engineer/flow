import { fileURLToPath } from "node:url";
import { createAgent, openAICompatible, whatsapp, type Agent, type Channel, type EventSink, type HostOptions, type Model, type Tool } from "../../../src/index.ts";
import { ZONE } from "./draft.ts";
import { tools } from "./tools.ts";

export interface BuildOptions {
  model?: Model;
  events?: EventSink[];
  tools?: Tool[];
  channels?: Channel[];
  host?: HostOptions;
}

export { tools };

const notConnected = async () => {
  throw new Error("not connected yet: only test people in the playground reach the agent for now");
};
const provider = { sendMessage: notConnected, react: notConnected, typing: notConnected, markRead: notConnected, status: notConnected };

export function buildAgent(options: BuildOptions = {}) {
  const connected = options.channels ?? [];
  const unconnected = options.host?.messaging ? [] : [whatsapp(provider)].filter((c) => !connected.some((k) => k.name === c.name));
  const agent: Agent = createAgent({
    dir: fileURLToPath(new URL("../agent", import.meta.url)),
    host: options.host,
    model: options.model ?? openAICompatible(),
    tools: options.tools ?? tools,
    events: options.events ?? [],
    channels: [...unconnected, ...connected],
    // The draft and the published listings are the agent's own records; a person's are deleted when they are forgotten.
    records: { drafts: { people: ["person"] }, listings: { people: ["person"] } },
    testPeople: [{ name: "Sam", phone: "+15555550102" }, { name: "Priya", phone: "+15555550103" }],
    timeZone: ZONE,
  });
  return agent;
}
