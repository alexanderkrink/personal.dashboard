/**
 * Validation boundaries for the calendar item write paths (CLAUDE.md: *Zod at
 * every boundary*).
 *
 * Everything here parses strings, because that is all an HTML form sends. Field
 * names are camelCase and match the schema keys one-for-one, so `fieldErrors`
 * lands on the right control without a mapping table.
 */

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Quick-add (§6) — FORM ONLY                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 🚫 **The natural-language parse is deliberately NOT here.** §6 describes an
 * LLM (`gemini-3.1-flash-lite`) turning "ML assignment 3 due next friday 23:59"
 * into these fields — that is CAL-3/M2 and needs the `packages/ai` provider
 * layer, which Wave 2 does not have. §6 also says the structured form is "the
 * fallback, not a separate feature", so building the form first is building the
 * floor the parse will later land on, not a stopgap.
 *
 * This schema is exactly the shape `quickAddParseSchema` will eventually
 * produce, minus `confidence`, so wiring the parse in later is a new caller
 * rather than a rewrite.
 */
export const QUICK_ADD_FIELDS = [
  "title",
  "kind",
  "date",
  "time",
  "durationMinutes",
  "courseId",
  "weightPercent",
] as const;

/**
 * `""` → null. An HTML form has no way to send "absent", only "blank".
 *
 * The blank case is short-circuited *before* the inner schema runs, rather than
 * unioned with `z.literal("")`. A union would have to widen the input type to
 * accept both, which loses the string input the pipeline is built on — and it
 * would run the inner schema's coercion against `""` first, where
 * `z.coerce.number()` cheerfully produces `0`. A blank "worth" field is not 0%.
 */
function blankToNull<Output>(
  schema: z.ZodType<Output, unknown>,
): z.ZodType<Output | null, unknown> {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.union([z.null(), schema]),
  ) as z.ZodType<Output | null, unknown>;
}

export const quickAddSchema = z
  .object({
    title: z
      .string()
      .transform((value) => value.trim())
      .pipe(
        z
          .string()
          .min(1, "Give it a name — “Problem set 3”, say.")
          .max(200, "Keep this under 200 characters."),
      ),
    kind: z.enum(["deadline", "class", "event"], {
      message: "Pick a deadline, a class or an event.",
    }),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date.")
      // A structurally valid date that does not exist — 2026-02-30, say — would
      // otherwise be silently rolled forward by `Date.UTC` into 2 March, which
      // is a wrong deadline rather than a rejected one.
      .refine((value) => {
        const [year, month, day] = value.split("-").map(Number);
        if (year === undefined || month === undefined || day === undefined) return false;
        const date = new Date(Date.UTC(year, month - 1, day));
        return (
          date.getUTCFullYear() === year &&
          date.getUTCMonth() === month - 1 &&
          date.getUTCDate() === day
        );
      }, "That date doesn’t exist."),
    /** `null` → all-day, per §6's `time: …nullable()`. */
    time: blankToNull(z.string().regex(/^\d{2}:\d{2}$/, "Use 24-hour time, like 23:59.")),
    durationMinutes: blankToNull(
      z.coerce
        .number({ message: "Minutes, as a number." })
        .int("Whole minutes only.")
        .positive("Must be more than zero.")
        .max(24 * 60, "That’s longer than a day."),
    ),
    courseId: blankToNull(z.uuid("Pick a course from the list.")),
    weightPercent: blankToNull(
      z.coerce
        .number({ message: "A percentage, as a number." })
        .min(0, "Can’t be negative.")
        .max(100, "Can’t be more than 100%."),
    ),
  })
  .refine((value) => value.time !== null || value.durationMinutes === null, {
    message: "An all-day entry has no duration.",
    path: ["durationMinutes"],
  });

export type QuickAddInput = z.infer<typeof quickAddSchema>;

/* -------------------------------------------------------------------------- */
/* Course assignment (§5.1 step 4)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Filing one Unassigned group under a course.
 *
 * `pattern` is the course hint the group was built from, and it becomes the
 * `course_matchers.pattern` verbatim — which is why it is bounded here. A
 * one-character pattern is a substring of nearly every summary and would file
 * the whole feed under one course on the next sync.
 */
export const assignCourseSchema = z.object({
  pattern: z
    .string()
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .min(3, "That pattern is too short to match on safely.")
        .max(200, "Keep this under 200 characters."),
    ),
  courseId: z.uuid("Pick a course."),
});

/* -------------------------------------------------------------------------- */
/* Inline edits on a week row                                                 */
/* -------------------------------------------------------------------------- */

export const occurrenceIdSchema = z.uuid();
export const itemIdSchema = z.uuid();

/**
 * A user's ruling on a course's exam date (§5.1b).
 *
 * A discriminated union rather than one loose object, because the three moves
 * do not take the same input and a shared shape would have to make both
 * `itemId` and `courseId` optional — which is precisely how you end up with a
 * `reset` that quietly resets nothing because no course was named.
 *
 * `set` and `reject` address a **session**; `reset` addresses a **course**,
 * since after a rejection there is no session left to point at. That asymmetry
 * is the whole reason rejection used to be a dead end.
 */
export const examDecisionSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("set"), itemId: z.uuid() }),
  z.object({ intent: z.literal("reject"), itemId: z.uuid() }),
  z.object({ intent: z.literal("reset"), courseId: z.uuid() }),
]);

/** The inline weight override on the badge (§5.2 step 1, §7 part 3). */
export const weightOverrideSchema = z.object({
  itemId: itemIdSchema,
  weightPercent: blankToNull(
    z.coerce
      .number({ message: "A percentage, as a number." })
      .min(0, "Can’t be negative.")
      .max(100, "Can’t be more than 100%."),
  ),
});
