import type { z } from "zod";

/**
 * The one shape every Server Action that backs a form returns.
 *
 * Actions used to report failure by `redirect("/login?status=…")`. A redirect
 * remounts the whole route subtree, which wiped every field the user had typed
 * and dropped focus onto `<body>` — WCAG 2.2 SC 3.3.7 *Redundant Entry* (Level
 * A), and PLAN.md's "error = danger border + message below (never wipe the
 * field)". Returning state instead keeps the form mounted, so uncontrolled
 * inputs simply keep their values, and `values` below re-seeds them for the
 * no-JavaScript path where the document really is re-rendered.
 *
 * Actions still `redirect()` on SUCCESS — that is a real navigation, and losing
 * the form at that point is the point.
 */
export type FormState = {
  status: "idle" | "error" | "success" | "info";
  /**
   * The form-level message: the thing that went wrong for the submission as a
   * whole, or the confirmation. Rendered in a live region.
   */
  message?: string;
  /**
   * Field name -> message. Each entry puts `aria-invalid` and an
   * `aria-describedby` pointing at the message onto exactly that control, and
   * makes it the target for focus after a failed submit.
   */
  fieldErrors?: Readonly<Record<string, string>>;
  /**
   * What to re-render the form with. **Never put a secret in here** — no
   * passwords, no access codes, no tokens. It is echoed straight back into the
   * HTML, and on the auth surfaces it carries the email address only.
   */
  values?: Readonly<Record<string, string>>;
};

export const IDLE_FORM_STATE: FormState = { status: "idle" };

/**
 * Flattens a ZodError into `fieldErrors`, keeping the FIRST issue per field —
 * the rest are almost always downstream of it, and one message per field is
 * what the user can act on.
 *
 * Issues with an empty path (a schema that validates a bare value rather than
 * an object) have no field to attach to, so they become the form-level message.
 * Parse an object in the action and this stays empty.
 */
export function toFormState(
  error: z.ZodError,
  values?: Readonly<Record<string, string>>,
): FormState {
  const fieldErrors: Record<string, string> = {};
  let message: string | undefined;

  for (const issue of error.issues) {
    const [field] = issue.path;
    if (typeof field !== "string") {
      message ??= issue.message;
      continue;
    }
    if (!(field in fieldErrors)) fieldErrors[field] = issue.message;
  }

  return {
    status: "error",
    ...(message ? { message } : {}),
    ...(Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
    ...(values ? { values } : {}),
  };
}

/** A failure that belongs to the submission as a whole, not to one field. */
export function formError(message: string, values?: Readonly<Record<string, string>>): FormState {
  return { status: "error", message, ...(values ? { values } : {}) };
}
