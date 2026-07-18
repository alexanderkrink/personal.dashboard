"use client";

import { Check, Circle } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { evaluatePassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { cn } from "@/lib/utils";

/**
 * A new-password input with the policy shown live as it is typed.
 *
 * This is the CLIENT half of the compensating control for the unavailable
 * leaked-password check: it drives the checklist from `evaluatePassword`, the
 * same rule list the Zod schema on the Server Action parses through, so the two
 * can never disagree about what a valid password is. It is feedback, not
 * enforcement — the server re-validates everything regardless.
 */
export function PasswordField({
  name,
  label,
  autoComplete = "new-password",
}: {
  name: string;
  label: string;
  autoComplete?: string;
}) {
  const inputId = useId();
  const rulesId = useId();
  const [value, setValue] = useState("");
  const rules = evaluatePassword(value);

  return (
    <Field>
      <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
      <Input
        id={inputId}
        name={name}
        type="password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        maxLength={MAX_PASSWORD_LENGTH}
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        aria-describedby={rulesId}
      />

      <ul id={rulesId} className="mt-1 grid gap-1">
        {rules.map((rule) => (
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
    </Field>
  );
}
