import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The exam write path's contract with `calendar_items_one_exam_per_course`.
 *
 * The invariant itself is the database's job now (migration 20260718235227) and
 * the plan is `planExamDecision`'s. What is left for `setExamDate` — and what is
 * tested here — is the two things that sit between them:
 *
 * 1. **Clears are applied before sets.** A partial unique index cannot be
 *    deferred, so a legitimate "move the exam" that flags the new session before
 *    clearing the old one is rejected by Postgres. The browser click-through
 *    exercises the happy move; this pins the statement ORDER that makes it work,
 *    which a screenshot cannot show.
 * 2. **A unique violation becomes a sentence.** When another writer takes the
 *    slot between our read and our write, the user must get an explanation and a
 *    next step — not a 500, and not the generic "that didn't save", which would
 *    invite them to retry into the same wall without reloading.
 *
 * Both are deterministic here and neither is reproducible on demand in a
 * browser: the race needs an interleave that clears-first makes rare by design.
 */

const state = vi.hoisted(() => ({
  /** Rows the action's read returns. */
  items: [] as {
    id: string;
    is_exam_candidate: boolean;
    detection_source: string | null;
    user_locked_fields: string[];
  }[],
  /** Every update the action issued, in order. */
  updates: [] as { id: string; is_exam_candidate: boolean }[],
  /** Ids whose UPDATE should fail with a unique violation. */
  failWith23505: new Set<string>(),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/require-user", () => ({ requireUserId: async () => "user-1" }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      // Set once `.update()` has been called, which is what tells the shared
      // `.eq()` whether it is terminating a read chain or a write.
      //
      // The real client returns a thenable builder from every call, but a mock
      // with a `then` property is a footgun (and Biome rightly rejects one), so
      // the write path returns a genuine Promise instead. Same observable
      // behaviour for the two shapes this action actually uses.
      let pendingUpdate: { is_exam_candidate: boolean } | null = null;

      const builder = {
        // --- read: resolve the item's course, then the course's items ---
        select: () => builder,
        maybeSingle: async () => ({ data: { course_id: "course-1" }, error: null }),

        // --- write ---
        update: (columns: { is_exam_candidate: boolean }) => {
          pendingUpdate = columns;
          return builder;
        },

        eq: (column: string, value: string) => {
          if (pendingUpdate !== null) {
            // `.update(...).eq("id", id)` — awaited directly by the action.
            const columns = pendingUpdate;
            pendingUpdate = null;
            state.updates.push({ id: value, is_exam_candidate: columns.is_exam_candidate });
            return Promise.resolve({
              error: state.failWith23505.has(value) ? { code: "23505" } : null,
            });
          }
          if (column === "id") {
            // `.select("course_id").eq("id", …)` — followed by `.maybeSingle()`.
            return builder;
          }
          // `.eq("course_id", …)` — the course's full item list.
          return Promise.resolve({ data: state.items, error: null });
        },
      };
      return builder;
    },
  }),
}));

const { setExamDate } = await import("./item-actions");

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

/** Real UUIDs: `examDecisionSchema` validates `itemId` with `z.uuid()`. */
const NEW_ID = "11111111-1111-4111-8111-111111111111";
const OLD_ID = "22222222-2222-4222-8222-222222222222";

const IDLE = { status: "idle" } as const;

beforeEach(() => {
  state.updates = [];
  state.failWith23505 = new Set();
  // The live shape: one detector-flagged session, plus the one being moved to.
  state.items = [
    { id: NEW_ID, is_exam_candidate: false, detection_source: null, user_locked_fields: [] },
    {
      id: OLD_ID,
      is_exam_candidate: true,
      detection_source: "syllabus_total_sessions",
      user_locked_fields: [],
    },
  ];
});

describe("setExamDate against the one-exam-per-course index", () => {
  it("clears the old candidate BEFORE flagging the new one", async () => {
    const result = await setExamDate(IDLE, form({ intent: "set", itemId: NEW_ID }));

    expect(result.status).toBe("success");
    // The order is the whole point: a set landing first would momentarily give
    // the course two candidates and Postgres would reject it.
    expect(state.updates).toEqual([
      { id: OLD_ID, is_exam_candidate: false },
      { id: NEW_ID, is_exam_candidate: true },
    ]);
  });

  it("turns a unique violation into an explanation and a next step", async () => {
    state.failWith23505.add(NEW_ID);

    const result = await setExamDate(IDLE, form({ intent: "set", itemId: NEW_ID }));

    expect(result.status).toBe("error");
    // Names the cause, and tells them the page is stale — retrying without a
    // reload would just hit the same row again.
    expect(result.message).toMatch(/another change set this course’s exam date first/i);
    expect(result.message).toMatch(/reload/i);
  });

  it("does not disguise an ordinary failure as a race", async () => {
    state.items = [
      { id: OLD_ID, is_exam_candidate: true, detection_source: "manual", user_locked_fields: [] },
    ];
    const result = await setExamDate(IDLE, form({ intent: "reject", itemId: OLD_ID }));

    expect(result.status).toBe("success");
    expect(state.updates).toEqual([{ id: OLD_ID, is_exam_candidate: false }]);
  });
});
