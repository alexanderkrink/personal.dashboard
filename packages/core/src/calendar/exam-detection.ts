/**
 * Exam detection — the REVISED §5.1b oracle chain.
 *
 * **Syllabus session count first; max session number as fallback; never
 * keyword, never chronology.**
 *
 * Two facts from the real feed rule out the obvious approaches:
 * - The `FINAL EXAM` keyword appears on **one course in the whole feed**, so
 *   text matching is useless.
 * - Session numbers are **not monotonic with date** (Corporate Finance has
 *   `Ses. 11` on 02-27 and `Ses. 10` on 03-02), so "last session" must key on
 *   the session number and never on chronology.
 *
 * ## Why the chain is ordered this way
 *
 * `max(sessionTo)` silently conflates two genuinely different states: *"session
 * N is the last one"* and *"session N is the last one **published so far**"*.
 * The syllabus's declared total distinguishes them, so the return type models
 * **three** outcomes rather than the found/not-found pair the earlier framing
 * allowed:
 *
 * 1. `found`     — an oracle named session N and the feed has an event for it.
 * 2. `pending`   — an oracle named session N and the feed does **not** have it
 *                  yet: *"exam not yet published, expect session N"*. This state
 *                  is the entire point of the reordering.
 * 3. `fallback`  — no syllabus on file; derived from `max(sessionTo)`, flagged
 *                  as such so the UI never presents it with false confidence.
 *
 * ## ⚠ What actually runs today
 *
 * 🔴 Verified 2026-07-18 (Agent 0, independently confirmed): all three syllabi
 * on disk are **2025-26 first-year** documents and map to **none** of the seven
 * fall-2026 courses. `assessments` is deliberately 0 rows. So:
 * - step 1 (`courses.total_sessions`) is live — the column IS seeded;
 * - step 2 (`assessments.session_number`) is currently **dead**, no rows;
 * - step 3 (`max(sessionTo)`) is **the live path for all 7 fall courses**.
 *
 * All three are built properly — fall-2026 syllabi are expected later — but the
 * fallback's three guards are not a rare path today. They are the only path.
 */

import type { NormalizedSummary } from "./summary";
import { expandSessionRange } from "./summary";

/** One feed event, reduced to what exam detection actually needs. */
export interface ExamCandidateEvent {
  uid: string;
  /** ISO 8601 UTC. */
  startsAtUtc: string;
  summary: NormalizedSummary;
}

/** A `semesters` row. Only the bounds matter here. */
export interface SemesterBounds {
  /** ISO date or datetime, inclusive. */
  startsAt: string;
  /** ISO date or datetime, inclusive. */
  endsAt: string;
}

/**
 * One `assessments` row, reduced to the columns the step-2 oracle reads.
 *
 * Field-for-field with the real table (`20260717161053` + `20260718161329`).
 */
export interface AssessmentOracleRow {
  id: string;
  /** `assessments.title` — e.g. `"Final Exam"`, `"In class Midterm Exam"`. */
  title: string;
  /** `assessments.kind` — one of exam/quiz/project/participation/paper/other. */
  kind: string;
  /** `assessments.session_number`; null for participation and for ranges. */
  sessionNumber: number | null;
}

export interface DetectExamInput {
  /** Feed events for ONE course, already normalized and course-matched. */
  events: readonly ExamCandidateEvent[];
  /**
   * Step 1 — `courses.total_sessions`, the syllabus-declared count N. The
   * strongest oracle: the syllabus states it as a first-class header field.
   */
  totalSessions?: number | null;
  /**
   * Step 2 — `assessments` rows carrying a `session_number`. The syllabus
   * labels WHICH session is WHICH assessment ("session 30 is the final,
   * session 19 the midterm"), which beats a bare total.
   *
   * Mirrors the real `assessments` columns. `title` is required because it is
   * the **only** place the final/midterm distinction exists: `kind` is
   * constrained to `('exam','quiz','project','participation','paper','other')`,
   * so both a final and a midterm are stored as `'exam'`.
   */
  assessments?: readonly AssessmentOracleRow[];
  /** Step 3's guard 2. Pass every semester row; the matching one is selected here. */
  semesters?: readonly SemesterBounds[];
}

export type ExamDetectionSource =
  /** `courses.total_sessions` — the syllabus's declared count. */
  | "syllabus_total_sessions"
  /** An `assessments.session_number` match. */
  | "assessment_session_number"
  /** `max(sessionTo)` across the feed. */
  | "feed_max_session";

