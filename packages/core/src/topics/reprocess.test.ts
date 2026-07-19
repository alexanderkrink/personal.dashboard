import { describe, expect, it } from "vitest";
import { type MergeTargetLike, type PriorContribution, planMergeWork } from "./reprocess";

/**
 * The convergence rules, pinned as a table.
 *
 * This is the deterministic half of the fix for PLAN §5's missing strip: the guarantee that a
 * second pass over an already-merged document does not append a second revision, does not
 * bump `topics.revision` again, and does not pay for a merge + critic it has already paid
 * for. Every row here corresponds to a real prefix of Step C's three un-transactional writes,
 * so "which crash left this state?" is answerable for each one.
 */

const target = (over: Partial<MergeTargetLike> = {}): MergeTargetLike => ({
  topicId: "topic-a",
  topicKey: "topic-a",
  title: "Neural Networks",
  currentRevision: 1,
  ...over,
});

const prior = (over: Partial<PriorContribution> = {}): PriorContribution => ({
  topicId: "topic-a",
  snapshotRevision: null,
  hasProvenance: false,
  ...over,
});

describe("planMergeWork — the first run", () => {
  it("owes every target when the document has contributed nothing", () => {
    const targets = [target(), target({ topicId: "topic-b", topicKey: "topic-b" })];
    const plan = planMergeWork({ targets, priorContributions: [] });

    expect(plan.toMerge).toHaveLength(2);
    expect(plan.skipped).toEqual([]);
  });

  it("always owes a create — a topic that does not exist cannot have been merged into", () => {
    const plan = planMergeWork({
      targets: [target({ topicId: null, topicKey: "proposal:0", currentRevision: 0 })],
      priorContributions: [prior({ topicId: "topic-a", hasProvenance: true })],
    });

    expect(plan.toMerge).toHaveLength(1);
    expect(plan.skipped).toEqual([]);
  });

  it("owes a target whose prior contribution is to a different topic", () => {
    const plan = planMergeWork({
      targets: [target()],
      priorContributions: [prior({ topicId: "topic-z", snapshotRevision: 3, hasProvenance: true })],
    });

    expect(plan.toMerge).toHaveLength(1);
  });
});

describe("planMergeWork — the second run", () => {
  /**
   * The headline case, and the exact mechanism the branch review found: `currentRevision` is
   * read fresh, so on the second pass it is already the value the FIRST pass bumped it to.
   * Before this function existed, that made the `unique (topic_id, revision)` guard
   * unreachable and every re-run appended another revision.
   */
  it("skips a topic whose page update already landed", () => {
    const plan = planMergeWork({
      targets: [target({ currentRevision: 4 })],
      priorContributions: [prior({ snapshotRevision: 3, hasProvenance: true })],
    });

    expect(plan.toMerge).toEqual([]);
    expect(plan.skipped).toEqual([
      {
        topicId: "topic-a",
        topicKey: "topic-a",
        title: "Neural Networks",
        mergedAtRevision: 4,
        provenanceMissing: false,
      },
    ]);
  });

  it("skips a topic this document CREATED — the create path writes no snapshot at all", () => {
    const plan = planMergeWork({
      targets: [target({ currentRevision: 1 })],
      priorContributions: [prior({ snapshotRevision: null, hasProvenance: true })],
    });

    expect(plan.toMerge).toEqual([]);
    expect(plan.skipped[0]?.mergedAtRevision).toBe(1);
    expect(plan.skipped[0]?.provenanceMissing).toBe(false);
  });

  it("stays skipped after other documents have moved the topic on", () => {
    // Upload A (partial) → upload B (bumps the same topic twice) → "Retry the rest" on A.
    // A's contribution is still in the page; re-merging it would double-count it.
    const plan = planMergeWork({
      targets: [target({ currentRevision: 9 })],
      priorContributions: [prior({ snapshotRevision: 3, hasProvenance: true })],
    });

    expect(plan.toMerge).toEqual([]);
    expect(plan.skipped[0]?.mergedAtRevision).toBe(4);
  });

  it("is a fixed point — planning over its own output changes nothing", () => {
    const targets = [target({ currentRevision: 4 })];
    const priors = [prior({ snapshotRevision: 3, hasProvenance: true })];

    const first = planMergeWork({ targets, priorContributions: priors });
    const second = planMergeWork({ targets, priorContributions: priors });

    expect(second).toEqual(first);
    expect(second.toMerge).toEqual([]);
  });
});

