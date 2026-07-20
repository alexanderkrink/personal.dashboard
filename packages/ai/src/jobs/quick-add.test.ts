import { describe, expect, it } from "vitest";
import type { AIGenerationStamp, AIRuntime, GenerateStructuredOptions } from "../runtime";
import type { QuickAddParse } from "../schemas/quick-add";
import { parseQuickAdd, renderQuickAddCourses } from "./quick-add";

/**
 * The `quick-add` wrapper's own obligations — the two deterministic guards that sit
 * between the model's output and the confirm card, plus the binding itself.
 *
 * The guards exist because the schema cannot carry them: a JSON-Schema string field
 * cannot know the user's course list, and "duration null when all-day" is a cross-field
 * rule the provider does not enforce. Both are exactly the shape of check PLAN §6 says
 * to adjudicate in code for free rather than burn a ladder rung on.
 */

const STAMP: AIGenerationStamp = {
  promptId: "quick-add",
  promptVersion: 1,
  job: "quick-add",
  provider: "google",
  model: "gemini-3.1-flash-lite",
  inputHash: "deadbeef",
};

const COURSES = [
  { id: "11111111-1111-4111-8111-111111111111", title: "Machine Learning" },
  { id: "22222222-2222-4222-8222-222222222222", title: "Econometrics" },
] as const;

const PARSE: QuickAddParse = {
  title: "ML assignment 3",
  kind: "deadline",
  date: "2026-07-24",
  time: "23:59",
  durationMinutes: null,
  courseId: COURSES[0].id,
  weightPercent: 15,
  confidence: 0.92,
  ambiguity: null,
};

/** A runtime that returns a canned parse and records what it was asked. */
function fakeRuntime(value: QuickAddParse): {
  runtime: AIRuntime;
  calls: GenerateStructuredOptions<never, never>[];
} {
  const calls: GenerateStructuredOptions<never, never>[] = [];
  const runtime = {
    resolve: () => {
      throw new Error("not under test");
    },
    guardCheck: async () => ({ allowed: true }) as never,
    streamProse: () => {
      throw new Error("not under test");
    },
    generateStructured: async (options: never) => {
      calls.push(options);
      return { status: "success", value, stamp: STAMP } as never;
    },
  } as AIRuntime;
  return { runtime, calls };
}

function options(value: QuickAddParse) {
  const { runtime, calls } = fakeRuntime(value);
  return {
    calls,
    options: {
      runtime,
      utterance: "ML assignment 3 due next friday 23:59, worth 15%",
      today: "2026-07-21",
      weekday: "Tuesday",
      timezone: "Europe/Madrid",
      courses: COURSES,
    },
  };
}

describe("parseQuickAdd — the binding", () => {
  it("sends the utterance, the injected today/timezone and the course list, interactively", async () => {
    const { options: opts, calls } = options(PARSE);
    const result = await parseQuickAdd(opts);

    expect(result.status).toBe("success");
    expect(calls).toHaveLength(1);
    const call = calls[0] as unknown as {
      prompt: { id: string; version: number };
      vars: Record<string, string>;
      kind: string;
      system: string;
    };
    expect(call.prompt.id).toBe("quick-add");
    expect(call.prompt.version).toBe(1);
    expect(call.kind).toBe("interactive");
    expect(call.system).toContain("NEVER invent a date");
    // The caller's clock, verbatim — the model has no other today to resolve "friday" from.
    expect(call.vars.today).toBe("2026-07-21");
    expect(call.vars.weekday).toBe("Tuesday");
    expect(call.vars.timezone).toBe("Europe/Madrid");
    expect(call.vars.courseList).toContain(COURSES[0].id);
    expect(call.vars.courseList).toContain("Machine Learning");
  });

  it("passes a courseId through when it names a provided course", async () => {
    const { options: opts } = options(PARSE);
    const result = await parseQuickAdd(opts);
    if (result.status !== "success") throw new Error("expected success");
    expect(result.value.courseId).toBe(COURSES[0].id);
  });
});

describe("parseQuickAdd — the deterministic guards", () => {
  it("nulls a courseId that is not in the provided list — a hallucinated id must not reach the card", async () => {
    // Real-shaped but foreign: right format, wrong universe. Pre-selecting it on the
    // confirm card would either 404 the select or, worse, file the entry under whatever
    // course happens to share the id.
    const { options: opts } = options({
      ...PARSE,
      courseId: "99999999-9999-4999-8999-999999999999",
    });
    const result = await parseQuickAdd(opts);
    if (result.status !== "success") throw new Error("expected success");
    expect(result.value.courseId).toBeNull();
  });

  it("nulls durationMinutes on an all-day parse — the form's own invariant, enforced before it renders", async () => {
    // `quickAddSchema` rejects time=null + duration set ("An all-day entry has no
    // duration"), so a card pre-filled that way would fail on submit with an error the
    // student never caused.
    const { options: opts } = options({ ...PARSE, time: null, durationMinutes: 90 });
    const result = await parseQuickAdd(opts);
    if (result.status !== "success") throw new Error("expected success");
    expect(result.value.durationMinutes).toBeNull();
  });
});

describe("renderQuickAddCourses", () => {
  it("renders one id — title line per course", () => {
    const rendered = renderQuickAddCourses(COURSES);
    expect(rendered).toBe(
      `- ${COURSES[0].id} — Machine Learning\n- ${COURSES[1].id} — Econometrics`,
    );
  });

  it("says so in words when there are no courses", () => {
    expect(renderQuickAddCourses([])).toBe("(no courses yet)");
  });
});
