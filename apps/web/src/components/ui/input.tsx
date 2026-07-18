import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        // `border-input-border`, not `border-input`: the control edge is the
        // only boundary of a non-text UI component and owes WCAG 1.4.11 its
        // 3:1, which the decorative `--border`/`--input` hairline does not meet.
        // `focus-ring` replaces the registry's 3px 50%-alpha halo, which
        // measured 1.60:1 in light. Both are documented in globals.css.
        "focus-ring h-8 w-full min-w-0 rounded-lg border border-input-border bg-transparent px-2.5 py-1 text-base transition-colors file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive md:text-sm dark:bg-input/30 dark:disabled:bg-input/80",
        // 44px minimum touch target on coarse pointers (PLAN.md "Mobile / PWA &
        // accessibility"); the compact 32px control is for mice only.
        "pointer-coarse:h-11",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
