/**
 * The `quick-add` job (PLAN.md §Deadlines & Calendar Hub §6, CAL-3).
 *
 * Natural language → a proposed calendar entry, through the metered runtime. This is the
 * thin binding of one prompt to one schema to one system message, in the shape of
 * `syllabus-components`: it does not know where the utterance came from, and it does not
 * touch a database. Everything it returns is a *proposal* for the confirm card — deadlines
 * are date-critical data behind the §2b mandatory human confirm, and the decision to
 * persist belongs to the app, after the human.
 *
 * The caller injects `today`, `weekday` and `timezone` because this package cannot read a
 * clock — and must not: the today that matters is the user's, computed from
 * `profiles.timezone`, not the server's.
 *
 * Metering, the §3 stamp and the §2 failure ladder all come from `generateStructured`;
 * this module adds nothing to them and cannot bypass them.
 */

import { QUICK_ADD_SYSTEM, quickAddPrompt } from "../prompts/quick-add";
import type { AIRuntime, GenerateStructuredResult } from "../runtime";
import { type QuickAddParse, quickAddParseSchema } from "../schemas/quick-add";

/** One course the parse may link to. The id is what `courseId` must be copied from. */
export interface QuickAddCourse {
  readonly id: string;
  readonly title: string;
}

export interface ParseQuickAddOptions {
  readonly runtime: AIRuntime;
  /** What the student typed — "ML assignment 3 due next friday 23:59". */
  readonly utterance: string;
  /** Today's date, YYYY-MM-DD, **in the user's timezone**. Injected by the caller. */
  readonly today: string;
  /** The weekday `today` falls on ("Tuesday") — what makes "next friday" computable. */
  readonly weekday: string;
  /** The IANA timezone every returned date/time is expressed in ("Europe/Madrid"). */
  readonly timezone: string;
  /** The user's active courses. `courseId` may only ever be one of these ids. */
  readonly courses: readonly QuickAddCourse[];
}

/** The course list as the prompt shows it — one `- id — title` line per course. */
export function renderQuickAddCourses(courses: readonly QuickAddCourse[]): string {
  if (courses.length === 0) return "(no courses yet)";
  return courses.map((course) => `- ${course.id} — ${course.title}`).join("\n");
}

/**
 * Runs the parse.
 *
 * Returns the ladder's own result type rather than throwing on a dead-letter: an utterance
 * the model cannot parse is a normal outcome — §6 degrades it to the empty structured form
 * — not an exception. Transport errors still throw, and the caller (a Server Action with a
 * human waiting) degrades those to the same form.
 */
export async function parseQuickAdd({
  runtime,
  utterance,
  today,
  weekday,
  timezone,
  courses,
}: ParseQuickAddOptions): Promise<GenerateStructuredResult<QuickAddParse>> {
  const result = await runtime.generateStructured({
    prompt: quickAddPrompt,
    vars: {
      utterance,
      today,
      weekday,
      timezone,
      courseList: renderQuickAddCourses(courses),
    },
    schema: quickAddParseSchema,
    system: QUICK_ADD_SYSTEM,
    // A human is watching the confirm card fill in. Under budget pressure §6 defers
    // background work first and interactive work last, and this is the latter.
    kind: "interactive",
  });

  if (result.status !== "success") return result;

  // ── The two deterministic guards ─────────────────────────────────────────────
  // Adjudicated in code, not in the schema, because the schema cannot hold either:
  // a JSON-Schema string cannot know the caller's course list, and the provider does
  // not enforce cross-field rules. Both follow the routing precedent — a violation
  // the code can settle for free never burns a §2 ladder rung.
  //
  // 1. `courseId` must name a PROVIDED course (§6: "chosen from the provided list
  //    only"). A hallucinated id — right shape, wrong universe — pre-selected on the
  //    confirm card would file the entry under whichever course happens to own that
  //    id. Nulled, so the card shows "No course" and the human picks.
  // 2. An all-day parse (`time: null`) carries no duration. `quickAddSchema` rejects
  //    the combination on submit, so letting it through would hand the student a
  //    pre-filled card that fails validation through no fault of their own.
  const known = new Set(courses.map((course) => course.id));
  const courseId =
    result.value.courseId !== null && known.has(result.value.courseId)
      ? result.value.courseId
      : null;
  const durationMinutes = result.value.time === null ? null : result.value.durationMinutes;

  return { ...result, value: { ...result.value, courseId, durationMinutes } };
}
