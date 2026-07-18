"use client";

import { useActionState } from "react";
import { confirmExamDate } from "@/app/(app)/calendar/item-actions";
import { SubmitButton } from "@/components/submit-button";
import { IDLE_FORM_STATE } from "@/lib/forms/form-state";

/**
 * The §5.1b **mandatory human confirm** on an exam date.
 *
 * Exam dates are date-critical *and* grade-critical — the two gates deliberately
 * reserved by the Human-reversible-AI principle — so a detected date is a
 * proposal until someone presses this. Confirming writes
 * `detection_source = 'manual'` and locks `is_exam_candidate`; rejecting clears
 * the flag and locks it too, so a wrong guess does not come back tomorrow.
 *
 * Both buttons live on one form, distinguished by `intent`, following the
 * convention the feed and semester rows already use.
 */
export function ExamConfirmButtons({ itemId, confirmed }: { itemId: string; confirmed: boolean }) {
  const [, action] = useActionState(confirmExamDate, IDLE_FORM_STATE);

  return (
    <form action={action} className="flex shrink-0 items-center gap-1.5">
      <input type="hidden" name="itemId" value={itemId} />
      {confirmed ? (
        <>
          <span className="text-muted-foreground text-ui-xs">Confirmed</span>
          <SubmitButton variant="ghost" size="sm" name="intent" value="reject" pendingLabel="…">
            Undo
          </SubmitButton>
        </>
      ) : (
        <>
          <SubmitButton variant="outline" size="sm" name="intent" value="confirm" pendingLabel="…">
            Confirm
          </SubmitButton>
          <SubmitButton variant="ghost" size="sm" name="intent" value="reject" pendingLabel="…">
            Not an exam
          </SubmitButton>
        </>
      )}
    </form>
  );
}
