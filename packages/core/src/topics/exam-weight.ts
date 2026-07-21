/**
 * The exam-weight blend (PLAN §9's *"Weight computation (pure function in `packages/core`),
 * 0–1 per topic"*).
 *
 * A topic's exam weight is a single number in `[0, 1]` that reorders a student's revision
 * plan, so the arithmetic behind it lives here — pure, I/O-free, clock-free — for the same
 * reason `assessment-weights.ts` does: the same function has to serve the pipeline's
 * recompute step, a future what-if panel, and any test that wants to pin the blend against a
 * frozen corpus, none of which can share a database round-trip.
 *
 * ## The four terms, and the one that is not a term
 *
 * §9 names four inputs (a)–(d). Three of them *blend*; the fourth *overrides*:
 *
 *  - **(a) instructor `examSignals`** — the strongest term. A lecturer saying "this is on the
 *    exam" is worth more than any amount of inferred structure, so its weight dominates and a
 *    single mapped signal moves the number materially.
 *  - **(b) coverage** — how many documents/sessions fed the topic, and how recently. Breadth
 *    without recency is a topic covered once early and never again; recency without breadth is
 *    a single fresh mention. Both matter, so both are folded in.
 *  - **(c) artifact density** — formulas and worked examples are what testable material looks
 *    like, so a page dense with them is more likely to be examined than a page of prose.
 *  - **(d) `exam_weight_override`** — NOT a term. When the user has set it, it **wins
 *    outright**: the function returns it and blends nothing, because §9 says "the user is
 *    allowed to be right about their own exam" and a blend that merely *weighted* the override
 *    heavily would still let the computed terms drag it, which is precisely the thing an
 *    override exists to stop.
 *
 * ## Why the floor is not 0.5
 *
 * `topics.exam_weight` defaults to `0.5` in the schema, but that default is an *inert
 * placeholder* for a topic nothing has been computed for yet — it is deliberately NOT the
 * value this function returns for a weakly-supported topic. A topic with no exam signals, a
 * single stale source and no artifacts is, on the evidence, only weakly exam-relevant, and it
 * should sit near the low floor so the ordering it produces means something. Returning 0.5
 * there would make the computed weight indistinguishable from "not yet computed", which is the
 * failure this floor exists to prevent.
 */

/** A topic's blended exam weight sits in `[0, 1]`, matching the column's `check`. */
export const EXAM_WEIGHT_MIN = 0;
export const EXAM_WEIGHT_MAX = 1;

/**
 * The residual weight a topic carries just for existing — well below the `0.5` default so a
 * bare topic reads as "weakly relevant", not "uncomputed". Small enough that the blend, not
 * the floor, decides the ordering.
 */
export const EXAM_WEIGHT_FLOOR = 0.05;

/**
 * How the three blended terms divide the headroom above the floor. Signals dominate (§9: "the
 * strongest term"); coverage is next; artifact density is the tie-breaker.
 *
 * They sum to **0.95**, exactly `1 - FLOOR`. This is load-bearing, not cosmetic: each sub-score
 * is a saturating curve that approaches but never reaches 1, so `FLOOR + 0.95·(subscores)`
 * approaches but never reaches 1.0 for any finite input. If the terms summed to 1.0 the
 * pre-clamp blend would asymptote *above* 1.0 and cross it at ~27 symmetric counts, pinning
 * every strongly-supported topic to exactly 1.0 through `clamp01` — and a weight whose whole
 * job is to *order* revision priority must not collapse its top end into a flat ceiling.
 */
export const EXAM_WEIGHT_TERMS = {
  signal: 0.475,
  coverage: 0.285,
  artifact: 0.19,
} as const;

/**
 * Saturation half-lives: the count at which each sub-score reaches 0.5. Chosen so *one*
 * mapped signal is already worth half of the signal term (signals are cheap to trust and
 * rare), while coverage and artifacts need a small handful before they saturate.
 */
export const EXAM_WEIGHT_HALF = {
  /** One signal → 0.5 of the signal sub-score. */
  signal: 1,
  /** Two sources → 0.5 of the breadth sub-score. */
  sourceBreadth: 2,
  /** Three artifacts → 0.5 of the artifact sub-score. */
  artifact: 3,
} as const;

export interface ExamWeightInput {
  /**
   * `topics.exam_weight_override`. When non-null it wins outright — the function returns it
   * (clamped) and blends nothing. `null` hands the topic to the computed blend below.
   */
  readonly override: number | null;
  /**
   * How many instructor exam signals map to this topic (the count `mapExamSignals` produces).
   * The strongest term.
   */
  readonly signalCount: number;
  /** How many documents/sessions fed this topic — `topic_sources` rows for it. */
  readonly sourceCount: number;
  /**
   * Recency of the topic's newest source, normalised to `[0, 1]` by the caller: `1` = the
   * course's most recent material, `0` = its oldest (or unknown). Pure code has no clock, so
   * this is pre-digested; the pipeline derives it from `documents.created_at` ordering.
   */
  readonly recencyFactor: number;
  /** Formulas on the topic page — an artifact-density signal. */
  readonly formulaCount: number;
  /** Worked examples on the topic page — an artifact-density signal. */
  readonly workedExampleCount: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return EXAM_WEIGHT_MIN;
  return Math.min(EXAM_WEIGHT_MAX, Math.max(EXAM_WEIGHT_MIN, value));
}

/**
 * A saturating `count → [0, 1)` curve. `0 → 0`, `half → 0.5`, growing monotonically and
 * never quite reaching 1. Monotonic in `count`, which is what makes signal monotonicity a
 * property of the blend rather than a coincidence of the constants.
 */
function saturate(count: number, half: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return count / (count + half);
}

/**
 * Blends a topic's exam weight into `[0, 1]`, or returns the user's override outright.
 *
 * Pure: hand it the counts, get back the number. The pipeline's recompute step is the only
 * production caller, and it computes every input from already-fetched rows.
 */
export function computeExamWeight(input: ExamWeightInput): number {
  // (d) — the override wins outright. Checked first and returned directly: a blend that
  // merely weighted it heavily would still let the computed terms move it, which is the one
  // thing an override must not allow.
  if (input.override !== null) {
    return clamp01(input.override);
  }

  // (a) — instructor signals, the strongest term.
  const signalScore = saturate(input.signalCount, EXAM_WEIGHT_HALF.signal);

  // (b) — coverage: breadth (how many sources) modulated by recency (how fresh the newest is).
  // Recency never zeroes breadth entirely — a topic covered once, long ago, is still covered —
  // so it scales between half and full credit rather than 0 and 1.
  const breadth = saturate(input.sourceCount, EXAM_WEIGHT_HALF.sourceBreadth);
  const coverageScore = breadth * (0.5 + 0.5 * clamp01(input.recencyFactor));

  // (c) — artifact density: formulas + worked examples together.
  const artifactScore = saturate(
    input.formulaCount + input.workedExampleCount,
    EXAM_WEIGHT_HALF.artifact,
  );

  const blended =
    EXAM_WEIGHT_FLOOR +
    EXAM_WEIGHT_TERMS.signal * signalScore +
    EXAM_WEIGHT_TERMS.coverage * coverageScore +
    EXAM_WEIGHT_TERMS.artifact * artifactScore;

  return clamp01(blended);
}
