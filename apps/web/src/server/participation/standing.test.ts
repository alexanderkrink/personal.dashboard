import { describe, expect, it } from "vitest";
import {
  courseStandings,
  type LedgerAttendanceRow,
  type LedgerCourse,
  type LedgerLogRow,
} from "./standing";

/**
 * Per-course standing = core's gate + pace + streak over joined rows. Core's
 * boundary math is red-tested in @study/core; what this module owns — and what
 * was proven red against a trusting scaffold first — is the seam between a
 * database that permits weird numbers and pure functions that throw on them:
 *
 *  - absent/excused sessions must not enter the pace denominator (being
 *    marked down for silence in a class you missed double-counts the absence
 *    the gate already scored);
 *  - `absence_fail_pct`, `total_sessions` and `participation_target` are
 *    unchecked numerics typed by a human — out-of-range values mean "cannot
 *    compute", never a RangeError that 500s the whole ledger page.
 */

const course = (overrides: Partial<LedgerCourse> = {}): LedgerCourse => ({
  id: "course-1",
  title: "Statistics",
  totalSessions: 30,
  absenceFailPct: 20,
  participationTarget: 1,
  ...overrides,
});

const att = (
  occurrenceId: string,
  status: LedgerAttendanceRow["status"],
  startsAt: string,
): LedgerAttendanceRow => ({ occurrenceId, courseId: "course-1", startsAt, status });

const log = (occurrenceId: string, startsAt: string): LedgerLogRow => ({
  occurrenceId,
  courseId: "course-1",
  startsAt,
});

describe("courseStandings — the pace denominator", () => {
  it("absent and excused sessions never enter the pace denominator", () => {
    // Present twice (1 contribution each), absent once, excused once. Pace is
    // 2 contributions over 2 attended sessions — counting the absences drops
    // it to 0.5 and calls a perfectly-paced course behind.
    const attendance = [
      att("o1", "present", "2026-09-01T09:00:00Z"),
      att("o2", "absent", "2026-09-03T09:00:00Z"),
      att("o3", "present", "2026-09-08T09:00:00Z"),
      att("o4", "excused", "2026-09-10T09:00:00Z"),
    ];
    const logs = [log("o1", "2026-09-01T09:00:00Z"), log("o3", "2026-09-08T09:00:00Z")];

    const [standing] = courseStandings([course()], attendance, logs);
    expect(standing?.pace.sessions).toBe(2);
    expect(standing?.pace.perSession).toBe(1);
    expect(standing?.pace.onPace).toBe(true);
    // The absence still counts where it belongs: the gate.
    expect(standing?.absent).toBe(1);
    expect(standing?.excused).toBe(1);
    expect(standing?.gate?.absent).toBe(1);
  });

  it("the streak is measured over attended sessions in start order", () => {
    const attendance = [
      att("o3", "present", "2026-09-08T09:00:00Z"),
      att("o1", "present", "2026-09-01T09:00:00Z"),
      att("o2", "present", "2026-09-03T09:00:00Z"),
    ];
    // Contributed in o1 and o3 but sat silent in o2 — streak restarted at o3.
    const logs = [log("o1", "2026-09-01T09:00:00Z"), log("o3", "2026-09-08T09:00:00Z")];
    const [standing] = courseStandings([course()], attendance, logs);
    expect(standing?.streak).toBe(1);
  });
});

describe("courseStandings — hostile database numerics", () => {
  it("an out-of-range absence_fail_pct means no gate, not a crash", () => {
    const brokenPct = course({ absenceFailPct: 150 });
    const attendance = [att("o1", "absent", "2026-09-01T09:00:00Z")];
    const [standing] = courseStandings([brokenPct], attendance, []);
    expect(standing?.gate).toBeNull();
    // The raw counts survive so the page can still say "1 absence recorded".
    expect(standing?.absent).toBe(1);
  });

  it("a zero or negative total_sessions means no gate, not a crash", () => {
    for (const totalSessions of [0, -4]) {
      const [standing] = courseStandings([course({ totalSessions })], [], []);
      expect(standing?.gate).toBeNull();
    }
  });

  it("a null total_sessions means no gate (nothing to measure against)", () => {
    const [standing] = courseStandings([course({ totalSessions: null })], [], []);
    expect(standing?.gate).toBeNull();
  });

  it("a zero or negative participation_target reads as 'no target', not a crash", () => {
    const attendance = [att("o1", "present", "2026-09-01T09:00:00Z")];
    for (const participationTarget of [0, -1]) {
      const [standing] = courseStandings([course({ participationTarget })], attendance, []);
      expect(standing?.pace.target).toBeNull();
      expect(standing?.pace.onPace).toBeNull();
    }
  });
});

describe("courseStandings — shape", () => {
  it("a course with no ledger data still gets a standing (full allowance, no evidence)", () => {
    const [standing] = courseStandings([course()], [], []);
    expect(standing?.gate?.remainingAbsences).toBe(6);
    expect(standing?.gate?.status).toBe("ok");
    expect(standing?.pace.sessions).toBe(0);
    expect(standing?.streak).toBe(0);
  });

  it("courses do not see each other's rows", () => {
    const other = course({ id: "course-2", title: "Strategy" });
    const attendance = [
      att("o1", "absent", "2026-09-01T09:00:00Z"),
      { ...att("o9", "present", "2026-09-01T09:00:00Z"), courseId: "course-2" },
    ];
    const standings = courseStandings([course(), other], attendance, []);
    expect(standings[0]?.absent).toBe(1);
    expect(standings[1]?.absent).toBe(0);
    expect(standings[1]?.gate?.present).toBe(1);
  });
});
