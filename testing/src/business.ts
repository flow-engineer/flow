// Business runs on the developer's side of the tunnel: scenarios the business starts (an event its
// backend sends, a nudge, time passing). Each run gets an agent of its own, built with a clock the
// cloud's commands move and with copies of the agent's own channels, so its sends go through what
// the agent wraps around them and come to the cloud with the run's time. The person writes through
// agent.message(), as a provider's webhook would, so they are a person the agent can nudge.

import { randomBytes } from "node:crypto";
import { signEvent } from "../../src/index.ts";
import type { Agent, Channel, EventSink, Incoming, Outbound, Tool } from "../../src/index.ts";
import type { BusinessCommand, BusinessOutbound, Command, Receipt, StepAnswer } from "./protocol.ts";

/** What a business run's agent must do: a Flow Framework Agent. */
export type BusinessAgent = Pick<Agent, "channels" | "channel" | "message" | "reacted" | "nudge" | "reach" | "runDue" | "conversation" | "fetch">;

/** What buildAgent is given for a business run, beside its tools and events. */
export interface BusinessBuild {
  channels: Channel[];
  testing: {
    /** The run's clock. */
    now: () => number;
    /** No schedule timer: the clock moves only when the cloud says, and what came due runs then. */
    scheduleCheckMs: 0;
    /** The secret the run's events are signed with (Flow-Signature): made for the run, never a real one. */
    eventsSecret: string;
  };
}

/** One minute: the clock moves this far at a time, and what came due runs at each step. */
export const STEP_MS = 60_000;

interface Run {
  agent: BusinessAgent;
  clock: number;
  secret: string;
  address: string;
  channelName: string;
  /** The agent's conversation for the run's person. */
  conversationId: string;
  deliveries: Set<Promise<void>>;
  sent: number;
}

export interface BusinessContext {
  /** The agent the session was opened with: its channels are copied for each run. */
  sessionAgent: BusinessAgent;
  build: (options: { tools: Tool[]; events: EventSink[] } & BusinessBuild) => BusinessAgent;
  /** The tunnel's tools (each call asks the cloud), and the agent's own, for tools.real. */
  tunnelTools: Tool[];
  realTools: Tool[];
  /** The session's event uploader. */
  events: EventSink;
  /** A POST to the session, sent again under `key` while it may be. */
  post: (path: string, body: unknown, key: string, what: string) => Promise<unknown>;
  /** Keeps a failure of fire-and-forget work as the session's (refusals allowed). */
  watch: (work: Promise<unknown>, context: string, allowRefusal?: boolean) => void;
  log: (line: string) => void;
}

