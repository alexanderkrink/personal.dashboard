/**
 * The single-topic funnel backstop (Wave 6) — **code, not LLM**, and a guard that CAN fire.
 *
 * On 2026-07-21 a real 47-segment deck hit an empty course and `topic-routing@1` funnelled
 * every segment into one create. Everything downstream then worked perfectly — 47 pages
 * mapped, 70/70 citations resolved, coverage `trustworthy: true` — and `topicCount: 1`
 * shipped without a single durable flag, where the acceptance band requires 4–12 topics.
 * The page-level trust machinery measures whether content *reached* the notes; nothing
 * measured whether it reached them in a navigable shape.
 *
 * The prompt fix (v2's empty-index mode) is the primary repair, and it is probabilistic: a
 * prompt cannot be proven to hold for every deck. This predicate is the deterministic
 * backstop behind it, deliberately downstream of every model call so no routing output can
 * argue it out of firing:
 *
 *     empty index at routing time  ∧  ≥ {@link FUNNEL_MIN_SEGMENTS} routed segments
 *     ∧  exactly 1 resulting merge target
 *     ⇒  the created topic is flagged `needs_review`, with this note as the reason.
 *
 * **It flags; it never blocks.** A student who uploaded a deck and got one reviewable page
 * is strictly better off than one who got nothing — the flag rides the same durable
 * `needs_review` channel on the topic's first revision that Wave 5 built for grounding
 * findings, so the review chip appears on the page itself.
 *
 * Pure: no I/O, no clock, no `process.env`.
 */

/**
 * Below this many routed segments, one topic is a legitimate outcome, not a funnel.
 *
 * 12 is the upper edge of the 4–12 topics-per-document acceptance band: a document with
 * fewer segments than the band's ceiling can plausibly be one concept treated at length,
 * and flagging it would teach the reader to ignore the flag. A document whose segment count
 * exceeds the largest acceptable topic count and STILL produced one topic is presumptively
 * under-split.
 */
export const FUNNEL_MIN_SEGMENTS = 12;

export interface FunnelBackstopInput {
  /** Topics the course had when routing ran. The predicate only applies to an EMPTY index —
   * on a grown index, one document expanding one topic is the product invariant working. */
  readonly existingTopicCount: number;
  /** Distinct segments that reached a merge target. */
  readonly routedSegmentCount: number;
  /** Merge targets after resolve → duplicate guard → grouping. */
  readonly mergeTargetCount: number;
}

/**
 * The review note when the whole document funnelled into one topic on an empty index, or
 * `null` when the shape is acceptable.
 *
 * Returns the note rather than a boolean so the wording lives beside the predicate — a
 * caller cannot fire the check and then describe a different condition.
 */
export function detectSingleTopicFunnel(input: FunnelBackstopInput): string | null {
  if (input.existingTopicCount > 0) return null;
  if (input.mergeTargetCount !== 1) return null;
  if (input.routedSegmentCount < FUNNEL_MIN_SEGMENTS) return null;
  return `[routing] Whole document funnelled into a single topic on an empty index (${input.routedSegmentCount} sections → 1 topic) — likely under-split.`;
}
