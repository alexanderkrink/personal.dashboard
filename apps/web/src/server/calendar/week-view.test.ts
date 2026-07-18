import { describe, expect, it } from "vitest";
import { buildWeekView, type WeekViewOccurrence } from "./week-view";

const MADRID = "Europe/Madrid";

/**
 * ⚠ Every date here is pinned deliberately. Today is 2026-07-18 and the fall
 * term starts 2026-08-31, so the live week window is genuinely empty — a suite
 * that used the wall clock would assert nothing at all and still pass. These
 * dates are where the real synced feed has data.
 */
const MID_TERM = new Date("2026-09-15T09:00:00.000Z"); // Tue, week of Mon 14 Sep
const EXAM_WEEK = new Date("2026-12-07T09:00:00.000Z"); // Mon, finals run 09→18 Dec
const SUMMER = new Date("2026-07-18T09:00:00.000Z"); // today: term has not started

let seq = 0;

function occurrence(overrides: {
  startsAt: string;
  kind?: string;
  weightOverride?: number | string | null;
  assessmentWeight?: number | string | null;
  completedAt?: string | null;
  status?: string;
  hidden?: boolean;
  missingSince?: string | null;
  updatedAt?: string;
  title?: string;
  sessionFrom?: number | null;
  course?: { id: string; title: string; color: string } | null;
  isExamCandidate?: boolean;
}): WeekViewOccurrence {
  seq += 1;
  const id = `occ-${String(seq).padStart(3, "0")}`;
  return {
    id,
    starts_at: overrides.startsAt,
    ends_at: null,
    all_day: false,
    status: overrides.status ?? "confirmed",
    updated_at: overrides.updatedAt ?? overrides.startsAt,
    completed_at: overrides.completedAt ?? null,
    item: {
      id: `item-${id}`,
      kind: overrides.kind ?? "deadline",
      title: overrides.title ?? "",
      raw_summary: null,
      location: null,
      session_from: overrides.sessionFrom ?? null,
      session_to: overrides.sessionFrom ?? null,
      descriptor: overrides.sessionFrom == null ? null : "regular",
      hidden: overrides.hidden ?? false,
      missing_since: overrides.missingSince ?? null,
      weight_override: (overrides.weightOverride ?? null) as number | null,
      is_exam_candidate: overrides.isExamCandidate ?? false,
      detection_source: overrides.isExamCandidate ? "syllabus_total_sessions" : null,
      course: overrides.course ?? null,
      assessment:
        overrides.assessmentWeight == null
          ? null
          : {
              id: "a1",
              title: "Final Exam",
              weight_percent: overrides.assessmentWeight as number,
            },
    },
  };
}

