"use client";

import { Plus } from "@phosphor-icons/react";
import { Form, type FormAction } from "@/components/form/form";
import { FormField } from "@/components/form/form-field";
import { FormStatus } from "@/components/form/form-status";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import type { FormState } from "@/lib/forms/form-state";

/** The three fields of a term, shared by the add form and the row editor. */
function SemesterFields({ state }: { state: FormState }) {
  return (
    <div className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr]">
      <FormField name="name" label="Name" state={state}>
        {(control) => <Input {...control} required autoComplete="off" placeholder="2026/27 Fall" />}
      </FormField>

      <FormField name="startsOn" label="Starts" state={state}>
        {(control) => <Input {...control} type="date" required className="font-mono" />}
      </FormField>

      <FormField name="endsOn" label="Ends" state={state}>
        {(control) => <Input {...control} type="date" required className="font-mono" />}
      </FormField>
    </div>
  );
}

/**
 * Adds a term.
 *
 * A semester is not bookkeeping: the planner's exam-detection rule validates a
 * candidate exam date against these bounds, so a term that is absent or wrong
 * silently rejects every exam inside it. The `ends_on >= starts_on` rule is
 * enforced in the schema as well as by the database — the constraint exists,
 * but a constraint violation arrives as a 500, and a 500 is not an error
 * message.
 */
export function SemesterCreateForm({ action }: { action: FormAction }) {
  return (
    <Form action={action}>
      {(state) => (
        <>
          <SemesterFields state={state} />
          <FormStatus state={state} />
          <div>
            <SubmitButton size="sm" pendingLabel="Adding…">
              <Plus aria-hidden="true" />
              Add semester
            </SubmitButton>
          </div>
        </>
      )}
    </Form>
  );
}

export { SemesterFields };
