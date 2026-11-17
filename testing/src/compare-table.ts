// The comparison `flow test compare` prints: one table of the variants' results and, for each row, whether a
// difference from the baseline (the first variant) clears the noise rule (variant-stats.ts). Pure: the
// children's reports and events go in, the table and its JSON come out.

import type { JsonReport, ReportRun } from "./report.ts";
import type { ChildResult } from "./variants.ts";
import { conversationRun, type ConversationCounts } from "./variant-counts.ts";
import { conversationsNeeded, difference, proportion, ratio, RUNS_CAP, type Difference, type Estimate } from "./variant-stats.ts";
import type { VariantSpec } from "./variants.ts";

export interface VariantResult {
  name: string;
  spec: VariantSpec;
  /** The child's --json report; null when it printed none (it did not start). */
  report: JsonReport | null;
  exitCode: number | null;
  wallMs: number;
  /** Per conversation, from the agent's events; null for an agent elsewhere (--agent-url) or when no event came. */
  counts: ConversationCounts[] | null;
  /** Edits of this variant that matched no text: the override did nothing. */
  unmatchedEdits: string[];
  /** The child's own list of which conversation each run was; absent: a run's file name is taken for the cloud's scenario id. */
  runKeys?: ChildResult["runs"];
  log: string;
}

type Unit = "percent" | "count" | "seconds" | "tokens" | "usd";

interface RowDef {
  id: string;
  label: string;
  unit: Unit;
  judged: boolean;
}

export interface Cell {
  value: number | null;
  low: number | null;
  high: number | null;
  /** Runs (pass rate, judged) or conversations the number rests on. */
  n: number;
  /** How many of those passed, for a share of runs. */
  k?: number;
}

export interface Row extends RowDef {
  cells: Record<string, Cell | null>;
  /** Each non-baseline variant against the baseline. */
  versus: Record<string, Difference>;
  /** Runs per scenario that would make the gap seen now clear the rule; null when the gap is zero or unknown; "more than N" past the cap. */
  runsNeeded: Record<string, number | null>;
}

export interface Comparison {
  version: 1;
  baseline: string;
  runsPerScenario: number;
  seeded: false;
  noiseRule: string;
  variants: Array<{
    name: string;
    change: VariantSpec;
    ran: boolean;
    outcome: string | null;
    exitCode: number | null;
    sessionId: string | null;
    dashboard: string | null;
    wallSeconds: number;
    costUsd: { agent: number; test: number; total: number } | null;
    runs: { counted: number; passed: number; failed: number; flaky: number; notCounted: number; providerLimited: number };
    conversations: number | null;
    turns: number | null;
    error: string | null;
  }>;
  rows: Row[];
  conclusions: string[];
  warnings: string[];
}

export const NOISE_RULE = "A difference counts only when the 95% intervals of the two variants do not overlap (pass rate: Wilson interval over runs; every other count: ratio of totals with a t interval over conversations); otherwise it is within noise. Rows are not corrected for how many there are.";

const COUNT_ROWS: Array<RowDef & { y: (c: ConversationCounts) => number; x: (c: ConversationCounts) => number }> = [
  { id: "messages_per_turn", label: "messages per turn", unit: "count", judged: false, y: (c) => c.messages, x: (c) => c.turns },
  { id: "multi_message_turns", label: "turns with more than one message", unit: "percent", judged: false, y: (c) => c.multiMessageTurns, x: (c) => c.turns },
  { id: "model_calls_per_turn", label: "model calls per turn", unit: "count", judged: false, y: (c) => c.modelCalls, x: (c) => c.turns },
  { id: "model_seconds_per_turn", label: "model time per turn", unit: "seconds", judged: false, y: (c) => c.modelMs / 1000, x: (c) => c.turns },
  { id: "first_reply_seconds", label: "time to first reply", unit: "seconds", judged: false, y: (c) => c.replyMs / 1000, x: (c) => c.repliedTurns },
  { id: "tool_calls_per_turn", label: "tool calls per turn", unit: "count", judged: false, y: (c) => c.toolCalls, x: (c) => c.turns },
  { id: "text_beside_later_tools", label: "turns with text beside a 2nd+ round of tool calls", unit: "percent", judged: false, y: (c) => c.textBesideLaterTools, x: (c) => c.turns },
  { id: "extra_call_to_send", label: "turns needing an extra model call to send the answer", unit: "percent", judged: false, y: (c) => c.extraCallToSend, x: (c) => c.turns },
  { id: "input_tokens", label: "input tokens per conversation", unit: "tokens", judged: false, y: (c) => c.inputTokens, x: () => 1 },
  { id: "output_tokens", label: "output tokens per conversation", unit: "tokens", judged: false, y: (c) => c.outputTokens, x: () => 1 },
  { id: "cached_tokens", label: "cached input tokens per conversation", unit: "tokens", judged: false, y: (c) => c.cachedTokens, x: () => 1 },
];

