/**
 * The three LLM calls of PLAN §5 — routing, merge, critic — bound to their prompts and
 * schemas (M1 item 5d).
 *
 * Like `doc-structuring`, this module knows nothing about Supabase, Inngest or where the
 * segments came from. It is the binding of prompt → schema → job, so no call site has to
 * know which goes with which, and so the cross-family critic rule is expressed once in code
 * rather than re-decided at each call.
 *
 * Every call goes through `runtime.generateStructured`: the §3 stamp, the §2 ladder, the §6
 * guard and metering all come from there and none of them is bypassable here.
 */

import {
  MERGE_CRITIC_SYSTEM,
  mergeCriticPrompt,
  TOPIC_MERGE_SYSTEM,
  TOPIC_ROUTING_SYSTEM,
  topicMergePrompt,
  topicMergeRepairPrompt,
  topicRoutingPrompt,
} from "../prompts/topics";
import type { AIRuntime, GenerateStructuredResult } from "../runtime";
import {
  type MergeCriticVerdict,
  mergeCriticSchema,
  type RoutingBatch,
  routingBatchSchema,
  type TopicMerge,
  topicMergeSchema,
} from "../schemas/topics";

/* ────────────────────────────────────────────────────────────────────────── */
/* Rendering helpers                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/** One entry of the cached course topic index (§5 Step A.1: `{id, title, summary, keyTerms}`). */
export interface TopicIndexEntry {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly keyTerms: readonly string[];
}

/**
 * Renders the course topic index — the stable, prompt-cached prefix.
 *
 * Plain text rather than JSON, and sorted by title rather than by id or by recency. Both
 * choices are about cache stability: JSON re-serialization can reorder keys, and any
 * ordering derived from row creation or update time would shuffle the prefix every time a
 * topic is merged, invalidating the cache the index exists to populate.
 */
export function renderTopicIndex(topics: readonly TopicIndexEntry[]): string {
  if (topics.length === 0) {
    return "(This course has no topics yet. Every segment will need a new topic — but still keep them concept-shaped, and do not create two topics for one concept.)";
  }
  return [...topics]
    .sort((a, b) => a.title.localeCompare(b.title))
    .map(
      (topic) =>
        `- id: ${topic.id}\n  title: ${topic.title}\n  summary: ${topic.summary}\n  key terms: ${
          topic.keyTerms.length === 0 ? "(none recorded)" : topic.keyTerms.join(", ")
        }`,
    )
    .join("\n");
}

/** A segment plus the shortlist retrieved for it (§5 Step A.2's top-5). */
export interface RoutableSegment {
  readonly key: string;
  readonly title: string;
  readonly markdown: string;
  readonly candidates: readonly {
    readonly id: string;
    readonly title: string;
    readonly similarity: number;
  }[];
}

/** Renders the per-segment block: the text to route, and the candidates it may pick from. */
export function renderRoutableSegments(segments: readonly RoutableSegment[]): string {
  return segments
    .map((segment) => {
      const candidates =
        segment.candidates.length === 0
          ? "  (no similar existing topic was found — but check the full index above before creating one)"
          : segment.candidates
              .map(
                (candidate) =>
                  `  - ${candidate.id} — ${candidate.title} (similarity ${candidate.similarity.toFixed(3)})`,
              )
              .join("\n");
      return `### segmentKey: ${segment.key}\nHeading: ${segment.title}\n\nCandidate topics:\n${candidates}\n\nContent:\n${segment.markdown}`;
    })
    .join("\n\n---\n\n");
}

/**
 * Renders routed segment text for the merge and critic calls.
 *
 * The page range is stated in the header as well as inline. Each page already carries its own
 * `[p.N]` marker inside `markdown` (`segment.ts`), so the range is redundant for a reader
 * that tracks them — and that is exactly the assumption worth not making. A merger that
 * summarises a seven-slide run into one block has to choose which pages to cite, and an
 * explicit "covers pp. 22–28" is the difference between citing the run and citing whichever
 * marker it happened to read last. `fromPage`/`toPage` are optional because the critic and
 * the tests both pass bare `{key, title, markdown}` triples.
 */
