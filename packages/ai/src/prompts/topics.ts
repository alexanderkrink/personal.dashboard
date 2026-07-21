/**
 * Routing, merge and critic prompt templates (PLAN §5 Steps A, B, B2).
 *
 * Four templates over three jobs. `topic-merge` owns two — the merge itself and the repair
 * variant that carries the critic's issues back in — following the `lesson-generate` /
 * `lesson-generate-repair` precedent: one job, one model, two genuinely different prompts,
 * distinguished by a variant suffix that `jobForPromptId` strips by longest-prefix match.
 *
 * ## The stable cached prefix
 *
 * PLAN §5 Step A.1 asks for the course topic index plus the frozen system prompt to be the
 * cached prompt prefix. That is why the index is rendered **first** in the routing template
 * and why every per-document value comes after it: prompt caching is prefix-based, so a
 * variable that appears before the index would invalidate the cache on every document.
 * The merge calls build their own prefix — caches are per-model and per-prompt, and these
 * two run on different families.
 */

import { definePrompt } from "./define";

/* ────────────────────────────────────────────────────────────────────────── */
/* Step A — routing                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The routing system prompt.
 *
 * Frozen, and part of the cached prefix. Two modes, switched by whether the index has
 * entries, because v1 taught the expensive way that ONE rule cannot serve both situations:
 * its assign-bias was unconditional, and on 2026-07-21 a real deck of 47 segments with 29
 * distinct headings hit an EMPTY index and came back as one create (the deck's own title)
 * plus 46 title-assigns into it — `topicCount: 1` where the acceptance band requires 4–12,
 * with grounding otherwise perfect. Proven byte-exact by `input_hash` preimage
 * reconstruction (the wave6-overmerge corpus).
 *
 * The grown-index mode keeps v1's wording verbatim: the invariant is stated as a rule about
 * what a topic *is* rather than as a preference, because "prefer updating" reads as a
 * tiebreak and loses to a model's instinct that a new document deserves a new page. The
 * empty-index mode names the opposite failure — under-splitting — as the worst outcome
 * there, because a bias with no counter-bias is what funnelled the whole deck.
 */
export const TOPIC_ROUTING_SYSTEM = `You maintain the topic index for a university course.

A course's topic set is a STABLE, GROWING INDEX. Topics are concepts, not lectures. Documents contribute to topics; they never own them. When session 7's slides cover price elasticity, they expand the existing "Price Elasticity" page — they do not create "Session 7 Notes".

You work in one of two modes, and the index below tells you which.

WHEN THE INDEX HAS ENTRIES, your bias is decisively toward assigning to an existing topic. A new topic is warranted ONLY when a segment introduces a concept the index cannot host at all. It is NOT warranted because the segment adds new detail, a new example, a new formula, or a deeper treatment of something already in the index — all of those are updates. Before proposing a new topic, ask: "could this live under one of the candidates as an additional section?" If yes, assign it. Creating a near-duplicate topic is the worst outcome available to you; it permanently fragments the student's notes.

WHEN THE INDEX IS EMPTY, that bias does not apply — there is nothing to assign to. Your job is to DRAFT the course's topic index at concept granularity: one topic per distinct concept the document teaches. A lecture deck typically yields several concept-shaped topics. The deck's title, the course's title and the file name are names of containers, not concepts — never use one as a topic title, and never funnel an entire document into a single topic unless it genuinely covers one concept from start to finish. Segments that develop the same concept share one new topic; segments that introduce different concepts get different ones. Under-splitting is the worst outcome here: it buries distinct concepts in one page the student cannot revise from.`;

