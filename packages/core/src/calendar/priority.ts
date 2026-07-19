/**
 * Grade-impact weighting and the priority score (§5.2).
 *
 * The number that drives ranking is **weight_percent**: how much of the course
 * grade an item is worth. Everything here is pure so the same functions serve
 * the server render, a future client-side what-if panel, and the exam planner's
 * objective function without a round-trip.
 */

import type { CalendarItemKind } from "./provider";

/** Kind-based defaults — step 3 of the resolution order. */
export const KIND_DEFAULT_WEIGHT: Record<CalendarItemKind, number> = {
  deadline: 5,
  class: 0,
  event: 0,
};

/** Badge thresholds. Rendered from weight alone, never from the score. */
export const HIGH_WEIGHT_THRESHOLD = 15;
export const MEDIUM_WEIGHT_THRESHOLD = 5;

/**
 * The floor on `daysUntilDue`.
 *
 * Overdue items clamp here rather than going negative — a negative denominator
 * would flip the score's sign and sort the most overdue item *last*.
 */
export const MIN_DAYS_UNTIL_DUE = 0.5;

export interface WeightResolutionInput {
  kind: CalendarItemKind;
  /** `calendar_items.weight_override` — manual, always wins. */
  weightOverride?: number | null;
  /** `assessments.weight_percent` via `assessment_id`. */
  assessmentWeightPercent?: number | null;
}

export interface ResolvedWeight {
  weightPercent: number;
  source: "override" | "assessment" | "kind_default";
}

/**
 * Resolution order, first non-null wins (§5.2):
 * 1. `calendar_items.weight_override` — manual, set inline from the event card.
 * 2. `assessments.weight_percent` via `assessment_id` — syllabus-derived.
 * 3. Kind-based default: `deadline` → 5%, `class`/`event` → 0%.
 */
export function resolveWeightPercent(input: WeightResolutionInput): ResolvedWeight {
  if (input.weightOverride != null && Number.isFinite(input.weightOverride)) {
    return { weightPercent: input.weightOverride, source: "override" };
  }
  if (input.assessmentWeightPercent != null && Number.isFinite(input.assessmentWeightPercent)) {
    return { weightPercent: input.assessmentWeightPercent, source: "assessment" };
  }
  return { weightPercent: KIND_DEFAULT_WEIGHT[input.kind], source: "kind_default" };
}

/**
 * `priority(weight%, daysUntilDue) = (weight% + 1) / max(daysUntilDue, 0.5)`
 *
 * The `+ 1` keeps a 0%-weight item from scoring zero regardless of urgency, so
 * a class today still outranks a class next month.
 *
 * Worked example from the spec, which this must reproduce exactly:
 * - a 30% project in 6 days  → `31 / 6`  = **5.17**
 * - a 2% quiz tomorrow       → `3 / 1`   = **3.00**
 * - a 30% project in a month → `31 / 30` = **1.03**
 *
 * So the big project outranks the imminent quiz, which still outranks the
 * distant project — which is how a student should actually triage.
 */
export function priorityScore(weightPercent: number, daysUntilDue: number): number {
  return (weightPercent + 1) / Math.max(daysUntilDue, MIN_DAYS_UNTIL_DUE);
}

export type PriorityTier = "overdue" | "high" | "medium" | "low" | "info";

/**
 * Badge tier: **High** ≥ 15%, **Medium** 5–15%, **Low** < 5%, **Info** for
 * classes — plus the pinned `overdue` tier, which outranks all of them.
 *
 * Classes resolve to `info` before the weight thresholds are consulted, since a
 * class carries a 0% default that would otherwise read as a meaningful "Low".
 */
export function priorityTier(input: {
  kind: CalendarItemKind;
  weightPercent: number;
  isOverdue: boolean;
}): PriorityTier {
  if (input.isOverdue) {
    return "overdue";
  }
  if (input.kind === "class") {
    return "info";
  }
  if (input.weightPercent >= HIGH_WEIGHT_THRESHOLD) {
    return "high";
  }
  if (input.weightPercent >= MEDIUM_WEIGHT_THRESHOLD) {
    return "medium";
  }
  return "low";
}

const MS_PER_DAY = 86_400_000;

/**
 * Fractional days from `nowUtc` to `dueUtc`. Negative when overdue — callers
 * pass the raw value to `priorityScore`, which does the clamping.
 *
 * `nowUtc` is a parameter rather than `Date.now()` because `packages/core` must
 * stay a pure function of its inputs (and because a test that depends on the
 * wall clock is a test that fails at midnight).
 */
export function daysUntil(dueUtc: string, nowUtc: string): number {
  return (Date.parse(dueUtc) - Date.parse(nowUtc)) / MS_PER_DAY;
}

export interface RankableItem {
  id: string;
  kind: CalendarItemKind;
  dueUtc: string;
  weightOverride?: number | null;
  assessmentWeightPercent?: number | null;
  /** Completed items are excluded from ranking entirely (§5.2). */
  completedAt?: string | null;
}

export interface RankedItem {
  id: string;
  weightPercent: number;
  weightSource: ResolvedWeight["source"];
  daysUntilDue: number;
  score: number;
  tier: PriorityTier;
  isOverdue: boolean;
}

/**
 * Resolves weight, scores and sorts a set of items, highest priority first.
 *
 * Completed items are dropped rather than sorted to the bottom — §5.2 says
 * excluded, and a done item competing for attention is noise.
 *
 * Ties break on `id` so the order is stable across renders; an unstable sort
 * would make rows visibly swap on every refresh.
 */
export function rankItems(items: readonly RankableItem[], nowUtc: string): RankedItem[] {
  const ranked: RankedItem[] = [];

  for (const item of items) {
    if (item.completedAt != null) {
      continue;
    }

    const resolved = resolveWeightPercent({
      kind: item.kind,
      weightOverride: item.weightOverride,
      assessmentWeightPercent: item.assessmentWeightPercent,
    });
    const daysUntilDue = daysUntil(item.dueUtc, nowUtc);
    const isOverdue = daysUntilDue < 0;

    ranked.push({
      id: item.id,
      weightPercent: resolved.weightPercent,
      weightSource: resolved.source,
      daysUntilDue,
      score: priorityScore(resolved.weightPercent, daysUntilDue),
      tier: priorityTier({ kind: item.kind, weightPercent: resolved.weightPercent, isOverdue }),
      isOverdue,
    });
  }

  // Overdue is a *pinned* tier: it sorts above everything regardless of score,
  // so a 0%-weight overdue item still surfaces above a high-weight future one.
  return ranked.sort((a, b) => {
    if (a.isOverdue !== b.isOverdue) {
      return a.isOverdue ? -1 : 1;
    }
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.id.localeCompare(b.id);
  });
}
