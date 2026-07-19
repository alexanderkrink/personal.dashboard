import type { WeightTier } from "@/server/calendar/week-view";

/**
 * The heat ramp (§7 part 3, and *Identity & design*'s urgency system).
 *
 * 🎨 **Green is `done` ONLY — never urgency.** Getting this wrong inverts the
 * entire system: a green "high priority" badge reads as *finished* at a glance,
 * which is the one message it must never send. The ramp runs
 *
 * ```
 * overdue → danger red     (--urgency-overdue)
 * high    → amber          (--urgency-high)     ≥ 15%
 * medium  → dim amber      (--urgency-medium)   5–15%
 * low     → neutral        (--urgency-low  = --muted-foreground)   < 5%
 * info    → neutral        classes: context, not a graded thing
 * done    → green          (--urgency-done) — applied by completion, not weight
 * ```
 *
 * The `--urgency-*` tokens already existed in `globals.css`; this maps tiers
 * onto them in one place so no component ever picks a colour by hand.
 *
 * All backgrounds are a low-alpha tint of the same hue rather than a second
 * token, so the text colour and its field always agree, and the badge stays
 * legible in both themes without a separate dark-mode ramp.
 *
 * ⚠ The BADGE writes with `-text` tokens where they exist (`high`), not the
 * painting token. 11px glyphs on a 10% wash of their own hue lose contrast to
 * anti-aliasing, so `--urgency-high` renders at 4.42:1 sampled while measuring
 * 4.68:1 on the specified colours. `TIER_RULE_CLASS` below is the opposite
 * case — a solid 2px rule, no glyphs — and keeps the painting tokens.
 */
export const TIER_BADGE_CLASS: Record<WeightTier, string> = {
  overdue: "bg-urgency-overdue/10 text-urgency-overdue-text dark:bg-urgency-overdue/20",
  high: "bg-urgency-high/10 text-urgency-high-text dark:bg-urgency-high/20",
  medium: "bg-urgency-medium/10 text-urgency-medium-text dark:bg-urgency-medium/20",
  low: "bg-muted text-muted-foreground",
  info: "bg-muted text-muted-foreground",
};

/** The word on the badge. `Info` is what a class gets — it carries no weight. */
export const TIER_LABEL: Record<WeightTier, string> = {
  overdue: "Overdue",
  high: "High",
  medium: "Med",
  low: "Low",
  info: "Class",
};

/**
 * The left edge on a row. 2px of colour is the whole visual ranking signal on a
 * hairline list, so it uses the *solid* token rather than a tint.
 */
export const TIER_RULE_CLASS: Record<WeightTier, string> = {
  overdue: "bg-urgency-overdue",
  high: "bg-urgency-high",
  medium: "bg-urgency-medium",
  low: "bg-border",
  info: "bg-border",
};

/**
 * "Thu · in 2 days" (§7 part 3), or "Thu · 3 days ago" when overdue.
 *
 * Rendered from `daysUntilDue`, which is fractional, so the thresholds are
 * expressed in whole days from the *user's* perspective: anything inside the
 * next 24 hours reads as hours, because "in 0 days" is not a thing anyone says.
 */
export function formatDueIn(daysUntilDue: number): string {
  const hours = daysUntilDue * 24;

  if (daysUntilDue < 0) {
    const overdueHours = Math.abs(hours);
    if (overdueHours < 1) return "just now";
    if (overdueHours < 24) return `${Math.floor(overdueHours)}h ago`;
    const days = Math.floor(Math.abs(daysUntilDue));
    return `${days} ${days === 1 ? "day" : "days"} ago`;
  }

  if (hours < 1) return "now";
  if (hours < 24) return `in ${Math.floor(hours)}h`;

  const days = Math.floor(daysUntilDue);
  return days === 1 ? "tomorrow" : `in ${days} days`;
}

/** "Synced 12 min ago" — the sync strip's relative time. */
export function formatSyncedAgo(lastSyncedAt: string | null, now: Date): string {
  if (lastSyncedAt === null) return "never synced";

  const ms = now.getTime() - Date.parse(lastSyncedAt);
  if (Number.isNaN(ms)) return "never synced";
  if (ms < 60_000) return "just now";

  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
