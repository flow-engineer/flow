// Business runs on the developer's side of the tunnel: scenarios the business starts (an event its
// backend sends, a nudge, time passing). Each run gets an agent of its own, built with a clock the
// cloud's commands move and with copies of the agent's own channels, so its sends go through what
// the agent wraps around them and come to the cloud with the run's time. The person writes through
// agent.message(), as a provider's webhook would, so they are a person the agent can nudge.
// Each run's agent keeps its state in a database of the run's own, so a `restart` step starts a new
// agent on the same store: as a crash (the old one dies where it is) or a deploy (the new one
// starts beside it, and the old one finishes what it holds and stops).

import { randomBytes } from "node:crypto";
import { signEvent, sqlite } from "../../src/index.ts";
import type { Agent, Channel, Database, EventSink, Incoming, Outbound, Tool } from "../../src/index.ts";
import { LEASE_MS } from "../../src/conversation.ts";
import type { BusinessCommand, BusinessOutbound, Command, Receipt, StepAnswer } from "./protocol.ts";

/** What a business run's agent must do: a Flow Framework Agent. */
export type BusinessAgent = Pick<Agent, "channels" | "channel" | "message" | "reacted" | "nudge" | "reach" | "runDue" | "conversation" | "fetch" | "resume" | "runner"> & Partial<Pick<Agent, "seedHistory">>;

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
    /** The run's store, which an agent restarted in the run (a `restart` step) starts on again. */
    database: Database;
    /** This agent's runner name in the run: runner-1, then runner-2 after a restart, ... */
    runner: string;
  };
}

/** One minute: the clock moves this far at a time, and what came due runs at each step. */
export const STEP_MS = 60_000;

/** How long a deploy's old agent may take to finish what it holds before it is stopped where it is. */
export const DRAIN_MS = 120_000;

/** One agent of a run, from its start until it stops: a dead one sends, calls, records and keeps nothing more. */
interface Life {
  agent: BusinessAgent;
  dead: boolean;
  /** The run's store as this agent reaches it: killed, every statement fails, as when its process died. */
  database: Database & { kill(): void };
}

interface Run {
  /** The agent that takes the run's commands. */
  agent: BusinessAgent;
  life: Life;
  /** Every agent started in the run that has not stopped (a deploy's old one while it finishes). */
  lives: Set<Life>;
  database: Database;
  /** How many agents the run has started. */
  started: number;
  /** The tools whose own code runs (tools.real). */
  real: Set<string>;
  clock: number;
  secret: string;
  address: string;
  channelName: string;
  /** The agent's conversation for the run's person. */
  conversationId: string;
  /** The cloud's conversation: the run's key. */
  cloudId: string;
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
  /** Each outbound a run's channel took (testing/src/client.ts's send-path check). */
  sent?: (cloudId: string, outbound: Outbound) => void;
}

