import { CourseDot } from "@/components/courses/course-dot";
import { cn } from "@/lib/utils";
import type { WeekViewClassDay } from "@/server/calendar/week-view";

/**
 * The Mon–Sun strip of classes (§7 part 4).
 *
 * **Deliberately visually secondary.** §7 is explicit: *classes are context,
 * deadlines are the payload*. So this is smaller type, muted by default, no
 * urgency colour anywhere on it, and it sits below the ranked list rather than
 * above it. Every choice here is about it losing an attention contest with the
 * section above.
 *
 * A seven-column grid on desktop; on narrow screens it becomes a plain stack of
 * the days that actually have classes, because seven columns at 375px is seven
 * unreadable slivers. Empty days disappear there rather than being rendered as
 * blank columns — a column with nothing in it is only meaningful when you can
 * see its neighbours for comparison.
 */
export function WeekGrid({
  days,
  timeZone,
  todayIndex,
}: {
  days: readonly WeekViewClassDay[];
  timeZone: string;
  /** Which column is today, or -1 when the pinned reference date is elsewhere. */
  todayIndex: number;
}) {
  const total = days.reduce((count, day) => count + day.rows.length, 0);
  if (total === 0) return null;

  const dayName = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone });
  const dayNumber = new Intl.DateTimeFormat("en-GB", { day: "numeric", timeZone });
  const clock = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  });

  return (
    <section className="mb-6 rounded-lg border border-border bg-surface">
      {/* h3, not h2: this section is a peer of "Deadlines" and "On the horizon"
          underneath the "This week" h2 — not a sibling of it. As an h2 the grid
          §7 calls "deliberately visually secondary" outranked the ranked
          deadline list in the document outline, so a screen-reader user
          navigating by heading met the context before the payload. */}
      <h3 className="border-border border-b px-4 py-2.5 font-medium text-muted-foreground text-ui-sm">
        Classes this week
        <span className="ml-2 font-mono tabular-nums">{total}</span>
      </h3>

      <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-7 sm:divide-x sm:divide-y-0">
        {days.map((day, index) => {
          const date = new Date(day.dayStartUtc);
          const isToday = index === todayIndex;

          // Narrow screens drop empty days entirely; wide ones keep the column
          // so the week keeps its shape.
          if (day.rows.length === 0) {
            return (
              <div
                key={day.dayStartUtc}
                className={cn("hidden min-h-24 p-2 sm:block", isToday && "bg-accent-subtle")}
              >
                <DayHeading
                  name={dayName.format(date)}
                  number={dayNumber.format(date)}
                  isToday={isToday}
                />
              </div>
            );
          }

          return (
            <div
              key={day.dayStartUtc}
              className={cn("min-h-24 p-2", isToday && "bg-accent-subtle")}
            >
              <DayHeading
                name={dayName.format(date)}
                number={dayNumber.format(date)}
                isToday={isToday}
              />
              <ul className="mt-1.5 space-y-1">
                {day.rows.map((row) => (
                  <li
                    key={row.occurrenceId}
                    className={cn(
                      "rounded-sm bg-muted/60 px-1.5 py-1 text-ui-xs",
                      row.cancelled && "line-through opacity-60",
                    )}
                  >
                    <span className="block font-mono text-muted-foreground tabular-nums">
                      {row.allDay ? "all day" : clock.format(new Date(row.startsAt))}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1">
                      {row.course ? <CourseDot color={row.course.color} /> : null}
                      <span className="truncate text-foreground">
                        {row.course?.title ?? row.label}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DayHeading({ name, number, isToday }: { name: string; number: string; isToday: boolean }) {
  return (
    <p
      className={cn(
        "flex items-baseline gap-1.5 font-mono text-ui-xs tabular-nums",
        isToday ? "text-accent-text" : "text-muted-foreground",
      )}
    >
      <span className="uppercase">{name}</span>
      <span>{number}</span>
      {isToday ? <span className="sr-only">(today)</span> : null}
    </p>
  );
}
