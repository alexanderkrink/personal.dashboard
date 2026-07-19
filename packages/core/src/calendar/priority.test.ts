/**
 * Grade-impact weighting and the priority score (§5.2).
 *
 * The load-bearing assertion in this file is the spec's own worked example:
 * a 30% project in 6 days must outrank a 2% quiz due tomorrow, which must still
 * outrank a 30% project a month out. That ordering is the whole justification
 * for ranking by score rather than chronologically, so it is asserted as a
 * ranking — not just as three isolated arithmetic results.
 */

import { describe, expect, it } from "vitest";
import {
  daysUntil,
  HIGH_WEIGHT_THRESHOLD,
  KIND_DEFAULT_WEIGHT,
  MEDIUM_WEIGHT_THRESHOLD,
  MIN_DAYS_UNTIL_DUE,
  priorityScore,
  priorityTier,
  rankItems,
  resolveWeightPercent,
} from "./priority";

const NOW = "2026-07-18T12:00:00.000Z";

describe("priorityScore — (weight% + 1) / max(daysUntilDue, 0.5)", () => {
  /**
   * §5.2's worked example, verbatim: "A 30% final project due in 6 days outranks
   * a 2% quiz due tomorrow (5.2 vs 3.0) — while the quiz still beats a 30%
   * project due in a month (3.0 vs 1.0)."
   */
  it("reproduces the spec's three worked figures", () => {
    expect(priorityScore(30, 6)).toBeCloseTo(5.17, 2); // 31 / 6
    expect(priorityScore(2, 1)).toBeCloseTo(3.0, 2); //  3 / 1
    expect(priorityScore(30, 30)).toBeCloseTo(1.03, 2); // 31 / 30
  });

  it("orders those three exactly as the spec says a student should triage", () => {
    const bigProjectSoon = priorityScore(30, 6);
    const smallQuizTomorrow = priorityScore(2, 1);
    const bigProjectLater = priorityScore(30, 30);

    expect(bigProjectSoon).toBeGreaterThan(smallQuizTomorrow);
    expect(smallQuizTomorrow).toBeGreaterThan(bigProjectLater);
  });

  it("keeps a 0%-weight item from scoring zero — the `+ 1` in the numerator", () => {
    // A class today must still outrank a class next month.
    expect(priorityScore(0, 1)).toBeGreaterThan(0);
    expect(priorityScore(0, 1)).toBeGreaterThan(priorityScore(0, 30));
  });

  it("clamps daysUntilDue at 0.5 so an overdue item never flips sign", () => {
    // A negative denominator would sort the MOST overdue item last.
    expect(priorityScore(10, 0)).toBe(priorityScore(10, MIN_DAYS_UNTIL_DUE));
    expect(priorityScore(10, -20)).toBe(priorityScore(10, MIN_DAYS_UNTIL_DUE));
    expect(priorityScore(10, -20)).toBeGreaterThan(0);
  });

  it("is monotonic in weight and in urgency", () => {
    expect(priorityScore(40, 5)).toBeGreaterThan(priorityScore(20, 5));
    expect(priorityScore(20, 2)).toBeGreaterThan(priorityScore(20, 10));
  });
});