export function businessRuns(ctx: BusinessContext) {
  const runs = new Map<string, Run>();

  const open = async (command: Extract<BusinessCommand, { type: "open" }>): Promise<StepAnswer> => {
    const cloudId = command.conversationId;
    const real = new Set(command.realTools ?? []);
    const unknown = [...real].filter((name) => !ctx.realTools.some((t) => t.name === name));
    if (unknown.length) return { conversationId: cloudId, step: 0, at: command.now, error: `the agent has no tool ${unknown.join(", ")} to run for real` };
    const run = { clock: command.now, secret: `whsec_test_${randomBytes(18).toString("hex")}`, address: command.address, channelName: command.channelName, conversationId: "", deliveries: new Set(), sent: 0 } as unknown as Run;
    // The run's events and tool calls are the cloud's conversation, whatever the agent calls it.
    const events: EventSink = Object.assign((event: Parameters<EventSink>[0]) => ctx.events({ ...event, conversationId: cloudId }), { context: true });
    const tools = ctx.tunnelTools.map((t): Tool => {
      if (real.has(t.name)) return ctx.realTools.find((r) => r.name === t.name)!;
      return { ...t, run: (input: unknown, context: Parameters<Tool["run"]>[1]) => t.run(input, { ...context, conversationId: cloudId }) } as Tool;
    });
    const channels = ctx.sessionAgent.channels().map(({ name }): Channel => {
      const own = ctx.sessionAgent.channel(name)!;
      return { ...own, send: (address: string, outbound: Outbound) => deliver(run, cloudId, address, outbound) };
    });
    run.agent = ctx.build({ tools, events: [events], channels, testing: { now: () => run.clock, scheduleCheckMs: 0, eventsSecret: run.secret } });
    run.conversationId = (await run.agent.reach({ channel: command.channelName, address: command.address })).conversationId;
    runs.set(cloudId, run);
    return { conversationId: cloudId, step: 0, at: run.clock };
  };

  const deliver = (run: Run, cloudId: string, address: string, outbound: Outbound): Promise<void> => {
    if (address !== run.address) {
      ctx.log(`${cloudId}: the agent sent to ${address}, not the run's person; the cloud does not see it`);
      return Promise.resolve();
    }
    const body: BusinessOutbound = { conversationId: cloudId, outbound, at: run.clock };
    const delivery = ctx.post("outbound", body, `outbound:${cloudId}:b${++run.sent}`, "outbound delivery").then(() => {});
    run.deliveries.add(delivery);
    const done = () => void run.deliveries.delete(delivery);
    delivery.then(done, done);
    ctx.watch(delivery, "outbound delivery", true);
    return delivery;
  };

  /** Until nothing more comes due now and everything set off has been sent. */
  const settle = async (run: Run) => {
    for (let i = 0; i < 10; i++) {
      const due = await run.agent.runDue();
      await run.agent.conversation(run.conversationId)?.whenIdle();
      await Promise.allSettled([...run.deliveries]);
      if (!due && !run.agent.conversation(run.conversationId)?.busy) return;
    }
  };

  const event = async (run: Run, command: Extract<BusinessCommand, { type: "event" }>): Promise<Omit<StepAnswer, "conversationId" | "step" | "at">> => {
    const body = JSON.stringify(command.envelope);
    const secret = command.signature === "bad" ? `whsec_test_${randomBytes(18).toString("hex")}` : run.secret;
    const headers: Record<string, string> = { "content-type": "application/json", "idempotency-key": command.envelope.id };
    if (command.signature !== "missing") headers["flow-signature"] = signEvent(secret, body, run.clock);
    const response = await run.agent.fetch(new Request(`http://agent.test${command.path ?? "/v1/events"}`, { method: "POST", headers, body }));
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON: kept as text */ }
    return { answer: { status: response.status, body: parsed } };
  };

  const step = async (run: Run, command: Exclude<BusinessCommand, { type: "open" | "close" }>): Promise<StepAnswer> => {
    const base = { conversationId: command.conversationId, step: command.step };
    let result: Omit<StepAnswer, "conversationId" | "step" | "at"> = {};
    try {
      if (command.type === "event") result = await event(run, command);
      else if (command.type === "nudge") {
        const { expiresAt, ...rest } = command.nudge;
        const nudged = await run.agent.nudge({ to: { channel: run.channelName, address: run.address }, ...rest, ...(expiresAt !== undefined ? { expiresAt } : {}) });
        result = { nudge: { status: nudged.status, ...(nudged.reason ? { reason: nudged.reason } : {}) } };
      } else {
        if (command.to < run.clock) throw new Error("the clock never moves back");
        while (run.clock < command.to) {
          run.clock = Math.min(command.to, run.clock + STEP_MS);
          await settle(run);
        }
      }
      await settle(run);
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    return { ...base, ...result, at: run.clock };
  };

  return {
    /** A business run's command, or a message or reaction for one: true when it was one. */
    handle(command: Command, withFiles: (incoming: Extract<Command, { type: "message" }>["incoming"]) => Incoming): boolean {
      // Steps run beside the stream, so one run's long wait never holds up another's commands; the cloud
      // sends a run's next command only after this one's answer.
      if (command.type === "open") {
        ctx.watch((async () => {
          const answer = await open(command).catch((error: unknown): StepAnswer => ({ conversationId: command.conversationId, step: 0, at: command.now, error: error instanceof Error ? error.message : String(error) }));
          await ctx.post("steps", answer, `step:${command.conversationId}:0`, "step answer");
        })(), "business step");
        return true;
      }
      if (command.type === "close") {
        runs.delete(command.conversationId);
        return true;
      }
      if (command.type === "event" || command.type === "nudge" || command.type === "advance") {
        ctx.watch((async () => {
          const run = runs.get(command.conversationId);
          const answer = run ? await step(run, command) : { conversationId: command.conversationId, step: command.step, at: 0, error: "no such run open" };
          await ctx.post("steps", answer, `step:${command.conversationId}:${command.step}`, "step answer");
        })(), "business step");
        return true;
      }
      if (command.type !== "message" && command.type !== "reaction") return false;
      const run = runs.get(command.conversationId);
      if (!run) return false;
      if (command.type === "reaction") {
        run.agent.reacted(run.conversationId, command.emoji, command.toText);
        return true;
      }
      // As a provider's webhook would: the person by their address on the run's channel.
      const work = (async () => {
        const taken = await run.agent.message({ channel: run.channelName, from: run.address, message: withFiles(command.incoming), messageId: command.messageId });
        // An intercepted message's reply is out before its receipt, as on the other runs.
        if (!taken) await Promise.allSettled([...run.deliveries]);
        const receipt: Receipt = { conversationId: command.conversationId, messageId: command.messageId, status: taken ? "taken" : "intercepted" };
        await ctx.post("receipts", receipt, `receipt:${receipt.conversationId}:${receipt.messageId}`, "delivery receipt");
      })();
      ctx.watch(work, "delivery receipt");
      return true;
    },
  };
}
