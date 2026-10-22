// covers: testing/src/print-run.ts testing/src/cli.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { runPrinter, sessionLines } from "../testing/src/print-run.ts";
import type { CostWarning, RunSummary, RunTiming } from "../testing/src/protocol.ts";

const run = (extra: Partial<RunSummary> = {}): RunSummary => ({
  runId: "run_1",
  scenario: "s",
  run: 1,
  channel: "sms",
  passed: true,
  checks: [],
  ended: "goal_met",
  turns: 1,
  messagesIn: 1,
  messagesOut: 1,
  toolCalls: 0,
  slowestAckMs: 10,
  agentUsage: { input: 0, output: 0, costUsd: 0 },
  agentModels: [],
  testUsage: { input: 0, output: 0, costUsd: 0 },
  watch: "https://example.test/watch",
  ...extra,
});

test("a run is printed once when it finishes, and not again with the summary", () => {
  const lines: string[] = [];
  const print = runPrinter((line) => lines.push(line));
  print(run());
  print(run());
  const passes = lines.filter((line) => line.startsWith("PASS"));
  assert.equal(passes.length, 1);
});

test("a run's line names its id, for flow show", () => {
  const lines: string[] = [];
  runPrinter((line) => lines.push(line))(run({ passed: false, runId: "trn_ABC", turns: 6 }));
  assert.match(lines[0], /^FAIL {2}s #1 \(sms\) trn_ABC: 6 turns, ended: goal_met;/);
});

test("a retry is named on the line", () => {
  const lines: string[] = [];
  runPrinter((line) => lines.push(line))(run({ retried: true }));
  assert.match(lines[0], /tried once more/);
});

test("a run the cloud names an error for prints ERROR with its code, even when it ended goal_met, and not its checks", () => {
  const lines: string[] = [];
  const checks = [{ kind: "judge", text: "Asks to confirm.", pass: false, reason: "not judged" }] as RunSummary["checks"];
  runPrinter((line) => lines.push(line))(run({ passed: false, ended: "goal_met", error: "judge_failed", checks }));
  assert.match(lines[0], /^ERROR {2}s #1 \(sms\) run_1: 1 turn, ended: goal_met; error: judge_failed \(the cloud could not play or judge this run, not the agent's fault\);/);
  assert.equal(lines.some((line) => line.includes("not judged")), false);
  const failed: string[] = [];
  runPrinter((line) => failed.push(line))(run({ passed: false, ended: "run_failed" }));
  assert.match(failed[0], /^ERROR .*error: run_failed/);
});

const timing: RunTiming = {
  firstReply: { p50: 1240, p95: 3400, max: 3400, unanswered: 0 },
  turn: { count: 3, p50: 2000, p95: 5100, totalMs: 9000 },
  model: { calls: 4, totalMs: 7000, p95: 2500 },
  tools: { calls: 2, totalMs: 1400, simulated: true },
  ownMs: 600,
};

test("with the cloud's timing, a run's line gives first reply p50 and p95, turn p95 and the agent's tokens, and never $0 for a cost the provider did not report", () => {
  const line = (agentUsage: RunSummary["agentUsage"], t: RunTiming | null = timing) => {
    const lines: string[] = [];
    runPrinter((l) => lines.push(l))(run({ ...(t ? { timing: t } : {}), agentUsage, testUsage: { input: 0, output: 0, costUsd: 0.004 } }));
    return lines[0]!.slice(lines[0]!.indexOf("ended: goal_met; ") + "ended: goal_met; ".length);
  };
  const tokens = { input: 31_200, output: 2_040, cacheRead: 18_000, calls: 4 };
  assert.equal(line({ ...tokens, costUsd: 0.0123, costKnown: "all" }), "first reply p50 1.2 s, p95 3.4 s; turn p95 5.1 s; cost $0.0123 agent (31k in, 2k out, 18k cached) + $0.0040 test");
  assert.equal(line({ ...tokens, costUsd: 0, costKnown: "none" }), "first reply p50 1.2 s, p95 3.4 s; turn p95 5.1 s; agent cost not reported by your provider (31k in, 2k out, 18k cached) + $0.0040 test");
  assert.equal(line({ input: 840, output: 12, costUsd: 0.001, costKnown: "some" }, { ...timing, firstReply: { p50: null, p95: null, max: null, unanswered: 2 } }), "first reply never (2 unanswered); turn p95 5.1 s; cost at least $0.0010 agent (840 in, 12 out) + $0.0040 test");
  // An older cloud sends no timing: today's line.
  assert.equal(line({ input: 1, output: 1, costUsd: 0.01 }, null), "slowest acknowledgement 10 ms; cost $0.0100 agent + $0.0040 test");
});

test("the session's lines: an older cloud gets only today's Cost line; a newer one adds Latency, then Warnings (budget first) and Improvements", () => {
  const runs = [run({ agentUsage: { input: 1_200, output: 30, costUsd: 0.02 }, testUsage: { input: 0, output: 0, costUsd: 0.01 } })];
  assert.deepEqual(sessionLines({ runs }), ["Cost: $0.0200 agent (1,200 in, 30 out) + $0.0100 test models."]);

  const warning = (over: Partial<CostWarning>): CostWarning => ({ scenario: "refund-request", path: "scenarios/refund-request.yaml", channel: "whatsapp", kind: "budget", metric: "cost_usd", value: 0.031, runs: 1, ...over });
  const newer = sessionLines({
    runs: [
      run({ agentUsage: { input: 1_200, output: 30, cacheRead: 900, costUsd: 0.02, costKnown: "all" } }),
      run({ runId: "run_2", agentUsage: { input: 100, output: 3, costUsd: 0, costKnown: "none" } }),
    ],
    latency: {
      firstReply: { p50: 1300, p95: 3900, max: 7200, slowest: { scenario: "travel-planner", run: 2, channel: "sms", runId: "trn_9" } },
      turn: { p50: 2000, p95: 5000 },
      split: { modelMs: 7800, toolsMs: 1500, ownMs: 700 },
    },
    warnings: [
      warning({ limit: 0.02 }),
      warning({ kind: "regression", metric: "first_reply_ms", value: 4800, baseline: 2900, baselineSessionId: "s0", baselineRunId: "trn_1", baselineRuns: 1 }),
    ],
    improvements: [warning({ scenario: "hello", path: "scenarios/hello.yaml", channel: "sms", kind: "regression", value: 0.006, baseline: 0.01, runs: 3, baselineRuns: 3 })],
  });
  assert.deepEqual(newer, [
    "Cost: at least $0.0200 agent (1,300 in, 33 out, 900 cached) + $0.0000 test models.",
    "Latency: first reply p50 1.3 s, p95 3.9 s (slowest 7.2 s, travel-planner #2); agent turn p95 5.0 s: model 78%, tools 15% (simulated), agent 7%.",
    "Warnings:",
    "  scenarios/refund-request.yaml (whatsapp): cost $0.0310 per run, budget $0.0200",
    "  scenarios/refund-request.yaml (whatsapp): p95 first reply 4.8 s, was 2.9 s (+66%)",
    "  A regression from 1 run is noisy: run flow test --runs 3 to confirm it.",
    "Improvements: scenarios/hello.yaml (sms) cost down 40%.",
  ]);
  // No warnings, nothing about them.
  assert.equal(sessionLines({ runs, latency: undefined, warnings: [], improvements: [] }).length, 1);
});
