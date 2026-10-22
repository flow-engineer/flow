import type { CostWarning, RunSummary, SessionSummary, Usage } from "./protocol.ts";
import { runVerdict, unsupported } from "./report.ts";

const usd = (n: number) => `$${n.toFixed(4)}`;
const seconds = (ms: number | null) => (ms === null ? "none" : `${(ms / 1000).toFixed(1)} s`);
/** 840, 1.2k, 31k: a token count short enough for a run's line. */
const short = (n: number) => (n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${Math.round(n / 1000)}k`);

/** Whether every play's agent cost was reported: an older cloud says nothing, read as every one (its old meaning). */
export function costKnownOver(runs: Array<{ agentUsage: Usage }>): "all" | "some" | "none" {
  const known = runs.map((r) => r.agentUsage.costKnown ?? "all");
  if (known.every((k) => k === "all")) return "all";
  return known.every((k) => k === "none") ? "none" : "some";
}

/** The agent's cost as a line says it: never $0 when the provider reported none. */
function agentCost(costUsd: number, known: "all" | "some" | "none"): string {
  return known === "none" ? "agent cost not reported by your provider" : `${known === "some" ? "at least " : ""}${usd(costUsd)} agent`;
}

/** The part of a run's line after its outcome: today's acknowledgement and cost from an older cloud, else latency and cost. */
function costAndTime(r: RunSummary): string {
  const t = r.timing;
  if (!t) return `slowest acknowledgement ${r.slowestAckMs === null ? "never" : `${r.slowestAckMs} ms`}; cost ${usd(r.agentUsage.costUsd)} agent + ${usd(r.testUsage.costUsd)} test`;
  const unanswered = t.firstReply.unanswered ? ` (${t.firstReply.unanswered} unanswered)` : "";
  const reply = t.firstReply.p50 === null ? "first reply never" : `first reply p50 ${seconds(t.firstReply.p50)}, p95 ${seconds(t.firstReply.p95)}`;
  const u = r.agentUsage;
  const cached = u.cacheRead ? `, ${short(u.cacheRead)} cached` : "";
  return `${reply}${unanswered}; turn p95 ${seconds(t.turn.p95)}; ${u.costKnown === "none" ? "" : "cost "}${agentCost(u.costUsd, u.costKnown ?? "all")} (${short(u.input)} in, ${short(u.output)} out${cached}) + ${usd(r.testUsage.costUsd)} test`;
}

/** Prints each run once. A run already shown as it finished is not printed again with the summary. */
export function runPrinter(log: (line: string) => void = console.log): (run: RunSummary) => void {
  const printed = new Set<string>();
  return (r) => {
    // The cloud's second play of a failed run is shown under its original, from the original's `rerun`.
    if (r.rerunOf || printed.has(r.runId)) return;
    printed.add(r.runId);
    const verdict = runVerdict(r);
    // A scenario the cloud could not play: its file and what is wrong in it, not a run of the agent.
    if (r.invalid) {
      log(`INVALID  ${r.scenario} #${r.run} (${r.channel}) ${r.runId}: the cloud could not play this scenario: ${r.invalid.path}: ${r.invalid.reason}${unsupported(r.invalid.reason)}`);
      return;
    }
    const gaveUp = verdict === "passed" && r.ended === "gave_up" ? " (passed, the person gave up)" : "";
    const retried = r.retried ? "; tried once more" : "";
    const stored = r.replayed ? r.replayed.person + r.replayed.tools + r.replayed.judge : 0;
    const replayed = stored ? `; replayed ${stored} stored simulator answer${stored === 1 ? "" : "s"}` : "";
    // An errored run: the cloud could not play or judge it, so its checks say nothing about the agent.
    const error = verdict === "errored" ? `; error: ${r.error ?? r.ended} (the cloud could not play or judge this run, not the agent's fault)` : "";
    const label = verdict === "errored" ? "ERROR" : verdict === "passed" ? "PASS" : verdict === "flaky" ? "FLAKY" : "FAIL";
    log(`${label}  ${r.scenario} #${r.run} (${r.channel}) ${r.runId}: ${r.turns} turn${r.turns === 1 ? "" : "s"}, ended: ${r.ended}${gaveUp}${retried}${replayed}${error}; ${costAndTime(r)}`);
    if (verdict !== "errored") for (const c of r.checks.filter((c) => !c.pass)) log(`      ✗ ${c.kind}: ${c.text}\n        ${c.reason}`);
    log(`      watch: ${r.watch}`);
    if (r.rerun) log(`      played again: ${r.rerun.passed ? "passed" : "failed"} ${r.rerun.watch}`);
  };
}

