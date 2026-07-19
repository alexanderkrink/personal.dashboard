"use client";

import { Check } from "@phosphor-icons/react";
import { useActionState, useId, useRef, useState } from "react";
import {
  setItemCourse,
  setWeightOverride,
  toggleCompleted,
} from "@/app/(app)/calendar/item-actions";
import { CourseDot } from "@/components/courses/course-dot";
import { FOCUS_RING } from "@/components/shell/focus-ring";
import { IDLE_FORM_STATE } from "@/lib/forms/form-state";
import { cn } from "@/lib/utils";

/**
 * The two inline controls on a deadline row (§7 part 3): the completion
 * checkbox and the weight override on the badge.
 *
 * Both are `<form action={…}>` rather than click handlers, so they work with
 * JavaScript still loading and land on the same validated Server Action a
 * scripted call would. `useActionState` keeps the row mounted on failure.
 */

/**
 * Checkbox → `completed_at`.
 *
 * A real `<button>` with `aria-pressed` rather than an `<input type=checkbox>`:
 * the control submits a form, and a checkbox that submits on change is a
 * checkbox whose state can disagree with the server's for as long as the round
 * trip takes. `aria-pressed` says "toggle" honestly.
 *
 * Optimistic locally so the tick lands on the same frame as the click — the
 * revalidation replaces it a moment later with the server's answer.
 */
export function CompleteToggle({
  occurrenceId,
  completed,
  label,
}: {
  occurrenceId: string;
  completed: boolean;
  label: string;
}) {
  const [, action, pending] = useActionState(toggleCompleted, IDLE_FORM_STATE);
  const [optimistic, setOptimistic] = useState(completed);
  const shown = pending ? optimistic : completed;

  return (
    <form action={action} className="shrink-0">
      <input type="hidden" name="occurrenceId" value={occurrenceId} />
      <button
        type="submit"
        aria-pressed={shown}
        aria-label={shown ? `Mark “${label}” as not done` : `Mark “${label}” as done`}
        onClick={() => setOptimistic(!completed)}
        className={cn(
          "flex size-4.5 items-center justify-center rounded-sm border transition-colors",
          FOCUS_RING,
          shown
            ? "border-urgency-done bg-urgency-done text-background"
            : "border-input-border hover:border-foreground",
        )}
      >
        {shown ? <Check weight="bold" className="size-3" aria-hidden="true" /> : null}
      </button>
    </form>
  );
}

/**
 * The weight badge, which doubles as its own override control (§5.2 step 1).
 *
 * Idle it is a badge. Activated it becomes a small number input that submits on
 * blur or Enter and reverts on Escape — so the common case (reading the weight)
 * costs no extra chrome, and the rare case (correcting it) costs one click.
 *
 * Classes render as a static badge: `KIND_DEFAULT_WEIGHT` puts them at 0%, and
 * an editable "0%" on a lecture invites a number that means nothing.
 */
export function WeightOverrideField({
  itemId,
  weightPercent,
  isOverridden,
  className,
  tierLabel,
  kind,
}: {
  itemId: string;
  weightPercent: number;
  isOverridden: boolean;
  className?: string;
  tierLabel: string;
  kind: string;
}) {
  const [, action] = useActionState(setWeightOverride, IDLE_FORM_STATE);
  const [editing, setEditing] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const id = useId();

  const badge = cn(
    "inline-flex h-5 shrink-0 items-center gap-1 rounded-4xl px-2 font-medium text-ui-xs tabular-nums",
    className,
  );

  if (kind === "class") {
    return (
      <span className={badge} title="Classes carry no grade weight.">
        {tierLabel}
      </span>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`Weight ${weightPercent}%${isOverridden ? " (set by you)" : ""}. Change it.`}
        className={cn(badge, FOCUS_RING, "hover:brightness-95 dark:hover:brightness-110")}
      >
        {weightPercent}%
        {/* A dot, not a word: the row is already dense, and "set by you" matters
            only when you are looking straight at it. */}
        {isOverridden ? (
          <span aria-hidden="true" className="size-1 rounded-full bg-current" />
        ) : null}
      </button>
    );
  }

  return (
    <form ref={formRef} action={action} className="shrink-0">
      <input type="hidden" name="itemId" value={itemId} />
      <label htmlFor={id} className="sr-only">
        Weight percent
      </label>
      <input
        id={id}
        name="weightPercent"
        type="number"
        min={0}
        max={100}
        step="0.5"
        defaultValue={weightPercent}
        /*
         * Focus moves here imperatively rather than through `autoFocus`.
         *
         * The behaviour is required: this input REPLACES a button the user just
         * activated, so focus has to follow the swap or the click appears to
         * have done nothing and a keyboard user is stranded on an element that
         * no longer exists. But `autoFocus` is the wrong instrument — it also
         * fires on hydration, which would yank focus into a random row when the
         * page loads. A ref callback fires only on the mount this interaction
         * caused.
         */
        ref={(node) => {
          node?.focus();
          node?.select();
        }}
        onBlur={(event) => {
          setEditing(false);
          event.currentTarget.form?.requestSubmit();
        }}
        onKeyDown={(event) => {
          // Escape reverts rather than submitting — the field is entered by a
          // single click, so an accidental one must cost nothing.
          if (event.key === "Escape") {
            event.preventDefault();
            setEditing(false);
          }
        }}
        className={cn(
          "h-5 w-16 rounded-4xl border border-input-border bg-input px-2 text-center text-foreground text-ui-xs tabular-nums",
          FOCUS_RING,
        )}
      />
    </form>
  );
}

