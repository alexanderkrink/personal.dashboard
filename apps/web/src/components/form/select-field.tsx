"use client";

import { FormField } from "@/components/form/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FormState } from "@/lib/forms/form-state";

export type SelectFieldOption = { value: string; label: string };

/**
 * A labelled `Select`, wired into the shared form pattern.
 *
 * `FormField` hands over the id / name / value / error wiring; the only work
 * here is spreading it across Base UI's split anatomy — `name` and `value` live
 * on the root (which renders the hidden input that actually posts), while `id`
 * and the ARIA attributes belong on the trigger, since that is the element the
 * label points at and the one `Form` moves focus to after a failed submit.
 *
 * `onValueChange` takes `control.onChange` directly: `FieldControlProps` accepts
 * a bare value as well as a DOM event precisely so value-based controls need no
 * adapter here.
 *
 * `defaultValue` fills in before the first submit, when `FormField` has nothing
 * echoed to seed from. Passing `""` means "no selection", and the option list
 * should then carry an explicit empty-valued entry to say so in words.
 */
export function SelectField({
  name,
  label,
  state,
  options,
  defaultValue = "",
  labelAdornment,
}: {
  name: string;
  label: React.ReactNode;
  state: FormState;
  options: readonly SelectFieldOption[];
  defaultValue?: string;
  labelAdornment?: React.ReactNode;
}) {
  const items = Object.fromEntries(options.map((option) => [option.value, option.label]));

  return (
    <FormField name={name} label={label} state={state} labelAdornment={labelAdornment}>
      {(control) => (
        <Select
          items={items}
          name={control.name}
          value={control.value || defaultValue}
          onValueChange={control.onChange}
        >
          <SelectTrigger
            id={control.id}
            className="w-full"
            aria-invalid={control["aria-invalid"]}
            aria-describedby={control["aria-describedby"]}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </FormField>
  );
}