describe("resolveWeightPercent — override → assessment → kind default", () => {
  it("1. weight_override always wins", () => {
    expect(
      resolveWeightPercent({ kind: "deadline", weightOverride: 40, assessmentWeightPercent: 25 }),
    ).toEqual({ weightPercent: 40, source: "override" });
  });

  it("2. assessments.weight_percent when there is no override", () => {
    expect(
      resolveWeightPercent({ kind: "deadline", weightOverride: null, assessmentWeightPercent: 25 }),
    ).toEqual({ weightPercent: 25, source: "assessment" });
  });

  it("3. kind default when neither is set — deadline 5%, class/event 0%", () => {
    expect(resolveWeightPercent({ kind: "deadline" })).toEqual({
      weightPercent: 5,
      source: "kind_default",
    });
    expect(resolveWeightPercent({ kind: "class" })).toEqual({
      weightPercent: 0,
      source: "kind_default",
    });
    expect(resolveWeightPercent({ kind: "event" })).toEqual({
      weightPercent: 0,
      source: "kind_default",
    });
    expect(KIND_DEFAULT_WEIGHT).toEqual({ deadline: 5, class: 0, event: 0 });
  });

  it("treats an explicit 0 override as a real value, not as absent", () => {
    // The classic falsy bug: `weightOverride || fallback` would discard a
    // deliberate "this is worth nothing".
    expect(
      resolveWeightPercent({ kind: "deadline", weightOverride: 0, assessmentWeightPercent: 25 }),
    ).toEqual({ weightPercent: 0, source: "override" });
    expect(resolveWeightPercent({ kind: "deadline", assessmentWeightPercent: 0 })).toEqual({
      weightPercent: 0,
      source: "assessment",
    });
  });

  it("skips a non-finite override rather than propagating NaN into the score", () => {
    expect(resolveWeightPercent({ kind: "deadline", weightOverride: Number.NaN })).toEqual({
      weightPercent: 5,
      source: "kind_default",
    });
  });
});

describe("priorityTier — High ≥ 15, Medium 5–15, Low < 5, Info for classes", () => {
  const tierOf = (kind: "deadline" | "class" | "event", weightPercent: number) =>
    priorityTier({ kind, weightPercent, isOverdue: false });

  it("applies the three weight thresholds", () => {
    expect(tierOf("deadline", 30)).toBe("high");
    expect(tierOf("deadline", HIGH_WEIGHT_THRESHOLD)).toBe("high"); // 15 is High
    expect(tierOf("deadline", 14.99)).toBe("medium");
    expect(tierOf("deadline", MEDIUM_WEIGHT_THRESHOLD)).toBe("medium"); // 5 is Medium
    expect(tierOf("deadline", 4.99)).toBe("low");
    expect(tierOf("deadline", 0)).toBe("low");
  });

  it("gives classes Info regardless of weight", () => {
    // A class's 0% default would otherwise read as a meaningful "Low".
    expect(tierOf("class", 0)).toBe("info");
    expect(tierOf("class", 30)).toBe("info");
  });

  it("pins overdue above every weight tier", () => {
    expect(priorityTier({ kind: "deadline", weightPercent: 30, isOverdue: true })).toBe("overdue");
    expect(priorityTier({ kind: "class", weightPercent: 0, isOverdue: true })).toBe("overdue");
  });
});

describe("daysUntil", () => {
  it("returns fractional days, negative when overdue", () => {
    expect(daysUntil("2026-07-24T12:00:00.000Z", NOW)).toBe(6);
    expect(daysUntil("2026-07-19T00:00:00.000Z", NOW)).toBe(0.5);
    expect(daysUntil("2026-07-16T12:00:00.000Z", NOW)).toBe(-2);
  });

  it("takes `now` as a parameter — core stays a pure function of its inputs", () => {
    // A test that reads the wall clock is a test that fails at midnight.
    expect(daysUntil("2026-07-24T12:00:00.000Z", NOW)).toBe(
      daysUntil("2026-07-24T12:00:00.000Z", NOW),
    );
  });
});

