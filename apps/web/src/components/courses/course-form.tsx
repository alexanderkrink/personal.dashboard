"use client";

import { ButtonLink } from "@/components/button-link";
import { CoursePaletteField } from "@/components/courses/course-palette-field";
import { Form, type FormAction } from "@/components/form/form";
import { FormField } from "@/components/form/form-field";
import { FormStatus } from "@/components/form/form-status";
import { SelectField } from "@/components/form/select-field";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { DEFAULT_GRADING_SCALE, GRADING_SCALES } from "@/lib/courses/schemas";
import type { FormState } from "@/lib/forms/form-state";

export type CourseFormValues = Readonly<Record<string, string>>;
export type SemesterOption = { id: string; name: string };

/**
 * Create and edit are the same form.
 *
 * The difference is entirely in what it starts holding and where it posts:
 * `initialValues` seeds every field through `Form`'s `initialState`, and a
 * hidden `courseId` tells the update action which row it is looking at. Two
 * near-identical forms would drift the moment a column is added.
 */
export function CourseForm({
  action,
  courseId,
  initialValues,
  semesters,
  submitLabel,
}: {
  action: FormAction;
  courseId?: string;
  initialValues?: CourseFormValues;
  semesters: readonly SemesterOption[];
  submitLabel: string;
}) {
  const initialState: FormState = {
    status: "idle",
    ...(initialValues ? { values: initialValues } : {}),
  };

  const semesterOptions = [
    { value: "", label: "No semester yet" },
    ...semesters.map((semester) => ({ value: semester.id, label: semester.name })),
  ];

  const scaleOptions = GRADING_SCALES.map((scale) => ({
    value: scale.value,
    label: `${scale.label} · ${scale.hint}`,
  }));

  return (
    <Form action={action} initialState={initialState} className="max-w-2xl">
      {(state) => (
        <>
          {courseId ? <input type="hidden" name="courseId" value={courseId} /> : null}

          <Section title="The course">
            <FormField name="title" label="Title" state={state}>
              {(control) => <Input {...control} required autoComplete="off" />}
            </FormField>

            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="code" label="Code" state={state} labelAdornment={<OptionalHint />}>
                {(control) => (
                  <Input
                    {...control}
                    placeholder="DBA-301"
                    autoComplete="off"
                    className="font-mono"
                  />
                )}
              </FormField>

              <SelectField
                name="semesterId"
                label="Semester"
                state={state}
                options={semesterOptions}
              />
            </div>

            <CoursePaletteField state={state} />
          </Section>

          <Section title="Grading" lead="What the grade cockpit does its arithmetic against.">
            <div className="grid gap-5 sm:grid-cols-2">
              <SelectField
                name="gradingScale"
                label="Grading scale"
                state={state}
                options={scaleOptions}
                defaultValue={DEFAULT_GRADING_SCALE}
              />

              <FormField
                name="targetGrade"
                label="Target grade"
                state={state}
                labelAdornment={<OptionalHint />}
              >
                {(control) => <Input {...control} inputMode="decimal" className="font-mono" />}
              </FormField>

              <FormField
                name="credits"
                label="Credits (ECTS)"
                state={state}
                labelAdornment={<OptionalHint />}
              >
                {(control) => <Input {...control} inputMode="decimal" className="font-mono" />}
              </FormField>
            </div>
          </Section>

          <Section
            title="Attendance & participation"
            lead="Leave these blank unless the syllabus actually sets them."
          >
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField
                name="participationWeight"
                label="Participation weight (%)"
                state={state}
                labelAdornment={<OptionalHint />}
              >
                {(control) => <Input {...control} inputMode="decimal" className="font-mono" />}
              </FormField>

              <FormField
                name="absenceFailPct"
                label="Absence fail threshold (%)"
                state={state}
                labelAdornment={<OptionalHint />}
              >
                {(control) => <Input {...control} inputMode="decimal" className="font-mono" />}
              </FormField>

              <FormField
                name="participationTarget"
                label="Contributions per session"
                state={state}
                labelAdornment={<OptionalHint />}
              >
                {(control) => <Input {...control} inputMode="decimal" className="font-mono" />}
              </FormField>
            </div>
          </Section>

          <FormStatus state={state} />

          <div className="flex items-center gap-2">
            <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
            {/* Cancel returns where the user came from, which `courseId`
                already says: editing came from the course, creating came from
                the list. The two branches render separate `Link`s rather than
                sharing one `href` variable — a ternary widens to `string`, and
                `typedRoutes` can only check a literal it can still see. */}
            {courseId ? (
              <ButtonLink variant="ghost" href={`/courses/${courseId}`}>
                Cancel
              </ButtonLink>
            ) : (
              <ButtonLink variant="ghost" href="/courses">
                Cancel
              </ButtonLink>
            )}
          </div>
        </>
      )}
    </Form>
  );
}

function OptionalHint() {
  return <span className="text-muted-foreground text-ui-sm">Optional</span>;
}

function Section({
  title,
  lead,
  children,
}: {
  title: string;
  lead?: string;
  children: React.ReactNode;
}) {
  // A plain section, not a `fieldset`: these groupings are visual, every
  // control inside is individually labelled, and the one control that genuinely
  // needs a group name — the colour radios — brings its own fieldset. Wrapping
  // this in a second one would nest fieldsets and announce each heading twice.
  return (
    <section className="space-y-5 border-border border-t pt-5 first:border-t-0 first:pt-0">
      <div className="space-y-0.5">
        <h3 className="font-medium text-foreground text-ui-lg">{title}</h3>
        {lead ? <p className="text-muted-foreground text-ui-sm">{lead}</p> : null}
      </div>
      {children}
    </section>
  );
}
