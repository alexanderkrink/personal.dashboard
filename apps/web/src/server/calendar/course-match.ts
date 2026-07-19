/**
 * Course matching (§5.1), first hit wins.
 *
 * ```
 * 1. feed-level pin (config.courseId)   — per-course feeds, zero inference
 * 2. course_matchers   (substring, ci)  — what the user taught the system
 * 3. courses.code / courses.title       — implicit patterns
 * 4. no match  → the Unassigned bucket
 * ```
 *
 * 🚫 **`DESCRIPTION` is not a matching surface.** Verified 2026-07-18 against
 * the live feed: 378 of 379 events carry the literal two-character value `\n\n`,
 * so it is blank after `.trim()` and the one non-blank value belongs to the
 * `Last Update` pseudo-row. The matching surface is `courseHint` — the §5.1b
 * normalizer's first multi-space segment, i.e. the clean course name.
 *
 * Split out of `sync.ts` because the **read** path needs the identical answer:
 * the Unassigned bucket groups synced rows by the hint that failed to match, and
 * a second, subtly different implementation there would show the user a bucket
 * whose contents disagree with what the next sync does.
 *
 * `step` is returned alongside the id rather than the id alone so the UI can say
 * *why* something matched — "pinned to this feed" and "guessed from the title"
 * deserve different amounts of trust, and §5.1's whole point is that a learned
 * matcher outranks an inference.
 */

/** Which rung of the chain answered. Ordered, most trustworthy first. */
export type CourseMatchStep = "feed_pin" | "matcher" | "course_code" | "course_title";

export interface CourseMatch {
  courseId: string;
  step: CourseMatchStep;
  /** The `course_matchers.pattern` or course field that matched. Absent for a pin. */
  matchedOn?: string;
}

export interface CourseMatchCourse {
  id: string;
  code: string | null;
  title: string;
}

export interface CourseMatchContext {
  /**
   * `calendar_feeds.config.courseId` — step 1.
   *
   * Validated against `courses` before it is honoured. A pin naming a course the
   * user does not own would be rejected by the composite `(course_id, user_id)`
   * foreign key anyway, and failing the whole sync on one stale config value is
   * a worse outcome than falling through to inference.
   */
  pinnedCourseId?: string | null;
  matchers: readonly { course_id: string; pattern: string }[];
  courses: readonly CourseMatchCourse[];
}

/**
 * A prepared matcher, so the per-event work is a few `includes` calls rather
 * than re-lowercasing the whole course list 374 times.
 */
export function createCourseMatcher(
  context: CourseMatchContext,
): (hint: string) => CourseMatch | null {
  const courseIds = new Set(context.courses.map((course) => course.id));
  const pinned =
    context.pinnedCourseId != null && courseIds.has(context.pinnedCourseId)
      ? context.pinnedCourseId
      : null;

  const matchers = context.matchers
    .map((matcher) => ({
      courseId: matcher.course_id,
      pattern: matcher.pattern.trim().toLowerCase(),
      raw: matcher.pattern,
    }))
    // A blank pattern is a substring of everything and would swallow the entire
    // feed into one course. Dropped rather than trusted.
    .filter((matcher) => matcher.pattern !== "" && courseIds.has(matcher.courseId));

  const codes = context.courses
    .map((course) => ({ id: course.id, value: (course.code ?? "").trim().toLowerCase() }))
    .filter((course) => course.value !== "");

  const titles = context.courses
    .map((course) => ({ id: course.id, value: course.title.trim().toLowerCase() }))
    .filter((course) => course.value !== "");

  return (hint: string): CourseMatch | null => {
    // Step 1 answers before the hint is even read — that is what "zero
    // inference" means, and it is why a pinned per-course feed does not need a
    // parseable summary at all.
    if (pinned !== null) return { courseId: pinned, step: "feed_pin" };

    const needle = hint.trim().toLowerCase();
    if (needle === "") return null;

    // Step 2. Learned rules win over inference: a user who filed an event under
    // a course is correcting the guess, not asking to be second-guessed by one.
    for (const matcher of matchers) {
      if (needle.includes(matcher.pattern)) {
        return { courseId: matcher.courseId, step: "matcher", matchedOn: matcher.raw };
      }
    }

    // Step 3a — code. Whole-word, never substring: a code like `MM` would
    // otherwise match `SUMMER SCHOOL`, and a two-letter false positive files a
    // whole course's events under the wrong heading silently.
    for (const course of codes) {
      if (containsWord(needle, course.value)) {
        return { courseId: course.id, step: "course_code", matchedOn: course.value };
      }
    }

    // Step 3b — title. Exact first, then containment in both directions: the
    // feed truncates long course names, and it also appends room text that
    // survives normalization.
    for (const course of titles) {
      if (course.value === needle) {
        return { courseId: course.id, step: "course_title", matchedOn: course.value };
      }
    }
    for (const course of titles) {
      if (needle.includes(course.value) || course.value.includes(needle)) {
        return { courseId: course.id, step: "course_title", matchedOn: course.value };
      }
    }

    return null;
  };
}

/**
 * Whole-word containment, with word boundaries defined as "not alphanumeric".
 *
 * Built by scanning rather than by `new RegExp(...)` because a course code is
 * user input: `C++` or `MATH.1` would either throw or quietly become a wildcard
 * if interpolated into a pattern.
 */
function containsWord(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;

    const before = at === 0 ? "" : haystack[at - 1];
    const after = haystack[at + needle.length] ?? "";
    if (!isWordChar(before) && !isWordChar(after)) return true;

    from = at + 1;
  }
}

function isWordChar(character: string | undefined): boolean {
  return character !== undefined && character !== "" && /[a-z0-9]/i.test(character);
}