/** A warning's number in its own unit. */
const amount = (metric: CostWarning["metric"], n: number) => (metric === "cost_usd" ? usd(n) : seconds(n));
const what = { cost_usd: "cost", first_reply_ms: "p95 first reply", turn_ms: "p95 agent turn" } as const;
const change = (w: CostWarning) => (w.baseline ? Math.round(((w.value - w.baseline) / w.baseline) * 100) : undefined);

/**
 * The session summary's cost, latency and warning lines. An older cloud sends no latency or warnings: only
 * the Cost line, as before. Cost counts every play, second plays included: the cloud spent it.
 */
export function sessionLines(summary: Pick<SessionSummary, "runs" | "latency" | "warnings" | "improvements">): string[] {
  const total = (pick: (r: RunSummary) => number | undefined) => summary.runs.reduce((n, r) => n + (pick(r) ?? 0), 0);
  const tokens = (n: number) => n.toLocaleString("en-US");
  const cached = total((r) => r.agentUsage.cacheRead);
  const lines = [`Cost: ${agentCost(total((r) => r.agentUsage.costUsd), costKnownOver(summary.runs))} (${tokens(total((r) => r.agentUsage.input))} in, ${tokens(total((r) => r.agentUsage.output))} out${cached ? `, ${tokens(cached)} cached` : ""}) + ${usd(total((r) => r.testUsage.costUsd))} test models.`];
  const l = summary.latency;
  if (l) {
    const slow = l.firstReply.slowest && l.firstReply.max !== null ? ` (slowest ${seconds(l.firstReply.max)}, ${l.firstReply.slowest.scenario} #${l.firstReply.slowest.run})` : "";
    const reply = l.firstReply.p50 === null ? "first reply never" : `first reply p50 ${seconds(l.firstReply.p50)}, p95 ${seconds(l.firstReply.p95)}${slow}`;
    const { modelMs, toolsMs, ownMs } = l.split;
    const all = modelMs + toolsMs + ownMs;
    const pct = (ms: number) => `${Math.round((ms / all) * 100)}%`;
    const split = all > 0 ? `: model ${pct(modelMs)}, tools ${pct(toolsMs)} (simulated), agent ${pct(ownMs)}` : "";
    lines.push(`Latency: ${reply}; agent turn p95 ${seconds(l.turn.p95)}${split}.`);
  }
  const warnings = summary.warnings ?? [];
  if (warnings.length) {
    lines.push("Warnings:");
    for (const w of warnings) {
      const was = w.kind === "budget" ? `, budget ${amount(w.metric, w.limit ?? 0)}` : `, was ${amount(w.metric, w.baseline ?? 0)}${change(w) === undefined ? "" : ` (${change(w)! >= 0 ? "+" : ""}${change(w)}%)`}`;
      lines.push(`  ${w.path} (${w.channel}): ${what[w.metric]} ${amount(w.metric, w.value)}${w.metric === "cost_usd" ? " per run" : ""}${was}`);
    }
    if (warnings.some((w) => w.kind === "regression" && (w.runs === 1 || w.baselineRuns === 1))) lines.push("  A regression from 1 run is noisy: run flow test --runs 3 to confirm it.");
  }
  const better = (summary.improvements ?? []).map((w) => `${w.path} (${w.channel}) ${what[w.metric]} down ${change(w) === undefined ? "" : `${-change(w)!}%`}`.trimEnd());
  if (better.length) lines.push(`Improvements: ${better.join("; ")}.`);
  return lines;
}
