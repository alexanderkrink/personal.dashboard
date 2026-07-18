"use client";

import { useEffect, useId, useRef, useState } from "react";
import { unlock } from "@/app/gate/actions";
import { Form } from "@/components/form/form";
import { FormStatus } from "@/components/form/form-status";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";

/**
 * The access-code input. One field, JetBrains Mono, wide tracking — the screen
 * has exactly one affordance and says almost nothing about what is behind it
 * (PLAN.md "Access-code gate & auth").
 *
 * A rejected code no longer redirects, so the typed value survives and a
 * near-miss can be corrected rather than retyped (WCAG 2.2 SC 3.3.7). The code
 * never leaves the client on the failure path — `unlock` returns a bare message
 * and never echoes the submission back.
 */
export function GateForm() {
  const inputRef = useRef<HTMLInputElement>(null);
  const statusId = useId();
  // Controlled, for the same reason `FormField` controls its own value: React
  // resets a `<form action={…}>` after the action settles, and an uncontrolled
  // field would come back empty. The gate cannot use `FormField`'s echo route
  // either way — an access code is a secret and is never sent back down.
  const [code, setCode] = useState("");

  // Focus on mount. Done imperatively rather than with the `autoFocus`
  // attribute: on a page whose entire content is this one field there is
  // nothing for a screen-reader user to be yanked away from, which is the
  // situation `autoFocus` is otherwise discouraged for.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <Form action={unlock} className="w-full max-w-xs gap-4">
      {(state) => {
        const invalid = state.status === "error";
        return (
          <>
            <label htmlFor="access-code" className="sr-only">
              Access code
            </label>
            <Input
              ref={inputRef}
              id="access-code"
              name="code"
              type="text"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              maxLength={256}
              placeholder="••••••••"
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? statusId : undefined}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              // `md:text-mono-data` is not redundant: the Input primitive
              // carries `text-base md:text-sm`, and tailwind-merge keys
              // responsive variants separately from unprefixed ones — so a bare
              // `text-mono-data` replaces `text-base` but loses to `md:text-sm`
              // from 768px up, silently rendering the gate at 14px instead of
              // the 13px token.
              className="h-11 text-center font-mono text-mono-data md:text-mono-data tracking-[0.35em] placeholder:tracking-[0.35em]"
            />

            <FormStatus state={state} id={statusId} className="justify-center text-center" />

            <SubmitButton className="h-9 w-full" pendingLabel="Checking…">
              Enter
            </SubmitButton>
          </>
        );
      }}
    </Form>
  );
}
