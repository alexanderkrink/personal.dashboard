/**
 * Adjudicating one routing batch (PLAN §5 Step A.3 → A.4) — **code, not LLM**.
 *
 * The routing model returns a flat list of `{segmentKey, assignToTopicId, createNewTitle}`.
 * Turning that list into proposals looks like a two-line `if`, and for a course that already
 * has topics it very nearly is. On a course with **no** topics it is not, and the difference
 * cost Wave 4 an entire document.
 *
 * ## The batch-local reference
 *
 * `routingDecisionSchema` can express "assign this segment to topic `<uuid>`" and "create a
 * topic called `<title>`". It cannot express **"assign this segment to the topic I am
 * creating in decision 5"** — that topic has no id yet, and will not have one until after
 * this batch is adjudicated and written.
 *
 * A model asked to route 48 slides into an empty course therefore does the only sensible
 * thing available to it: it creates a handful of topics and refers to them *by title* in the
 * `assignToTopicId` of every later segment that belongs to one. Measured on the real Wave 4
 * deck (`wave5-routing-replay.test.ts`, live call, prompt hash-verified against the recorded
 * `input_hash`): 48 decisions for 48 segments, 7 creates, 41 assigns — and every single one
 * of those 41 `assignToTopicId` values was the exact title of one of the 7 creates. Not one
 * was a uuid, invented or otherwise. The two sets matched exactly in both directions.
 *
 * The old code read those 41 as assignments to a real topic id, failed to find one, and
 * dropped them without a word. 47 of 48 segments evaporated between routing and merge, a
 * single learning-objectives slide reached the merger, and it wrote 12,500 characters of
 * correct-looking statistics from parametric knowledge with all 20 citations pointing at that
 * one slide — while coverage recorded `trustworthy: true` and zero warnings.
 *
 * So this module resolves a batch-local reference to the create it names, rather than
 * treating it as a broken uuid. That is not leniency toward a misbehaving model: it is
 * reading what the model actually said. The segments then group onto one proposal key per
 * created title, which is exactly what {@link applyDuplicateGuard} exists to do.
 *
 * ## What it refuses to do
 *
 * An `assignToTopicId` that matches neither a known topic id nor a title created in this
 * batch is **not** trusted. Writing into a topic on the strength of a model-generated
 * identifier, through a client that bypasses RLS, is how one course's notes end up in
 * another's. Those fall through to a create and are reported, never followed.
 *
 * ## Why every departure is reported rather than logged at the call site
 *
 * Every field on {@link RoutingResolution} beyond `proposals` exists because the Wave 4
 * failure was *invisible*: the drop path was the only segment-losing branch in the pipeline
 * that logged nothing, while every sibling branch warned. Returning the counts makes silence
 * impossible to reintroduce — a caller that ignores them is visibly ignoring them.
 */

/** One decision from `routingBatchSchema`, structurally. */
export interface RoutingDecisionLike {
  readonly segmentKey: string;
  readonly assignToTopicId: string | null;
  readonly createNewTitle: string | null;
  readonly rationale: string;
}

/** A segment as the adjudicator needs to see it. */
export interface RoutableSegmentLike {
  readonly key: string;
  readonly title: string;
}

/**
 * A proposal, before titles have been embedded.
 *
 * Deliberately not `RoutingProposal`: that type carries `titleEmbedding`, and the whole point
 * of adjudicating first is that the caller cannot know which titles need embedding until
 * after the batch-local references have been resolved. Wave 4 shipped the opposite order —
 * `createTitles` was filtered out of the raw decisions with one predicate while the proposal
 * loop classified them with a *different* one, so a single disagreeing decision advanced the
 * embedding cursor without contributing a vector and silently mis-paired every title after
 * it. One predicate, applied once, in one place, is the fix for that whole class.
 */
export type ResolvedProposal =
  | { readonly segmentKey: string; readonly kind: "assign"; readonly topicId: string }
  | {
      readonly segmentKey: string;
      readonly kind: "create";
      readonly title: string;
      readonly rationale: string;
    };

/** An `assignToTopicId` that named a topic being created in the same batch. */
export interface BatchLocalAssign {
  readonly segmentKey: string;
  /** What the decision said. */
  readonly reference: string;
  /** The canonical title of the create it resolved to. */
  readonly title: string;
}

/** An `assignToTopicId` that named nothing this course has and nothing this batch creates. */
export interface UnresolvableAssign {
  readonly segmentKey: string;
  readonly reference: string;
  /** The title the segment fell through to a create with. */
  readonly fallbackTitle: string;
}

export interface RoutingResolution {
  readonly proposals: readonly ResolvedProposal[];
  /** Assigns resolved against a create in the same batch. The normal path on a new course. */
  readonly batchLocal: readonly BatchLocalAssign[];
  /** Assigns naming an unknown topic. Fell through to a create; never followed. */
  readonly unresolvable: readonly UnresolvableAssign[];
  /** Decisions naming a segment that does not exist. Dropped. */
  readonly unknownSegmentKeys: readonly string[];
  /** Segments the model returned no decision for. Nothing routes them. */
  readonly segmentsWithoutDecision: readonly string[];
  /** Segments the model returned more than one decision for. Only the first is used. */
  readonly duplicateSegmentKeys: readonly string[];
}

/**
 * The one definition of "this decision is an assignment".
 *
 * Matches `routingDecisionSchema`'s `superRefine` exactly, including the empty-string case.
 * Exported so no caller has to restate it and drift from it.
 */
export function isAssignDecision(decision: RoutingDecisionLike): boolean {
  return decision.assignToTopicId !== null && decision.assignToTopicId !== "";
}

