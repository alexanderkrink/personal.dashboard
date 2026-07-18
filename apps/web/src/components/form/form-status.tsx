import type { FormState } from "@/lib/forms/form-state";
import { cn } from "@/lib/utils";

export type FormStatusTone = "error" | "success" | "info";

const TONE_CLASS: Record<FormStatusTone, string> = {
  error: "text-destructive",
  success: "text-success",
  info: "text-muted-foreground",
};

/**
 * A form's single live region — the form-level message under the fields.
 *
 * It is the ONLY `role="alert"` in a form: per-field messages reach the user
 * through `aria-describedby` when `Form` moves focus to the offending control,
 * so a screen reader hears the summary once and then the specific field once,
 * rather than the same failure once per invalid field.
 *
 * Errors are assertive (`role="alert"`); confirmations and hints are polite
 * (`role="status"`), so nobody is interrupted mid-sentence by "check your
 * inbox". `tabIndex={-1}` exists so `Form` can land focus here when a failure
 * belongs to no single field; `data-slot` is how `Form` finds it.
 *
 * `fallback` covers the messages that genuinely arrive by navigation rather
 * than by submitting this form — an expired recovery link, say — so a page can
 * render one status line rather than two competing ones.
 */
export function FormStatus({
  state,
  fallback,
  className,
  id,
}: {
  state: FormState;
  fallback?: { tone: FormStatusTone; message: string };
  className?: string;
  /** Set this when a control needs to `aria-describedby` the form-level message. */
  id?: string;
}) {
  const active =
    state.status === "idle" ? fallback : { tone: state.status, message: state.message };

  if (!active?.message) return null;
  const { tone, message } = active;

  return (
    <p
      id={id}
      data-slot="form-status"
      tabIndex={-1}
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 text-ui-base outline-none",
        TONE_CLASS[tone],
        className,
      )}
    >
      {/* `bg-current` wins over `.dot-motif`'s azure: the motif is declared in
          the components layer, and Tailwind emits utilities after it. */}
      <span aria-hidden="true" className="dot-motif mt-[0.4rem] bg-current" />
      <span>{message}</span>
    </p>
  );
}
