import type { GuardDecision } from "@study/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Regenerate Server Action's guards, at the point a guard-less variant gives way.
 *
 * Two properties §9 hangs money on:
 *  - **Ownership.** Only the course's owner may enqueue its ~$0.50–1.50 Opus run; an unknown
 *    course sends nothing.
 *  - **Clamp / DEFER pre-check.** If `AI_MAX_TIER` clamped exam-review off Opus, or the §6 guard
 *    is deferring, the action returns `deferred` and sends NOTHING — it must never quietly
 *    enqueue a run that would silently produce a non-Opus review or hang.
 *
 * Each is red against precisely the variant that drops it.
 */

const COURSE_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => ({
  course: { id: "course" } as { id: string } | null,
  rank: "deep" as "fast" | "balanced" | "deep",
  guard: { allowed: true } as GuardDecision,
  throwUnconfigured: false,
  sends: [] as { name: string; data: Record<string, unknown> }[],
}));

vi.mock("@/lib/auth/require-user", () => ({ requireUserId: async () => "user-1" }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/inngest/client", () => ({
  inngest: {
    send: async (event: { name: string; data: Record<string, unknown> }) => {
      state.sends.push(event);
    },
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: state.course, error: null }) }),
      }),
    }),
  }),
}));
vi.mock("@/lib/ai/runtime", () => {
  class AINotConfiguredError extends Error {}
  return {
    AINotConfiguredError,
    createStudyAIRuntime: () => {
      if (state.throwUnconfigured) throw new AINotConfiguredError("no keys");
      return {
        resolve: () => ({ rank: state.rank }),
        guardCheck: async () => state.guard,
      };
    },
  };
});

import { requestExamReview } from "@/app/(app)/courses/[id]/reviews/actions";

beforeEach(() => {
  state.course = { id: "course" };
  state.rank = "deep";
  state.guard = { allowed: true };
  state.throwUnconfigured = false;
  state.sends = [];
});

describe("requestExamReview", () => {
  it("sends the event with the requestId when ownership and the gate pass", async () => {
    const result = await requestExamReview({ courseId: COURSE_ID, requestId: REQUEST_ID });
    expect(result).toEqual({ ok: true });
    expect(state.sends).toHaveLength(1);
    expect(state.sends[0]).toEqual({
      name: "course/review.requested",
      data: { courseId: COURSE_ID, requestId: REQUEST_ID },
    });
  });

  // RED against dropping the ownership check: an unknown course would otherwise enqueue a run.
  it("refuses and sends NOTHING for a course the caller does not own", async () => {
    state.course = null;
    const result = await requestExamReview({ courseId: COURSE_ID, requestId: REQUEST_ID });
    expect(result).toMatchObject({ ok: false });
    expect(state.sends).toHaveLength(0);
  });

  // RED against dropping the clamp check: a clamped runtime would otherwise enqueue a run that
  // silently produces a non-Opus review.
  it("DEFERS and sends nothing when AI_MAX_TIER has clamped exam-review off Opus", async () => {
    state.rank = "fast";
    const result = await requestExamReview({ courseId: COURSE_ID, requestId: REQUEST_ID });
    expect(result).toMatchObject({ ok: false, deferred: true });
    expect(state.sends).toHaveLength(0);
  });

  // RED against dropping the budget guard: a deferred budget would otherwise enqueue a run.
  it("DEFERS and sends nothing when the §6 budget guard denies", async () => {
    state.guard = { allowed: false, reason: "budget-defer-deep" };
    const result = await requestExamReview({ courseId: COURSE_ID, requestId: REQUEST_ID });
    expect(result).toMatchObject({ ok: false, deferred: true });
    expect(state.sends).toHaveLength(0);
  });

  it("still sends when the runtime is merely unconfigured (the function gates authoritatively)", async () => {
    state.throwUnconfigured = true;
    const result = await requestExamReview({ courseId: COURSE_ID, requestId: REQUEST_ID });
    expect(result).toEqual({ ok: true });
    expect(state.sends).toHaveLength(1);
  });

  it("rejects a malformed input without sending", async () => {
    const result = await requestExamReview({ courseId: "not-a-uuid", requestId: REQUEST_ID });
    expect(result).toMatchObject({ ok: false });
    expect(state.sends).toHaveLength(0);
  });
});
