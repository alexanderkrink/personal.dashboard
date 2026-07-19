import { CourseDot } from "@/components/courses/course-dot";
import { cn } from "@/lib/utils";
import type { WeekViewRow } from "@/server/calendar/week-view";
import { CompleteToggle, WeightOverrideField } from "./row-controls";
import { formatDueIn, TIER_BADGE_CLASS, TIER_LABEL, TIER_RULE_CLASS } from "./urgency";

/**
 * One hairline deadline row (§7 part 3).
 *
 * Reading order left to right is the triage order: **is it done → how much is it
 * worth → what is it → which course → when**. The checkbox leads because the
 * most common interaction with this list is crossing something off, and the
 * weight badge comes before the title because §7 ranks by weight — a list sorted
 * by a value you have to hunt for reads as an arbitrary order.
 *
 * The mono countdown is right-aligned and tabular so the column forms a straight
 * numeric edge rather than a ragged one; `--font-mono` carries
 * `font-feature-settings: "tnum" 1` for exactly this.
 */
export function DeadlineRow({
  row,
  timeZone,
  showWeekday = true,
}: {
  row: WeekViewRow;
  timeZone: string;
  showWeekday?: boolean;
}) {
  const weekday = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone,
  }).format(new Date(row.startsAt));

  const time = row.allDay
    ? "all day"
    : new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone,
      }).format(new Date(row.startsAt));

  return (
    <li className="relative flex items-center gap-3 py-2.5 pr-3 pl-4">
      {/* The 2px rule is the ranking signal on a hairline list. Decorative: the
          badge beside it carries the same information as text. */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 left-0 w-0.5",
          row.completed ? "bg-urgency-done" : TIER_RULE_CLASS[row.tier],
        )}
      />

      <CompleteToggle occurrenceId={row.occurrenceId} completed={row.completed} label={row.label} />

      {/* Weight is an editable control, not a decoration — §7 part 3 puts the
          inline override on the badge itself. */}
      <WeightOverrideField
        itemId={row.itemId}
        weightPercent={row.weightPercent}
        isOverridden={row.weightSource === "override"}
        className={cn(
          "shrink-0",
          // `-text`, not the painting token: 11px on a 10% wash of its own hue
          // samples 4.50:1, exactly on the AA floor. See globals.css.
          row.completed ? "bg-urgency-done/10 text-urgency-done-text" : TIER_BADGE_CLASS[row.tier],
        )}
        tierLabel={TIER_LABEL[row.tier]}
        kind={row.kind}
      />

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate text-ui-base",
            row.cancelled || row.completed
              ? "text-muted-foreground line-through"
              : "text-foreground",
          )}
        >
          {row.label}
          {row.isExamCandidate ? (
            <span className="ml-2 rounded-sm bg-urgency-high/10 px-1.5 py-0.5 align-middle font-medium text-urgency-high-text text-ui-xs dark:bg-urgency-high/20">
              Exam
            </span>
          ) : null}
          {row.cancelled ? (
            <span className="ml-2 align-middle text-destructive text-ui-xs">Cancelled</span>
          ) : null}
        </p>
        {row.course ? (
          <span className="mt-0.5 flex items-center gap-1.5 text-muted-foreground text-ui-sm">
            <CourseDot color={row.course.color} />
            <span className="truncate">{row.course.title}</span>
          </span>
        ) : null}
      </div>

      <span className="shrink-0 text-right font-mono text-muted-foreground text-ui-sm tabular-nums">
        {showWeekday ? <span className="hidden sm:inline">{weekday} · </span> : null}
        <span className="hidden sm:inline">{time} · </span>
        <span className={row.tier === "overdue" ? "text-urgency-overdue" : undefined}>
          {formatDueIn(row.daysUntilDue)}
        </span>
      </span>
    </li>
  );
}
