"use client";

import { requestPasswordReset } from "@/app/auth/actions";
import { Form } from "@/components/form/form";
import { FormField } from "@/components/form/form-field";
import { FormStatus } from "@/components/form/form-status";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";

export function ForgotPasswordForm() {
  return (
    <Form action={requestPasswordReset}>
      {(state) => (
        <>
          <FormField name="email" label="Email" state={state}>
            {(control) => (
              <Input
                {...control}
                type="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
              />
            )}
          </FormField>

          <FormStatus state={state} />

          <SubmitButton className="h-9 w-full" pendingLabel="Sending…">
            Send reset link
          </SubmitButton>
        </>
      )}
    </Form>
  );
}
