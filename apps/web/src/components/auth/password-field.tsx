"use client";

import { Check, Circle } from "@phosphor-icons/react";
import { useId } from "react";
import { FormField } from "@/components/form/form-field";
import { Input } from "@/components/ui/input";
import { evaluatePassword, MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import type { FormState } from "@/lib/forms/form-state";
import { cn } from "@/lib/utils";

/**
 * A new-password input with the policy shown live as it is typed.
 *
 * This is the CLIENT half of the compensating control for the unavailable
 * leaked-password check: it drives the checklist from `evaluatePassword`, the
 * same rule list the Zod schema on the Server Action parses through, so the two
 * can never disagree about what a valid password is. It is feedback, not
 * enforcement — the server re-validates everything regardless.
 *
 * The checklist reads the value straight off `FormField`, which already owns it
 * — one source of truth, and no password ever needs to be echoed back from the
 * server for the field to survive a failed submit.
 */
export function PasswordField({
  name,
  label,
  state,
  autoComplete = "new-password",
}: {
  name: string;
  label: string;
  state: FormState;
  autoComplete?: string;
}) {
  const rulesId = useId();

  return (
    <FormField name={name} label={label} state={state} describedBy={rulesId}>
      {(control, value) => (
        <>
          <Input
            {...control}
            type="password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            // `maxLength` counts UTF-16 code units, which is as close as a DOM
            // attribute gets to bcrypt's 72-BYTE ceiling. Coarse guard only —
            // `passwordSchema` measures the real byte length on the server.
            maxLength={MAX_PASSWORD_BYTES}
            autoComplete={autoComplete}
          />

          <ul id={rulesId} className="mt-1 grid gap-1">
            {evaluatePassword(value).map((rule) => (
              <li
                key={rule.label}
                className={cn(
                  "flex items-center gap-1.5 text-ui-sm transition-colors duration-fast",
                  rule.satisfied ? "text-success" : "text-muted-foreground",
                )}
              >
                {rule.satisfied ? (
                  <Check aria-hidden="true" className="size-3" weight="bold" />
                ) : (
                  <Circle aria-hidden="true" className="size-3" />
                )}
                {/* The icon is decorative, so the met/unmet state has to reach a
                    screen reader as text rather than as colour plus a glyph. */}
                <span className="sr-only">{rule.satisfied ? "Met:" : "Not yet met:"}</span>
                {rule.label}
              </li>
            ))}
          </ul>
        </>
      )}
    </FormField>
  );
}
