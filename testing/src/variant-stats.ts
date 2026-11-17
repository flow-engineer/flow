// The noise rule of `flow test compare`: when is a difference between two variants more than run-to-run
// luck? One rule, no judgement, the same answer for the same numbers.
//
//   Every estimate has a 95% interval. Pass rate: the Wilson score interval over runs. Every other count: the
//   ratio of totals over conversations (a conversation is the unit that repeats, its turns are not independent),
//   with a Student t interval from the conversations' own spread. Two variants differ on a row only when their
//   intervals do not overlap; otherwise the row is "within noise". It is deliberately cautious: it says
//   "within noise" for some real differences and almost never the reverse. Rows are not corrected for how
//   many there are: one row clearing among many is a lead to confirm with more runs, not a result.
//   When a row is within noise, `runsNeeded` says how many conversations per variant would make the gap
//   seen now clear the rule (if the gap is real and stays the same).

const Z = 1.96;
/** Two-sided 95% Student t, by degrees of freedom 1 to 30; beyond that a value for 31-60, 61-120 and above. */
const T95 = [0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];

export function tCritical(df: number): number {
  return df < 1 ? Infinity : df <= 30 ? T95[df]! : df <= 60 ? 2.0 : df <= 120 ? 1.98 : Z;
}

/** An estimate with its 95% interval. `n` is the units it rests on (runs or conversations); `sd` its per-unit spread. */
export interface Estimate {
  value: number | null;
  low: number | null;
  high: number | null;
  n: number;
  sd: number;
}

/** A share (k of n) with its Wilson score interval. */
export function proportion(k: number, n: number): Estimate {
  if (n === 0) return { value: null, low: null, high: null, n, sd: 0 };
  const p = k / n;
  const z2 = Z * Z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { value: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half), n, sd: Math.sqrt(p * (1 - p)) };
}

/** Σy / Σx over units, its interval from how the units spread (the ratio estimator's linearised variance). Needs two units. */
export function ratio(units: Array<{ y: number; x: number }>, max = Infinity): Estimate {
  const n = units.length;
  const sx = units.reduce((a, u) => a + u.x, 0);
  if (n === 0 || sx === 0) return { value: null, low: null, high: null, n, sd: 0 };
  const sy = units.reduce((a, u) => a + u.y, 0);
  const r = sy / sx;
  if (n < 2) return { value: r, low: null, high: null, n, sd: 0 };
  const mx = sx / n;
  const variance = units.reduce((a, u) => a + (u.y - r * u.x) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance) / mx;
  const half = (tCritical(n - 1) * sd) / Math.sqrt(n);
  // A count or a share cannot be below 0, and a share cannot be above 1.
  return { value: r, low: Math.max(0, r - half), high: Math.min(max, r + half), n, sd };
}

export type Difference = "higher" | "lower" | "within_noise" | "unknown";

/** `b` against the baseline `a`: higher or lower when the intervals do not overlap, else within noise; unknown when an interval does not exist. */
export function difference(a: Estimate, b: Estimate): Difference {
  if (a.low === null || b.low === null || a.high === null || b.high === null) return "unknown";
  if (b.low > a.high) return "higher";
  if (b.high < a.low) return "lower";
  return "within_noise";
}

/** The most runs per scenario a note will promise; past it the answer is "more than". */
export const RUNS_CAP = 1000;

/**
 * How many conversations each variant would need for the gap between `a` and `b` as measured to clear the rule:
 * each half-width must be at most half the gap, so n >= (2 * 1.96 * sd / gap)^2. null when the gap is zero (no
 * number of runs separates equal estimates) or the spread is not known.
 */
export function conversationsNeeded(a: Estimate, b: Estimate): number | null {
  if (a.value === null || b.value === null) return null;
  const gap = Math.abs(a.value - b.value);
  const sd = (a.sd + b.sd) / 2;
  if (gap === 0 || sd === 0) return null;
  return Math.ceil(((2 * Z * sd) / gap) ** 2);
}
