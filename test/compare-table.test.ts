// covers: testing/src/compare-table.ts testing/src/variant-stats.ts
// The noise rule and the table: a difference is named only when the intervals do not overlap, and the table never calls a winner the data does not show.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildComparison, renderComparison, type VariantResult } from "../testing/src/compare-table.ts";
import type { JsonReport, ReportRun } from "../testing/src/report.ts";
import type { ConversationCounts } from "../testing/src/variant-counts.ts";
import { conversationsNeeded, difference, proportion, ratio } from "../testing/src/variant-stats.ts";

const run = (i: number, verdict: ReportRun["verdict"], failed: string[] = []): ReportRun => ({
  runId: `r${i}`, scenario: `s${i % 5}`, channel: "sms", run: Math.floor(i / 5) + 1, verdict, outcome: verdict === "errored" ? "infra" : verdict === "failed" ? "failed" : "passed", error: null, ended: "goal_met", turns: 2, watch: null,
  failedChecks: failed.map((text) => ({ kind: "judge", text, reason: "r" })), invalid: null, rerun: null, label: verdict === "flaky" ? "flaky" : null,
});
const report = (runs: ReportRun[]): JsonReport => ({ outcome: "passed", exitCode: 0, sessionId: "s", dashboard: "http://d", strict: false, costUsd: { agent: 0.5, test: 0.25 }, runs } as unknown as JsonReport);
const counts = (id: string, turns: number, messages: number): ConversationCounts => ({ conversationId: id, turns, repliedTurns: turns, messages, multiMessageTurns: 0, modelCalls: turns * 2, modelMs: turns * 2000, replyMs: turns * 3000, toolCalls: turns, inputTokens: 1000, outputTokens: 100, cachedTokens: 500, costUsd: 0.01, textBesideLaterTools: 0, extraCallToSend: 0, modelErrors: 0, capacityErrors: 0 });
const variant = (name: string, passed: number, of: number, extra: Partial<VariantResult> = {}, failedText: string[] = []): VariantResult => ({
  name, spec: {}, exitCode: 0, wallMs: 60_000, unmatchedEdits: [], log: "",
  report: report(Array.from({ length: of }, (_, i) => (i < passed ? run(i, "passed") : run(i, "failed", failedText)))),
  counts: Array.from({ length: of }, (_, i) => counts(`sms:tse_X.s${i % 5}.sms.${Math.floor(i / 5) + 1}`, 4, 5)),
  ...extra,
});

test("Wilson and ratio intervals, and the overlap rule, give fixed answers", () => {
  const p = proportion(8, 10);
  assert.ok(Math.abs(p.low! - 0.4902) < 1e-3 && Math.abs(p.high! - 0.9433) < 1e-3);
  assert.equal(difference(proportion(90, 100), proportion(60, 100)), "lower");
  assert.equal(difference(proportion(60, 100), proportion(90, 100)), "higher");
  assert.equal(difference(proportion(64, 70), proportion(59, 70)), "within_noise");
  assert.equal(difference(proportion(1, 1), ratio([{ y: 1, x: 1 }])), "unknown", "one unit has no interval");
  const spread = ratio([{ y: 2, x: 1 }, { y: 4, x: 1 }, { y: 3, x: 1 }, { y: 3, x: 1 }]);
  assert.equal(spread.value, 3);
  assert.ok(spread.low! < 3 && spread.high! > 3);
  // A gap of 0.05 on a spread of 0.3 needs (2 * 1.96 * 0.3 / 0.05)^2 = 553 conversations; equal estimates cannot be separated.
  assert.equal(conversationsNeeded({ value: 0.9, low: 0, high: 1, n: 10, sd: 0.3 }, { value: 0.85, low: 0, high: 1, n: 10, sd: 0.3 }), 554);
  assert.equal(conversationsNeeded({ value: 0.9, low: 0, high: 1, n: 10, sd: 0.3 }, { value: 0.9, low: 0, high: 1, n: 10, sd: 0.3 }), null);
});

test("a gap inside the noise names no winner and says how many runs would settle it; a clear gap is named", () => {
  const close = buildComparison([variant("current", 64, 70), variant("b", 59, 70)], [], 5);
  assert.equal(close.rows[0]!.versus.b, "within_noise");
  assert.match(close.conclusions.join("\n"), /within noise/);
  assert.match(close.conclusions.join("\n"), /about \d+ runs per scenario would be needed/);
  assert.match(close.conclusions.join("\n"), /Do not pick one on these runs/);
  assert.doesNotMatch(close.conclusions.join("\n"), /higher|lower/);

  const clear = buildComparison([variant("current", 90, 100), variant("b", 60, 100)], [], 5);
  assert.equal(clear.rows[0]!.versus.b, "lower");
  assert.match(clear.conclusions[0]!, /b is lower than current/);
  assert.doesNotMatch(clear.conclusions.join("\n"), /Do not pick one/);
  assert.match(renderComparison(clear).join("\n"), /↓/);
});

test("a judged check added by the comparison is its own row and never changes the pass rate", () => {
  const sentence = "The acknowledgement does not narrate internal steps.";
  const a = variant("current", 10, 10);
  // Every run of b failed only the added sentence: the agent's own checks all passed.
  const b = variant("b", 0, 10, {}, [sentence]);
  const c = buildComparison([a, b], [sentence], 5);
  assert.equal(c.rows[0]!.cells.b!.value, 1);
  const judged = c.rows.find((r) => r.judged)!;
  assert.equal(judged.label, `judged: ${sentence}`);
  assert.equal(judged.cells.current!.value, 1);
  assert.equal(judged.cells.b!.value, 0);
  assert.equal(judged.versus.b, "lower");
});

test("an edit that matched nothing, and a variant that never played are warned about", () => {
  const c = buildComparison([variant("current", 5, 5), variant("b", 5, 5, { unmatchedEdits: ["gone text"] }), { ...variant("c", 0, 0), report: null, counts: null, log: "boom" }], [], 5);
  const text = c.warnings.join("\n");
  assert.match(text, /b: an edit matched no text and changed nothing/);
  assert.match(text, /c did not play: no report \(boom\)/);
  assert.equal(c.variants[2]!.ran, false);
  assert.equal(c.seeded, false);
});

test("a run whose agent met the provider's limits is left out of every row and named, while a model error of its own is counted against the variant", () => {
  const a = variant("current", 5, 5);
  // Every conversation of b hit a 429 on the first scenario's first run: that run says nothing about b.
  const b = variant("b", 4, 5);
  b.counts = b.counts!.map((c, i) => (i === 0 ? { ...c, modelErrors: 1, capacityErrors: 1 } : i === 1 ? { ...c, modelErrors: 1, capacityErrors: 0 } : c));
  b.report!.runs[0]!.verdict = "failed";
  const c = buildComparison([a, b], [], 1);
  assert.equal(c.variants[1]!.runs.counted, 4);
  assert.equal(c.variants[1]!.runs.providerLimited, 1);
  assert.match(c.warnings.join("\n"), /b: 1 run left out because the provider refused model calls/);
  assert.equal(c.rows[0]!.cells.b!.n, 4, "the pass rate counts the other four runs");
  assert.equal(c.rows.find((r) => r.id === "model_errors")!.cells.b!.value, 2 / 5, "both errors show in the errors row, over every first play");
});
