"use client";

import { CaretDown } from "@phosphor-icons/react";
import { useActionState, useId, useState } from "react";
import { assignCourse } from "@/app/(app)/calendar/item-actions";
import { CourseDot } from "@/components/courses/course-dot";
import { FormStatus } from "@/components/form/form-status";
import { FOCUS_RING } from "@/components/shell/focus-ring";
import { SubmitButton } from "@/components/submit-button";
import { IDLE_FORM_STATE } from "@/lib/forms/form-state";
import { cn } from "@/lib/utils";
import type { UnassignedGroup } from "@/server/calendar/unassigned";

/**
 * The Unassigned bucket (§7 part 6, §5.1 step 4).
 *
 * ⚠ **On the live database this holds 217 visible rows across 15 patterns**,
 * almost all of them 2025/26 spring courses that were never seeded. §5.1 says
 * surface it at the top of the calendar page — but 217 rows there is a wall that
 * pushes the actual deadlines off the screen, so three things keep it small:
 *
 * 1. It is **grouped by course-name pattern**, so 217 rows become ~15.
 * 2. It is **collapsed by default**, showing a one-line count. Nothing here is
 *    urgent — these are events that already have a date and simply lack a
 *    course label — so it must not outrank a deadline for attention.
 * 3. Assigning is **per pattern**, which is what makes one click worth making:
 *    it files every event of that course at once *and* writes the
 *    `course_matchers` row that files all future ones automatically.
 *
 * The pattern shown is literally the string a matcher will be created from, so
 * what the user sees is what the next sync will match on.
 *
 * ## 🔴 …and a fourth thing, added 2026-07-19
 *
 * Grouping alone was not enough, because **every one of those 217 rows is in the
 * past**. The 2025/26 spring term is over and has been decided against ever
 * getting a `semesters` row, so the collapsed line read *"217 across 15
 * courses"* permanently, above the deadlines, about work that finished in June.
 *
 * A count that never falls and never matters is training to ignore the bucket —
 * and the bucket only earns its position by being actionable. So it now splits:
 *
 * - **Anything still to come** renders as before: a normal, visible section.
 * - **A finished term** renders as one muted line with no panel chrome, below
 *   everything. Present, reachable, silent.
 *
 * No rows are hidden from the user and none are deleted; the history expands on
 * click and files exactly as it always did. This is a display decision.
 */
