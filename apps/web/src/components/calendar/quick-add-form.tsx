"use client";

import { createQuickAddItem } from "@/app/(app)/calendar/item-actions";
import { Form } from "@/components/form/form";
import { FormField } from "@/components/form/form-field";
import { FormStatus } from "@/components/form/form-status";
import { SelectField } from "@/components/form/select-field";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";

/**
 * Structured quick-add (§6) — **the form, and only the form**.
 *
 * 🚫 The natural-language box ("`ML assignment 3 due next friday 23:59`") is
 * **out of scope for Wave 2**. It needs the `packages/ai` provider layer and a
 * versioned `definePrompt`, neither of which exists yet, and adding an
 * `@ai-sdk/*` import here would put a model call outside `packages/ai` — which
 * CLAUDE.md forbids outright. §6 already names the structured card as *"the
 * fallback, not a separate feature"*, so this is the floor that parse will later
 * land on rather than a placeholder for it.
 *
 * Every field is wired through `FormField`, which **holds its value in state**.
 * That is not optional: React 19 resets an uncontrolled `<form action>` once the
 * action settles, so a correctly-wired field would otherwise come back empty
 * after a failed submit — the WCAG 2.2 SC 3.3.7 failure the shared form shell
 * exists to prevent.
 */
export function QuickAddForm({ courses }: { courses: readonly { id: string; title: string }[] }) {
  return (
    <Form action={createQuickAddItem} className="space-y-4">
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
