/**
 * Exam detection wired to real data (§5.1b), with **honest provenance**.
 *
 * `detectExam` produces three outcomes — `found`, `pending`, `unknown` — but
 * only `found` leaves a trace in the database (`calendar_items.is_exam_candidate`
 * plus `detection_source`). `pending` produces *no row at all*, just an expected
 * session number, which is precisely the state §5.1b says is the whole point of
 * the reordering: *"exam not yet published, expect session N"*. So the chain is
 * re-run here at read time, over the synced rows, rather than read back from the
 * column — otherwise the two states the user most needs to tell apart would be
 * indistinguishable, both rendering as "no exam".
 *
 * ## 🚨 The circularity this module exists to expose
 *
 * `detectExam` reports `syllabus_total_sessions` whenever `courses.total_sessions`
 * is set. On the live database that column is seeded for all 7 fall courses —
 * **from feed-derived counts**, not from any syllabus. All three syllabi on disk
 * are 2025-26 documents matching none of the 7 (verified 2026-07-18). Steps 1
 * and 3 therefore read the same number by two routes, and their agreement is a
 * tautology.
 *
 * `courses.total_sessions_source` exists to make that visible, and this module
 * is what consumes it: a `syllabus_total_sessions` detection whose course says
 * `feed_derived` is reported as **feed-derived**, never as syllabus-confirmed.
 * The detection source alone is not evidence of provenance, and presenting it as
 * such would put a confident label on a number that has never been checked
 * against a syllabus.
 */

import { detectExam, type ExamDetection, maxSessionNumber, normalizeSummary } from "@study/core";

/** How much the UI is entitled to trust the answer. */
export type ExamConfidence =
  /** A syllabus document declared the session count or labelled the session. */
  | "syllabus"
  /** The user typed the session count themselves. */
  | "manual"
  /**
   * Derived from the feed's own session numbers — including the case where the
   * detector *says* `syllabus_total_sessions` but the count behind it was
   * feed-derived. Circular with step 3; never independent corroboration.
   */
  | "feed_derived";

export interface ExamStatusCourse {
  id: string;
  title: string;
  color: string;
  total_sessions: number | null;
  total_sessions_source: string | null;
}

export interface ExamStatusItem {
  id: string;
  course_id: string | null;
  ics_uid: string;
  raw_summary: string | null;
  starts_at: string;
  is_exam_candidate: boolean;
  detection_source: string | null;
  user_locked_fields: string[];
}

export interface ExamStatusAssessment {
  id: string;
  course_id: string;
  title: string;
  kind: string;
  session_number: number | null;
}

export interface ExamStatus {
  course: { id: string; title: string; color: string };
  detection: ExamDetection;
  confidence: ExamConfidence;
  /** One line naming where the number actually came from. Never overstated. */
  provenanceLabel: string;
  /** The `calendar_items.id` of the resolved exam, when there is one. */
  itemId: string | null;
  /** True once the user has confirmed this exam by hand — the §5.1b hard gate. */
  confirmed: boolean;
  /**
   * The declared total and the feed's highest session disagree.
   *
   * §5.1b: *"surface as a conflict for one-tap resolution, never a silent
   * pick"*. Null when they agree or when only one of them exists.
   */
  conflict: { declaredSessions: number; feedMaxSession: number } | null;
}

/**
 * Maps the detector's answer plus the course's recorded provenance onto what the
 * UI may claim.
 *
 * The `syllabus_total_sessions` → `feed_derived` line is the load-bearing one.
 */
function confidenceFor(
  detection: ExamDetection,
  course: ExamStatusCourse,
): { confidence: ExamConfidence; provenanceLabel: string } {
  const source = detection.outcome === "unknown" ? null : detection.source;

  if (source === "assessment_session_number") {
    return {
      confidence: "syllabus",
      provenanceLabel: "A syllabus assessment names this session.",
    };
  }

  if (source === "syllabus_total_sessions") {
    switch (course.total_sessions_source) {
      case "syllabus":
        return {
          confidence: "syllabus",
          provenanceLabel: `A syllabus declares ${course.total_sessions} sessions.`,
        };
      case "manual":
        return {
          confidence: "manual",
          provenanceLabel: `You set this course to ${course.total_sessions} sessions.`,
        };
      default:
        // ⚠ The honest label. The detector says "syllabus"; the data says the
        // number was counted off this same feed, so the two oracles that appear
        // to agree are one oracle read twice.
        return {
          confidence: "feed_derived",
          provenanceLabel:
            "Session count was read off this feed, not a syllabus — the calendar is agreeing with itself.",
        };
    }
  }

  if (source === "feed_max_session") {
    return {
      confidence: "feed_derived",
      provenanceLabel: "No syllabus on file — taken from the last session in the feed.",
    };
  }

  return { confidence: "feed_derived", provenanceLabel: "Nothing to go on yet." };
}

export interface BuildExamStatusesInput {
  courses: readonly ExamStatusCourse[];
  items: readonly ExamStatusItem[];
  assessments: readonly ExamStatusAssessment[];
  semesters: readonly { starts_on: string; ends_on: string }[];
}

/**
 * Runs the §5.1b chain once per course that has synced events.
 *
 * Courses with no events at all are omitted rather than reported `unknown`: an
 * exam status for a course the feed has never mentioned is noise, not
 * information.
 */
export function buildExamStatuses(input: BuildExamStatusesInput): ExamStatus[] {
  const byCourse = new Map<string, ExamStatusItem[]>();
  for (const item of input.items) {
    if (item.course_id === null) continue;
    const bucket = byCourse.get(item.course_id) ?? [];
    bucket.push(item);
    byCourse.set(item.course_id, bucket);
  }

  const semesters = input.semesters.map((semester) => ({
    startsAt: semester.starts_on,
    endsAt: semester.ends_on,
  }));

  const statuses: ExamStatus[] = [];

  for (const course of input.courses) {
    const items = byCourse.get(course.id);
    if (!items || items.length === 0) continue;

    // `normalizeSummary` returns null for the 5 pseudo/LMS rows, which must not
    // reach the detector — two of them carry a real course prefix, so filtering
    // on "has a course" would let them through.
    const candidates = items.flatMap((item) => {
      const summary = normalizeSummary(item.raw_summary ?? "");
      return summary === null ? [] : [{ uid: item.ics_uid, startsAtUtc: item.starts_at, summary }];
    });

    const detection = detectExam({
      events: candidates,
      totalSessions: course.total_sessions,
      assessments: input.assessments
        .filter((assessment) => assessment.course_id === course.id)
        .map((assessment) => ({
          id: assessment.id,
          title: assessment.title,
          kind: assessment.kind,
          sessionNumber: assessment.session_number,
        })),
      semesters,
    });

    const resolved =
      detection.outcome === "found"
        ? (items.find((item) => item.ics_uid === detection.uid) ?? null)
        : null;

    const feedMax = maxSessionNumber(candidates);
    const declared = course.total_sessions;

    statuses.push({
      course: { id: course.id, title: course.title, color: course.color },
      detection,
      ...confidenceFor(detection, course),
      itemId: resolved?.id ?? null,
      // The §5.1b hard gate: an exam date is confirmed truth only once a human
      // said so. `manual` is what the confirm action writes.
      confirmed: resolved?.detection_source === "manual",
      conflict:
        declared !== null && feedMax !== null && declared !== feedMax
          ? { declaredSessions: declared, feedMaxSession: feedMax }
          : null,
    });
  }

  return statuses.sort((a, b) => a.course.title.localeCompare(b.course.title));
}