export function UnassignedBucket({
  actionable,
  historical,
  courses,
}: {
  /** Groups with something still to come. */
  actionable: readonly UnassignedGroup[];
  /** Groups entirely in the past — real, keepable, and not urgent. */
  historical: readonly UnassignedGroup[];
  courses: readonly { id: string; title: string; color: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const panelId = useId();
  const historyId = useId();

  if (actionable.length === 0 && historical.length === 0) return null;

  const total = count(actionable);
  const historicalTotal = count(historical);

  /**
   * Today's real state: nothing actionable at all.
   *
   * Rendered as a bare line rather than a bordered section on purpose — the
   * border and background are what make the other sections read as "a thing to
   * deal with", and this is explicitly not one.
   */
  if (actionable.length === 0) {
    return (
      <section className="mb-6">
        <button
          type="button"
          onClick={() => setShowHistory(!showHistory)}
          aria-expanded={showHistory}
          aria-controls={historyId}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-muted-foreground text-ui-xs hover:text-foreground",
            FOCUS_RING,
          )}
        >
          <CaretDown
            aria-hidden="true"
            className={cn("size-3 shrink-0 transition-transform", showHistory && "rotate-180")}
          />
          <span className="font-mono tabular-nums">{historicalTotal}</span>
          <span>unmatched {historicalTotal === 1 ? "entry" : "entries"} from earlier terms</span>
          <span className="ml-auto hidden sm:inline">{showHistory ? "Hide" : "File them"}</span>
        </button>

        {showHistory ? (
          <div id={historyId} className="mt-2 overflow-hidden rounded-lg border border-border">
            <HistoryNote />
            <ul className="divide-y divide-border">
              {historical.map((group) => (
                <UnassignedGroupRow key={group.pattern} group={group} courses={courses} />
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className="mb-6 rounded-lg border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={panelId}
        className={cn(
          "flex w-full items-center gap-2 px-4 py-2.5 text-left text-ui-sm",
          FOCUS_RING,
        )}
      >
        <CaretDown
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
        <span className="font-medium text-foreground">Unassigned</span>
        {/* Counts the actionable groups only. Folding a finished term into this
            number is what made it a permanent 217 that meant nothing. */}
        <span className="font-mono text-muted-foreground tabular-nums">
          {total} across {actionable.length} {actionable.length === 1 ? "course" : "courses"}
        </span>
        <span className="ml-auto hidden text-muted-foreground text-ui-xs sm:inline">
          {open ? "Hide" : "File them"}
        </span>
      </button>

      {open ? (
        <div id={panelId} className="border-border border-t">
          <p className="px-4 py-2.5 text-muted-foreground text-ui-sm">
            Synced events whose course name matches nothing on file. Filing one pattern moves every
            event under it — and links future ones automatically.
          </p>
          <ul className="divide-y divide-border">
            {actionable.map((group) => (
              <UnassignedGroupRow key={group.pattern} group={group} courses={courses} />
            ))}
          </ul>

          {historical.length > 0 ? (
            <div className="border-border border-t">
              <button
                type="button"
                onClick={() => setShowHistory(!showHistory)}
                aria-expanded={showHistory}
                aria-controls={historyId}
                className={cn(
                  "flex w-full items-center gap-2 px-4 py-2 text-left text-muted-foreground text-ui-xs hover:text-foreground",
                  FOCUS_RING,
                )}
              >
                <CaretDown
                  aria-hidden="true"
                  className={cn(
                    "size-3 shrink-0 transition-transform",
                    showHistory && "rotate-180",
                  )}
                />
                <span className="font-mono tabular-nums">{historicalTotal}</span>
                <span>more from earlier terms</span>
              </button>

              {showHistory ? (
                <ul id={historyId} className="divide-y divide-border border-border border-t">
                  {historical.map((group) => (
                    <UnassignedGroupRow key={group.pattern} group={group} courses={courses} />
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function HistoryNote() {
  return (
    <p className="bg-surface px-4 py-2.5 text-muted-foreground text-ui-sm">
      Events from terms that have finished. Nothing here needs a decision — but filing a pattern
      still writes the rule that links that course automatically if it ever comes back.
    </p>
  );
}

function count(groups: readonly UnassignedGroup[]): number {
  return groups.reduce((total, group) => total + group.count, 0);
}

function UnassignedGroupRow({
  group,
  courses,
}: {
  group: UnassignedGroup;
  courses: readonly { id: string; title: string; color: string }[];
}) {
  const [state, action] = useActionState(assignCourse, IDLE_FORM_STATE);
  const selectId = useId();

  const range = `${formatMonth(group.firstStartsAt)} – ${formatMonth(group.lastStartsAt)}`;

  return (
    <li className="px-4 py-3">
      <form action={action} className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <input type="hidden" name="pattern" value={group.pattern} />

        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-foreground text-ui-base">{group.pattern}</p>
          <p className="font-mono text-muted-foreground text-ui-xs tabular-nums">
            {group.count} {group.count === 1 ? "event" : "events"} · {range}
          </p>
        </div>

        <label htmlFor={selectId} className="sr-only">
          Course for {group.pattern}
        </label>
        {/*
          A native `<select>`, not the Base UI one. This list renders up to
          fifteen times on one page and each Base UI Select mounts a popup;
          native is lighter, works before hydration, and is the better control on
          a phone regardless.
        */}
        <select
          id={selectId}
          name="courseId"
          required
          defaultValue=""
          className={cn(
            "h-8 max-w-[14rem] rounded-md border border-input-border bg-input px-2 text-foreground text-ui-sm",
            FOCUS_RING,
          )}
        >
          <option value="" disabled>
            Choose a course…
          </option>
          {courses.map((course) => (
            <option key={course.id} value={course.id}>
              {course.title}
            </option>
          ))}
        </select>

        <SubmitButton variant="outline" size="sm" pendingLabel="Filing…">
          File {group.count}
        </SubmitButton>
      </form>

      {state.status !== "idle" ? <FormStatus state={state} className="mt-2" /> : null}

      {courses.length === 0 ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-muted-foreground text-ui-xs">
          <CourseDot color="rust" />
          Add a course first — there is nothing to file this under yet.
        </p>
      ) : null}
    </li>
  );
}

function formatMonth(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { month: "short", year: "2-digit" }).format(
    new Date(iso),
  );
}