export interface ExamFlags {
  /**
   * No `semesters` row covers the candidate's date, so the bounds check was
   * **skipped rather than failed**.
   *
   * ⚠ This must never discard the candidate. Only 2026/27 Fall and Spring are
   * seeded while 225 real feed events run from 2026-01-19 under a 2025/26 term
   * that has no row — a strict bounds check would silently drop half the
   * sample the fixtures are built from.
   */
  unbounded: boolean;
  /** The candidate falls outside every semester row that *could* contain it. */
  outsideSemester: boolean;
}

export type ExamDetection =
  | {
      outcome: "found";
      source: ExamDetectionSource;
      sessionNumber: number;
      uid: string;
      startsAtUtc: string;
      flags: ExamFlags;
      /** Events tagged as re-sits: hidden by default, NEVER deleted. */
      retakes: RetakeEvent[];
    }
  | {
      /** An oracle named session N; the feed has not published it yet. */
      outcome: "pending";
      source: Exclude<ExamDetectionSource, "feed_max_session">;
      expectedSessionNumber: number;
      retakes: RetakeEvent[];
    }
  | {
      /** Nothing to go on: no oracle, and no session numbers in the feed. */
      outcome: "unknown";
      retakes: RetakeEvent[];
    };

export interface RetakeEvent {
  uid: string;
  startsAtUtc: string;
  rawSummary: string;
}

/**
 * The maximum session number any event covers, expanding `(Ses. N-M)` ranges.
 *
 * Ranges are why this cannot read `sessionTo` naively across a raw feed:
 * `PROBABILITY & STATISTICS` has 34 events but **35 sessions**, because ranged
 * rows cover two apiece.
 */
export function maxSessionNumber(events: readonly ExamCandidateEvent[]): number | null {
  let max: number | null = null;
  for (const event of events) {
    for (const session of expandSessionRange(event.summary)) {
      if (max === null || session > max) {
        max = session;
      }
    }
  }
  return max;
}

/**
 * The event covering session N, resolving ties by **earliest date**.
 *
 * Guard 1 of the fallback: among events sharing the session number, earliest
 * wins — which defeats a retake that ever reuses the final session number.
 * (Verified: today every retake in the feed carries no `(Ses. N)` token at all,
 * so retakes are structurally outside the session domain. The guard stays
 * because feed formats change.)
 */
function eventCoveringSession(
  events: readonly ExamCandidateEvent[],
  session: number,
): ExamCandidateEvent | null {
  let best: ExamCandidateEvent | null = null;
  for (const event of events) {
    if (!expandSessionRange(event.summary).includes(session)) {
      continue;
    }
    if (best === null || Date.parse(event.startsAtUtc) < Date.parse(best.startsAtUtc)) {
      best = event;
    }
  }
  return best;
}

/**
 * Guard 3: events with no session number whose text matches
 * `/retake|resit|convocatoria/i` **after** the candidate date.
 *
 * Tagged, hidden by default, and never deleted — a re-sit is real information
 * about the course even when it is not the final.
 */
function collectRetakes(
  events: readonly ExamCandidateEvent[],
  afterUtc: string | null,
): RetakeEvent[] {
  const threshold = afterUtc === null ? Number.NEGATIVE_INFINITY : Date.parse(afterUtc);
  const retakes: RetakeEvent[] = [];
  for (const event of events) {
    if (event.summary.sessionFrom !== undefined) {
      continue;
    }
    if (!/\b(?:retake|resit|convocatoria)\b/i.test(event.summary.rawSummary)) {
      continue;
    }
    if (Date.parse(event.startsAtUtc) <= threshold) {
      continue;
    }
    retakes.push({
      uid: event.uid,
      startsAtUtc: event.startsAtUtc,
      rawSummary: event.summary.rawSummary,
    });
  }
  return retakes;
}

/**
 * Guard 2, in its **skip-and-flag** form.
 *
 * If no `semesters` row covers the date we flag `unbounded` and keep the
 * candidate. If a row exists and the date sits outside every row, we flag
 * `outsideSemester` — still keeping the candidate, since suppressing an exam
 * date is worse than showing a low-confidence one, and the UI has a confirm
 * gate in front of it either way.
 */
function boundsFlags(startsAtUtc: string, semesters: readonly SemesterBounds[]): ExamFlags {
  if (semesters.length === 0) {
    return { unbounded: true, outsideSemester: false };
  }
  const at = Date.parse(startsAtUtc);
  const covered = semesters.some(
    (semester) => at >= Date.parse(semester.startsAt) && at <= Date.parse(semester.endsAt),
  );
  return covered
    ? { unbounded: false, outsideSemester: false }
    : { unbounded: true, outsideSemester: true };
}

