"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

type SubmitButtonProps = React.ComponentProps<typeof Button> & {
  /** Label shown while the form's Server Action is in flight. */
  pendingLabel?: string;
};

/**
 * Submit button that disables itself while the form's Server Action is pending.
 * `useFormStatus` reports the status of the enclosing form, so on a form with
 * two submit buttons (e.g. sign-in and magic-link) both correctly go busy —
 * the form really is busy, whichever one was pressed.
 */
export function SubmitButton({ children, pendingLabel = "Working…", ...props }: SubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" {...props} disabled={pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
