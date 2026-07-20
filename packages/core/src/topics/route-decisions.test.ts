import { describe, expect, it } from "vitest";
import {
  isAssignDecision,
  isCreateDecision,
  type RoutingDecisionLike,
  resolveRoutingDecisions,
} from "./route-decisions";

function segments(count: number): { key: string; title: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `seg-${i + 1}`,
    title: `Heading ${i + 1}`,
  }));
}

function decision(
  over: Partial<RoutingDecisionLike> & { segmentKey: string },
): RoutingDecisionLike {
  return {
    assignToTopicId: null,
    createNewTitle: null,
    rationale: "because",
    ...over,
  };
}

/**
 * The rule the pipeline used through Wave 4, restated here so the regression tests below
 * have something to be red against.
 *
 * `runRouting` pushed any non-empty `assignToTopicId` through as an assignment, and
 * `planMerges` then resolved it against the course's *existing* topics only, dropping what
 * it could not find — silently. On a course with no topics that is every assignment.
 */
function legacyResolution(input: {
  decisions: readonly RoutingDecisionLike[];
  knownTopicIds: ReadonlySet<string>;
}): { merged: string[]; droppedSilently: string[] } {
  const merged: string[] = [];
  const droppedSilently: string[] = [];
  for (const d of input.decisions) {
    if (d.assignToTopicId !== null && d.assignToTopicId !== "") {
      if (input.knownTopicIds.has(d.assignToTopicId)) merged.push(d.segmentKey);
      else droppedSilently.push(d.segmentKey);
      continue;
    }
    merged.push(d.segmentKey);
  }
  return { merged, droppedSilently };
}

/**
 * The measured shape of the Wave 4 failure, reproduced.
 *
 * The live replay (`apps/web/src/test/wave5-routing-replay.test.ts`, prompt hash-verified
 * against the recorded `input_hash`) returned 48 decisions for 48 segments: 7 creates and 41
 * assigns, where every one of the 41 `assignToTopicId` values was the exact title of one of
 * the 7 creates. The recorded run's `embed-topic-title` call billed **2 input tokens** — one
 * title — so the run that actually failed was the degenerate case of the same shape: one
 * create, and 47 assignments back to it by name.
 */
function wave4Batch(): RoutingDecisionLike[] {
  return [
    decision({ segmentKey: "seg-1", createNewTitle: "Sampling Distributions" }),
    ...Array.from({ length: 47 }, (_, i) =>
      decision({ segmentKey: `seg-${i + 2}`, assignToTopicId: "Sampling Distributions" }),
    ),
  ];
}

describe("resolveRoutingDecisions — the Wave 4 batch-local reference", () => {
  it("RED: the legacy rule silently drops 47 of 48 segments on this exact batch", () => {
    const { merged, droppedSilently } = legacyResolution({
      decisions: wave4Batch(),
      knownTopicIds: new Set(),
    });

    // This is the defect, reproduced: one slide reaches the merge, 47 vanish without a word.
    expect(merged).toEqual(["seg-1"]);
    expect(droppedSilently).toHaveLength(47);
  });

  it("GREEN: resolves all 48 onto the one topic the batch creates", () => {
    const resolution = resolveRoutingDecisions({
      decisions: wave4Batch(),
      segments: segments(48),
      knownTopicIds: [],
    });

    expect(resolution.proposals).toHaveLength(48);
    expect(resolution.segmentsWithoutDecision).toEqual([]);
    expect(resolution.batchLocal).toHaveLength(47);
    expect(resolution.unresolvable).toEqual([]);
    expect(
      resolution.proposals.every(
        (p) => p.kind === "create" && p.title === "Sampling Distributions",
      ),
    ).toBe(true);
  });

  it("GREEN: the 7-topic replay shape lands every segment on one of the 7 titles", () => {
    const titles = [
      "Statistical Inference",
      "Populations and Samples",
      "Sampling Distributions",
      "Central Limit Theorem",
      "Sampling Distributions of Proportions",
      "Sampling Distributions of Variances",
      "Chi-Square Distribution",
    ];
    const decisions: RoutingDecisionLike[] = [
      ...titles.map((title, i) => decision({ segmentKey: `seg-${i + 1}`, createNewTitle: title })),
      ...Array.from({ length: 41 }, (_, i) =>
        decision({
          segmentKey: `seg-${i + 8}`,
          assignToTopicId: titles[i % titles.length] ?? "",
        }),
      ),
    ];

    const resolution = resolveRoutingDecisions({
      decisions,
      segments: segments(48),
      knownTopicIds: [],
    });

    expect(resolution.proposals).toHaveLength(48);
    expect(resolution.batchLocal).toHaveLength(41);
    expect(resolution.unresolvable).toEqual([]);
    expect(new Set(resolution.proposals.map((p) => (p.kind === "create" ? p.title : "")))).toEqual(
      new Set(titles),
    );
  });

  it("resolves a back-reference to a create that appears LATER in the batch", () => {
    const resolution = resolveRoutingDecisions({
      decisions: [
        decision({ segmentKey: "seg-1", assignToTopicId: "Bayes' Theorem" }),
        decision({ segmentKey: "seg-2", createNewTitle: "Bayes' Theorem" }),
      ],
      segments: segments(2),
      knownTopicIds: [],
    });

    expect(resolution.batchLocal).toHaveLength(1);
    expect(resolution.proposals).toEqual([
      { segmentKey: "seg-1", kind: "create", title: "Bayes' Theorem", rationale: "because" },
      { segmentKey: "seg-2", kind: "create", title: "Bayes' Theorem", rationale: "because" },
    ]);
  });

  it("matches a back-reference case- and whitespace-insensitively, keeping the first spelling", () => {
    const resolution = resolveRoutingDecisions({
      decisions: [
        decision({ segmentKey: "seg-1", createNewTitle: "Central Limit Theorem" }),
        decision({ segmentKey: "seg-2", assignToTopicId: "  central   limit theorem  " }),
      ],
      segments: segments(2),
      knownTopicIds: [],
    });

    expect(resolution.batchLocal).toHaveLength(1);
    expect(resolution.proposals[1]).toMatchObject({ title: "Central Limit Theorem" });
  });
});

