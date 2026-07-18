/**
 * The arithmetic behind a course's assessment weights.
 *
 * This is the first piece of the Grade & Semester Cockpit's math to land (PLAN
 * "Grade & Semester Cockpit" (c): *all math is pure `packages/core`*). It is
 * deliberately framework-free and I/O-free so the same functions serve the
 * server render, a future client-side what-if panel, and the exam planner's
 * objective function without a round-trip.
 */

/** What a syllabus is *supposed* to add up to. */
export const WEIGHT_TOTAL_TARGET = 100;

/**
 * How far from 100 still counts as balanced. `weight_percent` is
 * `numeric(5,2)`, so a hundredth is the smallest difference the database can
 * even represent — anything inside that is rounding, not a real gap.
 */
export const WEIGHT_TOTAL_TOLERANCE = 0.01;

export type WeightTotalVerdict =
  /** No components recorded yet — nothing to be right or wrong about. */
  | "empty"
  /** Sums to 100 (within tolerance). */
  | "balanced"
  /** Sums to less than 100 — components are probably still missing. */
  | "under"
  /** Sums to more than 100 — usually a double-counted component. */
  | "over";

/**
 * Sums percentages without float drift.
 *
 * `0.1 + 0.2 !== 0.3` would surface here as a total of `99.99999999999999`
 * against a tolerance of `0.01` — which happens to pass, but only by luck.
 * Summing in hundredths (the column's own precision) makes it exact instead.
 */
export function sumWeightPercent(weights: readonly number[]): number {
  return toHundredths(weights.reduce((total, weight) => total + Math.round(weight * 100), 0) / 100);
}

/**
 * A percentage as a whole number of hundredths — the column's own precision,
 * and the only unit in this module where comparison is exact.
 *
 * This is not decoration. `99.99 - 100` is `-0.010000000000005116`, so the
 * obvious `Math.abs(total - 100) <= 0.01` reports a syllabus that adds up
 * perfectly as *under*-weighted. Every comparison below therefore happens in
 * integers, and the division back to a percentage happens exactly once, at the
 * end.
 */
function hundredthsOf(value: number): number {
  return Math.round(value * 100);
}

function toHundredths(value: number): number {
  return hundredthsOf(value) / 100;
}

const TARGET_HUNDREDTHS = hundredthsOf(WEIGHT_TOTAL_TARGET);
const TOLERANCE_HUNDREDTHS = hundredthsOf(WEIGHT_TOTAL_TOLERANCE);

/**
 * Classifies a weight total.
 *
 * This is deliberately advisory. A real syllabus does not always add up to 100
 * — an extra-credit component, a "best 3 of 4" rule, a lecturer who rounded —
 * and the person holding the syllabus knows more than we do. So nothing here
 * blocks a write; the UI warns and moves on.
 */
export function weightTotalVerdict(total: number, count: number): WeightTotalVerdict {
  if (count === 0) return "empty";

  const delta = hundredthsOf(total) - TARGET_HUNDREDTHS;
  if (Math.abs(delta) <= TOLERANCE_HUNDREDTHS) return "balanced";
  return delta > 0 ? "over" : "under";
}

/**
 * Signed distance from 100, rounded to the column's precision. Positive is
 * over-weighted. Callers render it punctuated in a semantic colour (PLAN
 * "Hero numbers": *the delta … punctuated in accent/semantic colour*).
 */
export function weightTotalDelta(total: number): number {
  return (hundredthsOf(total) - TARGET_HUNDREDTHS) / 100;
}
