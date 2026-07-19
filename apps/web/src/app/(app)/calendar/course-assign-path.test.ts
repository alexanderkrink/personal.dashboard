import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `setItemCourse`'s contract with `user_locked_fields`.
 *
 * The write itself is one UPDATE and needs no test. What needs one is the lock
 * decision, because it is **the opposite of the neighbouring action's** and the
 * two look like they should match:
 *
 * - `setWeightOverride` REMOVES its lock on clear, because clearing a weight
 *   means "go back to the derived value".
 * - `setItemCourse` ADDS its lock on clear, because un-assigning means "this
 *   belongs to no course" — and sync's matcher is additive, so an unlocked row
 *   whose hint still matches is re-filed on the very next run. Without the lock,
 *   un-assign would visibly work and then silently undo itself.
 *
 * That difference is invisible in a browser: both produce an empty course line,
 * and the divergence only appears an hour later when a sync runs. So it is pinned
 * here.
 *
 * Also pinned: `reset` is the only intent that unlocks, which is what keeps
 * un-assign from being a one-way door.
 */

const state = vi.hoisted(() => ({
  /** `user_locked_fields` the action's read returns. */
  locks: [] as string[],
  /** Every update the action issued. */
  updates: [] as { course_id: string | null; user_locked_fields: string[] }[],
  /** Set to make the UPDATE fail with a unique violation. */
  fail23505: false,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/require-user", () => ({ requireUserId: async () => "user-1" }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      let pendingUpdate: { course_id: string | null; user_locked_fields: string[] } | null = null;

      const builder = {
        select: () => builder,
        maybeSingle: async () =>
          table === "courses"
            ? { data: { title: "ALGORITHMS & DATA STRUCTURES" }, error: null }
            : { data: { id: "item-1", user_locked_fields: state.locks }, error: null },

        update: (columns: { course_id: string | null; user_locked_fields: string[] }) => {
          pendingUpdate = columns;
          return builder;
        },

        eq: () => {
          if (pendingUpdate === null) return builder;
          if (state.fail23505) return Promise.resolve({ error: { code: "23505" } });
          state.updates.push(pendingUpdate);
          return Promise.resolve({ error: null });
        },
      };
      return builder;
    },
  }),
}));

const { setItemCourse } = await import("./item-actions");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const IDLE = { status: "idle" } as const;
const COURSE = "6f1b0d3c-6f3e-4c5a-9d2b-1a2b3c4d5e6f";
const ITEM = "0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";

beforeEach(() => {
  state.locks = [];
  state.updates = [];
  state.fail23505 = false;
});

describe("setItemCourse — lock semantics", () => {
  it("locks course_id when filing under a course, so the next sync cannot re-derive it", async () => {
    const result = await setItemCourse(
      IDLE,
      form({ intent: "set", itemId: ITEM, courseId: COURSE }),
    );

    expect(result.status).toBe("success");
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]?.course_id).toBe(COURSE);
    expect(state.updates[0]?.user_locked_fields).toContain("course_id");
  });

  it("ALSO locks when un-assigning — otherwise the matcher re-files it next sync", async () => {
    // The one that would be wrong if this action copied `setWeightOverride`.
    const result = await setItemCourse(IDLE, form({ intent: "clear", itemId: ITEM }));

    expect(result.status).toBe("success");
    expect(state.updates[0]?.course_id).toBeNull();
    expect(state.updates[0]?.user_locked_fields).toContain("course_id");
  });

  it("unlocks ONLY on reset, handing the decision back to sync", async () => {
    state.locks = ["course_id", "title"];
    const result = await setItemCourse(IDLE, form({ intent: "reset", itemId: ITEM }));

    expect(result.status).toBe("success");
    expect(state.updates[0]?.course_id).toBeNull();
    expect(state.updates[0]?.user_locked_fields).not.toContain("course_id");
    // Every OTHER lock survives. A course decision is not a licence to drop the
    // user's title edit.
    expect(state.updates[0]?.user_locked_fields).toContain("title");
  });

  it("does not duplicate a lock that is already there", async () => {
    state.locks = ["course_id"];
    await setItemCourse(IDLE, form({ intent: "set", itemId: ITEM, courseId: COURSE }));

    expect(state.updates[0]?.user_locked_fields).toEqual(["course_id"]);
  });

  it("explains a one-exam-per-course collision instead of saying “that didn’t save”", async () => {
    // Moving a row that is its course's exam candidate into a course that already
    // has one. The generic message would invite retrying into a wall.
    state.fail23505 = true;
    const result = await setItemCourse(
      IDLE,
      form({ intent: "set", itemId: ITEM, courseId: COURSE }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/already has an exam date/i);
  });

  it("rejects a set with no course rather than treating it as an un-assign", async () => {
    const result = await setItemCourse(IDLE, form({ intent: "set", itemId: ITEM }));

    expect(result.status).toBe("error");
    expect(state.updates).toHaveLength(0);
  });
});