/** Exam-like `assessments.kind` values. Both a final and a midterm are `'exam'`. */
const EXAM_KIND = /\bexam\b/i;

/** `assessments.title` values that name the *final* specifically. */
const FINAL_TITLE = /\bfinals?\b/i;

/**
 * Picks the row that represents the course's final exam.
 *
 * 🔴 **Corrected 2026-07-18.** The original predicate was
 * `/\bfinal\b/i.test(assessment.kind)`, which can never match: `assessments.kind`
 * is constrained to `('exam','quiz','project','participation','paper','other')`,
 * so no legal value contains "final" — and `\bfinal\b` would not have matched a
 * snake_case `final_exam` either, since `_` is a word character. Step 2 was
 * therefore not merely dormant for want of rows; it was **structurally dead** and
 * would have silently fallen through to step 3 even once syllabi were loaded.
 *
 * The distinction actually lives in `title` — real syllabi write `Final Exam`
 * and `In class Midterm Exam` — so that is what is matched, gated on an
 * exam-like `kind`. Where no title says "final" but several exams carry session
 * numbers, the **highest** session number wins: the final is the last exam.
 */
function selectFinalAssessment(
  assessments: readonly AssessmentOracleRow[],
): AssessmentOracleRow | null {
  const sessioned = assessments.filter(
    (assessment) => assessment.sessionNumber !== null && EXAM_KIND.test(assessment.kind),
  );
  if (sessioned.length === 0) {
    return null;
  }

  const explicitFinals = sessioned.filter((assessment) => FINAL_TITLE.test(assessment.title));
  const pool = explicitFinals.length > 0 ? explicitFinals : sessioned;

  return pool.reduce<AssessmentOracleRow | null>((best, candidate) => {
    if (best === null) {
      return candidate;
    }
    return (candidate.sessionNumber ?? 0) > (best.sessionNumber ?? 0) ? candidate : best;
  }, null);
}

/**
 * Runs the three-step chain for one course.
 *
 * Steps are tried in order and the first that names a session number wins; a
 * named session that the feed cannot supply yields `pending`, never a silent
 * drop to the next step. That is deliberate: falling through from "the syllabus
 * says 30" to "the feed's highest is 24" would confidently report the wrong
 * date, which is exactly the failure the reordering exists to prevent.
 */
export function detectExam(input: DetectExamInput): ExamDetection {
  const { events, totalSessions, assessments = [], semesters = [] } = input;

  const resolve = (
    session: number,
    source: Exclude<ExamDetectionSource, "feed_max_session">,
  ): ExamDetection => {
    const event = eventCoveringSession(events, session);
    if (!event) {
      return {
        outcome: "pending",
        source,
        expectedSessionNumber: session,
        retakes: collectRetakes(events, null),
      };
    }
    return {
      outcome: "found",
      source,
      sessionNumber: session,
      uid: event.uid,
      startsAtUtc: event.startsAtUtc,
      flags: boundsFlags(event.startsAtUtc, semesters),
      retakes: collectRetakes(events, event.startsAtUtc),
    };
  };

  // Step 1 — `courses.total_sessions`. Live today: the column is seeded.
  if (typeof totalSessions === "number" && Number.isFinite(totalSessions) && totalSessions > 0) {
    return resolve(totalSessions, "syllabus_total_sessions");
  }

  // Step 2 — an `assessments.session_number` match. Dead today (0 rows), built
  // for the fall-2026 syllabi that will arrive later.
  const finalAssessment = selectFinalAssessment(assessments);
  if (finalAssessment?.sessionNumber != null) {
    return resolve(finalAssessment.sessionNumber, "assessment_session_number");
  }

  // Step 3 — `max(sessionTo)` from the feed. THE live path for all 7 fall
  // courses until a fall-2026 syllabus exists.
  const max = maxSessionNumber(events);
  if (max === null) {
    return { outcome: "unknown", retakes: collectRetakes(events, null) };
  }

  const event = eventCoveringSession(events, max);
  if (!event) {
    return { outcome: "unknown", retakes: collectRetakes(events, null) };
  }

  return {
    outcome: "found",
    source: "feed_max_session",
    sessionNumber: max,
    uid: event.uid,
    startsAtUtc: event.startsAtUtc,
    flags: boundsFlags(event.startsAtUtc, semesters),
    retakes: collectRetakes(events, event.startsAtUtc),
  };
}
