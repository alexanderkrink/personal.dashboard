import { describe, expect, it } from "vitest";
import { assignCourseSchema, quickAddSchema, weightOverrideSchema } from "./item-schemas";

const VALID = {
  title: "Problem set 3",
  kind: "deadline",
  date: "2026-09-18",
  time: "23:59",
  durationMinutes: "",
  courseId: "",
  weightPercent: "35",
};

describe("quickAddSchema", () => {
  it("accepts a well-formed entry and nulls the blanks", () => {
    const parsed = quickAddSchema.parse(VALID);
    expect(parsed).toMatchObject({
      title: "Problem set 3",
      kind: "deadline",
      date: "2026-09-18",
      time: "23:59",
      durationMinutes: null,
      courseId: null,
      weightPercent: 35,
    });
  });

  /**
   * A blank number field must be NULL, never 0. `z.coerce.number()` turns `""`
   * into `0` quite happily, so a left-blank "Worth" would silently claim the
   * item is worth 0% of the grade rather than "unknown" — which is a different
   * and wrong statement, and one that changes its priority tier.
   */
  it("treats a blank number as absent, not as zero", () => {
    const parsed = quickAddSchema.parse({ ...VALID, weightPercent: "  ", durationMinutes: "" });
    expect(parsed.weightPercent).toBeNull();
    expect(parsed.durationMinutes).toBeNull();
  });

  it("still accepts an explicit zero weight", () => {
    expect(quickAddSchema.parse({ ...VALID, weightPercent: "0" }).weightPercent).toBe(0);
  });

  /**
   * The browser's own date input rejects this before the action is reached, so
   * this guard exists for the paths that are not a browser: a scripted POST to
   * the Server Action endpoint. Without it `Date.UTC` rolls 30 February forward
   * to 2 March — a wrong deadline rather than a rejected one.
   */
  it("rejects a structurally valid date that does not exist", () => {
    const result = quickAddSchema.safeParse({ ...VALID, date: "2026-02-30" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("That date doesn’t exist.");
  });

  it("accepts a real leap day and rejects a fake one", () => {
    expect(quickAddSchema.safeParse({ ...VALID, date: "2028-02-29" }).success).toBe(true);
    expect(quickAddSchema.safeParse({ ...VALID, date: "2026-02-29" }).success).toBe(false);
  });

  it("refuses a duration on an all-day entry", () => {
    const result = quickAddSchema.safeParse({ ...VALID, time: "", durationMinutes: "90" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["durationMinutes"]);
  });

  it("allows an all-day entry with no duration", () => {
    const parsed = quickAddSchema.parse({ ...VALID, time: "", durationMinutes: "" });
    expect(parsed.time).toBeNull();
  });

  it("rejects an empty title, a bad kind, and an out-of-range weight", () => {
    expect(quickAddSchema.safeParse({ ...VALID, title: "   " }).success).toBe(false);
    expect(quickAddSchema.safeParse({ ...VALID, kind: "lecture" }).success).toBe(false);
    expect(quickAddSchema.safeParse({ ...VALID, weightPercent: "101" }).success).toBe(false);
    expect(quickAddSchema.safeParse({ ...VALID, weightPercent: "-1" }).success).toBe(false);
  });

  it("rejects a malformed time", () => {
    expect(quickAddSchema.safeParse({ ...VALID, time: "11pm" }).success).toBe(false);
    expect(quickAddSchema.safeParse({ ...VALID, time: "23:59" }).success).toBe(true);
  });
});

describe("assignCourseSchema", () => {
  /**
   * The pattern becomes a `course_matchers.pattern` verbatim, matched as a
   * case-insensitive substring. A one- or two-character pattern is a substring
   * of nearly every summary in the feed and would file all 374 events under one
   * course on the next sync.
   */
  it("refuses a pattern too short to match on safely", () => {
    const result = assignCourseSchema.safeParse({
      pattern: "IE",
      courseId: "8115fe58-3b93-4bdc-af05-28cb3b0658cb",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a real course-name pattern", () => {
    expect(
      assignCourseSchema.parse({
        pattern: "  FINANCE LAB  ",
        courseId: "8115fe58-3b93-4bdc-af05-28cb3b0658cb",
      }).pattern,
    ).toBe("FINANCE LAB");
  });

  it("rejects a non-uuid course", () => {
    expect(
      assignCourseSchema.safeParse({ pattern: "FINANCE LAB", courseId: "not-a-uuid" }).success,
    ).toBe(false);
  });
});

describe("weightOverrideSchema", () => {
  it("reads a blank as a clear, not as zero", () => {
    const parsed = weightOverrideSchema.parse({
      itemId: "8115fe58-3b93-4bdc-af05-28cb3b0658cb",
      weightPercent: "",
    });
    expect(parsed.weightPercent).toBeNull();
  });

  it("accepts a fractional weight", () => {
    expect(
      weightOverrideSchema.parse({
        itemId: "8115fe58-3b93-4bdc-af05-28cb3b0658cb",
        weightPercent: "12.5",
      }).weightPercent,
    ).toBe(12.5);
  });
});