/** The complement, by the same definition. A decision is exactly one of the two. */
export function isCreateDecision(decision: RoutingDecisionLike): boolean {
  return !isAssignDecision(decision) && decision.createNewTitle !== null;
}

/**
 * Case- and whitespace-insensitive, and nothing more.
 *
 * Deliberately not fuzzy. A near-miss title should NOT be resolved here on a guess — it
 * falls through to a create, where {@link applyDuplicateGuard} adjudicates it: against the
 * cosine threshold when the collision is with an EXISTING topic, and against this same
 * normalisation when it is with another title in this batch (Wave 6 — a distinct title
 * within one routing call is a deliberate distinction, so only spelling variants of the
 * SAME title fold there). Exported so the guard and this resolver cannot drift on what
 * "the same title" means.
 */
export function normaliseTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The one spelling of "this title field carries nothing".
 *
 * `routingDecisionSchema` permits `createNewTitle: ""` on an assign decision — its
 * `superRefine` only requires exactly-one-of, and the assign side already satisfies that —
 * so every read of `createNewTitle` must treat `""` and `null` identically. Writing it once
 * is what stops the two fall-through paths below from disagreeing.
 */
function emptyToNull(title: string | null): string | null {
  return title === null || title === "" ? null : title;
}

/**
 * Turns one routing batch into proposals, resolving batch-local references.
 *
 * Pure and total. Two passes are required and the order is not incidental: a decision may
 * assign to a title that a *later* decision creates, so the create index has to be complete
 * before any assignment is adjudicated.
 */
export function resolveRoutingDecisions(input: {
  readonly decisions: readonly RoutingDecisionLike[];
  readonly segments: readonly RoutableSegmentLike[];
  readonly knownTopicIds: Iterable<string>;
}): RoutingResolution {
  const knownTopicIds = new Set(input.knownTopicIds);
  const segmentTitles = new Map(input.segments.map((segment) => [segment.key, segment.title]));

  // ── Pass 1: index every title this batch creates ───────────────────────────
  const createdTitles = new Map<string, string>();
  for (const decision of input.decisions) {
    if (!segmentTitles.has(decision.segmentKey)) continue;
    if (!isCreateDecision(decision)) continue;
    const title = decision.createNewTitle ?? "";
    if (title === "") continue;
    const key = normaliseTitle(title);
    // First spelling wins, so the canonical title is stable regardless of how later
    // decisions capitalise it.
    if (!createdTitles.has(key)) createdTitles.set(key, title);
  }

  // ── Pass 2: adjudicate ─────────────────────────────────────────────────────
  const proposals: ResolvedProposal[] = [];
  const batchLocal: BatchLocalAssign[] = [];
  const unresolvable: UnresolvableAssign[] = [];
  const unknownSegmentKeys: string[] = [];
  const duplicateSegmentKeys: string[] = [];
  const decided = new Set<string>();

  for (const decision of input.decisions) {
    const segmentTitle = segmentTitles.get(decision.segmentKey);
    if (segmentTitle === undefined) {
      unknownSegmentKeys.push(decision.segmentKey);
      continue;
    }
    if (decided.has(decision.segmentKey)) {
      // A segment routed twice would be merged into two topics, duplicating its content
      // across the index. The first decision stands; the rest are reported.
      duplicateSegmentKeys.push(decision.segmentKey);
      continue;
    }
    decided.add(decision.segmentKey);

    if (!isAssignDecision(decision)) {
      proposals.push({
        segmentKey: decision.segmentKey,
        kind: "create",
        // A create with no title still has to route somewhere; the segment's own heading is
        // the honest fallback and the duplicate guard will coalesce it if it collides.
        title: emptyToNull(decision.createNewTitle) ?? segmentTitle,
        rationale: decision.rationale,
      });
      continue;
    }

    const reference = decision.assignToTopicId ?? "";

    // A real topic in this course. The only case where an assignment is followed.
    if (knownTopicIds.has(reference)) {
      proposals.push({ segmentKey: decision.segmentKey, kind: "assign", topicId: reference });
      continue;
    }

    // A topic this batch is creating, named by title because it has no id yet.
    const canonical = createdTitles.get(normaliseTitle(reference));
    if (canonical !== undefined) {
      batchLocal.push({ segmentKey: decision.segmentKey, reference, title: canonical });
      proposals.push({
        segmentKey: decision.segmentKey,
        kind: "create",
        title: canonical,
        rationale: decision.rationale,
      });
      continue;
    }

    // Names nothing. Never followed — fall through to a create, and say so.
    //
    // `""` is treated as absent, exactly as `routingDecisionSchema`'s `superRefine` and
    // {@link isAssignDecision} treat it. A bare `?? segmentTitle` here would let an assign
    // carrying `createNewTitle: ""` — which the schema ACCEPTS, since exactly-one-of is
    // satisfied by the assign side — create an untitled topic. That is the same
    // empty-title defect this module exists to prevent on the create path above, and it
    // must be spelled the same way in both places.
    const fallbackTitle = emptyToNull(decision.createNewTitle) ?? segmentTitle;
    unresolvable.push({ segmentKey: decision.segmentKey, reference, fallbackTitle });
    proposals.push({
      segmentKey: decision.segmentKey,
      kind: "create",
      title: fallbackTitle,
      rationale: decision.rationale,
    });
  }

  const segmentsWithoutDecision = input.segments
    .map((segment) => segment.key)
    .filter((key) => !decided.has(key));

  return {
    proposals,
    batchLocal,
    unresolvable,
    unknownSegmentKeys,
    segmentsWithoutDecision,
    duplicateSegmentKeys,
  };
}
