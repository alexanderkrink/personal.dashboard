"use client";

import { createQuickAddItem } from "@/app/(app)/calendar/item-actions";
import { Form } from "@/components/form/form";
import { FormField } from "@/components/form/form-field";
import { FormStatus } from "@/components/form/form-status";
import { SelectField } from "@/components/form/select-field";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import type { FormState } from "@/lib/forms/form-state";

/**
 * Structured quick-add (§6) — the form, in both of its §6 roles.
 *
 * Empty, it is the floor: direct manual entry, and the fallback when the
 * natural-language parse fails or is unavailable. Seeded through `initialState`
 * (by `NlQuickAdd`, CAL-3), it is the **confirm card**: every proposed field
 * sits in an editable control, and nothing exists in the calendar until the
 * human presses the one submit button — `createQuickAddItem` is the only write
 * path, and this form's own `FormData` is its only input. §6: "the structured
 * form is the fallback, not a separate feature".
 *
 * Every field is wired through `FormField`, which **holds its value in state**.
 * That is not optional: React 19 resets an uncontrolled `<form action>` once the
 * action settles, so a correctly-wired field would otherwise come back empty
 * after a failed submit — the WCAG 2.2 SC 3.3.7 failure the shared form shell
 * exists to prevent. It is also what makes the confirm card work at all:
 * `state.values` seeds each control, whether those values came from a failed
 * submit or from the parse.
 */
export function QuickAddForm({
  courses,
  initialState,
}: {
  courses: readonly { id: string; title: string }[];
  /**
   * The parse's proposal, as `{ status: "info", values }`. Read once on mount —
   * a NEW proposal must arrive on a NEW `key`, which is how `NlQuickAdd`
   * remounts this into a fresh confirm card per parse.
   */
  initialState?: FormState;
}) {
  return (
    <Form action={createQuickAddItem} className="space-y-4" initialState={initialState}>
      {(state) => (
        <>
          <FormField name="title" label="What is it?" state={state}>
            {(control) => (
              <Input {...control} required placeholder="Problem set 3" autoComplete="off" />
            )}
          </FormField>

          <div className="grid gap-4 sm:grid-cols-3">
            <SelectField
              name="kind"
              label="Type"
              state={state}
              defaultValue="deadline"
              options={[
                { value: "deadline", label: "Deadline" },
                { value: "class", label: "Class" },
                { value: "event", label: "Event" },
              ]}
            />

            <FormField name="date" label="Date" state={state}>
              {(control) => <Input {...control} type="date" required />}
            </FormField>

            <FormField
              name="time"
              label="Time"
              state={state}
              labelAdornment={
                <span className="text-muted-foreground text-ui-xs">blank = all day</span>
              }
            >
              {(control) => <Input {...control} type="time" />}
            </FormField>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <SelectField
              name="courseId"
              label="Course"
              state={state}
              defaultValue=""
              options={[
                { value: "", label: "No course" },
                ...courses.map((course) => ({ value: course.id, label: course.title })),
              ]}
            />

            <FormField
              name="weightPercent"
              label="Worth"
              state={state}
              labelAdornment={<span className="text-muted-foreground text-ui-xs">% of grade</span>}
            >
              {(control) => (
                <Input {...control} type="number" min={0} max={100} step="0.5" placeholder="20" />
              )}
            </FormField>

            <FormField
              name="durationMinutes"
              label="Duration"
              state={state}
              labelAdornment={<span className="text-muted-foreground text-ui-xs">minutes</span>}
            >
              {(control) => <Input {...control} type="number" min={1} placeholder="90" />}
            </FormField>
          </div>

          <FormStatus state={state} />

          <div className="flex items-center gap-3">
            <SubmitButton pendingLabel="Adding…">Add to calendar</SubmitButton>
            <p className="text-muted-foreground text-ui-xs">
              Saved as your own entry — sync never touches it.
            </p>
          </div>
        </>
      )}
    </Form>
  );
}
