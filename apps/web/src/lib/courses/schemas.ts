import { z } from "zod";

/**
 * The validation boundary for the three foundation tables — semesters, courses
 * and assessments (CLAUDE.md: *Zod at every boundary — form input, Server
 * Actions…*).
 *
 * Everything here parses **strings**, because that is all an HTML form can
 * send: `readFormValues` normalises a `FormData` into a `Record<string,string>`
 * and these schemas turn it into the typed, nullable shape the database
 * columns actually want. Field names are camelCase and match the schema keys
 * one-for-one, so `fieldErrors` lands on the right control without a mapping
 * table; the action does the single camelCase → snake_case hop when it builds
 * the row.
 *
 * Where a database constraint exists, the schema restates it deliberately —
 * `semesters_dates_ordered`, `assessments_weight_range`,
 * `courses_color_palette_key`, the `kind` check. A constraint violation
 * surfacing as a 500 is not an error message; it is a crash with a stack trace
 * where a sentence should be.
 */

/* -------------------------------------------------------------------------- */
/* String → value helpers                                                     */
/* -------------------------------------------------------------------------- */

/** Trims, then treats an empty field as "not provided" rather than as `""`. */
const blankToNull = z
  .string()
  .transform((value) => value.trim())
  .transform((value): string | null => (value === "" ? null : value));

const numberFromString = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value !== "" && Number.isFinite(Number(value)), {
    message: "Enter a number.",
  })
  .transform(Number);

function rangeMessage(min: number, max: number): string {
  return `Enter a number between ${min} and ${max}.`;
}

/** An optional numeric column: blank is a legitimate answer, garbage is not. */
function optionalNumeric(min: number, max: number) {
  return blankToNull.pipe(
    numberFromString
      .refine((value) => value >= min && value <= max, rangeMessage(min, max))
      .nullable(),
  );
}

function requiredText(message: string, max: number) {
  return z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1, message).max(max, `Keep this under ${max} characters.`));
}

function optionalText(max: number) {
  return blankToNull.pipe(z.string().max(max, `Keep this under ${max} characters.`).nullable());
}

/* -------------------------------------------------------------------------- */
/* Semesters                                                                  */
/* -------------------------------------------------------------------------- */

export const SEMESTER_FIELDS = ["name", "startsOn", "endsOn"] as const;

export const semesterSchema = z
  .object({
    name: requiredText("A semester needs a name — “2026/27 Fall”, say.", 80),
    startsOn: z.iso.date("Enter a start date."),
    endsOn: z.iso.date("Enter an end date."),
  })
  // Mirrors the `semesters_dates_ordered` check constraint. The planner's
  // exam-detection rule validates candidate dates against these bounds, so a
  // term that ends before it starts would silently reject every exam inside it.
  // ISO dates compare lexicographically, which for `YYYY-MM-DD` is chronological.
  .refine((value) => value.endsOn >= value.startsOn, {
    path: ["endsOn"],
    message: "The end date can’t fall before the start date.",
  });

export type SemesterInput = z.infer<typeof semesterSchema>;

/* -------------------------------------------------------------------------- */
/* Courses                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The curated 8-hue categorical set. These are **palette keys**, not colours:
 * `20260718094900_courses_color_palette_key.sql` constrains the column to
 * exactly this list, and the design tokens (`--course-*` in globals.css) own
 * the light/dark OKLCH pair for each. A raw hex has no dark-mode counterpart,
 * which is why one never reaches the database.
 */
export const COURSE_COLORS = [
  "indigo",
  "violet",
  "pink",
  "gold",
  "green",
  "teal",
  "cyan",
  "rust",
] as const;

export type CourseColor = (typeof COURSE_COLORS)[number];

export const DEFAULT_COURSE_COLOR: CourseColor = "indigo";

/**
 * Grading scales.
 *
 * PLAN names `ie_10` (the default, and the scale every IE course is marked on)
 * and describes the German 1.0–4.0 conversion as *derived* — `bavarian_grade()`
 * maps an IE 10-point mark onto it. `de_1_5` is here because the dual degree's
 * German half is graded natively on 1.0 (best) – 5.0 (fail), and a course
 * marked that way is not an IE course with a conversion applied to it.
 *
 * The column carries no check constraint, so this list is a UI decision rather
 * than a schema one and stays cheap to revise.
 */
