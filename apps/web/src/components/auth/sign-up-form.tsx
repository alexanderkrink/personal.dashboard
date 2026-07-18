"use client";

import { signUp } from "@/app/auth/actions";
import { PasswordField } from "@/components/auth/password-field";
import { Form } from "@/components/form/form";
import { FormField } from "@/components/form/form-field";
import { FormStatus } from "@/components/form/form-status";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";

export function SignUpForm() {
  return (
    <Form action={signUp}>
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

          <PasswordField name="password" label="Password" state={state} />

          <FormField name="confirmPassword" label="Confirm password" state={state}>
            {(control) => (
              <Input {...control} type="password" required autoComplete="new-password" />
            )}
          </FormField>

          <FormStatus state={state} />

          <SubmitButton className="h-9 w-full" pendingLabel="Creating…">
            Create account
          </SubmitButton>
        </>
      )}
    </Form>
  );
}
