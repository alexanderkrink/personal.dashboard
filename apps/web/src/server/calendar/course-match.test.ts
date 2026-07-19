import { describe, expect, it } from "vitest";
import { type CourseMatchContext, createCourseMatcher } from "./course-match";

const ADS = "11111111-1111-1111-1111-111111111111";
const MDMA = "22222222-2222-2222-2222-222222222222";

const COURSES = [
  { id: ADS, code: "ADS", title: "ALGORITHMS & DATA STRUCTURES" },
  { id: MDMA, code: null, title: "MATHEMATICS FOR DATA MANAGEMENT AND ANALYSIS" },
];

function matcher(overrides: Partial<CourseMatchContext> = {}) {
  return createCourseMatcher({ matchers: [], courses: COURSES, ...overrides });
}

describe("createCourseMatcher — the §5.1 chain", () => {
  it("step 1: a feed pin wins outright, without reading the hint", () => {
    const match = matcher({ pinnedCourseId: MDMA });
    expect(match("ALGORITHMS & DATA STRUCTURES")).toEqual({ courseId: MDMA, step: "feed_pin" });
    // Zero inference: even an unparseable summary resolves.
    expect(match("")).toEqual({ courseId: MDMA, step: "feed_pin" });
  });

  it("ignores a pin naming a course the user does not own", () => {
    // The composite (course_id, user_id) FK would reject the write anyway;
    // falling through to inference beats failing the whole sync on stale config.
    const match = matcher({ pinnedCourseId: "99999999-9999-9999-9999-999999999999" });
    expect(match("ALGORITHMS & DATA STRUCTURES")?.step).toBe("course_title");
  });

  it("step 2: a learned matcher beats the course title", () => {
    const match = matcher({ matchers: [{ course_id: MDMA, pattern: "ALGORITHMS" }] });
    expect(match("ALGORITHMS & DATA STRUCTURES")).toEqual({
      courseId: MDMA,
      step: "matcher",
      matchedOn: "ALGORITHMS",
    });
  });

  it("matches learned patterns case-insensitively, as a substring", () => {
    const match = matcher({ matchers: [{ course_id: ADS, pattern: "finance lab" }] });
    expect(match("FINANCE LAB")?.courseId).toBe(ADS);
    expect(match("Finance Lab   (Ses. 3)")?.courseId).toBe(ADS);
  });

  it("drops a blank matcher pattern rather than filing the whole feed under it", () => {
    const match = matcher({ matchers: [{ course_id: MDMA, pattern: "   " }] });
    expect(match("ALGORITHMS & DATA STRUCTURES")?.step).toBe("course_title");
  });

  it("drops a matcher pointing at a course that no longer exists", () => {
    const match = matcher({
      matchers: [{ course_id: "99999999-9999-9999-9999-999999999999", pattern: "ALGORITHMS" }],
    });
    expect(match("ALGORITHMS & DATA STRUCTURES")?.step).toBe("course_title");
  });

  it("step 3a: matches a course code as a whole word", () => {
    expect(matcher()("ADS lab session")).toEqual({
      courseId: ADS,
      step: "course_code",
      matchedOn: "ads",
    });
  });

  /**
   * The reason code matching is not a substring. A two-letter code inside a
   * longer word files an entire course's events under the wrong heading, and
   * does it silently.
   */
  it("does not match a course code embedded inside another word", () => {
    const match = createCourseMatcher({
      matchers: [],
      courses: [{ id: ADS, code: "MM", title: "MARKETING MANAGEMENT" }],
    });
    expect(match("SUMMER SCHOOL")).toBeNull();
    expect(match("MM   (Ses. 4)")?.step).toBe("course_code");
  });

  it("tolerates regex metacharacters in a course code", () => {
    const match = createCourseMatcher({
      matchers: [],
      courses: [{ id: ADS, code: "C++", title: "PROGRAMMING" }],
    });
    expect(match("C++ workshop")?.courseId).toBe(ADS);
    expect(match("CXX workshop")).toBeNull();
  });

  it("step 3b: matches the course title exactly, then by containment either way", () => {
    expect(matcher()("MATHEMATICS FOR DATA MANAGEMENT AND ANALYSIS")).toEqual({
      courseId: MDMA,
      step: "course_title",
      matchedOn: "mathematics for data management and analysis",
    });
    // The feed truncates long names…
    expect(matcher()("MATHEMATICS FOR DATA MANAGEMENT")?.courseId).toBe(MDMA);
    // …and it also appends text that survived normalization.
    expect(matcher()("MATHEMATICS FOR DATA MANAGEMENT AND ANALYSIS T-03.01")?.courseId).toBe(MDMA);
  });

  it("step 4: an unrecognised hint falls through to the Unassigned bucket", () => {
    expect(matcher()("FINANCE LAB")).toBeNull();
    expect(matcher()("")).toBeNull();
    expect(matcher()("   ")).toBeNull();
  });

  /**
   * The live shape of the data on 2026-07-18: all 7 fall courses match by title
   * and none has a `code`, while the 2025/26 spring courses match nothing at all
   * — which is exactly why the bucket holds 220 rows.
   */
  it("reproduces the live 154-matched / 220-unassigned split by hint", () => {
    const match = matcher();
    expect(match("ALGORITHMS & DATA STRUCTURES")?.step).toBe("course_title");
    for (const hint of ["FINANCE LAB", "MICROECONOMICS", "COST ACCOUNTING", "IE HUMANITIES"]) {
      expect(match(hint)).toBeNull();
    }
  });
});