describe("rankItems", () => {
  it("orders the spec's worked example correctly end to end", () => {
    const ranked = rankItems(
      [
        {
          id: "quiz-2pct-tomorrow",
          kind: "deadline",
          dueUtc: "2026-07-19T12:00:00.000Z",
          weightOverride: 2,
        },
        {
          id: "project-30pct-6d",
          kind: "deadline",
          dueUtc: "2026-07-24T12:00:00.000Z",
          weightOverride: 30,
        },
        {
          id: "project-30pct-30d",
          kind: "deadline",
          dueUtc: "2026-08-17T12:00:00.000Z",
          weightOverride: 30,
        },
      ],
      NOW,
    );

    expect(ranked.map((item) => item.id)).toEqual([
      "project-30pct-6d",
      "quiz-2pct-tomorrow",
      "project-30pct-30d",
    ]);
    expect(ranked[0]?.score).toBeCloseTo(5.17, 2);
    expect(ranked[1]?.score).toBeCloseTo(3.0, 2);
    expect(ranked[2]?.score).toBeCloseTo(1.03, 2);
  });

  it("excludes completed items entirely rather than sorting them last", () => {
    const ranked = rankItems(
      [
        {
          id: "done",
          kind: "deadline",
          dueUtc: "2026-07-19T12:00:00.000Z",
          weightOverride: 90,
          completedAt: "2026-07-17T09:00:00.000Z",
        },
        { id: "open", kind: "deadline", dueUtc: "2026-07-24T12:00:00.000Z", weightOverride: 10 },
      ],
      NOW,
    );

    expect(ranked.map((item) => item.id)).toEqual(["open"]);
  });

  it("pins overdue items above everything, whatever their weight", () => {
    const ranked = rankItems(
      [
        {
          id: "future-high",
          kind: "deadline",
          dueUtc: "2026-07-20T12:00:00.000Z",
          weightOverride: 50,
        },
        {
          id: "overdue-zero",
          kind: "deadline",
          dueUtc: "2026-07-10T12:00:00.000Z",
          weightOverride: 0,
        },
      ],
      NOW,
    );

    expect(ranked.map((item) => item.id)).toEqual(["overdue-zero", "future-high"]);
    expect(ranked[0]?.tier).toBe("overdue");
    expect(ranked[0]?.isOverdue).toBe(true);
  });

  it("resolves each item's weight through the full §5.2 order", () => {
    const ranked = rankItems(
      [
        {
          id: "by-override",
          kind: "deadline",
          dueUtc: "2026-07-24T12:00:00.000Z",
          weightOverride: 40,
          assessmentWeightPercent: 25,
        },
        {
          id: "by-assessment",
          kind: "deadline",
          dueUtc: "2026-07-24T12:00:00.000Z",
          assessmentWeightPercent: 25,
        },
        { id: "by-kind", kind: "deadline", dueUtc: "2026-07-24T12:00:00.000Z" },
        { id: "a-class", kind: "class", dueUtc: "2026-07-24T12:00:00.000Z" },
      ],
      NOW,
    );

    const byId = new Map(ranked.map((item) => [item.id, item]));
    expect(byId.get("by-override")).toMatchObject({
      weightPercent: 40,
      weightSource: "override",
      tier: "high",
    });
    expect(byId.get("by-assessment")).toMatchObject({
      weightPercent: 25,
      weightSource: "assessment",
      tier: "high",
    });
    expect(byId.get("by-kind")).toMatchObject({
      weightPercent: 5,
      weightSource: "kind_default",
      tier: "medium",
    });
    expect(byId.get("a-class")).toMatchObject({
      weightPercent: 0,
      weightSource: "kind_default",
      tier: "info",
    });
  });

  it("breaks ties on id so the order is stable across renders", () => {
    const items = [
      {
        id: "b",
        kind: "deadline" as const,
        dueUtc: "2026-07-24T12:00:00.000Z",
        weightOverride: 10,
      },
      {
        id: "a",
        kind: "deadline" as const,
        dueUtc: "2026-07-24T12:00:00.000Z",
        weightOverride: 10,
      },
      {
        id: "c",
        kind: "deadline" as const,
        dueUtc: "2026-07-24T12:00:00.000Z",
        weightOverride: 10,
      },
    ];
    expect(rankItems(items, NOW).map((item) => item.id)).toEqual(["a", "b", "c"]);
    // Same input in a different order must produce the same output order.
    expect(rankItems([...items].reverse(), NOW).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty list rather than throwing on no items", () => {
    expect(rankItems([], NOW)).toEqual([]);
  });
});
