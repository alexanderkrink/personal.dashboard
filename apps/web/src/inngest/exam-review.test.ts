// @vitest-environment node
//
// Node, not the jsdom default: the staleness contract below pulls in
// `@/inngest/functions/mark-reviews-stale`, whose import graph reaches `@/env` through the
// Inngest client, and t3-env refuses to hand a server variable to anything with a `window`.

import { EMPTY_TOPIC_PAGE, type StoredTopicPage } from "@study/ai";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildReviewSnapshot,
  type ReviewTopic,
  renderExamFormat,
  renderTopicIndex,
} from "@/inngest/exam-review";

/**
 * The contract that matters most (per the plan): the `topic_snapshot` the review WRITER emits
 * must be a shape `mark-reviews-stale.readSnapshot` accepts, and a snapshot at the current
 * revisions must make `isReviewStale` return `false`. A drift here would mark every review
 * this function writes permanently stale — so the generator and the staleness consumer are
 * pinned together here, against the real `readSnapshot`, so they cannot part ways silently.
 */

const BASE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ACCESS_CODE: "test_access_code",
  CRON_SECRET: "test_cron_secret_long_enough",
  INNGEST_SIGNING_KEY: `signkey-test-${"a".repeat(64)}`,
  VOYAGE_API_KEY: "pa-test",
  CLOUDCONVERT_API_KEY: "cc-test",
};

let isReviewStale: typeof import("./functions/mark-reviews-stale").isReviewStale;
let readSnapshot: typeof import("./functions/mark-reviews-stale").readSnapshot;

beforeAll(async () => {
  for (const [key, value] of Object.entries(BASE_ENV)) vi.stubEnv(key, value);
  ({ isReviewStale, readSnapshot } = await import("./functions/mark-reviews-stale"));
});

const TOPICS = [
  { id: "11111111-1111-1111-1111-111111111111", revision: 3 },
  { id: "22222222-2222-2222-2222-222222222222", revision: 1 },
];

/** The jsonb column serializes on the way in and out, so every check goes through JSON. */
const roundTrip = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));

describe("buildReviewSnapshot ↔ readSnapshot / isReviewStale (the staleness contract)", () => {
  it("emits a snapshot readSnapshot can parse", () => {
    const parsed = readSnapshot(roundTrip(buildReviewSnapshot(TOPICS)));
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual([
      { topicId: "11111111-1111-1111-1111-111111111111", revision: 3 },
      { topicId: "22222222-2222-2222-2222-222222222222", revision: 1 },
    ]);
  });

  it("is NOT stale at the revisions it was built from", () => {
    const snapshot = readSnapshot(roundTrip(buildReviewSnapshot(TOPICS)));
    const current = new Map(TOPICS.map((topic) => [topic.id, topic.revision]));
    expect(isReviewStale(snapshot, current)).toBe(false);
  });

  it("becomes stale when a covered topic's revision moves forward", () => {
    const snapshot = readSnapshot(roundTrip(buildReviewSnapshot(TOPICS)));
    const current = new Map([
      ["11111111-1111-1111-1111-111111111111", 4], // moved 3 → 4
      ["22222222-2222-2222-2222-222222222222", 1],
    ]);
    expect(isReviewStale(snapshot, current)).toBe(true);
  });

  it("becomes stale when a covered topic disappears", () => {
    const snapshot = readSnapshot(roundTrip(buildReviewSnapshot(TOPICS)));
    const current = new Map([["11111111-1111-1111-1111-111111111111", 3]]);
    expect(isReviewStale(snapshot, current)).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* The prompt surface                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

function topic(overrides: Partial<ReviewTopic>): ReviewTopic {
  const page: StoredTopicPage = { ...EMPTY_TOPIC_PAGE, ...(overrides.page ?? {}) };
  return {
    id: "topic-a",
    title: "A Topic",
    summary: "A summary.",
    effectiveWeight: 0.5,
    ...overrides,
    page,
  };
}

describe("renderTopicIndex", () => {
  it("states each topic's id and exam weight so the prompt can prioritise and link", () => {
    const index = renderTopicIndex([
      topic({ id: "topic-high", title: "Regression", effectiveWeight: 0.82 }),
    ]);
    expect(index).toContain("[topic-id: topic-high]");
    expect(index).toContain("0.82");
    expect(index).toContain("HIGH");
  });

  it("digests the page's formulas and open questions into the index", () => {
    const index = renderTopicIndex([
      topic({
        page: {
          ...EMPTY_TOPIC_PAGE,
          formulas: [
            {
              name: "OLS",
              latex: "\\beta = (X^TX)^{-1}X^Ty",
              explanation: "The least-squares coefficient vector.",
              sources: [],
            },
          ],
          openQuestions: [
            {
              question: "Which definition of residual applies?",
              context: "Session 3 vs Session 9 disagree.",
              kind: "conflict",
              sources: [],
            },
          ],
        },
      }),
    ]);
    expect(index).toContain("OLS");
    expect(index).toContain("[conflict]");
  });

  it("renders an empty course honestly rather than blank", () => {
    expect(renderTopicIndex([])).toContain("no topics");
  });
});

describe("renderExamFormat", () => {
  it("gives a null profile an honest default", () => {
    expect(renderExamFormat(null)).toContain("No exam-format profile");
  });

  it("flattens an object profile into readable lines", () => {
    expect(renderExamFormat({ duration: "3 hours", style: "open book" })).toContain(
      "duration: 3 hours",
    );
  });
});
