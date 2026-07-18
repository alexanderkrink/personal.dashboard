"use client";

import { FormField } from "@/components/form/form-field";
import { SelectField } from "@/components/form/select-field";
import { Input } from "@/components/ui/input";
import { ASSESSMENT_KINDS, DEFAULT_ASSESSMENT_KIND } from "@/lib/courses/schemas";
import type { FormState } from "@/lib/forms/form-state";

const KIND_OPTIONS = ASSESSMENT_KINDS.map((kind) => ({ value: kind.value, label: kind.label }));

/**
 * The four fields of an assessment, shared by the add form and the inline row
 * editor so the two can never disagree about what a component is.
 */
export function AssessmentFields({ state }: { state: FormState }) {
  return (
    <div className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr_1fr]">
      <FormField name="title" label="Component" state={state}>
        {(control) => <Input {...control} required autoComplete="off" placeholder="Midterm" />}
      </FormField>

      <SelectField
        name="kind"
        label="Kind"
        state={state}
        options={KIND_OPTIONS}
        defaultValue={DEFAULT_ASSESSMENT_KIND}
      />

      <FormField name="weightPercent" label="Weight (%)" state={state}>
        {(control) => (
          <Input {...control} required inputMode="decimal" className="font-mono" placeholder="30" />
        )}
      </FormField>

      <FormField
        name="dueHint"
        label="Due"
        state={state}
        labelAdornment={<span className="text-muted-foreground text-ui-sm">Optional</span>}
      >
        {/* Freeform on purpose: this is whatever the syllabus said. */}
        {(control) => <Input {...control} autoComplete="off" placeholder="week 9" />}
      </FormField>
    </div>
  );
}