/**
 * The course line on a row, which doubles as its own re-filing control (§5.1).
 *
 * Idle it is what it always was: a dot and a course name, or a muted
 * "Unassigned". Activated it becomes a `<select>` listing every course plus the
 * two non-course choices. Same shape as `WeightOverrideField` above — reading
 * costs no extra chrome, correcting costs one click — and for the same reason:
 * this text sits on a dense hairline row where a permanently visible control per
 * item would out-shout the content.
 *
 * ## Why a native `<select>`
 *
 * Not a Base UI menu. This is inside `<form action={…}>`, and a native select
 * submits with the form whether or not JavaScript has finished loading — the same
 * progressive-enhancement stance the other two controls in this file take. It
 * also gets the platform's own mobile picker at 375px, which is a better control
 * than anything worth rebuilding here.
 *
 * ## The two non-course options are NOT the same
 *
 * "No course" (`clear`) is a decision: this belongs to nothing, and sync is
 * locked out of re-filing it. "Automatic" (`reset`) withdraws the decision and
 * lets the matcher decide again. Collapsing them would make un-assigning a
 * one-way door — the exact failure that made rejecting an exam date unrecoverable
 * before 2026-07-19.
 */
export function CourseAssignField({
  itemId,
  course,
  courses,
  isLocked,
  label,
}: {
  itemId: string;
  course: { id: string; title: string; color: string } | null;
  courses: readonly { id: string; title: string; color: string }[];
  /** `course_id` is in `user_locked_fields` — a human filed this, not the matcher. */
  isLocked: boolean;
  /** The item's own title, for the accessible name. */
  label: string;
}) {
  const [, action] = useActionState(setItemCourse, IDLE_FORM_STATE);
  const [editing, setEditing] = useState(false);
  const id = useId();

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={
          course
            ? `“${label}” is filed under ${course.title}. Change it.`
            : `“${label}” is not filed under a course. File it.`
        }
        className={cn(
          "mt-0.5 flex max-w-full items-center gap-1.5 rounded-sm text-ui-sm",
          FOCUS_RING,
          course ? "text-muted-foreground" : "text-muted-foreground italic",
          "hover:text-foreground",
        )}
      >
        {course ? <CourseDot color={course.color} /> : null}
        <span className="truncate">{course ? course.title : "Unassigned"}</span>
        {/* A dot, not a word — same convention as the weight badge. Only says
            "a human decided this" when you are looking straight at it. */}
        {isLocked ? (
          <span aria-hidden="true" className="size-1 shrink-0 rounded-full bg-current opacity-60" />
        ) : null}
      </button>
    );
  }

  return (
    <form action={action} className="mt-0.5">
      <input type="hidden" name="itemId" value={itemId} />
      <label htmlFor={id} className="sr-only">
        Course for “{label}”
      </label>
      <select
        id={id}
        name="choice"
        defaultValue={course?.id ?? "__clear__"}
        ref={(node) => node?.focus()}
        onChange={(event) => {
          const form = event.currentTarget.form;
          if (!form) return;
          // The select carries one value; the action takes a discriminated union.
          // Translating here rather than widening the schema keeps `clear` and
          // "a `set` whose courseId went missing" from ever being the same input.
          const value = event.currentTarget.value;
          const intent = form.elements.namedItem("intent");
          const courseId = form.elements.namedItem("courseId");
          if (!(intent instanceof HTMLInputElement) || !(courseId instanceof HTMLInputElement)) {
            return;
          }
          intent.value = value === "__clear__" ? "clear" : value === "__reset__" ? "reset" : "set";
          courseId.value = value.startsWith("__") ? "" : value;
          setEditing(false);
          form.requestSubmit();
        }}
        onKeyDown={(event) => {
          // Escape reverts rather than submitting — the control is entered with a
          // single click, so an accidental one must cost nothing.
          if (event.key === "Escape") {
            event.preventDefault();
            setEditing(false);
          }
        }}
        onBlur={() => setEditing(false)}
        className={cn(
          "h-6 max-w-56 rounded-sm border border-input-border bg-input px-1.5 text-foreground text-ui-sm",
          FOCUS_RING,
        )}
      >
        {courses.map((option) => (
          <option key={option.id} value={option.id}>
            {option.title}
          </option>
        ))}
        <option value="__clear__">— No course —</option>
        <option value="__reset__">— Automatic (let sync decide) —</option>
      </select>
      <input type="hidden" name="intent" value="set" />
      <input type="hidden" name="courseId" value="" />
    </form>
  );
}
