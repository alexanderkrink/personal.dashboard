"use client";

import { useActionState, useEffect, useRef } from "react";
import { type FormState, IDLE_FORM_STATE } from "@/lib/forms/form-state";
import { cn } from "@/lib/utils";

export type FormAction = (state: FormState, formData: FormData) => Promise<FormState>;

/**
 * The form shell every form in the app is built on.
 *
 * It owns three things that are easy to get wrong once per form and impossible
 * to get wrong once here:
 *
 *  1. **`useActionState`**, so a failed submit re-renders the SAME form instead
 *     of redirecting. Nothing the user typed is lost (WCAG 2.2 SC 3.3.7).
 *  2. **Focus**, which after a failed submit lands on the first invalid control
 *     — or on the form-level message when the failure belongs to no single
 *     field — rather than being dumped on `<body>`.
 *  3. The **state hand-off**: `children` is a render prop so every field can see
 *     the current `FormState` without a context or a prop drill.
 *
 * Usage — this is the pattern to copy for CRUD forms:
 *
 * ```tsx
 * <Form action={createCourse}>
 *   {(state) => (
 *     <>
 *       <FormField name="title" label="Title" state={state}>
 *         {(control) => <Input {...control} required />}
 *       </FormField>
 *       <FormStatus state={state} />
 *       <SubmitButton>Create course</SubmitButton>
 *     </>
 *   )}
 * </Form>
 * ```
 */
export function Form({
  action,
  children,
  className,
  initialState = IDLE_FORM_STATE,
  ...props
}: Omit<React.ComponentProps<"form">, "action" | "children"> & {
  action: FormAction;
  children: (state: FormState) => React.ReactNode;
  /**
   * What the form starts out holding. An **edit** form passes the row's current
   * values here — `{ status: "idle", values: { title: "…" } }` — and every
   * field seeds itself from `state.values` exactly as it already does after a
   * failed submit, so nothing below this component needs to know the difference
   * between "the server sent this back" and "this is what is on file".
   *
   * Leave it out for a create form. Never put a secret in `values`.
   */
  initialState?: FormState;
}) {
  const [state, formAction] = useActionState(action, initialState);
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status !== "error") return;
    const form = ref.current;
    if (!form) return;

    // The first invalid control is the most useful landing place: it is where
    // the work is, and its `aria-describedby` carries the reason, so a screen
    // reader announces the specific error as focus arrives. With no invalid
    // control the failure is form-level, so the message itself takes focus.
    const target =
      form.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      form.querySelector<HTMLElement>('[data-slot="form-status"]');
    target?.focus();
  }, [state]);

  return (
    <form ref={ref} action={formAction} className={cn("flex flex-col gap-5", className)} {...props}>
      {children(state)}
    </form>
  );
}
