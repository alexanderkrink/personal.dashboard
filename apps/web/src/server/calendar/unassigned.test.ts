import { describe, expect, it } from "vitest";
import { groupUnassigned, type UnassignedItem } from "./unassigned";

let seq = 0;
function row(rawSummary: string, startsAt = "2026-01-19T08:00:00.000Z"): UnassignedItem {
  seq += 1;
  return { id: `i${seq}`, raw_summary: rawSummary, title: "", starts_at: startsAt };
}

describe("groupUnassigned", () => {
  it("collapses the fragmented variants of one course into a single pattern", () => {
    // §5.1b correction 3: MARKETING MANAGEMENT fragments across three variants,
    // and an un-normalised group-by loses 5 of its 15 events.
    const groups = groupUnassigned([
      row("MARKETING MANAGEMENT   (Ses. 1) T-03.01"),
      row("MARKETING MANAGEMENT |   (Ses. 2) T-03.01"),
      row("MARKETING MANAGEMENT | | , null   (Ses. 3) T-03.01"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.pattern).toBe("MARKETING MANAGEMENT");
    expect(groups[0]?.count).toBe(3);
    expect(groups[0]?.itemIds).toHaveLength(3);
  });

  it("orders the biggest group first, so one click clears the most rows", () => {
    const groups = groupUnassigned([
      row("MICROECONOMICS   (Ses. 1)"),
      row("FINANCE LAB   (Ses. 1)"),
      row("FINANCE LAB   (Ses. 2)"),
      row("FINANCE LAB   (Ses. 3)"),
    ]);

    expect(groups.map((group) => [group.pattern, group.count])).toEqual([
      ["FINANCE LAB", 3],
      ["MICROECONOMICS", 1],
    ]);
  });

  it("records the date range each group spans", () => {
    const groups = groupUnassigned([
      row("FINANCE LAB   (Ses. 2)", "2026-03-02T08:00:00.000Z"),
      row("FINANCE LAB   (Ses. 1)", "2026-01-19T08:00:00.000Z"),
      row("FINANCE LAB   (Ses. 3)", "2026-06-26T08:00:00.000Z"),
    ]);

    expect(groups[0]?.firstStartsAt).toBe("2026-01-19T08:00:00.000Z");
    expect(groups[0]?.lastStartsAt).toBe("2026-06-26T08:00:00.000Z");
  });

  /**
   * Two of the 5 pseudo rows carry a REAL course prefix, so they would otherwise
   * appear as an offer to file a proctoring check under a course.
   */
  it("drops pseudo/LMS rows instead of offering them for assignment", () => {
    const groups = groupUnassigned([
      row("**Last Update (IE Calendar)**"),
      row("APPLIED BUSINESS MATHEMATICS   Test the download and upload of Excel files"),
      row("APPLIED BUSINESS MATHEMATICS   Smowl Check-Test: Multiattempt"),
      row("APPLIED BUSINESS MATHEMATICS   Final EXAM Retake June ABM30"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(1);
  });

  it("returns nothing for an empty bucket", () => {
    expect(groupUnassigned([])).toEqual([]);
  });

  /**
   * The live shape: 220 rows, 15 patterns. The grouping is what makes §5.1's
   * "surface it at the top of the calendar page" survivable.
   */
  it("turns the live 220-row bucket into a short list", () => {
    const live: [string, number][] = [
      ["FINANCE LAB", 32],
      ["FUNDAMENTALS OF DATA ANALYSIS", 32],
      ["COMPUTATIONAL THINKING FOR DATA MANAGEMENT AND ANALYSIS", 28],
      ["MICROECONOMICS", 27],
      ["CORPORATE FINANCE", 25],
      ["IE HUMANITIES", 22],
      ["DATA INSIGHTS AND VISUALIZATION", 19],
      ["COST ACCOUNTING", 15],
    ];

    const items = live.flatMap(([name, count]) =>
      Array.from({ length: count }, (_, index) => row(`${name}   (Ses. ${index + 1}) T-01.01`)),
    );

    const groups = groupUnassigned(items);
    expect(groups).toHaveLength(8);
    expect(groups.reduce((total, group) => total + group.count, 0)).toBe(200);
    expect(groups[0]?.pattern).toBe("FINANCE LAB");
  });
});