export const GRADING_SCALES = [
  { value: "ie_10", label: "IE — 10 point", hint: "10 best · 5 passes", min: 0, max: 10 },
  { value: "de_1_5", label: "German — 1.0 to 5.0", hint: "1.0 best · 4.0 passes", min: 1, max: 5 },
] as const;

export type GradingScale = (typeof GRADING_SCALES)[number]["value"];

const GRADING_SCALE_VALUES = GRADING_SCALES.map((scale) => scale.value) as [
  GradingScale,
  ...GradingScale[],
];

export const DEFAULT_GRADING_SCALE: GradingScale = "ie_10";

export const COURSE_FIELDS = [
  "semesterId",
  "code",
  "title",
  "color",
  "credits",
  "targetGrade",
  "gradingScale",
  "participationWeight",
  "absenceFailPct",
  "participationTarget",
] as const;

export const courseSchema = z
  .object({
    // `on delete set null` on the FK, and PLAN's own diagram marks the edge
    // optional: a course can exist before its term does.
    semesterId: blankToNull.pipe(z.uuid("Pick a semester from the list.").nullable()),
    code: optionalText(32),
    title: requiredText("A course needs a title.", 200),
    color: z.enum(COURSE_COLORS, "Pick one of the eight course colours."),
    // ECTS. 120 is a comfortable ceiling — a full year is 60.
    credits: optionalNumeric(0, 120),
    // Range-checked loosely here and precisely against the scale below, so the
    // message can name the scale the user actually chose.
    targetGrade: optionalNumeric(0, 10),
    gradingScale: z.enum(GRADING_SCALE_VALUES, "Pick a grading scale."),
    participationWeight: optionalNumeric(0, 100),
    absenceFailPct: optionalNumeric(0, 100),
    // Contributions aimed for per session — a small integer in practice.
    participationTarget: optionalNumeric(0, 100),
  })
  .superRefine((value, ctx) => {
    if (value.targetGrade === null) return;

    const scale = GRADING_SCALES.find((entry) => entry.value === value.gradingScale);
    if (!scale) return;

    if (value.targetGrade < scale.min || value.targetGrade > scale.max) {
      ctx.addIssue({
        code: "custom",
        path: ["targetGrade"],
        message: `On the ${scale.label} scale, that has to be between ${scale.min} and ${scale.max}.`,
      });
    }
  });

export type CourseInput = z.infer<typeof courseSchema>;

/* -------------------------------------------------------------------------- */
/* Assessments                                                                */
/* -------------------------------------------------------------------------- */

export const ASSESSMENT_KINDS = [
  { value: "exam", label: "Exam" },
  { value: "quiz", label: "Quiz" },
  { value: "project", label: "Project" },
  { value: "participation", label: "Participation" },
  { value: "paper", label: "Paper" },
  { value: "other", label: "Other" },
] as const;

export type AssessmentKind = (typeof ASSESSMENT_KINDS)[number]["value"];

const ASSESSMENT_KIND_VALUES = ASSESSMENT_KINDS.map((kind) => kind.value) as [
  AssessmentKind,
  ...AssessmentKind[],
];

export const DEFAULT_ASSESSMENT_KIND: AssessmentKind = "exam";

export function assessmentKindLabel(kind: string): string {
  return ASSESSMENT_KINDS.find((entry) => entry.value === kind)?.label ?? "Other";
}

export const ASSESSMENT_FIELDS = ["title", "kind", "weightPercent", "dueHint"] as const;

export const assessmentSchema = z.object({
  title: requiredText("A component needs a name — “Midterm”, “Group project”.", 200),
  kind: z.enum(ASSESSMENT_KIND_VALUES, "Pick what kind of component this is."),
  // Mirrors `assessments_weight_range`. Rounded to the column's own
  // `numeric(5,2)` precision here rather than letting Postgres round silently,
  // so what the weight total adds up to on screen is what is actually stored.
  weightPercent: z
    .string()
    .transform((value) => value.trim())
    .pipe(
      numberFromString
        .refine((value) => value >= 0 && value <= 100, rangeMessage(0, 100))
        .transform((value) => Math.round(value * 100) / 100),
    ),
  // Freeform on purpose — this is whatever the syllabus said ("week 9").
  // Real dates live in the calendar, not here.
  dueHint: optionalText(120),
});

export type AssessmentInput = z.infer<typeof assessmentSchema>;

/** Every action that takes an existing row's id validates it as one. */
export const rowIdSchema = z.uuid();
