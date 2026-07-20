// @vitest-environment node
//
// Node, not the jsdom default: this module's import graph reaches `@/env` through the
// Inngest client, and t3-env refuses to hand a server variable to anything with a `window`
// on it. The two functions under test need none of it.

import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * §9's staleness rule, pinned.
 *
 * The rule is small enough to look obviously right and has one branch that is easy to get
 * backwards — a *new* topic must not make an existing review stale — so every branch is
 * asserted. Getting that one wrong marks every review stale on the next upload forever,
 * which turns the badge into noise and, worse, invites the user to spend $1.50 on Opus
 * regenerating something that had not changed.
 */

const BASE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ACCESS_CODE: "test_access_code",
  CRON_SECRET: "test_cron_secret_long_enough",
  INNGEST_SIGNING_KEY: `signkey-test-${"a".repeat(64)}`,
  // Required since Wave 6 (fail-closed at build); tests satisfy them with fakes.
  VOYAGE_API_KEY: "pa-test",
  CLOUDCONVERT_API_KEY: "cc-test",
};

let isReviewStale: typeof import("./mark-reviews-stale").isReviewStale;
let readSnapshot: typeof import("./mark-reviews-stale").readSnapshot;

beforeAll(async () => {
  for (const [key, value] of Object.entries(BASE_ENV)) vi.stubEnv(key, value);
  ({ isReviewStale, readSnapshot } = await import("./mark-reviews-stale"));
});

const current = (pairs: Record<string, number>): Map<string, number> =>
  new Map(Object.entries(pairs));

describe("readSnapshot", () => {
  it("reads the camelCase shape", () => {
    expect(readSnapshot([{ topicId: "t1", revision: 3 }])).toEqual([
      { topicId: "t1", revision: 3 },
    ]);
  });

  it("also reads the snake_case shape, since Wave 5 writes this column", () => {
    expect(readSnapshot([{ topic_id: "t1", revision: 3 }])).toEqual([
      { topicId: "t1", revision: 3 },
    ]);
  });

  it("reads an empty snapshot as an empty list rather than as unreadable", () => {
    expect(readSnapshot([])).toEqual([]);
  });

  it("returns null for anything it cannot trust", () => {
    expect(readSnapshot(null)).toBeNull();
    expect(readSnapshot("nonsense")).toBeNull();
    expect(readSnapshot({ topicId: "t1", revision: 1 })).toBeNull();
    expect(readSnapshot([{ topicId: "t1" }])).toBeNull();
    expect(readSnapshot([{ revision: 1 }])).toBeNull();
    expect(readSnapshot([{ topicId: 7, revision: 1 }])).toBeNull();
    expect(readSnapshot([{ topicId: "t1", revision: "3" }])).toBeNull();
    expect(readSnapshot([null])).toBeNull();
  });
});

describe("isReviewStale", () => {
  it("is fresh when every topic is still at the revision it was built from", () => {
    const snapshot = [
      { topicId: "t1", revision: 3 },
      { topicId: "t2", revision: 1 },
    ];
    expect(isReviewStale(snapshot, current({ t1: 3, t2: 1 }))).toBe(false);
  });

  it("is stale when a topic it was built from moved forward", () => {
    const snapshot = [{ topicId: "t1", revision: 3 }];
    expect(isReviewStale(snapshot, current({ t1: 4 }))).toBe(true);
  });

  it("is stale when a topic it was built from no longer exists", () => {
    const snapshot = [{ topicId: "t1", revision: 3 }];
    expect(isReviewStale(snapshot, current({ t2: 1 }))).toBe(true);
  });

  it("is stale when the snapshot cannot be read — it cannot be PROVEN fresh", () => {
    // The safe direction: a wrong `stale` costs one avoidable click, a wrong `fresh` costs a
    // student revising from notes that no longer match their course.
    expect(isReviewStale(null, current({ t1: 1 }))).toBe(true);
  });

  it("is NOT stale merely because the course gained a topic it never covered", () => {
    // The branch that is easy to get backwards. A review has not decayed because the course
    // grew; treating growth as decay marks every review stale on every upload.
    const snapshot = [{ topicId: "t1", revision: 2 }];
    expect(isReviewStale(snapshot, current({ t1: 2, t2: 1, t3: 1 }))).toBe(false);
  });

  it("is not stale when a revision somehow went backwards", () => {
    // Impossible via the pipeline, but a revert could do it. Only a FORWARD move means the
    // notes the review was built from were edited past it.
    const snapshot = [{ topicId: "t1", revision: 5 }];
    expect(isReviewStale(snapshot, current({ t1: 4 }))).toBe(false);
  });

  it("is fresh for an empty snapshot against a course with topics", () => {
    // A review built from nothing has nothing that can have changed.
    expect(isReviewStale([], current({ t1: 9 }))).toBe(false);
  });

  it("is stale if ANY one topic of several moved", () => {
    const snapshot = [
      { topicId: "t1", revision: 1 },
      { topicId: "t2", revision: 1 },
      { topicId: "t3", revision: 1 },
    ];
    expect(isReviewStale(snapshot, current({ t1: 1, t2: 1, t3: 2 }))).toBe(true);
  });
});