export function renderMergeSegments(
  segments: readonly {
    readonly key: string;
    readonly title: string;
    readonly markdown: string;
    readonly fromPage?: number;
    readonly toPage?: number;
  }[],
): string {
  return segments
    .map((segment) => {
      const { fromPage, toPage } = segment;
      const range =
        fromPage === undefined
          ? ""
          : toPage === undefined || toPage === fromPage
            ? ` (covers p. ${fromPage})`
            : ` (covers pp. ${fromPage}–${toPage})`;
      return `### ${segment.title}${range}\n\n${segment.markdown}`;
    })
    .join("\n\n---\n\n");
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Step A — routing                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

export interface RouteSegmentsOptions {
  readonly runtime: AIRuntime;
  readonly courseTitle: string;
  readonly topicIndex: readonly TopicIndexEntry[];
  readonly segments: readonly RoutableSegment[];
  readonly documentLabel: string;
  readonly sessionLabel: string | null;
}

/**
 * §5 Step A.3: **one** call per document, every segment batched into it.
 *
 * One call rather than one per segment is not only a cost decision. A model that sees all
 * of a document's segments at once can notice that segments 4 and 11 are the same concept
 * and route both to the same place; a per-segment call cannot, and would leave that entirely
 * to the duplicate guard.
 */
export function routeSegments({
  runtime,
  courseTitle,
  topicIndex,
  segments,
  documentLabel,
  sessionLabel,
}: RouteSegmentsOptions): Promise<GenerateStructuredResult<RoutingBatch>> {
  return runtime.generateStructured({
    prompt: topicRoutingPrompt,
    vars: {
      courseTitle,
      topicIndex: renderTopicIndex(topicIndex),
      documentLabel,
      sessionLabel: sessionLabel ?? "",
      segments: renderRoutableSegments(segments),
    },
    schema: routingBatchSchema,
    system: TOPIC_ROUTING_SYSTEM,
    kind: "background",
  });
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Step B — merge                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

export interface MergeTopicOptions {
  readonly runtime: AIRuntime;
  readonly courseTitle: string;
  readonly topicTitle: string;
  readonly isNewTopic: boolean;
  /** The current page as JSON. `EMPTY_TOPIC_PAGE` for a new topic. */
  readonly currentPage: string;
  /** The exact `DiffBlock` keys of the current page — what `removals` must name. */
  readonly currentBlockKeys: readonly string[];
  readonly documentId: string;
  readonly documentLabel: string;
  readonly sessionLabel: string | null;
  readonly segments: readonly {
    readonly key: string;
    readonly title: string;
    readonly markdown: string;
    readonly fromPage?: number;
    readonly toPage?: number;
  }[];
}

function renderBlockKeys(keys: readonly string[]): string {
  return keys.length === 0
    ? "(the page has no blocks yet)"
    : keys.map((key) => `- ${key}`).join("\n");
}

export function mergeTopic(
  options: MergeTopicOptions,
): Promise<GenerateStructuredResult<TopicMerge>> {
  return options.runtime.generateStructured({
    prompt: topicMergePrompt,
    vars: {
      courseTitle: options.courseTitle,
      topicTitle: options.topicTitle,
      isNewTopic: options.isNewTopic,
      currentPage: options.currentPage,
      currentBlockKeys: renderBlockKeys(options.currentBlockKeys),
      documentId: options.documentId,
      documentLabel: options.documentLabel,
      sessionLabel: options.sessionLabel ?? "",
      segments: renderMergeSegments(options.segments),
    },
    schema: topicMergeSchema,
    system: TOPIC_MERGE_SYSTEM,
    kind: "background",
  });
}

export interface RemergeTopicOptions extends MergeTopicOptions {
  /** The page the first pass proposed, as JSON. */
  readonly proposedPage: string;
  readonly changeSummary: string;
  /** The combined loss-detector + critic findings, one per line. */
  readonly issues: readonly string[];
}

/**
 * The single automatic re-merge (§5 Step B2).
 *
 * `job: "topic-merge"` is passed explicitly. `topic-merge-repair` already resolves to
 * `topic-merge` by longest-prefix match, so this is not strictly required — it is written
 * out because a silent dependence on suffix-stripping for the *model* choice is worth
 * making explicit, exactly as `structureSlideText` does.
 */
export function remergeTopic(
  options: RemergeTopicOptions,
): Promise<GenerateStructuredResult<TopicMerge>> {
  return options.runtime.generateStructured({
    prompt: topicMergeRepairPrompt,
    vars: {
      courseTitle: options.courseTitle,
      topicTitle: options.topicTitle,
      isNewTopic: options.isNewTopic,
      currentPage: options.currentPage,
      currentBlockKeys: renderBlockKeys(options.currentBlockKeys),
      documentId: options.documentId,
      documentLabel: options.documentLabel,
      sessionLabel: options.sessionLabel ?? "",
      segments: renderMergeSegments(options.segments),
      proposedPage: options.proposedPage,
      changeSummary: options.changeSummary,
      issues: options.issues.map((issue) => `- ${issue}`).join("\n"),
    },
    schema: topicMergeSchema,
    system: TOPIC_MERGE_SYSTEM,
    job: "topic-merge",
    kind: "background",
  });
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Step B2 — the critic                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

export interface CriticiseMergeOptions {
  readonly runtime: AIRuntime;
  readonly topicTitle: string;
  /** True on a first merge, where check 1 is vacuous and grounding is the whole job. */
  readonly isNewTopic: boolean;
  readonly oldPage: string;
  readonly proposedPage: string;
  readonly changeSummary: string;
  readonly removals: readonly { readonly blockKey: string; readonly reason: string }[];
  readonly segments: readonly {
    readonly key: string;
    readonly title: string;
    readonly markdown: string;
  }[];
  /** Distinct pages the proposed page cites. Counted here, never asked of the model. */
  readonly citedPages: number;
  /** Distinct pages the segments cover. Counted here, never asked of the model. */
  readonly availablePages: number;
}

/**
 * §5 Step B2.2, and the reason the two-provider split exists.
 *
 * ⚠ `merge-critic` is pinned to `gemini-3.1-flash-lite` in `JOBS` while `topic-merge` runs
 * on `claude-sonnet-5`. **That cross-family pairing is the entire point of this call.** A
 * critic on the same family as its generator shares the generator's blind spots and will
 * wave through precisely the failures it was added to catch, while still costing money and
 * still reporting `ok: true` — the most expensive possible way to have no check at all.
 * Re-pointing this job to an Anthropic model does not weaken the check; it removes it.
 */
export function criticiseMerge({
  runtime,
  topicTitle,
  isNewTopic,
  oldPage,
  proposedPage,
  changeSummary,
  removals,
  segments,
  citedPages,
  availablePages,
}: CriticiseMergeOptions): Promise<GenerateStructuredResult<MergeCriticVerdict>> {
  return runtime.generateStructured({
    prompt: mergeCriticPrompt,
    vars: {
      topicTitle,
      isNewTopic,
      citedPages,
      availablePages,
      oldPage,
      proposedPage,
      changeSummary,
      removals:
        removals.length === 0
          ? "(the merger says it removed nothing)"
          : removals.map((removal) => `- ${removal.blockKey}: ${removal.reason}`).join("\n"),
      segments: renderMergeSegments(segments),
    },
    schema: mergeCriticSchema,
    system: MERGE_CRITIC_SYSTEM,
    kind: "background",
  });
}