describe("resolveRoutingDecisions — what it refuses to trust", () => {
  it("follows an assignment to a topic that really exists", () => {
    const resolution = resolveRoutingDecisions({
      decisions: [decision({ segmentKey: "seg-1", assignToTopicId: "topic-a" })],
      segments: segments(1),
      knownTopicIds: ["topic-a"],
    });

    expect(resolution.proposals).toEqual([
      { segmentKey: "seg-1", kind: "assign", topicId: "topic-a" },
    ]);
    expect(resolution.unresolvable).toEqual([]);
    expect(resolution.batchLocal).toEqual([]);
  });

  it("RED: never follows an id that names neither a known topic nor a batch create", () => {
    const resolution = resolveRoutingDecisions({
      decisions: [
        decision({
          segmentKey: "seg-1",
          assignToTopicId: "8f14e45f-ceea-467a-9a1b-1f0e5c2a77bd",
        }),
      ],
      segments: segments(1),
      knownTopicIds: ["topic-a"],
    });

    // The hazard this closes: a model-generated uuid followed through an RLS-bypassing
    // client would write one course's material into another course's topic.
    expect(resolution.proposals).toEqual([
      { segmentKey: "seg-1", kind: "create", title: "Heading 1", rationale: "because" },
    ]);
    expect(resolution.unresolvable).toEqual([
      {
        segmentKey: "seg-1",
        reference: "8f14e45f-ceea-467a-9a1b-1f0e5c2a77bd",
        fallbackTitle: "Heading 1",
      },
    ]);
  });

  it("RED: an unresolvable assign carrying createNewTitle:'' still gets a real title", () => {
    // `routingDecisionSchema` ACCEPTS this shape: its `superRefine` asks only for
    // exactly-one-of, and the assign side already satisfies that, so `createNewTitle: ""`
    // passes validation. A `?? segmentTitle` fall-through does not fire on `""` — it fires
    // only on `null` — so this decision used to produce a topic titled "". That is the
    // empty-title defect the create path guards against, reached through the other door.
    const resolution = resolveRoutingDecisions({
      decisions: [
        decision({
          segmentKey: "seg-1",
          assignToTopicId: "Ghost Topic",
          createNewTitle: "",
        }),
      ],
      segments: segments(1),
      knownTopicIds: [],
    });

    expect(resolution.proposals).toEqual([
      { segmentKey: "seg-1", kind: "create", title: "Heading 1", rationale: "because" },
    ]);
    expect(resolution.unresolvable).toEqual([
      { segmentKey: "seg-1", reference: "Ghost Topic", fallbackTitle: "Heading 1" },
    ]);
  });

  it("prefers a real topic id over a same-batch title that collides with it", () => {
    const resolution = resolveRoutingDecisions({
      decisions: [
        decision({ segmentKey: "seg-1", createNewTitle: "topic-a" }),
        decision({ segmentKey: "seg-2", assignToTopicId: "topic-a" }),
      ],
      segments: segments(2),
      knownTopicIds: ["topic-a"],
    });

    expect(resolution.proposals[1]).toEqual({
      segmentKey: "seg-2",
      kind: "assign",
      topicId: "topic-a",
    });
    expect(resolution.batchLocal).toEqual([]);
  });
});

