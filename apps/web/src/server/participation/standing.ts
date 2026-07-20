import {
  type AttendanceGate,
  type AttendanceStatus,
  attendanceGate,
  contributionStreak,
  type ParticipationPace,
  participationPace,
} from "@study/core";

/**
 * Per-course standing: core's attendance gate, participation pace and streak
 * computed over joined ledger rows. Pure — rows in, standings out — so the
 * tests beside this file can falsify it without a database.
 *
 * This module owns the seam between a database that permits weird numbers and
 * core functions that throw on them. `total_sessions`, `absence_fail_pct` and
 * `participation_target` are unchecked numerics a human typed; out-of-range
 * values here mean "cannot compute" (a null gate, a target-less pace), never a
 * RangeError that 500s the ledger page. Core keeps its throws — a CALLER
 * passing garbage is a bug; a USER typing garbage is Tuesday.
 *
 * The pace denominator is attended ('present') sessions only. An absent
 * session already cost its absence at the gate; letting it also read as "sat
 * silent" would double-count the same morning against both numbers — the plan
 * is explicit that the two measures are independent.
 */

export interface LedgerCourse {
  id: string;
  title: string;
  totalSessions: number | null;
  absenceFailPct: number | null;
  participationTarget: number | null;
}

export interface LedgerAttendanceRow {
  occurrenceId: string;
  courseId: string;
  startsAt: string;
  status: AttendanceStatus;
}

export interface LedgerLogRow {
  occurrenceId: string;
  courseId: string;
  startsAt: string;
}

export interface CourseStanding {
  course: LedgerCourse;
  /** Null when the course's numbers cannot support a verdict — never a guess. */
  gate: AttendanceGate | null;
  /** Raw counts survive even without a gate: "1 absence recorded" is still true. */
  absent: number;
  excused: number;
  pace: ParticipationPace;
  streak: number;
}

export function courseStandings(
  courses: readonly LedgerCourse[],
  attendance: readonly LedgerAttendanceRow[],
  logs: readonly LedgerLogRow[],
): CourseStanding[] {
  return courses.map((course) => {
    const records = attendance.filter((row) => row.courseId === course.id);
    const courseLogs = logs.filter((row) => row.courseId === course.id);

    const statuses = records.map((row) => row.status);
    const gateNumbers = gateInput(course);
    const gate =
      gateNumbers === null ? null : attendanceGate({ records: statuses, ...gateNumbers });

    const attended = records
      .filter((row) => row.status === "present")
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const perSession = attended.map(
      (session) => courseLogs.filter((log) => log.occurrenceId === session.occurrenceId).length,
    );

    const target =
      course.participationTarget !== null &&
      Number.isFinite(course.participationTarget) &&
      course.participationTarget > 0
        ? course.participationTarget
        : null;

    return {
      course,
      gate,
      absent: statuses.filter((status) => status === "absent").length,
      excused: statuses.filter((status) => status === "excused").length,
      pace: participationPace(perSession, target),
      streak: contributionStreak(perSession),
    };
  });
}

/** The gate needs a real denominator and a percentage that is one — or null. */
function gateInput(
  course: LedgerCourse,
): { totalSessions: number; absenceFailPct: number | null } | null {
  const { totalSessions, absenceFailPct } = course;
  if (totalSessions === null || !Number.isInteger(totalSessions) || totalSessions <= 0) {
    return null;
  }
  if (
    absenceFailPct !== null &&
    (!Number.isFinite(absenceFailPct) || absenceFailPct < 0 || absenceFailPct > 100)
  ) {
    return null;
  }
  return { totalSessions, absenceFailPct };
}