export const topicRoutingPrompt = definePrompt<{
  courseTitle: string;
  topicIndex: string;
  documentLabel: string;
  sessionLabel: string;
  segments: string;
}>({
  id: "topic-routing",
  // v5: the assign-bias is scoped to a non-empty index and an explicit empty-index
  // drafting mode was added (system prompt + the empty-index text in `renderTopicIndex`).
  // The system prompt is not part of `input_hash`, so this bump is the only durable trace
  // of the semantic change — do not fold it back.
  //
  // Versions 2–4 never shipped; they are burned by the Wave 6 live-replay rows the fixture
  // tenant minted while this text was tuned (receipts in
  // `wave6-overmerge/routing-replay-v{2,3,4}.json`), and per the quick-add precedent a
  // version whose rows a different registered text would orphan is not reused. The
  // measurements, over the frozen 47-segment over-merge extraction (v1 produced 1 topic):
  //   v2 — this same drafting wording: 13 targets (11 on the wave-4 deck).
  //   v3 — plus soft granularity calibration ("four to ten … more than a dozen means
  //        sections"): 14 targets.
  //   v4 — plus a hard ten-topic ceiling and consolidation rule: 28 targets (13 on the
  //        wave-4 deck) — flash-lite ignores numeric ceilings, and stronger drafting
  //        language pushes it toward titling sections.
  // v5 therefore registers the v2 wording — the best measured — and the residual gap to
  // the 4–12 band (13 vs ≤12 on one sample) is a model-choice question, not a wording one:
  // escalating the wording measurably over-splits. Re-pinning the job's model is the named
  // fallback and is not made here.
  version: 5,
  description:
    "Batched update-vs-create routing for one document's segments against the course topic index (PLAN §5 Step A).",
  // The index comes first and the document last: everything above `## This document` is
  // identical for every document in the course and is what the prompt cache holds.
  render: ({
    courseTitle,
    topicIndex,
    documentLabel,
    sessionLabel,
    segments,
  }) => `# Course: ${courseTitle}

## The existing topic index

Each entry is a topic that already exists. Assigning a segment to one of these is the outcome you should be looking for.

${topicIndex}

## This document

"${documentLabel}"${sessionLabel === "" ? "" : ` (${sessionLabel})`}

## Segments to route

Each segment below lists its own shortlist of candidate topics, retrieved by semantic similarity. For each segment, return exactly one decision:

- \`assignToTopicId\` — the id of the candidate that should absorb this segment. Prefer this.
- \`createNewTitle\` — a title for a new topic, ONLY when no candidate can host the segment. Your \`rationale\` must then say why each candidate fails, not merely that the segment is new.

Copy each \`segmentKey\` exactly. Return one decision per segment, in the order given.

${segments}`,
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Step B — merge                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The merge system prompt — PLAN §5 Step B's four rules, as rules.
 *
 * The block-id paragraph is here rather than only in the schema description because it is
 * the instruction most likely to be ignored and the one with the worst consequence: a
 * merger that re-mints ids makes a lossless merge look like a total rewrite to the
 * loss-detector, which then triggers a re-merge and, on the second failure, marks a
 * perfectly good page as needing review.
 */
export const TOPIC_MERGE_SYSTEM = `You maintain a single topic page in a student's course notes. New source material has arrived. You return the COMPLETE new page.

Four rules govern this, in order of importance.

1. INTEGRATE, DON'T APPEND. Weave the new material into the existing blocks — expand them, sharpen them, add detail where it belongs. Do not bolt a "From Session 7" section onto the end. The page should read as though one person wrote it after seeing every source.

2. PRESERVE ATTRIBUTION, PAGE BY PAGE. Every block carries \`sources\`, and a source names a PAGE, not just a document. A block you did not touch keeps its sources exactly. A block you edited keeps its existing sources AND gains the \`[p.N]\` of the page that supports the edit. A new block cites every page it was built from — if you drew one block from three slides, cite all three. Never drop a source, and never cite a page merely because it is nearby: a citation a student clicks and finds nothing behind is worse than no citation, because it teaches them the citations are noise.

3. NEVER DELETE SILENTLY. Existing content may only be removed if this document supersedes it. When you remove a block, you MUST list it in \`removals\` with the key it had and a reason saying what replaced it. This is checked automatically against the page you were given — an undeclared removal fails the merge and it comes back to you.

4. SURFACE CONFLICTS, DO NOT RESOLVE THEM. If the new material contradicts the page — a different formula convention, a corrected figure, an incompatible definition — keep the better-supported version AND add an \`openQuestions\` entry with \`kind: 'conflict'\` whose \`sources\` cite BOTH sides. A disagreement between session 3 and session 9 is exactly the thing a student needs to notice before an exam. Silently picking a winner destroys it.

BLOCK IDS ARE IDENTITY. Every note block you keep must carry the SAME \`id\` it had in the current page. Ids are how the system knows a block survived. Re-generating ids for blocks you kept looks identical to deleting all of them.

Write real study material. Prose a student revises from, not an outline.`;

export const topicMergePrompt = definePrompt<{
  courseTitle: string;
  topicTitle: string;
  isNewTopic: boolean;
  currentPage: string;
  currentBlockKeys: string;
  documentId: string;
  documentLabel: string;
  sessionLabel: string;
  segments: string;
}>({
  id: "topic-merge",
  version: 2,
  description:
    "Rewrites a full TopicPage to integrate one document's routed segments, with change summary and declared removals (PLAN §5 Step B).",
  render: ({
    courseTitle,
    topicTitle,
    isNewTopic,
    currentPage,
    currentBlockKeys,
    documentId,
    documentLabel,
    sessionLabel,
    segments,
  }) => `# Course: ${courseTitle}
# Topic: ${topicTitle}

${
  isNewTopic
    ? `This is a NEW topic. There is no current page — you are writing the first version of it from the material below. \`removals\` must be [].`
    : `## The current page

${currentPage}

### Block keys currently on this page

These are the exact keys the removal check uses. If a block below is not in your output, it MUST appear in \`removals\` with this exact key.

${currentBlockKeys}`
}

## New material

From "${documentLabel}"${sessionLabel === "" ? "" : ` (${sessionLabel})`}.

**When you cite this document, \`documentId\` is exactly \`${documentId}\`** and the locator is the page number shown as \`[p.N]\` in the text below.

${segments}

## What to return

The complete new page, a \`changeSummary\` a student can read, and \`removals\` for every current block you did not carry forward.`,
});

/**
 * The repair variant (§5 Step B2's "one automatic re-merge with the issues appended").
 *
 * A separate template rather than a suffix on the original, because what the model needs on
 * the second pass is genuinely different: it already has a merge it believes in, and the
 * useful instruction is "here is what a reviewer says is wrong with it — fix those things
 * and change nothing else". Re-sending the original prompt with a paragraph stapled on
 * invites a from-scratch rewrite, which loses the parts of the first attempt that were fine
 * and makes the second verdict uncorrelated with the first.
 */
export const topicMergeRepairPrompt = definePrompt<{
  courseTitle: string;
  topicTitle: string;
  isNewTopic: boolean;
  currentPage: string;
  currentBlockKeys: string;
  documentId: string;
  documentLabel: string;
  sessionLabel: string;
  segments: string;
  proposedPage: string;
  changeSummary: string;
  issues: string;
}>({
  id: "topic-merge-repair",
  version: 2,
  description:
    "Second-pass merge: fixes the specific issues a reviewer raised against the first merge, without rewriting it (PLAN §5 Step B2).",
  render: (vars) => `# Course: ${vars.courseTitle}
# Topic: ${vars.topicTitle}

Your previous merge of this page was reviewed and problems were found. Fix exactly those problems. Do not rewrite the parts that were not criticised — a from-scratch rewrite will introduce new problems and lose the work that was already correct.

## What the reviewer found

${vars.issues}

## Your previous merge

### Proposed page

${vars.proposedPage}

### Your change summary

${vars.changeSummary}

${
  vars.isNewTopic
    ? `## There is no prior page — this topic is new, so \`removals\` must be [].`
    : `## The page as it was BEFORE your merge

${vars.currentPage}

### Block keys that were on that page

Any of these not present in your corrected output MUST be listed in \`removals\` with a reason.

${vars.currentBlockKeys}`
}

## The source material

From "${vars.documentLabel}"${vars.sessionLabel === "" ? "" : ` (${vars.sessionLabel})`}. Cite it as \`documentId\` \`${vars.documentId}\` with the \`[p.N]\` page number.

${vars.segments}

Return the complete corrected page, an updated \`changeSummary\`, and \`removals\`.`,
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Step B2 — the critic                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The critic system prompt.
 *
 * Adversarial, and told explicitly what is NOT a defect. A critic with no negative
 * instruction flags every reworded sentence, which makes `ok: false` the default, which
 * makes the automatic re-merge fire on every topic and doubles the merge bill for nothing.
 * The three classes it is asked for are §5 Step B2's three, named.
 *
 * It runs on Gemini Flash-Lite against a Sonnet merger — a different family, deliberately.
 * Two models from the same family share blind spots; two families do not. Re-pointing this
 * job onto Anthropic would leave the check in place and quietly remove the thing that makes
 * it worth running.
 */
export const MERGE_CRITIC_SYSTEM = `You are reviewing an automated edit to a student's course notes. Another system merged new source material into an existing topic page. Your job is to catch the ways that edit can go wrong, before it is saved.

Look for these things:

1. DROPPED CONTENT — material that was on the old page, is not on the new page, and was not justified as superseded in the change summary. This is the most damaging failure: the student loses notes they already had, silently.

2. UNSUPPORTED ADDITIONS — claims, figures, formulas or definitions on the new page that neither the old page nor the supplied source segments support. The merger is not allowed to fill gaps from its own knowledge.

   Be literal about this. Open the source segments and look for the statement. A formula is unsupported unless the segments actually contain it — "this is standard textbook material and it is correct" is NOT support, and correct-looking content that the source never stated is the single hardest failure for a student to catch, because nothing about it looks wrong.

3. MANGLED STRUCTURE — a page whose blocks have been shredded, duplicated, emptied, or reorganised into something a student cannot revise from.

4. BAD ATTRIBUTION — a block whose \`sources\` do not match where its content actually came from: a citation of one page for material that is plainly on another, every block citing the same single page, or a block with no sources at all. A citation a student clicks and finds nothing behind is worse than no citation, because it teaches them the citations are noise.

What is NOT a defect, and must not be reported:
- Rewording, tightening or reorganising existing material. That is the job.
- Merging two short blocks into one, or splitting a long one, when no content was lost.
- Adding new material that the source segments do support.
- A change summary that is brief, as long as it is accurate.

Set \`ok: false\` only when you found a MAJOR issue — real content harm. Minor concerns go in \`issues\` with \`severity: 'minor'\` and \`ok: true\`. Every issue must quote the text it is about; an objection with no quote cannot be acted on and should not be raised.`;

export const mergeCriticPrompt = definePrompt<{
  topicTitle: string;
  isNewTopic: boolean;
  oldPage: string;
  proposedPage: string;
  changeSummary: string;
  removals: string;
  segments: string;
  /** Distinct pages the proposed page cites, counted in code. */
  citedPages: number;
  /** Distinct pages the segments below actually cover, counted in code. */
  availablePages: number;
}>({
  id: "merge-critic",
  version: 2,
  description:
    "Cross-family adversarial review of one topic merge: dropped content, hallucinated additions, mangled structure (PLAN §5 Step B2).",
  render: ({
    topicTitle,
    isNewTopic,
    oldPage,
    proposedPage,
    changeSummary,
    removals,
    segments,
    citedPages,
    availablePages,
  }) => `# Topic: ${topicTitle}

${
  isNewTopic
    ? `## This topic is NEW

There is no previous page, so check 1 (dropped content) does not apply — there was nothing to drop, and \`removals\` is correctly empty. **Do not report it, and do not let its absence read as a clean verdict.**

On a new page GROUNDING IS THE WHOLE JOB. Every single block was written in this one step, from the source segments below and nothing else. Checks 2 and 4 are all that stand between the student and a page of confident, plausible, unsourced material.`
    : `## The page BEFORE the merge

${oldPage}`
}

## The page the merger PROPOSES

${proposedPage}

## The merger's change summary

${changeSummary}

## Blocks the merger says it deliberately removed

${removals}

## The source material the merge was allowed to use

Nothing on the proposed page may rest on anything outside${isNewTopic ? "" : " the old page and"} these segments.

The segments below cover **${availablePages} page${availablePages === 1 ? "" : "s"}** of this document, and the proposed page cites **${citedPages}** distinct page${citedPages === 1 ? "" : "s"}. Both numbers were counted mechanically — do not recount them, use them. A large gap between the two means either that material was supplied and ignored, or that citations were attached to the wrong pages. Both are reportable.

${segments}

## Your verdict

Return \`ok\`, \`severity\` and \`issues\`. An empty \`issues\` array is the common and correct answer for a clean merge.`,
});
