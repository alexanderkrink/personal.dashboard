import { describe, expect, it } from "vitest";
import {
  AI_PAUSED_USER_MESSAGE,
  AIPausedError,
  type CallKind,
  guardDecision,
  type SpendPosture,
  spendPosture,
} from "./guard";
import type { Rank } from "./models";

/**
 * §6's kill switch and budget guard.
 *
 * The property under test throughout is the ordering principle: **interactive chat is the
 * last thing to die, background regeneration the first.** Every threshold cuts background
 * work before it touches a user who is waiting.
 */

const BUDGET = 75;

describe("spendPosture", () => {
  it.each([
    [0, "normal"],
    [37.5, "normal"],
    [74.99, "normal"],
    // Exactly 100% already defers deep jobs — §6 says "past 100%", and the boundary is
    // inclusive because a budget you have exactly consumed is a budget you have consumed.
    [75, "defer-deep"],
    [90, "defer-deep"],
    [93.74, "defer-deep"],
    [93.75, "defer-balanced"], // 125%
    [110, "defer-balanced"],
    [112.49, "defer-balanced"],
    [112.5, "halt"], // 150% — §4's ≈$110 hard threshold
    [1000, "halt"],
  ] satisfies readonly (readonly [number, SpendPosture])[])(
    "$%s of a $75 budget is %s",
    (monthToDateUsd, expected) => {
      expect(spendPosture({ monthToDateUsd, monthlyBudgetUsd: BUDGET })).toBe(expected);
    },
  );

  it("halts on a zero or negative budget rather than dividing by it", () => {
    expect(spendPosture({ monthToDateUsd: 0, monthlyBudgetUsd: 0 })).toBe("halt");
    expect(spendPosture({ monthToDateUsd: 0, monthlyBudgetUsd: -1 })).toBe("halt");
  });

  it("treats an unreadable spend figure as normal, not as a halt", () => {
    // A failed rollup read must not take AI down. One uncapped call is a smaller failure
    // than every AI feature going dark on a transient database hiccup, and the read is
    // retried on the very next call.
    expect(spendPosture({ monthToDateUsd: Number.NaN, monthlyBudgetUsd: BUDGET })).toBe("normal");
  });

  it("clamps a negative spend rather than trusting it", () => {
    expect(spendPosture({ monthToDateUsd: -500, monthlyBudgetUsd: BUDGET })).toBe("normal");
  });
});

describe("guardDecision", () => {
  const decide = (posture: SpendPosture, rank: Rank, kind: CallKind) =>
    guardDecision({ killSwitch: false, posture, rank, kind });

  it("blocks everything when the kill switch is set, interactive included", () => {
    for (const kind of ["interactive", "background"] as const) {
      for (const rank of ["fast", "balanced", "deep"] as const) {
        expect(guardDecision({ killSwitch: true, posture: "normal", rank, kind })).toEqual({
          allowed: false,
          reason: "kill-switch",
        });
      }
    }
  });

  it("blocks everything at 150%, because §6 says behave as if the kill switch were set", () => {
    expect(decide("halt", "fast", "interactive")).toEqual({
      allowed: false,
      reason: "budget-halt",
    });
    expect(decide("halt", "fast", "background")).toEqual({
      allowed: false,
      reason: "budget-halt",
    });
  });

  it("never defers an interactive call below the halt threshold", () => {
    // The headline §6 ordering: chat is the last thing to die.
    for (const posture of ["normal", "defer-deep", "defer-balanced"] as const) {
      for (const rank of ["fast", "balanced", "deep"] as const) {
        expect(decide(posture, rank, "interactive")).toEqual({ allowed: true });
      }
    }
  });

  it("defers deep-rank background jobs at 100%, and nothing cheaper", () => {
    expect(decide("defer-deep", "deep", "background")).toEqual({
      allowed: false,
      reason: "budget-defer-deep",
    });
    expect(decide("defer-deep", "balanced", "background")).toEqual({ allowed: true });
    expect(decide("defer-deep", "fast", "background")).toEqual({ allowed: true });
  });

  it("defers balanced AND deep background jobs at 125%, leaving the cheap tier alive", () => {
    expect(decide("defer-balanced", "deep", "background")).toEqual({
      allowed: false,
      reason: "budget-defer-balanced",
    });
    expect(decide("defer-balanced", "balanced", "background")).toEqual({
      allowed: false,
      reason: "budget-defer-balanced",
    });
    // Flash-Lite classification keeps the pipeline limping rather than stopping it dead.
    expect(decide("defer-balanced", "fast", "background")).toEqual({ allowed: true });
  });

  it("allows everything under budget", () => {
    for (const rank of ["fast", "balanced", "deep"] as const) {
      expect(decide("normal", rank, "background")).toEqual({ allowed: true });
    }
  });
});

describe("AIPausedError", () => {
  it("is always retryable — the call never ran, so nothing was lost", () => {
    for (const reason of [
      "kill-switch",
      "budget-halt",
      "budget-defer-deep",
      "budget-defer-balanced",
    ] as const) {
      expect(new AIPausedError(reason).retryable).toBe(true);
    }
  });

  it("carries the reason and the job for the Inngest wrapper to route on", () => {
    const error = new AIPausedError("budget-defer-deep", { job: "exam-review" });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AIPausedError");
    expect(error.reason).toBe("budget-defer-deep");
    expect(error.job).toBe("exam-review");
  });

  it("uses §6's friendly wording for the two hard stops a user can see", () => {
    expect(new AIPausedError("kill-switch").message).toContain(AI_PAUSED_USER_MESSAGE);
    expect(new AIPausedError("budget-halt").message).toContain(AI_PAUSED_USER_MESSAGE);
  });
});
