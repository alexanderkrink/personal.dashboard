"use client";

import { ArrowClockwise } from "@phosphor-icons/react";
import { useActionState } from "react";
import { updateFeed } from "@/app/(app)/calendar/actions";
import { FormStatus } from "@/components/form/form-status";
import { SubmitButton } from "@/components/submit-button";
import { IDLE_FORM_STATE } from "@/lib/forms/form-state";

/**
 * "Sync now" on the §7 status strip.
 *
 * A client island purely because `updateFeed` is a `(state, formData)` action
 * and `<form action>` alone cannot carry the state argument — `useActionState`
 * is what supplies it, and it also gives the rate-limit refusal
 * ("Just synced. Try again in 45s.") somewhere to render.
 *
 * 🔒 It posts a feed id and a label. No URL crosses this boundary.
 */
export function SyncNowButton({ feedId, label }: { feedId: string; label: string }) {
  const [state, action] = useActionState(updateFeed, IDLE_FORM_STATE);

  return (
    <form action={action} className="ml-auto flex items-center gap-2">
      {state.status !== "idle" && state.message ? (
        <FormStatus state={state} className="text-ui-xs" />
      ) : null}
      <input type="hidden" name="feedId" value={feedId} />
      <input type="hidden" name="intent" value="sync" />
      {/* `updateFeed` validates `label` on the edit path; the sync intent short-
          circuits before that, but sending it keeps one schema for one form. */}
      <input type="hidden" name="label" value={label} />
      <SubmitButton variant="ghost" size="sm" pendingLabel="Syncing…">
        <ArrowClockwise aria-hidden="true" className="size-3.5" />
        Sync now
      </SubmitButton>
    </form>
  );
}
