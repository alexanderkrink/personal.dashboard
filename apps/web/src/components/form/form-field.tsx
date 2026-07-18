"use client";

import { useEffect, useId, useState } from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import type { FormState } from "@/lib/forms/form-state";

/**
 * The props `FormField` hands to the control it wraps. Spread them onto the
 * `Input`/`Textarea`/`Select` — together they are the entire accessibility and
 * state contract of a form control, so spreading them is the only thing a
 * caller has to remember.
 */
export type FieldControlProps = {
  id: string;
  name: string;
  value: string;
  /**
   * Accepts either a DOM change event or a bare value.
   *
   * Native controls (`Input`, `Textarea`, `<select>`) hand over an event; Base
   * UI's value-based controls hand over the value itself — `Select`'s
   * `onValueChange` is `(value: string | null, eventDetails)`, where `null` is
   * "cleared", and the extra argument is harmless. Taking the union here means
   * `control.onChange` can be passed straight to either without a call site
   * inventing a fake event object.
   */
  onChange: (
    event:
      | React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
      | string
      | null,
  ) => void;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
};

/**
 * A labelled control plus its error message, wired together.
 *
 * When `state` carries an error for `name` this component:
 *  - puts `aria-invalid="true"` on the control, which paints the danger border
 *    and re-hues the focus ring (see the `aria-invalid:` variants in
 *    `components/ui/input.tsx` and the `focus-ring` utility), and makes the
 *    control the target that `Form` moves focus to after a failed submit;
 *  - renders the message **below** the field and points `aria-describedby` at
 *    it, so the reason is announced with the control rather than floating free
 *    (PLAN.md "Component conventions": *error = danger border + message below*);
 *  - keeps what the user typed.
 *
 * **Why the control is CONTROLLED.** React resets a `<form action={…}>` once its
 * action settles, and an uncontrolled field comes back as its `defaultValue` —
 * i.e. empty — which is exactly the WCAG 2.2 SC 3.3.7 *Redundant Entry* failure
 * this whole module exists to stop. Holding the value in state here survives
 * that reset for every field at once, without each action having to remember to
 * echo it. `state.values` is still what seeds the initial value, which is what
 * makes the no-JavaScript path (a real document re-render) preserve entry too.
 *
 * The message deliberately carries no `role="alert"`. `FormStatus` is the
 * form's one live region; a per-field alert on top of it makes a screen reader
 * read the same failure once per invalid field.
 */
export function FormField({
  name,
  label,
  labelAdornment,
  state,
  describedBy,
  className,
  children,
}: {
  name: string;
  label: React.ReactNode;
  /**
   * Rendered opposite the label on the label's own row, OUTSIDE the `<label>`
   * element — a "Forgot?" link, an "Optional" marker, a unit hint. Anything
   * interactive has to sit outside the label, or clicking it also activates the
   * control the label points at.
   */
  labelAdornment?: React.ReactNode;
  state: FormState;
  /** Extra ids to keep in `aria-describedby` — e.g. a live password checklist. */
  describedBy?: string;
  className?: string;
  children: (control: FieldControlProps, value: string) => React.ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const error = state.fieldErrors?.[name];
  const describedByIds = [describedBy, error ? errorId : undefined].filter(Boolean).join(" ");

  const echoed = state.values?.[name];
  const [value, setValue] = useState(echoed ?? "");

  // An echoed value is the server's word on what this field holds — it only
  // appears after a submit, and it only differs from local state when the
  // action normalised the input or the page was re-rendered without JS.
  useEffect(() => {
    if (echoed !== undefined) setValue(echoed);
  }, [echoed]);

  return (
    <Field className={className}>
      {labelAdornment ? (
        <div className="flex items-baseline justify-between gap-3">
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          {labelAdornment}
        </div>
      ) : (
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
      )}
      {children(
        {
          id,
          name,
          value,
          onChange: (event) => {
            if (event === null) return setValue("");
            setValue(typeof event === "string" ? event : event.target.value);
          },
          ...(error ? { "aria-invalid": true as const } : {}),
          ...(describedByIds ? { "aria-describedby": describedByIds } : {}),
        },
        value,
      )}
      {error ? (
        <p id={errorId} className="text-destructive text-ui-sm">
          {error}
        </p>
      ) : null}
    </Field>
  );
}
