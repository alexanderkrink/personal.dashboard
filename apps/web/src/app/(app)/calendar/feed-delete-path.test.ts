import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `deleteFeed`'s collision with the participation ledger's NO ACTION FKs
 * (20260720222423).
 *
 * Deleting a feed cascades feeds → items → occurrences, and the ledger's
 * composite FKs refuse to let an occurrence carrying attendance or
 * participation rows vanish with it — the whole delete rolls back as 23503.
 * That refusal is the schema working as designed (graded history must not die
 * as a side effect), but the action used to answer it with "Try again —
 * nothing you typed was lost", which is a lie twice over: no retry can ever
 * succeed, and the user is left with an undeletable feed and no explanation.
 *
 * Pinned here (red against the pre-fix action, which returned the generic
 * SAVE_FAILED for every error):
 *  1. 23503 gets its own honest, terminal message naming the logged history.
 *  2. Every other error keeps the generic retryable message.
 */

const state = vi.hoisted(() => ({
  deleteError: null as { code: string; message: string } | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/require-user", () => ({ requireUserId: async () => "user-1" }));
vi.mock("@/env", () => ({ env: {} }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const builder = {
        delete: () => builder,
        eq: () => builder,
        select: () => builder,
        maybeSingle: async () =>
          state.deleteError
            ? { data: null, error: state.deleteError }
            : { data: { id: "feed-1" }, error: null },
      };
      return builder;
    },
  }),
}));

const { updateFeed } = await import("./actions");

const FEED_ID = "3f8a2b1c-4d5e-4f6a-8b9c-0d1e2f3a4b5c";
const IDLE = { status: "idle" } as const;

function deleteForm(): FormData {
  const data = new FormData();
  data.append("feedId", FEED_ID);
  data.append("intent", "delete");
  data.append("label", "IE timetable");
  return data;
}

beforeEach(() => {
  state.deleteError = null;
});

describe("deleteFeed — the ledger's NO ACTION refusal", () => {
  it("23503 names the protected history instead of promising a retry", async () => {
    state.deleteError = {
      code: "23503",
      message:
        'update or delete on table "calendar_occurrences" violates foreign key constraint "attendance_records_occurrence_id_fkey"',
    };

    const result = await updateFeed(IDLE, deleteForm());

    expect(result.status).toBe("error");
    // The message must say WHY (logged attendance/participation) and must not
    // suggest retrying — a retry is guaranteed to hit the same constraint.
    expect(result.message).toMatch(/attendance|participation/i);
    expect(result.message).not.toMatch(/try again/i);
  });

  it("any other error keeps the generic retryable message", async () => {
    state.deleteError = { code: "57014", message: "canceling statement due to statement timeout" };

    const result = await updateFeed(IDLE, deleteForm());

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/try again/i);
  });

  it("a clean delete still reports the feed and its synced rows gone", async () => {
    const result = await updateFeed(IDLE, deleteForm());
    expect(result.status).toBe("info");
    expect(result.message).toMatch(/removed/i);
  });
});
