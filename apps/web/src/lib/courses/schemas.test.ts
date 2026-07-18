import { describe, expect, it } from "vitest";
import { assessmentSchema, courseSchema, semesterSchema } from "./schemas";

/** The shape a form actually posts: every field present, every field a string. */
function semesterForm(overrides: Record<string, string> = {}) {
  return { name: "2026/27 Fall", startsOn: "2026-09-01", endsOn: "2026-12-20", ...overrides };
}

function courseForm(overrides: Record<string, string> = {}) {
  return {
    semesterId: "",
    code: "",
    title: "Database Architecture",
    color: "indigo",
    credits: "",
    targetGrade: "",
    gradingScale: "ie_10",
    participationWeight: "",
    absenceFailPct: "",
    participationTarget: "",
    ...overrides,
  };
}

function assessmentForm(overrides: Record<string, string> = {}) {
  return { title: "Midterm", kind: "exam", weightPercent: "30", dueHint: "", ...overrides };
}

/** The first message for a field, or undefined — mirrors `toFormState`. */
function fieldError(
  result: { success: boolean; error?: { issues: readonly unknown[] } },
  field: string,
) {
  if (result.success) return undefined;
  const issues = (result.error?.issues ?? []) as ReadonlyArray<{
    path: readonly PropertyKey[];
    message: string;
  }>;
  return issues.find((issue) => issue.path[0] === field)?.message;
}

describe("semesterSchema", () => {
  it("accepts a well-formed term", () => {
    const result = semesterSchema.safeParse(semesterForm());
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      name: "2026/27 Fall",
      startsOn: "2026-09-01",
      endsOn: "2026-12-20",
    });
  });

  it("trims the name and rejects a blank one", () => {
    expect(semesterSchema.safeParse(semesterForm({ name: "  2026/27 Fall  " })).data?.name).toBe(
      "2026/27 Fall",
    );
    expect(fieldError(semesterSchema.safeParse(semesterForm({ name: "   " })), "name")).toContain(
      "needs a name",
    );
  });

  it("blames the END date when the term runs backwards", () => {
    // The DB constraint (semesters_dates_ordered) exists; catching it here is
    // what keeps it from arriving as a 500.
    const result = semesterSchema.safeParse(semesterForm({ endsOn: "2026-08-31" }));
    expect(result.success).toBe(false);
    expect(fieldError(result, "endsOn")).toContain("can’t fall before");
    expect(fieldError(result, "startsOn")).toBeUndefined();
  });

  it("allows a single-day term", () => {
    expect(
      semesterSchema.safeParse(semesterForm({ startsOn: "2026-09-01", endsOn: "2026-09-01" }))
        .success,
    ).toBe(true);
  });

  it("rejects a missing or malformed date", () => {
    expect(fieldError(semesterSchema.safeParse(semesterForm({ startsOn: "" })), "startsOn")).toBe(
      "Enter a start date.",
    );
    expect(
      fieldError(semesterSchema.safeParse(semesterForm({ endsOn: "20-12-2026" })), "endsOn"),
    ).toBe("Enter an end date.");
  });
});

