import { describe, expect, it } from "vitest";
import { formatDueIn, formatSyncedAgo, TIER_BADGE_CLASS } from "./urgency";

describe("the heat ramp", () => {
  /**
   * 🎨 The single most invertible decision in the view. A green "High" badge
   * reads as *finished* at a glance — the exact opposite of what it means.
   * Green belongs to `--urgency-done`, and nothing on this ramp may reach it.
   */
  it("never uses the done/green token for an urgency tier", () => {
    for (const className of Object.values(TIER_BADGE_CLASS)) {
      expect(className).not.toContain("urgency-done");
      expect(className).not.toContain("success");
      expect(className).not.toContain("green");
    }
  });

  it("runs red → amber → dim amber → neutral, in that order", () => {
    expect(TIER_BADGE_CLASS.overdue).toContain("urgency-overdue");
    expect(TIER_BADGE_CLASS.high).toContain("urgency-high");
    expect(TIER_BADGE_CLASS.medium).toContain("urgency-medium");
    expect(TIER_BADGE_CLASS.low).toContain("muted");
    // A class carries no grade weight, so it must not borrow a weight colour.
    expect(TIER_BADGE_CLASS.info).toContain("muted");
  });
});

describe("formatDueIn", () => {
  it("counts down in days beyond a day out", () => {
    expect(formatDueIn(2.4)).toBe("in 2 days");
    expect(formatDueIn(1.2)).toBe("tomorrow");
    expect(formatDueIn(9)).toBe("in 9 days");
  });

  it("switches to hours inside the last day, never “in 0 days”", () => {
    expect(formatDueIn(0.5)).toBe("in 12h");
    expect(formatDueIn(0.04)).toBe("now");
  });

  it("counts up once overdue", () => {
    expect(formatDueIn(-0.5)).toBe("12h ago");
    expect(formatDueIn(-3.2)).toBe("3 days ago");
    expect(formatDueIn(-1.5)).toBe("1 day ago");
    expect(formatDueIn(-0.01)).toBe("just now");
  });
});

describe("formatSyncedAgo", () => {
  const now = new Date("2026-09-15T12:00:00.000Z");

  it("reads as §7's “Synced 12 min ago”", () => {
    expect(formatSyncedAgo("2026-09-15T11:48:00.000Z", now)).toBe("12 min ago");
    expect(formatSyncedAgo("2026-09-15T11:59:30.000Z", now)).toBe("just now");
    expect(formatSyncedAgo("2026-09-15T09:00:00.000Z", now)).toBe("3h ago");
    expect(formatSyncedAgo("2026-09-12T12:00:00.000Z", now)).toBe("3d ago");
  });

  it("says so plainly when a feed has never synced", () => {
    expect(formatSyncedAgo(null, now)).toBe("never synced");
    expect(formatSyncedAgo("not a date", now)).toBe("never synced");
  });
});
