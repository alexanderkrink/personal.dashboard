"use client";

import Link from "next/link";
import { signIn } from "@/app/auth/actions";
import { Form } from "@/components/form/form";
import { FormField } from "@/components/form/form-field";
import { FormStatus, type FormStatusTone } from "@/components/form/form-status";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

/**
 * Sign-in, with the magic-link path as a second submitter on the same form so
 * the email is only ever typed once (see `signIn` for the `intent` convention).
 */
export function SignInForm({
  fallback,
}: {
  /** A message that arrived by navigation rather than by submitting this form. */
  fallback?: { tone: FormStatusTone; message: string };
}) {
  return (
    <Form action={signIn}>
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

          <FormField
            name="password"
            label="Password"
            state={state}
            labelAdornment={
              <Link
                href="/forgot-password"
                className="focus-ring rounded-sm text-accent-text text-ui-sm underline-offset-4 hover:underline"
              >
                Forgot?
              </Link>
            }
          >
            {(control) => (
              <Input {...control} type="password" required autoComplete="current-password" />
            )}
          </FormField>

          <FormStatus state={state} fallback={fallback} />

          <SubmitButton className="h-9 w-full" pendingLabel="Signing in…">
            Sign in
          </SubmitButton>

          <div className="flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-muted-foreground text-ui-sm">or</span>
            <Separator className="flex-1" />
          </div>

          {/*
            The secondary path. `name`/`value` tell `signIn` which of the form's
            two jobs this submitter is asking for, and `formNoValidate`
            suppresses the browser's required-field check on the password, which
            this path does not need.
          */}
          <SubmitButton
            variant="outline"
            className="h-9 w-full"
            name="intent"
            value="magic-link"
            formNoValidate
            pendingLabel="Sending…"
          >
            Email me a sign-in link
          </SubmitButton>
        </>
      )}
    </Form>
  );
}