const COUNTED = new Set(["passed", "failed", "flaky"]);

/** A run's verdict with the extra judged checks left out: a run that failed only on a sentence this comparison added passed on the agent's own checks. */
function ownVerdict(run: ReportRun, judge: Set<string>): "passed" | "failed" | "flaky" | null {
  if (!COUNTED.has(run.verdict)) return null;
  if (run.verdict !== "passed" && run.failedChecks.length && run.failedChecks.every((c) => judge.has(c.text))) return "passed";
  return run.verdict as "passed" | "failed" | "flaky";
}

const cell = (e: Estimate, k?: number): Cell => ({ value: e.value, low: e.low, high: e.high, n: e.n, ...(k !== undefined ? { k } : {}) });

export function buildComparison(results: VariantResult[], judge: string[], runsPerScenario: number): Comparison {
  const baseline = results[0]!.name;
  const sentences = new Set(judge);
  const failOnFlaky = results.some((r) => r.report?.strict);
  const warnings: string[] = [];

  // A run whose agent met the provider's limits (HTTP 429 or 5xx on a model call) says nothing about the variant: it is left out of every row, by this rule.
  const limited = new Map<VariantResult, Set<string>>();
  const limitedRuns = (r: VariantResult): Set<string> => {
    let ids = limited.get(r);
    if (ids) return ids;
    const bad = new Set<string>();
    for (const c of r.counts ?? []) {
      const key = c.capacityErrors ? conversationRun(c.conversationId) : null;
      if (key && !key.rerun) bad.add(`${key.scenario}\n${key.channel}\n${key.run}`);
    }
    // The child says which conversation each run was; without it a run's file name is taken for the scenario's id.
    const keys = r.runKeys?.length ? r.runKeys : (r.report?.runs ?? []).flatMap((run) => (run.runId ? [{ runId: run.runId, scenario: run.scenario, channel: run.channel, run: run.run }] : []));
    ids = new Set(keys.filter((k) => bad.has(`${k.scenario}\n${k.channel}\n${k.run}`)).map((k) => k.runId));
    limited.set(r, ids);
    return ids;
  };
  const runsOf = (r: VariantResult) => (r.report?.runs ?? []).filter((run) => !(run.runId && limitedRuns(r).has(run.runId))).map((run) => ({ run, verdict: ownVerdict(run, sentences) })).filter((x) => x.verdict !== null) as Array<{ run: ReportRun; verdict: "passed" | "failed" | "flaky" }>;
  const units = new Set((results[0]!.report?.runs ?? []).map((r) => `${r.scenario}\n${r.channel}`)).size || 1;

  const rows: Row[] = [];
  const addRow = (def: RowDef, estimate: (r: VariantResult) => Cell | null, raw: (r: VariantResult) => Estimate | null) => {
    const cells: Record<string, Cell | null> = {};
    const versus: Record<string, Difference> = {};
    const runsNeeded: Record<string, number | null> = {};
    const base = raw(results[0]!);
    for (const r of results) {
      cells[r.name] = estimate(r);
      if (r.name === baseline) continue;
      const mine = raw(r);
      versus[r.name] = base && mine ? difference(base, mine) : "unknown";
      const needed = base && mine ? conversationsNeeded(base, mine) : null;
      runsNeeded[r.name] = needed === null ? null : Math.min(RUNS_CAP + 1, Math.max(runsPerScenario + 1, Math.ceil(needed / units)));
    }
    rows.push({ ...def, cells, versus, runsNeeded });
  };

  const rate = (r: VariantResult) => {
    const runs = runsOf(r);
    const passed = runs.filter((x) => x.verdict === "passed" || (x.verdict === "flaky" && !failOnFlaky)).length;
    return { runs, passed, estimate: proportion(passed, runs.length) };
  };
  addRow({ id: "pass_rate", label: "pass rate", unit: "percent", judged: false }, (r) => { const p = rate(r); return r.report ? cell(p.estimate, p.passed) : null; }, (r) => (r.report ? rate(r).estimate : null));
  addRow({ id: "flaky_runs", label: "of which flaky (failed, passed when played again)", unit: "percent", judged: false }, (r) => { const runs = runsOf(r); return r.report ? cell(proportion(runs.filter((x) => x.verdict === "flaky").length, runs.length), runs.filter((x) => x.verdict === "flaky").length) : null; }, (r) => { const runs = runsOf(r); return r.report ? proportion(runs.filter((x) => x.verdict === "flaky").length, runs.length) : null; });

  const firstPlays = (r: VariantResult) => (r.counts ?? []).filter((c) => !conversationRun(c.conversationId)?.rerun);
  const conversations = (r: VariantResult) => firstPlays(r).filter((c) => c.turns > 0 && !c.capacityErrors);
  for (const def of COUNT_ROWS) {
    const est = (r: VariantResult): Estimate | null => (r.counts ? ratio(conversations(r).map((c) => ({ y: def.y(c), x: def.x(c) })).filter((u) => u.x > 0), def.unit === "percent" ? 1 : Infinity) : null);
    addRow(def, (r) => { const e = est(r); return e ? cell(e) : null; }, est);
  }
  const errors = (r: VariantResult): Estimate | null => (r.counts ? ratio(firstPlays(r).map((c) => ({ y: c.modelErrors, x: 1 }))) : null);
  addRow({ id: "model_errors", label: "turns failed on a model error, per conversation (all runs)", unit: "count", judged: false }, (r) => { const e = errors(r); return e ? cell(e) : null; }, errors);
  const cost = (r: VariantResult): Estimate | null => {
    const priced = conversations(r).filter((c) => c.costUsd !== null);
    return r.counts && priced.length ? ratio(priced.map((c) => ({ y: c.costUsd!, x: 1 }))) : null;
  };
  addRow({ id: "cost_per_conversation", label: "agent cost per conversation", unit: "usd", judged: false }, (r) => { const e = cost(r); return e ? cell(e) : null; }, cost);

  for (const sentence of judge) {
    const est = (r: VariantResult): { e: Estimate; k: number } | null => {
      const runs = runsOf(r);
      if (!r.report || !runs.length) return null;
      const passed = runs.filter((x) => !x.run.failedChecks.some((c) => c.text === sentence)).length;
      return { e: proportion(passed, runs.length), k: passed };
    };
    addRow({ id: `judged:${sentence}`, label: `judged: ${sentence}`, unit: "percent", judged: true }, (r) => { const x = est(r); return x ? cell(x.e, x.k) : null; }, (r) => est(r)?.e ?? null);
  }

  // What each variant did.
  const variants: Comparison["variants"] = results.map((r) => {
    const runs = runsOf(r);
    const report = r.report;
    const passed = runs.filter((x) => x.verdict === "passed" || (x.verdict === "flaky" && !failOnFlaky)).length;
    const conv = r.counts ? conversations(r) : null;
    return {
      name: r.name,
      change: r.spec,
      ran: !!report?.sessionId,
      outcome: report?.outcome ?? null,
      exitCode: report?.exitCode ?? r.exitCode,
      sessionId: report?.sessionId ?? null,
      dashboard: report?.dashboard ?? null,
      wallSeconds: Math.round(r.wallMs / 100) / 10,
      costUsd: report ? { agent: report.costUsd.agent, test: report.costUsd.test, total: report.costUsd.agent + report.costUsd.test } : null,
      runs: { counted: runs.length, passed, failed: runs.filter((x) => x.verdict === "failed").length, flaky: runs.filter((x) => x.verdict === "flaky").length, notCounted: (report?.runs.length ?? 0) - runs.length, providerLimited: report ? limitedRuns(r).size : 0 },
      conversations: conv ? conv.length : null,
      turns: conv ? conv.reduce((n, c) => n + c.turns, 0) : null,
      error: report?.error?.message ?? (report ? null : `no report (${r.log || "the process printed nothing"})`),
    };
  });

  for (const v of variants) {
    if (!v.ran) warnings.push(`${v.name} did not play: ${v.error ?? "unknown"}. It is left out of the comparison.`);
    else {
      if (v.runs.providerLimited) warnings.push(`${v.name}: ${v.runs.providerLimited} run${v.runs.providerLimited === 1 ? "" : "s"} left out because the provider refused model calls (HTTP 429 or 5xx): that says nothing about the variant. Lower --concurrency (by default 12 runs at once are shared among the variants) or run again.`);
      const other = v.runs.notCounted - v.runs.providerLimited;
      if (other > 0) warnings.push(`${v.name}: ${other} run${other === 1 ? "" : "s"} errored, hit the credit limit or never played; they are not counted.`);
    }
  }
  for (const r of results) if (r.unmatchedEdits.length) warnings.push(`${r.name}: ${r.unmatchedEdits.length === 1 ? "an edit matched" : `${r.unmatchedEdits.length} edits matched`} no text and changed nothing (find: ${r.unmatchedEdits.map((t) => JSON.stringify(t.length > 60 ? `${t.slice(0, 57)}...` : t)).join(", ")}): this variant is the baseline's wording, so its numbers say nothing about it.`);
  const counted = variants.filter((v) => v.ran).map((v) => v.runs.counted);
  if (counted.length && Math.min(...counted) !== Math.max(...counted)) warnings.push(`The variants have different numbers of counted runs (${variants.filter((v) => v.ran).map((v) => `${v.name} ${v.runs.counted}`).join(", ")}): a run that errored is not replaced.`);
  for (const r of results) if (r.report?.sessionId && r.counts === null && !r.spec.agentUrl) warnings.push(`${r.name}: no events came from the agent, so its counts are not shown.`);
  if (results.some((r) => r.spec.agentUrl)) warnings.push("A variant with agentUrl runs on another framework: only pass rate and judged checks are shown for it (its model calls are not visible from here).");

  // What the numbers allow us to say.
  const conclusions: string[] = [];
  const passRow = rows[0]!;
  const fmt = (c: Cell | null) => (c?.value == null ? "n/a" : `${(c.value * 100).toFixed(1)}%`);
  const clear: string[] = [];
  for (const v of variants.slice(1)) {
    const d = passRow.versus[v.name];
    if (!v.ran || !variants[0]!.ran) continue;
    if (d === "higher" || d === "lower") {
      clear.push(v.name);
      conclusions.push(`Pass rate: ${v.name} is ${d} than ${baseline} (${fmt(passRow.cells[v.name]!)} against ${fmt(passRow.cells[baseline]!)}) and the gap clears the noise rule.`);
    } else {
      const need = passRow.runsNeeded[v.name];
      const how = need === null || need === undefined ? "The two rates are equal, so no number of runs separates them." : need > RUNS_CAP ? `A gap this small would need more than ${RUNS_CAP} runs per scenario to settle.` : `To settle a gap of this size, about ${need} runs per scenario would be needed (--runs ${need}; this comparison had ${runsPerScenario}).`;
      conclusions.push(`Pass rate: ${v.name} against ${baseline} is within noise (${fmt(passRow.cells[v.name]!)} against ${fmt(passRow.cells[baseline]!)}). ${how}`);
    }
  }
  if (variants.slice(1).some((v) => v.ran) && variants[0]!.ran && !clear.length) conclusions.push(`No variant is shown better or worse than ${baseline} on pass rate. Do not pick one on these runs.`);
  const others = rows.slice(1).flatMap((row) => Object.entries(row.versus).filter(([, d]) => d === "higher" || d === "lower").map(([name, d]) => `${row.label} (${name} ${d})`));
  if (others.length) conclusions.push(`Other rows that clear the rule against ${baseline}: ${others.join("; ")}. With this many rows, expect about one in twenty to clear by chance: confirm a single one with more runs.`);
  else if (rows.length > 2) conclusions.push(`Every other row is within noise.`);

  return { version: 1, baseline, runsPerScenario, seeded: false, noiseRule: NOISE_RULE, variants, rows, conclusions, warnings };
}

