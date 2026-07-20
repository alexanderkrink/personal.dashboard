import { describe, expect, it } from "vitest";
import { contributionStreak, participationPace } from "./pace";

/**
 * Pace vs `courses.participation_target` (contributions per session) and the
 * contribution streak. Participation is the GRADED component; it never touches
 * the attendance gate. Boundaries proven red against the scaffold (`>` instead
 * of `>=`, false instead of null on zero sessions, streak counted from the
 * oldest end) before the correct implementation landed.
 */

describe("participationPace — the target boundary", () => {
  it("exactly meeting the target is on pace", () => {
    // 6 contributions over 6 sessions vs a target of 1 — a `>` implementation
    // calls this behind.
    const pace = participationPace([1, 1, 1, 1, 1, 1], 1);
    expect(pace.perSession).toBe(1);
    expect(pace.delta).toBe(0);
    expect(pace.onPace).toBe(true);
  });

  it("one contribution short of the target is behind", () => {
    const pace = participationPace([1, 1, 1, 1, 1, 0], 1);
    expect(pace.onPace).toBe(false);
    expect(pace.delta).toBeCloseTo(-1 / 6);
  });

  it("zero logged sessions is no evidence, not 'behind'", () => {
    const pace = participationPace([], 1);
    expect(pace.sessions).toBe(0);
    expect(pace.perSession).toBe(0);
    expect(pace.onPace).toBeNull();
    expect(pace.delta).toBeNull();
  });

  it("without a target there is nothing to be on pace against", () => {
    const pace = participationPace([2, 0, 1]);
    expect(pace.contributions).toBe(3);
    expect(pace.perSession).toBe(1);
    expect(pace.target).toBeNull();
    expect(pace.onPace).toBeNull();
    expect(pace.delta).toBeNull();
  });

  it("rejects negative or fractional per-session counts and a non-positive target", () => {
    expect(() => participationPace([1, -1], 1)).toThrow(RangeError);
    expect(() => participationPace([1.5], 1)).toThrow(RangeError);
    expect(() => participationPace([1], 0)).toThrow(RangeError);
    expect(() => participationPace([1], -2)).toThrow(RangeError);
    expect(() => participationPace([1], Number.NaN)).toThrow(RangeError);
  });
});

describe("contributionStreak", () => {
  it("counts consecutive contributing sessions from the NEWEST end", () => {
    // Oldest -> newest: spoke, spoke, silent. The streak is over — 0.
    // An implementation counting from the oldest end reports 2.
    expect(contributionStreak([1, 1, 0])).toBe(0);
    expect(contributionStreak([0, 1, 1])).toBe(2);
  });

  it("a fully-contributing history is a full streak; empty history is 0", () => {
    expect(contributionStreak([2, 1, 3])).toBe(3);
    expect(contributionStreak([])).toBe(0);
  });

  it("a silent session anywhere in the tail is where the streak stops", () => {
    expect(contributionStreak([1, 0, 1, 1])).toBe(2);
  });
});
