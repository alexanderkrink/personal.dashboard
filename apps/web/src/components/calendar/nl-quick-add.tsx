"use client";

import { Sparkle } from "@phosphor-icons/react";
import { useActionState, useId, useState } from "react";
import { parseQuickAddUtterance } from "@/app/(app)/calendar/quick-add-parse";
import { QuickAddForm } from "@/components/calendar/quick-add-form";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IDLE_QUICK_ADD_PARSE_STATE } from "@/lib/calendar/quick-add-parse-state";

/**
 * Natural-language quick-add (§6, CAL-3): one line in, a pre-filled confirm card out.
 *
 * Two forms, one write path. The top form runs the PARSE — a Server Action that can
 * only return a proposal. The bottom form is the same `QuickAddForm` as ever, wearing
 * §6's two hats: empty it is the floor (direct entry, and the fallback for a failed or
 * low-confidence parse); seeded it is the **confirm card**. Only its submit —
 * `createQuickAddItem`, fed by the card's own `FormData` — ever writes, which is the
 * §2b hard gate on date-critical data in component form: the human's press of "Add to
 * calendar" IS the confirm.
 *
 * The card remounts on `state.token` (a fresh value per parse) because `FormField`
 * seeds from `state.values` once and then owns its value — which is exactly right
 * mid-edit, and exactly wrong when a new proposal arrives. A keyed remount is the
 * seam between "the model proposed" and "the human is editing".
 */
export function NlQuickAdd({ courses }: { courses: readonly { id: string; title: string }[] }) {
  const [state, formAction] = useActionState(parseQuickAddUtterance, IDLE_QUICK_ADD_PARSE_STATE);
  // Controlled so the utterance survives the action settling — same WCAG 2.2 SC 3.3.7
  // reasoning as `FormField`, for the one input that lives outside it.
  const [utterance, setUtterance] = useState("");
  const inputId = useId();
  const noteId = useId();

  const note =
    state.status === "fallback" ? state.message : state.status === "parsed" ? state.note : null;

  return (
    <div className="space-y-4">
      <form action={formAction} className="space-y-2">
        <Label htmlFor={inputId}>Say it in one line</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={inputId}
            name="utterance"
            value={utterance}
            onChange={(event) => setUtterance(event.target.value)}
            placeholder="ML assignment 3 due next friday 23:59"
            autoComplete="off"
            aria-describedby={note === null ? undefined : noteId}
          />
          <SubmitButton variant="secondary" pendingLabel="Reading…" className="shrink-0">
            <Sparkle aria-hidden="true" />
            Fill in the form
          </SubmitButton>
        </div>
        {/* The parse's one live region: the fallback sentence, or the model's own
            ambiguity note. Polite — the student is mid-task, not in danger. */}
        {note === null ? null : (
          <p id={noteId} role="status" className="text-muted-foreground text-ui-sm">
            {note}
          </p>
        )}
      </form>

      <QuickAddForm
        key={state.status === "parsed" ? state.token : "empty"}
        courses={courses}
        initialState={
          state.status === "parsed"
            ? {
                status: "info",
                message: "Nothing is saved yet — check every field, then add.",
                values: state.values,
              }
            : undefined
        }
      />
    </div>
  );
}
