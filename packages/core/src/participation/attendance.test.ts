import { describe, expect, it } from "vitest";
import { type AttendanceStatus, attendanceGate, DEFAULT_ABSENCE_FAIL_PCT } from "./attendance";

/**
 * The 80% attendance gate (`absence_fail_pct = 20`, IE's universal rule).
 *
 * The quoted policy is "Students who do not comply with the 80% attendance
 * requirement … automatically fail". Attending EXACTLY 80% complies — the gate
 * fails strictly below it. Every boundary here was proven red against the
 * off-by-one scaffold (round instead of floor, `>=` instead of `>`, excused
 * counted as absent) before the correct implementation landed.
 */

const absences = (n: number): AttendanceStatus[] => Array.from({ length: n }, () => "absent");

describe("attendanceGate — the 80% boundary", () => {
  it("exactly at 80% attendance (6 of 30 absent) complies: at_limit, not failed", () => {
    const gate = attendanceGate({ records: absences(6), totalSessions: 30 });
    expect(gate.maxAbsences).toBe(6);
    expect(gate.remainingAbsences).toBe(0);
    expect(gate.status).toBe("at_limit");
  });

  it("one absence over the line (7 of 30) fails", () => {
    const gate = attendanceGate({ records: absences(7), totalSessions: 30 });
    expect(gate.status).toBe("failed");
    expect(gate.remainingAbsences).toBe(-1);
  });

  it("a fractional allowance floors: 28 sessions x 20% allows 5, never 6", () => {
    // 6 absences of 28 = 78.6% attendance < 80% — a Math.round implementation
    // (5.6 -> 6) would wave this through.
    expect(attendanceGate({ records: absences(6), totalSessions: 28 }).status).toBe("failed");
    expect(attendanceGate({ records: absences(5), totalSessions: 28 }).maxAbsences).toBe(5);
    expect(attendanceGate({ records: absences(5), totalSessions: 28 }).status).toBe("at_limit");
  });

  it("empty history is ok with the full allowance remaining", () => {
    const gate = attendanceGate({ records: [], totalSessions: 30 });
    expect(gate).toEqual({
      present: 0,
      absent: 0,
      excused: 0,
      maxAbsences: 6,
      remainingAbsences: 6,
      status: "ok",
    });
  });
});

describe("attendanceGate — excused absences", () => {
  it("excused absences never count toward the gate", () => {
    // 6 unexcused + 2 excused of 30: counting excused as absent would fail this.
    const records: AttendanceStatus[] = [...absences(6), "excused", "excused"];
    const gate = attendanceGate({ records, totalSessions: 30 });
    expect(gate.absent).toBe(6);
    expect(gate.excused).toBe(2);
    expect(gate.status).toBe("at_limit");
  });

  it("present sessions are counted, not treated as anything else", () => {
    const records: AttendanceStatus[] = ["present", "present", "absent"];
    const gate = attendanceGate({ records, totalSessions: 30 });
    expect(gate.present).toBe(2);
    expect(gate.absent).toBe(1);
  });
});

describe("attendanceGate — approach warnings", () => {
  it("one remaining absence is a warning, two is ok", () => {
    expect(attendanceGate({ records: absences(5), totalSessions: 30 }).status).toBe("warning");
    expect(attendanceGate({ records: absences(4), totalSessions: 30 }).status).toBe("ok");
  });

  it("a zero-tolerance gate (absenceFailPct 0) is at_limit from the start and fails on the first absence", () => {
    expect(attendanceGate({ records: [], totalSessions: 30, absenceFailPct: 0 }).status).toBe(
      "at_limit",
    );
    expect(
      attendanceGate({ records: absences(1), totalSessions: 30, absenceFailPct: 0 }).status,
    ).toBe("failed");
  });
});

describe("attendanceGate — input contract", () => {
  it("defaults absenceFailPct to the universal 20", () => {
    expect(DEFAULT_ABSENCE_FAIL_PCT).toBe(20);
    const dflt = attendanceGate({ records: [], totalSessions: 30 });
    const explicitNull = attendanceGate({ records: [], totalSessions: 30, absenceFailPct: null });
    expect(dflt.maxAbsences).toBe(6);
    expect(explicitNull.maxAbsences).toBe(6);
  });

  it("rejects a non-positive or fractional totalSessions", () => {
    expect(() => attendanceGate({ records: [], totalSessions: 0 })).toThrow(RangeError);
    expect(() => attendanceGate({ records: [], totalSessions: -3 })).toThrow(RangeError);
    expect(() => attendanceGate({ records: [], totalSessions: 29.5 })).toThrow(RangeError);
    expect(() => attendanceGate({ records: [], totalSessions: Number.NaN })).toThrow(RangeError);
  });

  it("rejects an absenceFailPct outside 0–100", () => {
    expect(() => attendanceGate({ records: [], totalSessions: 30, absenceFailPct: -1 })).toThrow(
      RangeError,
    );
    expect(() => attendanceGate({ records: [], totalSessions: 30, absenceFailPct: 101 })).toThrow(
      RangeError,
    );
    expect(() =>
      attendanceGate({ records: [], totalSessions: 30, absenceFailPct: Number.NaN }),
    ).toThrow(RangeError);
  });
});
