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
 * ⚠ **On the live database this holds 220 rows across 15 patterns**, almost all
 * of them 2025/26 spring courses that were never seeded. §5.1 says surface it at
 * the top of the calendar page — but 220 rows there is a wall that pushes the
 * actual deadlines off the screen, so three things keep it small:
 *
 * 1. It is **grouped by course-name pattern**, so 220 rows become ~15.
 * 2. It is **collapsed by default**, showing a one-line count. Nothing here is
 *    urgent — these are events that already have a date and simply lack a
 *    course label — so it must not outrank a deadline for attention.
 * 3. Assigning is **per pattern**, which is what makes one click worth making:
 *    it files every event of that course at once *and* writes the
 *    `course_matchers` row that files all future ones automatically.
 *
 * The pattern shown is literally the string a matcher will be created from, so
 * what the user sees is what the next sync will match on.
 */
export function UnassignedBucket({
  groups,
  courses,
}: {
  groups: readonly UnassignedGroup[];
  courses: readonly { id: string; title: string; color: string }[];
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  if (groups.length === 0) return null;

  const total = groups.reduce((count, group) => count + group.count, 0);

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
        <span className="font-mono text-muted-foreground tabular-nums">
          {total} across {groups.length} {groups.length === 1 ? "course" : "courses"}
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
            {groups.map((group) => (
              <UnassignedGroupRow key={group.pattern} group={group} courses={courses} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
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
