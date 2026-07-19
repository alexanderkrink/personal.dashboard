"use client";

import { Form, type FormAction } from "@/components/form/form";
import { FormStatus } from "@/components/form/form-status";
import { SubmitButton } from "@/components/submit-button";

/**
 * Confirm / Discard for one syllabus proposal.
 *
 * Two separate `<form>`s rather than one form with two submitters. The usual
 * `intent` convention would be lighter, but it makes both buttons share a single
 * `useFormStatus`, so pressing Confirm would visibly disable Discard as well —
 * and on a destructive/constructive pair that reads as "the app is deciding",
 * which is precisely the wrong feeling at a gate whose entire job is to make the
 * human the one deciding.
 *
 * Discard is `outline`, not `destructive`. It deletes only an unconfirmed
 * proposal that nothing depends on yet; dressing it in red would borrow urgency
 * from the confirm decision, where the actual risk lives.
 */
export function SyllabusProposalActions({
  courseId,
  extractionId,
  confirmAction,
  rejectAction,
}: {
  courseId: string;
  extractionId: string;
  confirmAction: FormAction;
  rejectAction: FormAction;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Form action={confirmAction} className="contents">
        {(state) => (
          <>
            <input type="hidden" name="extractionId" value={extractionId} />
            <input type="hidden" name="courseId" value={courseId} />
            <SubmitButton pendingLabel="Confirming…">Confirm these weights</SubmitButton>
            <FormStatus state={state} />
          </>
        )}
      </Form>

      <Form action={rejectAction} className="contents">
        {(state) => (
          <>
            <input type="hidden" name="extractionId" value={extractionId} />
            <input type="hidden" name="courseId" value={courseId} />
            <SubmitButton variant="outline" pendingLabel="Discarding…">
              Discard
            </SubmitButton>
            <FormStatus state={state} />
          </>
        )}
      </Form>
    </div>
  );
}