function show(unit: Unit, v: number): string {
  switch (unit) {
    case "percent": return `${(v * 100).toFixed(1)}%`;
    case "seconds": return `${v.toFixed(2)} s`;
    case "tokens": return Math.round(v).toLocaleString("en-US");
    case "usd": return `$${v.toFixed(4)}`;
    default: return v.toFixed(2);
  }
}

const MARK: Record<Difference, string> = { higher: "↑", lower: "↓", within_noise: "=", unknown: "?" };

function text(row: Row, name: string): string {
  const c = row.cells[name];
  if (!c || c.value === null) return "n/a";
  const own = show(row.unit, c.value);
  if (c.low === null || c.high === null) return `${own} (n=${c.n})`;
  // A share of runs has an uneven interval (Wilson); the others are symmetric.
  const spread = row.id === "pass_rate" || row.id === "flaky_runs" || row.judged ? `[${show(row.unit, c.low)}–${show(row.unit, c.high)}]` : `±${show(row.unit, (c.high - c.low) / 2).replace(/ s$/, "")}`;
  return `${own} ${spread}${c.k !== undefined ? ` ${c.k}/${c.n}` : ""}`;
}

/** The table as lines of text. */
export function renderComparison(c: Comparison): string[] {
  const names = c.variants.map((v) => v.name);
  const head = ["", ...names.map((n, i) => (i === 0 ? `${n} (baseline)` : n))];
  const table: string[][] = [head];
  table.push(["session time", ...c.variants.map((v) => `${v.wallSeconds.toFixed(0)} s`)]);
  table.push(["cost (agent + test)", ...c.variants.map((v) => (v.costUsd ? `$${v.costUsd.agent.toFixed(3)} + $${v.costUsd.test.toFixed(3)}` : "n/a"))]);
  table.push(["runs counted · conversations · turns", ...c.variants.map((v) => `${v.runs.counted} · ${v.conversations ?? "n/a"} · ${v.turns ?? "n/a"}`)]);
  const judged = c.rows.filter((r) => r.judged);
  for (const row of c.rows) {
    const label = row.judged ? `judged #${judged.indexOf(row) + 1}` : row.label;
    table.push([label, ...names.map((n, i) => { const t = text(row, n); const d = i === 0 ? "" : row.versus[n]; return d ? `${t} ${MARK[d]}` : t; })]);
  }
  const widths = head.map((_, i) => Math.max(...table.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((x, i) => x.padEnd(widths[i]!)).join("  ").trimEnd();
  const out = ["", line(table[0]!), widths.map((w) => "-".repeat(w)).join("  ")];
  for (const r of table.slice(1)) out.push(line(r));
  for (const [i, row] of judged.entries()) out.push(`judged #${i + 1}: ${row.label.slice("judged: ".length)}`);
  out.push("", "↑ higher and ↓ lower than the baseline clear the noise rule; = is within noise; ? has no interval to compare (too few runs). [a–b] and ± are 95% intervals.");
  for (const x of c.conclusions) out.push(x);
  for (const w of c.warnings) out.push(`Warning: ${w}`);
  for (const v of c.variants) if (v.dashboard) out.push(`${v.name}: ${v.dashboard}`);
  return out;
}
