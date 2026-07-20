import { AIPausedError } from "@study/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The §2b confirm gate on natural-language quick-add — the property PLAN §6 calls one of
 * the two deliberately-reserved hard gates: **a parse only ever proposes**. A deadline is
 * date-critical data, so nothing reaches `calendar_items` or `calendar_occurrences` until
 * a human submits the confirm card, which is a different Server Action taking a different
 * input (the card's own FormData, which only a human submit produces).
 *
 * The first test is the gate itself, exercised at the exact point a gate-less
 * implementation gives way: a HIGH-confidence parse — the one an "it's sure, skip the
 * card" shortcut would write. It was run red against precisely that variant (an auto-add
 * on `confidence >= 0.9` inside this action) before the variant was removed; the recorded
 * failure is two writes, `calendar_items` then `calendar_occurrences`.
 *
 * The second is §6 step 3's degrade rule, red against a variant that returned the parse
 * regardless of confidence: below 0.6 the student gets the SAME card, EMPTY — a parse the
 * app does not trust must not leak plausible-looking fields onto it either.
 */

const COURSE_ID = "11111111-1111-4111-8111-111111111111";

type FakeParse = {
  title: string;
  kind: string;
  date: string | null;
  time: string | null;
  durationMinutes: number | null;
  courseId: string | null;
  weightPercent: number | null;
  confidence: number;
  ambiguity: string | null;
};

const state = vi.hoisted(() => ({
  /** Every write-shaped call the action issued, in order. The gate says: none, ever. */
  writes: [] as { table: string; method: string }[],
  /** What the fake runtime returns — or "paused" to throw the real AIPausedError. */
  behavior: "success" as "success" | "paused",
  parse: null as FakeParse | null,
}));

vi.mock("@/lib/auth/require-user", () => ({ requireUserId: async () => "user-1" }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const record = (method: string) => state.writes.push({ table, method });
      const builder = {
        // --- reads: profiles.timezone, then the course list ---
        select: () => builder,
        eq: () => builder,
        order: () =>
          Promise.resolve({
            data: [{ id: COURSE_ID, title: "Machine Learning" }],
            error: null,
          }),
        maybeSingle: async () =>
          table === "profiles"
            ? { data: { timezone: "Europe/Madrid" }, error: null }
            : { data: { id: "written-row" }, error: null },
        // --- writes: recorded, and successful-looking, so a gate-less variant
        // sails through to the second write rather than erroring out early ---
        insert: () => {
          record("insert");
          return builder;
        },
        upsert: () => {
          record("upsert");
          return builder;
        },
        update: () => {
          record("update");
          return builder;
        },
        delete: () => {
          record("delete");
          return builder;
        },
      };
      return builder;
    },
    rpc: (name: string) => {
      state.writes.push({ table: `rpc:${name}`, method: "rpc" });
      return Promise.resolve({ data: null, error: null });
    },
  }),
}));

vi.mock("@/lib/ai/runtime", () => {
  class AINotConfiguredError extends Error {}
  return {
    AINotConfiguredError,
    createStudyAIRuntime: () => ({
      generateStructured: async () => {
        if (state.behavior === "paused") throw new AIPausedError("kill-switch");
        return {
          status: "success",
          value: state.parse,
          stamp: {
            promptId: "quick-add",
            promptVersion: 2,
            job: "quick-add",
            provider: "google",
            model: "gemini-3.1-flash-lite",
            inputHash: "deadbeef",
          },
        };
      },
    }),
  };
});

const { parseQuickAddUtterance } = await import("./quick-add-parse");

function form(utterance: string): FormData {
  const data = new FormData();
  data.append("utterance", utterance);
  return data;
}

const IDLE = { status: "idle" } as const;

const CONFIDENT: FakeParse = {
  title: "ML assignment 3",
  kind: "deadline",
  date: "2026-07-24",
  time: "23:59",
  durationMinutes: null,
  courseId: COURSE_ID,
  weightPercent: 15,
  confidence: 0.97,
  ambiguity: null,
};

beforeEach(() => {
  state.writes = [];
  state.behavior = "success";
  state.parse = CONFIDENT;
});

describe("the confirm gate — a parse only ever proposes", () => {
  it("writes NOTHING on a high-confidence parse; the calendar is the confirm card's to touch", async () => {
    const result = await parseQuickAddUtterance(
      IDLE,
      form("ML assignment 3 due next friday 23:59, worth 15%"),
    );

    expect(result.status).toBe("parsed");
    if (result.status !== "parsed") throw new Error("unreachable");
    expect(result.values).toEqual({
      title: "ML assignment 3",
      kind: "deadline",
      date: "2026-07-24",
      time: "23:59",
      durationMinutes: "",
      courseId: COURSE_ID,
      weightPercent: "15",
    });
    // The gate. Confidence 0.97 is exactly the parse an auto-add shortcut would
    // write, and the recording client would have let it succeed — so an empty list
    // here means the action *cannot* write, not that the write failed.
    expect(state.writes).toEqual([]);
  });

  it("degrades a low-confidence parse to the empty form — no values leak onto the card", async () => {
    state.parse = { ...CONFIDENT, confidence: 0.4 };

    const result = await parseQuickAddUtterance(IDLE, form("mumble something due whenever"));

    // §6 step 3: same card, empty. The `fallback` shape cannot carry values at all.
    expect(result.status).toBe("fallback");
    expect(state.writes).toEqual([]);
  });
});

describe("date discipline reaches the card intact", () => {
  it("leaves an unresolvable date blank and shows the model's own note", async () => {
    state.parse = {
      ...CONFIDENT,
      date: null,
      time: null,
      ambiguity: "No date given — “soon” doesn’t name a day.",
    };

    const result = await parseQuickAddUtterance(IDLE, form("hand in the essay soon"));

    expect(result.status).toBe("parsed");
    if (result.status !== "parsed") throw new Error("unreachable");
    expect(result.values.date).toBe("");
    expect(result.note).toMatch(/no date given/i);
    expect(state.writes).toEqual([]);
  });
});

describe("unavailability degrades to the form", () => {
  it("answers a paused runtime with the fallback card, not an error page", async () => {
    state.behavior = "paused";

    const result = await parseQuickAddUtterance(IDLE, form("essay due friday"));

    expect(result.status).toBe("fallback");
    if (result.status !== "fallback") throw new Error("unreachable");
    expect(result.message).toMatch(/form below/i);
    expect(state.writes).toEqual([]);
  });
});
