/**
 * The attendance gate — IE's universal 80% rule (`absence_fail_pct = 20`).
 *
 * Attendance is a PASS/FAIL GATE worth zero points; participation (pace.ts) is
 * the graded component. They are independent, and the plan is explicit that an
 * earlier draft's conflation of the two was wrong — nothing here feeds a grade.
 *
 * The quoted policy: "Students who do not comply with the 80% attendance
 * requirement … automatically fail both calls (ordinary and extraordinary) for
 * that Academic Year." Attending EXACTLY 80% complies, so the gate fails
 * strictly below it: with `maxAbsences = floor(totalSessions * pct / 100)`,
 * `absent > maxAbsences` fails and `absent === maxAbsences` is at the limit
 * but alive. floor, never round — 28 sessions at 20% allows 5 absences (6 is
 * 78.6% attendance), and rounding 5.6 up quietly moves a course-losing line.
 *
 * Absences are measured against the WHOLE course (`courses.total_sessions`),
 * not sessions elapsed: the allowance is a budget for the term.
 *
 * Excused absences are recorded but never counted toward the gate — that is
 * what "excused" means. If a course's policy differs, the honest fix is to log
 * the absence as 'absent', not to reinterpret 'excused' here.
 *
 * Pure by construction: no I/O, no clock, no environment. Inputs that cannot
 * describe a real course (zero sessions, a percentage outside 0–100) throw
 * RangeError rather than producing a confident wrong verdict — a lie from this
 * function costs an academic year.
 */

export type AttendanceStatus = "present" | "absent" | "excused";

/** IE's universal rule: 80% attendance required, i.e. failure past 20% absences. */
export const DEFAULT_ABSENCE_FAIL_PCT = 20;

export type AttendanceGateStatus = "ok" | "warning" | "at_limit" | "failed";

export interface AttendanceGate {
  present: number;
  /** Unexcused absences — the only number the gate counts. */
  absent: number;
  excused: number;
  /** floor(totalSessions * absenceFailPct / 100) — the absence budget. */
  maxAbsences: number;
  /** maxAbsences − absent. Negative once the course is failed. */
  remainingAbsences: number;
  status: AttendanceGateStatus;
}

export interface AttendanceGateInput {
  /** Every logged session's status, order irrelevant. */
  records: readonly AttendanceStatus[];
  /** `courses.total_sessions` — the gate has no denominator without it. */
  totalSessions: number;
  /** `courses.absence_fail_pct`; null/undefined falls back to the universal 20. */
  absenceFailPct?: number | null;
}

export function attendanceGate(input: AttendanceGateInput): AttendanceGate {
  const { records, totalSessions } = input;
  const pct = input.absenceFailPct ?? DEFAULT_ABSENCE_FAIL_PCT;

  if (!Number.isInteger(totalSessions) || totalSessions <= 0) {
    throw new RangeError(`totalSessions must be a positive integer, got ${totalSessions}`);
  }
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new RangeError(`absenceFailPct must be within 0–100, got ${pct}`);
  }

  let present = 0;
  let absent = 0;
  let excused = 0;
  for (const record of records) {
    if (record === "present") present += 1;
    else if (record === "absent") absent += 1;
    else excused += 1;
  }

  const maxAbsences = Math.floor((totalSessions * pct) / 100);
  const remainingAbsences = maxAbsences - absent;

  // remaining 1 warns even before the first absence: a course that only ever
  // tolerated one absence IS one bad morning from a lost year, and the plan
  // asks for approach-to-the-line as a hard alarm, not a eulogy.
  const status: AttendanceGateStatus =
    remainingAbsences < 0
      ? "failed"
      : remainingAbsences === 0
        ? "at_limit"
        : remainingAbsences === 1
          ? "warning"
          : "ok";

  return { present, absent, excused, maxAbsences, remainingAbsences, status };
}