describe("buildWeekView — §7 composition", () => {
  it("ranks this week's deadlines by priority score, not chronologically", () => {
    // The worked example from §5.2, laid onto the week of Mon 14 Sep 2026.
    const view = buildWeekView({
      now: MID_TERM,
      timezone: MADRID,
      occurrences: [
        // 2% quiz tomorrow → 3 / 1 = 3.00
        occurrence({ startsAt: "2026-09-16T09:00:00.000Z", weightOverride: 2, title: "Quiz" }),
        // 30% project in 4 days → 31 / 4 = 7.75
        occurrence({ startsAt: "2026-09-19T09:00:00.000Z", weightOverride: 30, title: "Project" }),
      ],
    });

    expect(view.deadlines.map((row) => row.label)).toEqual(["Project", "Quiz"]);
    expect(view.deadlines[0]?.tier).toBe("high");
    expect(view.deadlines[1]?.tier).toBe("low");
    // …and the chronological order is genuinely the opposite, so this is a real
    // assertion rather than one the input happened to satisfy already.
    expect(Date.parse(view.deadlines[0]?.startsAt ?? "")).toBeGreaterThan(
      Date.parse(view.deadlines[1]?.startsAt ?? ""),
    );
  });

  it("pins overdue deadlines above everything and carries them past the week", () => {
    const view = buildWeekView({
      now: MID_TERM,
      timezone: MADRID,
      occurrences: [
        // Three weeks before the week window even starts.
        occurrence({ startsAt: "2026-08-24T09:00:00.000Z", weightOverride: 0, title: "Missed" }),
        occurrence({ startsAt: "2026-09-18T09:00:00.000Z", weightOverride: 40, title: "Big" }),
      ],
    });

    expect(view.overdue.map((row) => row.label)).toEqual(["Missed"]);
    expect(view.overdue[0]?.tier).toBe("overdue");
    expect(view.deadlines.map((row) => row.label)).toEqual(["Big"]);
  });

  it("drops completed and cancelled items out of overdue", () => {
    const view = buildWeekView({
      now: MID_TERM,
      timezone: MADRID,
      occurrences: [
        occurrence({
          startsAt: "2026-09-10T09:00:00.000Z",
          completedAt: "2026-09-10T18:00:00.000Z",
          title: "Done",
        }),
        occurrence({
          startsAt: "2026-09-10T09:00:00.000Z",
          status: "cancelled",
          title: "Called off",
        }),
        occurrence({ startsAt: "2026-09-11T09:00:00.000Z", title: "Still open" }),
      ],
    });

    expect(view.overdue.map((row) => row.label)).toEqual(["Still open"]);
  });

  it("resolves weight in §5.2 order: override beats assessment beats kind default", () => {
    const view = buildWeekView({
      now: MID_TERM,
      timezone: MADRID,
      occurrences: [
        occurrence({
          startsAt: "2026-09-17T09:00:00.000Z",
          weightOverride: 50,
          assessmentWeight: 30,
          title: "Override",
        }),
        occurrence({
          startsAt: "2026-09-17T10:00:00.000Z",
          assessmentWeight: 30,
          title: "Syllabus",
        }),
        occurrence({ startsAt: "2026-09-17T11:00:00.000Z", title: "Default" }),
      ],
    });

    const byLabel = new Map(view.deadlines.map((row) => [row.label, row]));
    expect(byLabel.get("Override")?.weightPercent).toBe(50);
    expect(byLabel.get("Override")?.weightSource).toBe("override");
    expect(byLabel.get("Syllabus")?.weightPercent).toBe(30);
    expect(byLabel.get("Syllabus")?.weightSource).toBe("assessment");
    expect(byLabel.get("Default")?.weightPercent).toBe(5);
    expect(byLabel.get("Default")?.weightSource).toBe("kind_default");
  });

  /**
   * PostgREST returns `numeric` as a *string*. Passed through unparsed it fails
   * `Number.isFinite`, and the row silently falls back to the 5% kind default —
   * rendering "Low" on something the syllabus says is worth 30%.
   */
  it("parses numeric weights arriving as strings from PostgREST", () => {
    const view = buildWeekView({
      now: MID_TERM,
      timezone: MADRID,
      occurrences: [
        occurrence({ startsAt: "2026-09-17T09:00:00.000Z", assessmentWeight: "30.00", title: "S" }),
      ],
    });

    expect(view.deadlines[0]?.weightPercent).toBe(30);
    expect(view.deadlines[0]?.tier).toBe("high");
  });

  it("buckets classes into Mon…Sun and keeps them out of the deadline list", () => {
    const view = buildWeekView({
      now: MID_TERM,
      timezone: MADRID,
      occurrences: [
        occurrence({ startsAt: "2026-09-14T07:30:00.000Z", kind: "class", sessionFrom: 4 }),
        occurrence({ startsAt: "2026-09-16T07:30:00.000Z", kind: "class", sessionFrom: 5 }),
        occurrence({ startsAt: "2026-09-16T11:30:00.000Z", kind: "class", sessionFrom: 6 }),
        occurrence({ startsAt: "2026-09-20T09:00:00.000Z", kind: "class", sessionFrom: 7 }),
      ],
    });

    expect(view.classDays).toHaveLength(7);
    expect(view.classDays.map((day) => day.rows.length)).toEqual([1, 0, 2, 0, 0, 0, 1]);
    expect(view.deadlines).toHaveLength(0);
    // Labels come from core's composer, not from the (empty) feed title.
    expect(view.classDays[0]?.rows[0]?.label).toBe("Session 4");
  });

  it("shows only Medium-and-up on the horizon, and only beyond this week", () => {
    const view = buildWeekView({
      now: MID_TERM,
      timezone: MADRID,
      occurrences: [
        occurrence({ startsAt: "2026-09-23T09:00:00.000Z", weightOverride: 30, title: "Exam" }),
        occurrence({ startsAt: "2026-09-24T09:00:00.000Z", weightOverride: 1, title: "Trivial" }),
        occurrence({ startsAt: "2026-09-25T09:00:00.000Z", kind: "class", title: "Lecture" }),
        // Past the 14-day horizon entirely.
        occurrence({ startsAt: "2026-10-20T09:00:00.000Z", weightOverride: 40, title: "Far" }),
      ],
    });

    expect(view.horizon.map((row) => row.label)).toEqual(["Exam"]);
    expect(view.nextBeyondHorizon).toBeNull();
  });

  it("keeps the horizon chronological, so the nearest warning comes first", () => {
    const view = buildWeekView({
      now: MID_TERM,
      timezone: MADRID,
      occurrences: [
        occurrence({ startsAt: "2026-09-30T09:00:00.000Z", weightOverride: 60, title: "Heavier" }),
        occurrence({ startsAt: "2026-09-22T09:00:00.000Z", weightOverride: 20, title: "Sooner" }),
      ],
    });

    expect(view.horizon.map((row) => row.label)).toEqual(["Sooner", "Heavier"]);
  });

  /**
   * §7's empty state must "explicitly show the horizon — never false calm".
   */
  it("reports an empty week while still naming what is coming", () => {
    const view = buildWeekView({
      now: MID_TERM,
      timezone: MADRID,
      occurrences: [
        occurrence({ startsAt: "2026-09-24T09:00:00.000Z", weightOverride: 30, title: "Exam" }),
      ],
    });

    expect(view.isEmpty).toBe(true);
    expect(view.horizon).toHaveLength(1);
  });

  /**
   * ⚠ The genuine state on the day this was written. Term starts 2026-08-31, so
   * the week AND the 14-day horizon are both empty — and the honest answer is
   * "nothing until 31 August", not "nothing".
   */
  it("reaches past the horizon when term has not started (2026-07-18)", () => {
    const view = buildWeekView({
      now: SUMMER,
      timezone: MADRID,
      occurrences: [
        occurrence({ startsAt: "2026-08-31T07:30:00.000Z", kind: "class", sessionFrom: 1 }),
        occurrence({ startsAt: "2026-09-01T07:30:00.000Z", kind: "class", sessionFrom: 2 }),
      ],
    });

    expect(view.isEmpty).toBe(true);
    expect(view.deadlines).toHaveLength(0);
    expect(view.horizon).toHaveLength(0);
    expect(view.nextBeyondHorizon?.startsAt).toBe("2026-08-31T07:30:00.000Z");
  });

  it("hides retakes, aged tombstones and stale cancellations", () => {
    const view = buildWeekView({
      now: MID_TERM,
      timezone: MADRID,
      occurrences: [
        occurrence({ startsAt: "2026-09-17T09:00:00.000Z", hidden: true, title: "Retake" }),
        occurrence({
          startsAt: "2026-09-17T09:00:00.000Z",
          missingSince: "2026-09-10T09:00:00.000Z",
          title: "Vanished",
        }),
        occurrence({
          startsAt: "2026-09-17T09:00:00.000Z",
          status: "cancelled",
          updatedAt: "2026-08-01T09:00:00.000Z",
          title: "Long cancelled",
        }),
        occurrence({
          startsAt: "2026-09-17T09:00:00.000Z",
          status: "cancelled",
          updatedAt: "2026-09-14T09:00:00.000Z",
          title: "Just cancelled",
        }),
      ],
    });

    // Only the recent cancellation survives — struck through, because "this is
    // not happening" is information a silent gap does not convey.
    expect(view.deadlines.map((row) => row.label)).toEqual(["Just cancelled"]);
    expect(view.deadlines[0]?.cancelled).toBe(true);
  });

  it("computes the week boundary in the user's timezone, not the server's", () => {
    // 2026-09-20 23:30 UTC is Sunday in UTC but already Monday 01:30 in Madrid.
    const madrid = buildWeekView({
      now: new Date("2026-09-20T23:30:00.000Z"),
      timezone: MADRID,
      occurrences: [],
    });
    const utc = buildWeekView({
      now: new Date("2026-09-20T23:30:00.000Z"),
      timezone: "UTC",
      occurrences: [],
    });

    expect(madrid.window.startUtc).toBe("2026-09-20T22:00:00.000Z");
    expect(utc.window.startUtc).toBe("2026-09-14T00:00:00.000Z");
  });

  /**
   * The real December finals week: seven exams across 09→18 Dec, of which four
   * fall inside the week of Mon 7 Dec and three land on the horizon.
   */
  /**
   * 🔴 REGRESSION, found in the browser at the pinned finals week.
   *
   * Every one of the 374 synced IE events carries `kind = 'class'` — the feed
   * publishes a timetable, and a final exam is just the last *session* of a
   * course. Taken literally, all seven finals landed in the week grid, which §7
   * calls "deliberately visually secondary", and the ranked deadline list was
   * permanently empty. The horizon was empty too, since it filters classes out.
   *
   * The verify chain was fully green while this was true.
   */
  it("ranks an exam candidate as a deadline, not as a class", () => {
    const view = buildWeekView({
      now: EXAM_WEEK,
      timezone: MADRID,
      occurrences: [
        occurrence({
          startsAt: "2026-12-10T10:30:00.000Z",
          kind: "class",
          isExamCandidate: true,
          sessionFrom: 30,
        }),
        occurrence({ startsAt: "2026-12-08T07:30:00.000Z", kind: "class", sessionFrom: 12 }),
      ],
    });

    expect(view.deadlines.map((row) => row.label)).toEqual(["Session 30"]);
    // A class's 0% default would sort a final below a 5% homework task.
    expect(view.deadlines[0]?.weightPercent).toBe(5);
    expect(view.deadlines[0]?.tier).toBe("medium");
    // The ordinary lecture stays where it belongs: context, in the grid.
    expect(view.classDays.flatMap((day) => day.rows).map((row) => row.label)).toEqual([
      "Session 12",
    ]);
  });

  it("lets an exam on the horizon warn from outside the week", () => {
    const view = buildWeekView({
      now: EXAM_WEEK,
      timezone: MADRID,
      occurrences: [
        occurrence({
          startsAt: "2026-12-18T09:00:00.000Z",
          kind: "class",
          isExamCandidate: true,
          title: "MDMA final",
        }),
      ],
    });

    // Medium tier at the 5% deadline default, so it clears the horizon filter —
    // which is the entire "never ambushed from just outside the window" promise.
    expect(view.horizon.map((row) => row.label)).toEqual(["MDMA final"]);
  });

  it("splits the real finals fortnight into week and horizon (pinned 2026-12-07)", () => {
    const course = { id: "c1", title: "ALGORITHMS & DATA STRUCTURES", color: "indigo" };
    const view = buildWeekView({
      now: EXAM_WEEK,
      timezone: MADRID,
      occurrences: [
        occurrence({
          startsAt: "2026-12-09T09:30:00.000Z",
          weightOverride: 30,
          course,
          isExamCandidate: true,
          title: "BPR final",
        }),
        occurrence({
          startsAt: "2026-12-10T10:30:00.000Z",
          weightOverride: 30,
          course,
          isExamCandidate: true,
          title: "ADS final",
        }),
        occurrence({
          startsAt: "2026-12-11T09:00:00.000Z",
          weightOverride: 30,
          course,
          isExamCandidate: true,
          title: "P&S final",
        }),
        occurrence({
          startsAt: "2026-12-16T09:30:00.000Z",
          weightOverride: 30,
          course,
          isExamCandidate: true,
          title: "PDMA final",
        }),
        occurrence({
          startsAt: "2026-12-17T08:30:00.000Z",
          weightOverride: 30,
          course,
          isExamCandidate: true,
          title: "MM final",
        }),
        occurrence({
          startsAt: "2026-12-18T09:00:00.000Z",
          weightOverride: 30,
          course,
          isExamCandidate: true,
          title: "MDMA final",
        }),
      ],
    });

    expect(view.deadlines.map((row) => row.label)).toEqual(["BPR final", "ADS final", "P&S final"]);
    // Equal weight, so the soonest scores highest — which is the correct triage.
    expect(view.deadlines[0]?.score).toBeGreaterThan(view.deadlines[1]?.score ?? 0);
    expect(view.horizon.map((row) => row.label)).toEqual(["PDMA final", "MM final", "MDMA final"]);
    expect(view.isEmpty).toBe(false);
    expect(view.deadlines[0]?.course?.color).toBe("indigo");
  });
});
