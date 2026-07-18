"use client";

import { useEffect, useRef } from "react";
import { unlock } from "@/app/gate/actions";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";

/**
 * The access-code input. One field, JetBrains Mono, wide tracking — the screen
 * has exactly one affordance and says almost nothing about what is behind it
 * (PLAN.md "Access-code gate & auth").
 */
export function GateForm({ invalid }: { invalid: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus on mount. Done imperatively rather than with the `autoFocus`
  // attribute: on a page whose entire content is this one field there is
  // nothing for a screen-reader user to be yanked away from, which is the
  // situation `autoFocus` is otherwise discouraged for.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <form action={unlock} className="flex w-full max-w-xs flex-col gap-4">
      <label htmlFor="access-code" className="sr-only">
        Access code
      </label>
      <Input
        ref={inputRef}
        id="access-code"
        name="code"
        type="text"
        required
        maxLength={256}
        placeholder="••••••••"
        aria-invalid={invalid}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className="h-11 text-center font-mono text-mono-data tracking-[0.35em] placeholder:tracking-[0.35em]"
      />

      {invalid ? (
        <p role="alert" className="text-center text-destructive text-ui-sm">
          Not recognised.
        </p>
      ) : null}

      <SubmitButton className="h-9 w-full" pendingLabel="Checking…">
        Enter
      </SubmitButton>
    </form>
  );
}