describe("planMergeWork — the un-transactional prefixes of Step C", () => {
  /**
   * Step C writes snapshot → page → provenance with no transaction around them, so two crash
   * windows exist. They pull in opposite directions, which is why one witness is not enough.
   */

  it("re-merges when the snapshot landed but the page update did not", () => {
    // Crash between write 1 and write 2. The topic still holds the pre-merge page, so the
    // merge is genuinely unfinished and skipping it would silently lose content.
    const plan = planMergeWork({
      targets: [target({ currentRevision: 3 })],
      priorContributions: [prior({ snapshotRevision: 3, hasProvenance: false })],
    });

    expect(plan.toMerge).toHaveLength(1);
    expect(plan.skipped).toEqual([]);
  });

  it("skips — and flags the repair — when the page update landed but provenance did not", () => {
    // Crash between write 2 and write 3. Reading only `topic_sources` would re-merge here.
    const plan = planMergeWork({
      targets: [target({ currentRevision: 4 })],
      priorContributions: [prior({ snapshotRevision: 3, hasProvenance: false })],
    });

    expect(plan.toMerge).toEqual([]);
    expect(plan.skipped[0]).toEqual({
      topicId: "topic-a",
      topicKey: "topic-a",
      title: "Neural Networks",
      mergedAtRevision: 4,
      provenanceMissing: true,
    });
  });

  it("re-merges when nothing at all landed, even with a stale snapshot from an older revision", () => {
    // A snapshot at 3 with the topic at 2 cannot happen from this document, but a target
    // read before another writer rolled back can look like it. Merging is the safe answer.
    const plan = planMergeWork({
      targets: [target({ currentRevision: 2 })],
      priorContributions: [prior({ snapshotRevision: 3, hasProvenance: true })],
    });

    expect(plan.toMerge).toHaveLength(1);
  });
});

describe("planMergeWork — the mid-loop retry", () => {
  /**
   * The trigger a user cannot see coming: the merge step makes 2+ serial LLM calls per topic
   * and carries `retries: 3`, so a step timeout after topic 3 of 5 is ordinary. The retry
   * must finish topics 4 and 5 and leave 1–3 exactly as they are.
   */
  it("finishes only the topics that did not persist", () => {
    const targets: MergeTargetLike[] = [
      target({ topicId: "t1", topicKey: "t1", title: "One", currentRevision: 2 }),
      target({ topicId: "t2", topicKey: "t2", title: "Two", currentRevision: 5 }),
      target({ topicId: "t3", topicKey: "t3", title: "Three", currentRevision: 1 }),
      target({ topicId: "t4", topicKey: "t4", title: "Four", currentRevision: 7 }),
      target({ topicId: null, topicKey: "proposal:new", title: "Five", currentRevision: 0 }),
    ];

    const plan = planMergeWork({
      targets,
      priorContributions: [
        // t1, t2, t3 persisted before the timeout — t3 was created by this document.
        prior({ topicId: "t1", snapshotRevision: 1, hasProvenance: true }),
        prior({ topicId: "t2", snapshotRevision: 4, hasProvenance: true }),
        prior({ topicId: "t3", snapshotRevision: null, hasProvenance: true }),
      ],
    });

    expect(plan.skipped.map((entry) => entry.topicKey)).toEqual(["t1", "t2", "t3"]);
    expect(plan.toMerge.map((entry) => entry.topicKey)).toEqual(["t4", "proposal:new"]);
  });

  it("converges: replaying the retry a third time merges nothing new", () => {
    // t4 and the create landed on the retry, so the third pass owes nothing at all — which
    // is the property "a re-run does not compound" reduces to.
    const targets: MergeTargetLike[] = [
      target({ topicId: "t1", topicKey: "t1", currentRevision: 2 }),
      target({ topicId: "t4", topicKey: "t4", currentRevision: 8 }),
      target({ topicId: "t5", topicKey: "t5", currentRevision: 1 }),
    ];

    const plan = planMergeWork({
      targets,
      priorContributions: [
        prior({ topicId: "t1", snapshotRevision: 1, hasProvenance: true }),
        prior({ topicId: "t4", snapshotRevision: 7, hasProvenance: true }),
        prior({ topicId: "t5", snapshotRevision: null, hasProvenance: true }),
      ],
    });

    expect(plan.toMerge).toEqual([]);
    expect(plan.skipped).toHaveLength(3);
  });
});
