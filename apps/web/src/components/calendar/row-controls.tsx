"use client";

import { Check } from "@phosphor-icons/react";
import { useActionState, useId, useRef, useState } from "react";
import { setWeightOverride, toggleCompleted } from "@/app/(app)/calendar/item-actions";
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
