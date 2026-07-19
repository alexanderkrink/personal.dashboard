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
 *
 * ## 🔴 The user's decision overrides the detector — added 2026-07-19
 *
 * Because the chain is re-run **at read time**, it originally ignored the user
 * entirely: rejecting an exam wrote `is_exam_candidate = false` to the database
 * and then the very next render re-detected the same session and displayed it
 * again, unchanged. "Not an exam" was a button that appeared to do nothing.
 *
 * So the detection is now a *proposal* that a recorded decision outranks:
 *
 * | stored state | shown |
 * |---|---|
 * | `is_exam_candidate` + `detection_source = 'manual'` | that session, `chosen` |
 * | `is_exam_candidate` locked false | nothing, `rejected` |
 * | neither | the detector's proposal, `detected` |
 *
 * `confidence` is deliberately **not** part of that table. It is computed from
 * `courses.total_sessions_source` and nothing else, so no user action can
 * promote a `feed_derived` count into a syllabus-backed one.
 */

import { detectExam, type ExamDetection, maxSessionNumber, normalizeSummary } from "@study/core";
import { type ExamDecisionItem, isUserChosen, isUserRejected } from "./exam-decision";

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

/** One session of a course the user may nominate as the exam. */
export interface ExamSessionOption {
  itemId: string;
  sessionNumber: number;
  startsAtUtc: string;
}

/**
 * Whose answer the panel is showing.
 *
 * ⚠ This is **orthogonal to `confidence`**, and keeping the two apart is the
 * honesty requirement. `decision` says *who chose the session*; `confidence`
 * says *where the session count came from*. A user confirming a feed-derived
 * proposal changes the first and must never change the second — their agreeing
 * with the calendar does not turn the calendar into a syllabus.
 */
export type ExamDecisionState =
  /** Nobody has ruled. Whatever is shown is the detector's proposal. */
  | "detected"
  /** The user nominated this session by hand. */
  | "chosen"
  /** The user said this course has no exam. Nothing is proposed. */
  | "rejected";

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
  /** Who chose the session currently shown. Never a claim about provenance. */
  decision: ExamDecisionState;
  /**
   * The session the panel should actually display as the exam.
   *
   * The user's choice when there is one, the detector's when there is not, and
   * **null when the user rejected it** — which is what stops a rejection being
   * silently overruled by a detector that re-runs on every read.
   */
  exam: { itemId: string; sessionNumber: number; startsAtUtc: string } | null;
  /**
   * Every session of this course the user could nominate instead, by session
   * number. Empty when the feed carries no session tokens for the course.
   */
  sessions: ExamSessionOption[];
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

/** `ExamStatusItem` is a superset of what a decision reads; narrow it. */
function toDecisionItem(item: ExamStatusItem): ExamDecisionItem {
  return {
    id: item.id,
    is_exam_candidate: item.is_exam_candidate,
    detection_source: item.detection_source,
    user_locked_fields: item.user_locked_fields,
  };
}

/**
 * The course's sessions, one per item, ordered by session number.
 *
 * Ranged rows (`(Ses. 24-25)`) are addressed by their **last** session, which
 * is the one the chain resolves against `courses.total_sessions` — offering the
 * first would let a user pick "24" on a course whose total is 25 and get a row
 * the detector describes as session 25.
 *
 * Where several occurrences share an item the earliest date wins, matching
 * `eventCoveringSession`'s tie-break so the picker and the detector never
 * disagree about which instant a session is.
 */
function sessionOptions(items: readonly ExamStatusItem[]): ExamSessionOption[] {
  const byItem = new Map<string, ExamSessionOption>();

  for (const item of items) {
    const summary = normalizeSummary(item.raw_summary ?? "");
    if (summary === null) continue;

    const sessionNumber = summary.sessionTo ?? summary.sessionFrom;
    if (sessionNumber === undefined) continue;

    const existing = byItem.get(item.id);
    if (existing !== undefined && existing.startsAtUtc <= item.starts_at) continue;

    byItem.set(item.id, { itemId: item.id, sessionNumber, startsAtUtc: item.starts_at });
  }

  return [...byItem.values()].sort(
    (a, b) => a.sessionNumber - b.sessionNumber || a.startsAtUtc.localeCompare(b.startsAtUtc),
  );
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

    // Every session the user could nominate instead. Built from the same
    // normalized summaries the detector reads, so what the picker offers is
    // exactly what the chain can resolve — a session the picker showed but the
    // detector cannot address would be an offer that silently does nothing.
    const sessions = sessionOptions(items);

    // 🔒 The user's decision, read before the detector's answer is used.
    const chosen = items.find((item) => isUserChosen(toDecisionItem(item))) ?? null;
    const rejected = chosen === null && items.some((item) => isUserRejected(toDecisionItem(item)));

    const decision: ExamDecisionState =
      chosen !== null ? "chosen" : rejected ? "rejected" : "detected";

    const chosenSession = chosen
      ? (sessions.find((session) => session.itemId === chosen.id) ?? null)
      : null;

    const exam =
      chosen !== null
        ? {
            itemId: chosen.id,
            // A hand-picked row normally carries a session token; when it does
            // not, the date is still the answer and 0 stands for "no number",
            // which the UI renders as a bare date rather than "Ses. 0".
            sessionNumber: chosenSession?.sessionNumber ?? 0,
            startsAtUtc: chosenSession?.startsAtUtc ?? chosen.starts_at,
          }
        : rejected || detection.outcome !== "found" || resolved === null
          ? null
          : {
              itemId: resolved.id,
              sessionNumber: detection.sessionNumber,
              startsAtUtc: detection.startsAtUtc,
            };

    const feedMax = maxSessionNumber(candidates);
    const declared = course.total_sessions;

    statuses.push({
      course: { id: course.id, title: course.title, color: course.color },
      detection,
      ...confidenceFor(detection, course),
      itemId: exam?.itemId ?? resolved?.id ?? null,
      // The §5.1b hard gate: an exam date is confirmed truth only once a human
      // said so. `manual` is what the confirm action writes.
      confirmed: chosen !== null,
      decision,
      exam,
      sessions,
      conflict:
        declared !== null && feedMax !== null && declared !== feedMax
          ? { declaredSessions: declared, feedMaxSession: feedMax }
          : null,
    });
  }

  return statuses.sort((a, b) => a.course.title.localeCompare(b.course.title));
}
