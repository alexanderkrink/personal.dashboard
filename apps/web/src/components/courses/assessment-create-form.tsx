"use client";

import { Plus } from "@phosphor-icons/react";
import { AssessmentFields } from "@/components/courses/assessment-fields";
import { Form, type FormAction } from "@/components/form/form";
import { FormStatus } from "@/components/form/form-status";
import { SubmitButton } from "@/components/submit-button";

/**
 * Adds one graded component and clears itself.
 *
 * The reset is the action's doing, not this component's: it returns blank
 * `values` on success, and every field re-seeds from `state.values`. That keeps
 * "what the form holds" a single server-owned fact rather than something a
 * `ref` has to remember to wipe.
 */
export function AssessmentCreateForm({
  courseId,
  action,
}: {
  courseId: string;
  action: FormAction;
}) {
  return (
    <Form action={action}>
      {(state) => (
        <>
          <input type="hidden" name="courseId" value={courseId} />
          <AssessmentFields state={state} />
          <FormStatus state={state} />
          <div>
            <SubmitButton size="sm" pendingLabel="Adding…">
              <Plus aria-hidden="true" />
              Add component
            </SubmitButton>
          </div>
        </>
      )}
    </Form>
  );
}