export function businessRuns(ctx: BusinessContext) {
  const runs = new Map<string, Run>();

  const open = async (command: Extract<BusinessCommand, { type: "open" }>): Promise<StepAnswer> => {
    const cloudId = command.conversationId;
    const real = new Set(command.realTools ?? []);
    const unknown = [...real].filter((name) => !ctx.realTools.some((t) => t.name === name));
    if (unknown.length) return { conversationId: cloudId, step: 0, at: command.now, error: `the agent has no tool ${unknown.join(", ")} to run for real` };
    const run = { clock: command.now, secret: `whsec_test_${randomBytes(18).toString("hex")}`, address: command.address, channelName: command.channelName, conversationId: "", cloudId, deliveries: new Set(), sent: 0, lives: new Set(), database: sqlite(), started: 0, real } as unknown as Run;
    start(run, cloudId);
    run.conversationId = (await run.agent.reach({ channel: command.channelName, address: command.address })).conversationId;
    if (command.history?.length) {
      if (typeof run.agent.seedHistory !== "function") return { conversationId: cloudId, step: 0, at: command.now, error: "this agent cannot start from an earlier conversation (history)" };
      await run.agent.seedHistory(run.conversationId, command.history.map(({ from, text }) => ({ from, text })), { channelName: command.channelName });
    }
    runs.set(cloudId, run);
    return { conversationId: cloudId, step: 0, at: run.clock };
  };

  /** Builds the run's next agent on its store and makes it the one that takes the run's commands. */
  const start = (run: Run, cloudId: string): Life => {
    const life = { dead: false, database: killable(run.database) } as Life;
    const alive = <T>(work: () => Promise<T>): Promise<T> => (life.dead ? Promise.reject(new Error("the agent's process died")) : work());
    // The run's events and tool calls are the cloud's conversation, whatever the agent calls it.
    const events: EventSink = Object.assign((event: Parameters<EventSink>[0]) => void (life.dead || ctx.events({ ...event, conversationId: cloudId })), { context: true });
    // A tool run for real is the agent's own object, as in production, so buildAgent knows its own
    // tools by identity (t === myTool). A dead agent's conversation is closed (its tools' signal
    // aborted), its store and sends refused, as a crashed process. Simulated ones ask the cloud.
    const tools = ctx.tunnelTools.map((t): Tool => {
      if (run.real.has(t.name)) return ctx.realTools.find((r) => r.name === t.name)!;
      return { ...t, run: (input: unknown, context: Parameters<Tool["run"]>[1]) => alive(async () => t.run(input, { ...context, conversationId: cloudId })) } as Tool;
    });
    const channels = ctx.sessionAgent.channels().map(({ name }): Channel => {
      const own = ctx.sessionAgent.channel(name)!;
      return { ...own, send: (address: string, outbound: Outbound) => (life.dead ? Promise.resolve() : deliver(run, cloudId, address, outbound)) };
    });
    const runner = `runner-${++run.started}`;
    life.agent = ctx.build({ tools, events: [events], channels, testing: { now: () => run.clock, scheduleCheckMs: 0, eventsSecret: run.secret, database: life.database, runner } });
    if (run.started > 1 && !String(life.agent.runner ?? "").startsWith(`${runner}:`)) {
      kill(run, life);
      throw new Error("a restart needs buildAgent to pass options.testing on to createAgent as it is (its database and runner, neither replaced), so the new agent starts on the run's store");
    }
    run.lives.add(life);
    run.life = life;
    run.agent = life.agent;
    return life;
  };

  /** The agent stops where it is: its turn in flight is cut off, and nothing it does from now on is sent or kept. */
  const kill = (run: Run, life: Life) => {
    life.dead = true;
    run.lives.delete(life);
    if (run.conversationId) life.agent.conversation(run.conversationId)?.close();
    life.database.kill();
  };

  /**
   * The agent restarts on the run's store. crash: it dies where it is, holding its lease; a new one
   * starts and leaves the conversation to it, then the clock moves past the lease (LEASE_MS) and what
   * was cut off runs on the new one. deploy: a new one starts beside it and takes the run's commands
   * from now on; the old one finishes what it holds (with what the new one stores for it meanwhile)
   * and stops, within DRAIN_MS. The step is answered once the new agent is up.
   */
  const restart = async (run: Run, command: Extract<BusinessCommand, { type: "restart" }>): Promise<NonNullable<StepAnswer["restart"]>> => {
    const old = run.life;
    const life = start(run, command.conversationId);
    const names = { stopped: String(old.agent.runner), started: String(life.agent.runner) };
    if (command.mode === "crash") kill(run, old);
    await life.agent.resume();
    if (command.mode === "crash") {
      await settle(run);
      run.clock += LEASE_MS;
    } else {
      ctx.watch(retire(run, old), "the old agent of a deploy");
    }
    return names;
  };

  /** A deploy's old agent: once nothing runs or waits in the run's conversation there, it stops. */
  const retire = async (run: Run, old: Life) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = (async () => {
      for (;;) {
        const conversation = old.agent.conversation(run.conversationId);
        await conversation?.whenIdle();
        // Its last writes, the lease let go among them, before it stops.
        await conversation?.stored();
        await Promise.allSettled([...run.deliveries]);
        if (!old.agent.conversation(run.conversationId)?.busy) return;
      }
    })();
    await Promise.race([drained, new Promise<void>((done) => (timer = setTimeout(done, DRAIN_MS)))]);
    clearTimeout(timer);
    kill(run, old);
    // A message the new agent stored after the old one last looked: the scheduled messages' timer would
    // take it in production; a run has none, so the new agent looks now (unless the run is over).
    if (runs.get(run.cloudId) === run) await settle(run).catch(() => {});
  };

  const deliver = (run: Run, cloudId: string, address: string, outbound: Outbound): Promise<void> => {
    if (address !== run.address) {
      ctx.log(`${cloudId}: the agent sent to ${address}, not the run's person; the cloud does not see it`);
      ctx.sent?.(cloudId, outbound);
      return Promise.resolve();
    }
    const body: BusinessOutbound = { conversationId: cloudId, outbound, at: run.clock };
    const delivery = ctx.post("outbound", body, `outbound:${cloudId}:b${++run.sent}`, "outbound delivery").then(() => void ctx.sent?.(cloudId, outbound));
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
      else if (command.type === "restart") result = { restart: await restart(run, command) };
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
        const run = runs.get(command.conversationId);
        runs.delete(command.conversationId);
        for (const life of run?.lives ?? []) kill(run!, life);
        return true;
      }
      if (command.type === "event" || command.type === "nudge" || command.type === "advance" || command.type === "restart") {
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

/** The run's store as one agent reaches it: once killed, every statement fails, as when its process died. */
function killable(db: Database): Database & { kill(): void } {
  let dead = false;
  const guard = () => {
    if (dead) throw new Error("the agent's process died");
  };
  const on = (inner: Omit<Database, "transaction">): Omit<Database, "transaction"> => ({
    durable: inner.durable,
    dialect: inner.dialect,
    query: async (sql, params) => (guard(), inner.query(sql, params)),
    run: async (sql, params) => (guard(), inner.run(sql, params)),
  });
  return { ...on(db), transaction: async (work) => (guard(), db.transaction((tx) => work(on(tx)))), kill: () => void (dead = true) };
}
