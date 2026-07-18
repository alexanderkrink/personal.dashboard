"use client";

import { WarningCircle } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect } from "react";
import { FOCUS_RING } from "@/components/shell/focus-ring";
import { cn } from "@/lib/utils";

/**
 * Plain language, name the problem, suggest the fix, never a raw stack trace
 * (PLAN.md "States & voice"). `error.message` is deliberately not rendered: in
 * production React replaces it with a generic string anyway, and in development
 * it is a stack-adjacent internal. The `digest` is shown instead — it is a
 * short opaque id that matches a server log line, which is the useful half.
 *
 * Nothing the user typed is lost here: this boundary replaces the page body
 * only, and the shell (sidebar, top bar, palette) stays mounted around it.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Unhandled error in the app shell", error);
  }, [error]);

  return (
    <section className="rounded-lg border border-border bg-surface p-6 md:p-8">
      <WarningCircle aria-hidden="true" weight="duotone" className="size-6 text-destructive" />
      <h2 className="mt-4 font-medium text-foreground text-ui-lg">This page didn&apos;t load.</h2>
      <p className="mt-1.5 max-w-prose text-muted-foreground text-ui-md">
        Something went wrong fetching what belongs here. Nothing you entered has been lost — the
        rest of the app is still running, so you can keep working elsewhere while this settles.
      </p>
      <p className="mt-4 max-w-prose text-muted-foreground text-ui-sm">
        Try again first. If it keeps failing, it is most likely the connection to the database
        rather than anything on your end.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={reset}
          className={cn(
            "inline-flex h-8 items-center rounded-md bg-primary px-3 font-medium text-primary-foreground text-ui-base transition-colors duration-fast ease-out-quart hover:bg-accent-hover",
            "pointer-coarse:h-11",
            FOCUS_RING,
          )}
        >
          Try again
        </button>
        <Link
          href="/"
          className={cn(
            "inline-flex h-8 items-center rounded-md border border-border px-3 font-medium text-foreground text-ui-base transition-colors duration-fast ease-out-quart hover:bg-muted",
            "pointer-coarse:h-11",
            FOCUS_RING,
          )}
        >
          Back to the dashboard
        </Link>
      </div>

      {error.digest ? (
        <p className="mt-5 text-muted-foreground text-ui-xs">
          Reference <span className="font-mono text-foreground">{error.digest}</span>
        </p>
      ) : null}
    </section>
  );
}
