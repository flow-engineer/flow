// A load test for one process: N simulated conversations at once, each person writing T messages
// one after another, on the simulators' platforms (SMS, WhatsApp, iMessage, Telegram, web, in turn).
// The model is a fake that answers at once (or after --model-ms): no model spend, no network.
// Prints CPU per turn, memory per conversation, throughput and turn times. On demand only:
// `npm run bench:load -- --conversations 50 --turns 5` (see bench/README.md).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { setTimeout as wait } from "node:timers/promises";
import { createAgent, tool, z, type Model, type ModelRequest, type ModelResponse } from "../src/index.ts";
import { PLATFORMS, channelOf } from "../simulators/src/index.ts";

const { values } = parseArgs({
  options: {
    conversations: { type: "string", default: "50" },
    turns: { type: "string", default: "5" },
    "model-ms": { type: "string", default: "0" },
    json: { type: "boolean", default: false },
  },
});
const N = Number(values.conversations);
const T = Number(values.turns);
const modelMs = Number(values["model-ms"]);
if (!(N >= 1 && T >= 1 && modelMs >= 0)) throw new Error("bench: --conversations and --turns must be 1 or more, --model-ms 0 or more");

// Local only: no traces to Observe (FLOW_FRAMEWORK_TRACES_KEY and the rest are dropped) and no
// network at all (fetch throws), so a run never reaches a production service whatever the shell holds.
for (const name of Object.keys(process.env)) if (/^(FLOW_FRAMEWORK_|CHINWAG_)/.test(name)) delete process.env[name];
globalThis.fetch = async (input) => {
  throw new Error(`bench: no network in the load test (tried ${String(input instanceof Request ? input.url : input)})`);
};

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) console.error("bench: run with node --expose-gc (npm run bench:load does) for steady memory numbers");
const settle = async () => {
  for (let i = 0; i < 3; i++) {
    gc?.();
    await wait(10);
  }
  return process.memoryUsage();
};

let calls = 0;
/**
 * Every other turn looks something up first, so tool calls are part of the load. After a step that
 * only sent messages, Flow Framework asks once more; the fake answers that with nothing.
 */
const fake: Model = {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (modelMs) await wait(modelMs, undefined, { signal: request.signal });
    const last = request.messages.at(-1);
    const id = `c${++calls}`;
    if (last?.role === "user") {
      const said = String(last.content).replace(/^\[[^\]]*\] /, "");
      if (said.includes("order")) return { text: null, toolCalls: [{ id, name: "lookup_order", arguments: JSON.stringify({ ref: said.slice(-4) }) }] };
      return reply(id, `You said: ${said}`);
    }
    if (last?.role === "tool" && request.messages.at(-2)?.role === "assistant" && last.content.startsWith("{\"status\"")) return reply(id, `It is ${JSON.parse(last.content).status}.`);
    return { text: null, toolCalls: [] };
  },
};
const reply = (id: string, text: string): ModelResponse => ({ text: null, toolCalls: [{ id, name: "send_chat", arguments: JSON.stringify({ text }) }], usage: { inputTokens: 0, outputTokens: 0 } });

const lookup = tool({
  name: "lookup_order",
  description: "Looks up an order by its reference.",
  input: z.object({ ref: z.string() }),
  run: async ({ ref }) => JSON.stringify({ status: "on its way", ref }),
});

const dir = mkdtempSync(join(tmpdir(), "flow-bench-"));
writeFileSync(join(dir, "AGENTS.md"), "You are a load test agent.");
const agent = createAgent({ dir, model: fake, tools: [lookup], debounceMs: 0, scheduleCheckMs: 0 });
const channels = PLATFORMS.map((p) => channelOf(p));

/** One person: T messages, each sent once the agent has finished the turn before it. */
async function person(i: number, times: number[], out: { sent: number }) {
  const id = `bench-${i}`;
  const channel = channels[i % channels.length];
  for (let t = 0; t < T; t++) {
    const text = t % 2 ? `where is my order ${1000 + i}` : `hello, message ${t} from person ${i}`;
    const started = performance.now();
    agent.receive(id, text, (o) => void (o.type === "message" && out.sent++), { channel });
    await agent.conversation(id)!.whenIdle();
    times.push(performance.now() - started);
  }
}

// Warm up (JIT, the store's tables) with one conversation, then take the baseline.
await person(-1, [], { sent: 0 });
const before = await settle();
const cpu0 = process.cpuUsage();
const elu0 = performance.eventLoopUtilization();
const t0 = performance.now();
const times: number[] = [];
const out = { sent: 0 };
await Promise.all(Array.from({ length: N }, (_, i) => person(i, times, out)));
const wallMs = performance.now() - t0;
const cpu = process.cpuUsage(cpu0);
const busy = performance.eventLoopUtilization(elu0).utilization;
const after = await settle();

times.sort((a, b) => a - b);
const pct = (p: number) => times[Math.min(times.length - 1, Math.ceil((p / 100) * times.length) - 1)];
const turns = N * T;
const kb = (bytes: number) => Math.round(bytes / 1024);
const result = {
  conversations: N,
  turnsEach: T,
  modelMs,
  turns,
  repliesDelivered: out.sent,
  wallSeconds: +(wallMs / 1000).toFixed(2),
  turnsPerSecond: +(turns / (wallMs / 1000)).toFixed(1),
  cpuMsPerTurn: +((cpu.user + cpu.system) / 1000 / turns).toFixed(3),
  mainThreadBusy: +busy.toFixed(2),
  turnMs: { p50: +pct(50).toFixed(1), p95: +pct(95).toFixed(1), max: +times.at(-1)!.toFixed(1) },
  heapKbPerConversation: kb((after.heapUsed - before.heapUsed) / N),
  rssKbPerConversation: kb((after.rss - before.rss) / N),
  heapMbAfter: +(after.heapUsed / 2 ** 20).toFixed(1),
  rssMbAfter: +(after.rss / 2 ** 20).toFixed(1),
  node: process.version,
};
if (values.json) console.log(JSON.stringify(result));
else {
  console.log(`${N} conversations × ${T} turns (fake model, ${modelMs} ms a call), ${result.repliesDelivered}/${turns} replies delivered, ${result.wallSeconds}s`);
  console.log(`throughput     ${result.turnsPerSecond} turns/s`);
  console.log(`CPU per turn   ${result.cpuMsPerTurn} ms (user + system, the whole process)`);
  console.log(`main thread    ${Math.round(result.mainThreadBusy * 100)}% busy (the rest of the wall time it waited)`);
  console.log(`turn time      p50 ${result.turnMs.p50} ms   p95 ${result.turnMs.p95} ms   max ${result.turnMs.max} ms`);
  console.log(`memory         ${result.heapKbPerConversation} KB heap, ${result.rssKbPerConversation} KB RSS per conversation (heap ${result.heapMbAfter} MB, RSS ${result.rssMbAfter} MB after)`);
}
rmSync(dir, { recursive: true, force: true });
process.exit(result.repliesDelivered === turns ? 0 : 1);
