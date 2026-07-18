"use client";

import { updatePassword } from "@/app/auth/actions";
import { PasswordField } from "@/components/auth/password-field";
import { Form } from "@/components/form/form";
import { FormField } from "@/components/form/form-field";
import { FormStatus } from "@/components/form/form-status";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";

export function UpdatePasswordForm() {
  return (
    <Form action={updatePassword}>
      {(state) => (
        <>
          <PasswordField name="password" label="New password" state={state} />

          <FormField name="confirmPassword" label="Confirm new password" state={state}>
            {(control) => (
              <Input {...control} type="password" required autoComplete="new-password" />
            )}
          </FormField>

          <FormStatus state={state} />

          <SubmitButton className="h-9 w-full" pendingLabel="Saving…">
            Save new password
          </SubmitButton>
        </>
      )}
    </Form>
  );
}