describe("resolveRoutingDecisions — arity, which the schema does not enforce", () => {
  it("RED: reports segments the model returned no decision for", () => {
    const resolution = resolveRoutingDecisions({
      decisions: [decision({ segmentKey: "seg-1", createNewTitle: "A" })],
      segments: segments(3),
      knownTopicIds: [],
    });

    // `routingBatchSchema` says "exactly one decision per segment" in a `.describe()` string
    // and enforces nothing. This is the other world the Wave 5 arbitration could not rule
    // out, and it is caught here whether or not it was what happened.
    expect(resolution.segmentsWithoutDecision).toEqual(["seg-2", "seg-3"]);
    expect(resolution.proposals).toHaveLength(1);
  });

  it("RED: reports a segment routed more than once and keeps only the first", () => {
    const resolution = resolveRoutingDecisions({
      decisions: [
        decision({ segmentKey: "seg-1", createNewTitle: "A" }),
        decision({ segmentKey: "seg-1", createNewTitle: "B" }),
      ],
      segments: segments(1),
      knownTopicIds: [],
    });

    expect(resolution.duplicateSegmentKeys).toEqual(["seg-1"]);
    expect(resolution.proposals).toHaveLength(1);
    expect(resolution.proposals[0]).toMatchObject({ title: "A" });
  });

  it("RED: reports a decision for a segment that does not exist", () => {
    const resolution = resolveRoutingDecisions({
      decisions: [decision({ segmentKey: "seg-99", createNewTitle: "A" })],
      segments: segments(1),
      knownTopicIds: [],
    });

    expect(resolution.unknownSegmentKeys).toEqual(["seg-99"]);
    expect(resolution.segmentsWithoutDecision).toEqual(["seg-1"]);
    expect(resolution.proposals).toEqual([]);
  });

  it("falls a titleless create back onto the segment's own heading", () => {
    const resolution = resolveRoutingDecisions({
      decisions: [decision({ segmentKey: "seg-1", createNewTitle: "" })],
      segments: segments(1),
      knownTopicIds: [],
    });

    expect(resolution.proposals[0]).toMatchObject({ kind: "create", title: "Heading 1" });
  });
});

describe("the shared assign/create predicate", () => {
  // N2: `createTitles` was filtered with `assignToTopicId === null` while the proposal loop
  // classified with `assigned !== null && assigned !== ""`. A decision with
  // `assignToTopicId: ""` and a real `createNewTitle` took the create branch in one and not
  // the other, advancing the embedding cursor without contributing a vector — silently
  // mis-pairing the title embedding of every create after it.
  it("treats an empty-string assignToTopicId as a create, in BOTH directions", () => {
    const d = decision({ segmentKey: "seg-1", assignToTopicId: "", createNewTitle: "A" });
    expect(isAssignDecision(d)).toBe(false);
    expect(isCreateDecision(d)).toBe(true);

    const resolution = resolveRoutingDecisions({
      decisions: [d],
      segments: segments(1),
      knownTopicIds: [],
    });
    expect(resolution.proposals).toEqual([
      { segmentKey: "seg-1", kind: "create", title: "A", rationale: "because" },
    ]);
  });

  it("a decision is exactly one of assign or create, never both and never neither", () => {
    const cases: RoutingDecisionLike[] = [
      decision({ segmentKey: "s", assignToTopicId: "x" }),
      decision({ segmentKey: "s", createNewTitle: "y" }),
      decision({ segmentKey: "s", assignToTopicId: "", createNewTitle: "y" }),
      decision({ segmentKey: "s", assignToTopicId: "x", createNewTitle: "y" }),
    ];
    for (const c of cases) {
      expect(isAssignDecision(c)).toBe(!isCreateDecision(c) || c.createNewTitle === null);
    }
  });
});