describe("courseSchema", () => {
  it("accepts a minimal course and nulls every blank optional", () => {
    const result = courseSchema.safeParse(courseForm());
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      semesterId: null,
      code: null,
      title: "Database Architecture",
      color: "indigo",
      credits: null,
      targetGrade: null,
      gradingScale: "ie_10",
      participationWeight: null,
      absenceFailPct: null,
      participationTarget: null,
    });
  });

  it("parses a fully specified course", () => {
    const result = courseSchema.safeParse(
      courseForm({
        semesterId: "0b6d5a1e-6d5b-4a2e-9f3c-2a1b8c7d6e5f",
        code: "DBA-301",
        color: "rust",
        credits: "6",
        targetGrade: "8.5",
        participationWeight: "15",
        absenceFailPct: "25",
        participationTarget: "2",
      }),
    );
    expect(result.success).toBe(true);
    expect(result.data?.credits).toBe(6);
    expect(result.data?.targetGrade).toBe(8.5);
    expect(result.data?.semesterId).toBe("0b6d5a1e-6d5b-4a2e-9f3c-2a1b8c7d6e5f");
  });

  it("rejects a colour outside the eight palette keys", () => {
    // The database has the same check constraint; failing here gives it words.
    expect(fieldError(courseSchema.safeParse(courseForm({ color: "#6366f1" })), "color")).toContain(
      "eight course colours",
    );
    expect(
      fieldError(courseSchema.safeParse(courseForm({ color: "crimson" })), "color"),
    ).toBeTruthy();
  });

  it("rejects a non-numeric optional rather than storing NaN", () => {
    expect(fieldError(courseSchema.safeParse(courseForm({ credits: "six" })), "credits")).toBe(
      "Enter a number.",
    );
  });

  it("range-checks percentages", () => {
    expect(
      fieldError(courseSchema.safeParse(courseForm({ absenceFailPct: "120" })), "absenceFailPct"),
    ).toContain("between 0 and 100");
    expect(
      fieldError(
        courseSchema.safeParse(courseForm({ participationWeight: "-1" })),
        "participationWeight",
      ),
    ).toContain("between 0 and 100");
  });

  it("checks the target grade against the scale that was actually chosen", () => {
    // 9 is a fine IE target and a nonsensical German one.
    expect(courseSchema.safeParse(courseForm({ targetGrade: "9" })).success).toBe(true);

    const german = courseSchema.safeParse(courseForm({ gradingScale: "de_1_5", targetGrade: "9" }));
    expect(german.success).toBe(false);
    expect(fieldError(german, "targetGrade")).toContain("between 1 and 5");

    expect(
      courseSchema.safeParse(courseForm({ gradingScale: "de_1_5", targetGrade: "1.7" })).success,
    ).toBe(true);
  });

  it("rejects a semester id that is not a uuid", () => {
    expect(
      fieldError(courseSchema.safeParse(courseForm({ semesterId: "fall" })), "semesterId"),
    ).toContain("Pick a semester");
  });
});

describe("assessmentSchema", () => {
  it("accepts a component and nulls a blank due hint", () => {
    const result = assessmentSchema.safeParse(assessmentForm());
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      title: "Midterm",
      kind: "exam",
      weightPercent: 30,
      dueHint: null,
    });
  });

  it("keeps a freeform due hint verbatim", () => {
    expect(assessmentSchema.safeParse(assessmentForm({ dueHint: "week 9" })).data?.dueHint).toBe(
      "week 9",
    );
  });

  it("rejects a kind outside the check constraint", () => {
    expect(
      fieldError(assessmentSchema.safeParse(assessmentForm({ kind: "midterm" })), "kind"),
    ).toContain("what kind of component");
  });

  it("requires a weight and holds it to 0–100", () => {
    expect(
      fieldError(
        assessmentSchema.safeParse(assessmentForm({ weightPercent: "" })),
        "weightPercent",
      ),
    ).toBe("Enter a number.");
    expect(
      fieldError(
        assessmentSchema.safeParse(assessmentForm({ weightPercent: "101" })),
        "weightPercent",
      ),
    ).toContain("between 0 and 100");
    expect(assessmentSchema.safeParse(assessmentForm({ weightPercent: "0" })).success).toBe(true);
  });

  it("rounds to the column's numeric(5,2) precision instead of letting Postgres do it quietly", () => {
    expect(
      assessmentSchema.safeParse(assessmentForm({ weightPercent: "33.333" })).data?.weightPercent,
    ).toBe(33.33);
    expect(
      assessmentSchema.safeParse(assessmentForm({ weightPercent: "33.336" })).data?.weightPercent,
    ).toBe(33.34);
  });
});
