/**
 * The topic-routing / merge / critic contracts (PLAN "Document & Notes Pipeline" §5).
 *
 * Three model contracts and the artifact they operate on:
 * - {@link topicPageSchema} — `topics.page`, the thing the whole pipeline exists to build.
 * - {@link routingBatchSchema} — Step A's one batched update-vs-create decision.
 * - {@link topicMergeSchema} — Step B's complete rewritten page.
 * - {@link mergeCriticSchema} — Step B2's adversarial verdict.
 *
 * Per `./index.ts`: `.describe()` on every field, because on a call that ships a whole
 * TopicPage the descriptions steer more than the template does. And per the boundary rule,
 * `topics.page` is `safeParse`d on the way **out** of the database as well as in — a page
 * written by an older version of this schema is an external input like any other, and
 * `topics.page` defaults to a bare `{}` that has none of these fields at all.
 */

import { z } from "zod";

/* ────────────────────────────────────────────────────────────────────────── */
/* The TopicPage                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Where a piece of content came from: which document, and which page of it.
 *
 * ## 🔴 This was a nested `{documentId, locator: {page, slide}}` and Anthropic REFUSED it
 *
 * Measured, not reasoned. The first live merge against `claude-sonnet-5` came back
 * **HTTP 400 `invalid_request_error`: "The compiled grammar is too large, which would cause
 * performance issues. Simplify your tool schemas"** — every merge, on both topics, before a
 * single token was generated. A TopicPage is six arrays of objects, and giving each of them
 * an array of two-level nested source objects (with a nullable `page`/`slide` pair inside)
 * multiplied the constrained-decoding grammar past the provider's ceiling.
 *
 * Two things make this worth a long comment rather than a one-line fix:
 *
 * 1. **No unit test could have caught it.** The schema is valid Zod, parses correctly, and
 *    round-trips fixtures perfectly. The constraint lives in the provider's grammar
 *    compiler and is only observable by making a real call. This is exactly the class of
 *    failure the "build it, then run it once for real" rule exists to find.
 * 2. **The nesting was never earned.** `extractedPageSchema` already unifies the vocabulary
 *    — "1-based page (PDF) or slide (PPTX) number" — so a separate `page`/`slide` pair was
 *    modelling a distinction the extractor had already collapsed, at the cost of two object
 *    levels on the hottest schema in the product.
 *
 * So a source is flat: a document id and the one number that locates content in it. The
 * `{page: n}` shape still appears in `topic_sources.locators`, which is a database column
 * written by code rather than a grammar the model has to satisfy.
 */
export const blockSourceSchema = z.object({
  documentId: z
    .string()
    .describe("The id of the document this content came from. Copy it exactly as given."),
  page: z
    .number()
    .int()
    .describe("The 1-based page or slide number within that document, as shown in [p.N]."),
});

/**
 * One ordered markdown block of the page's notes.
 *
 * `id` is the load-bearing field and the one most likely to be got wrong. It is the block's
 * **identity across merges**: the deterministic loss-detector diffs pre- and post-merge
 * pages by it, so a merger that re-generates ids for blocks it kept makes every block look
 * deleted-and-recreated and trips the red flag on a merge that lost nothing. The prompt
 * says this too; the description says it here because this is what the model actually reads.
 */
export const noteBlockSchema = z.object({
  id: z
    .string()
    .describe(
      "Stable kebab-case identifier for this block, e.g. 'price-elasticity-intro'. If this block already existed in the current page, REUSE ITS EXISTING ID EXACTLY — the id is how the system knows the block survived rather than being deleted. Only invent an id for a genuinely new block.",
    ),
  heading: z.string().describe("Short heading for the block. May be refined between merges."),
  markdown: z
    .string()
    .describe(
      "The block's content as markdown: prose, bullets, tables, inline LaTeX ($…$). This is study material a person reads — write it out, do not summarise it away.",
    ),
  sources: z
    .array(blockSourceSchema)
    .describe(
      "Every document/locator that contributed to this block. If you edited an existing block with new material, KEEP its existing sources and ADD the new one. Never drop a source you did not invalidate.",
    ),
});

export const keyTermSchema = z.object({
  term: z.string().describe("The term being defined."),
  definition: z.string().describe("Its definition, in the course's own vocabulary."),
  sources: z.array(blockSourceSchema).describe("Where this term is defined or used."),
});

export const topicFormulaSchema = z.object({
  name: z.string().describe("What the formula is called, e.g. 'Price elasticity of demand'."),
  latex: z.string().describe("The formula as LaTeX, without surrounding $ delimiters."),
  explanation: z.string().describe("What it computes and what each symbol means in this course."),
  sources: z.array(blockSourceSchema),
});

export const topicWorkedExampleSchema = z.object({
  problem: z.string().describe("The problem or case as posed."),
  solution: z.string().describe("The worked solution and the method, keeping the numbers."),
  sources: z.array(blockSourceSchema),
});

/**
 * PLAN §5's study signal.
 *
 * `conflict` is the important one: when new material contradicts the page, the merger keeps
 * the better-supported version **and** records the disagreement here citing both sources.
 * A contradiction between lecture 3 and lecture 9 is something a student needs to know
 * about, so resolving it silently destroys the most valuable thing the merge could produce.
 * `gap` is written by the coverage checklist rather than by the merge.
 */
export const OPEN_QUESTION_KINDS = ["gap", "conflict"] as const;

export const openQuestionSchema = z.object({
  question: z
    .string()
    .describe("The open question or contradiction, phrased so a student can act on it."),
  context: z
    .string()
    .describe(
      "What disagrees with what, concretely — 'Session 3 defines margin on cost, Session 9 on price'.",
    ),
  kind: z
    .enum(OPEN_QUESTION_KINDS)
    .describe(
      "'conflict' when two sources disagree; 'gap' when the material is missing something the course expects.",
    ),
  sources: z
    .array(blockSourceSchema)
    .describe("BOTH sides of a conflict — the citation is what makes it checkable."),
});

export const topicPageSchema = z.object({
  summary: z
    .string()
    .describe("Three to five sentences: what this topic is, for someone deciding what to revise."),
  notes: z
    .array(noteBlockSchema)
    .describe("The topic's notes as ordered blocks. This is the body of the page."),
  keyTerms: z.array(keyTermSchema).describe("Terms this topic defines. [] if none."),
  formulas: z.array(topicFormulaSchema).describe("Formulas for this topic. [] if none."),
  workedExamples: z
    .array(topicWorkedExampleSchema)
    .describe("Worked examples and cases. [] if none."),
  openQuestions: z
    .array(openQuestionSchema)
    .describe(
      "Conflicts and gaps. [] is the common answer — only record a real disagreement between sources.",
    ),
});

export type BlockSource = z.infer<typeof blockSourceSchema>;
export type NoteBlock = z.infer<typeof noteBlockSchema>;
export type KeyTerm = z.infer<typeof keyTermSchema>;
export type TopicFormula = z.infer<typeof topicFormulaSchema>;
export type TopicWorkedExample = z.infer<typeof topicWorkedExampleSchema>;
export type OpenQuestion = z.infer<typeof openQuestionSchema>;
export type TopicPage = z.infer<typeof topicPageSchema>;

/**
 * A stored page, read back from `topics.page`.
 *
 * Every field defaulted, because the column is `jsonb not null default '{}'` — a topic row
 * created before its first merge holds a bare object with none of these keys. Parsing that
 * through `topicPageSchema` would fail on six missing required fields and turn "new topic"
 * into "corrupt topic"; parsing it through this yields the empty page that §5 Step B wants
 * to hand the merger anyway.
 */
export const storedTopicPageSchema = z.object({
  summary: z.string().default(""),
  notes: z.array(noteBlockSchema).default([]),
  keyTerms: z.array(keyTermSchema).default([]),
  formulas: z.array(topicFormulaSchema).default([]),
  workedExamples: z.array(topicWorkedExampleSchema).default([]),
  openQuestions: z.array(openQuestionSchema).default([]),
});

export type StoredTopicPage = z.infer<typeof storedTopicPageSchema>;

/** The empty page a brand-new topic is merged into. */
export const EMPTY_TOPIC_PAGE: StoredTopicPage = {
  summary: "",
  notes: [],
  keyTerms: [],
  formulas: [],
  workedExamples: [],
  openQuestions: [],
};

/* ────────────────────────────────────────────────────────────────────────── */
/* Step A — routing                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * One segment's update-vs-create decision.
 *
 * The shape is what enforces PLAN's "the schema *requires* it to pick from the retrieved
 * candidates or explicitly justify why none fit". `assignToTopicId` and `createNewTitle`
 * are both nullable, and `rationale` is required in every case — so a `createNew` cannot be
 * returned as a bare title. The model has to write down why the shortlist could not host
 * the segment, which is both the justification the plan asks for and the text a human reads
 * when the duplicate guard later overrules it.
 *
 * Exactly-one-of is NOT expressed as a Zod union: the AI SDK strips what providers cannot
 * enforce, unions degrade badly in JSON Schema, and a malformed pick would burn a ladder
 * rung on a shape the code can adjudicate for free. {@link routingDecisionSchema} carries
 * a `superRefine` so the violation is a *validation* failure — which is what the corrective
 * retry is for — rather than something the caller has to re-check.
 */
export const routingDecisionSchema = z
  .object({
    segmentKey: z
      .string()
      .describe("The segment's key, copied EXACTLY from the input. This is the join key."),
    assignToTopicId: z
      .string()
      .nullable()
      .describe(
        "The id of the existing topic this segment belongs to, chosen from that segment's candidate list. null ONLY if no candidate can host it.",
      ),
    createNewTitle: z
      .string()
      .nullable()
      .describe(
        "A title for a NEW topic, set only when assignToTopicId is null. Name the concept, not the lecture — 'Price Elasticity', never 'Session 7 Notes'.",
      ),
    rationale: z
      .string()
      .describe(
        "Why. For an assignment, why this candidate fits. For a new topic, why NONE of the candidates could host it — 'new detail about an existing concept' is NOT a valid reason to create one.",
      ),
    confidence: z
      .number()
      .describe("0..1. How sure you are. Be honest; low confidence is useful information."),
  })
  .superRefine((decision, ctx) => {
    const assigned = decision.assignToTopicId !== null && decision.assignToTopicId !== "";
    const created = decision.createNewTitle !== null && decision.createNewTitle !== "";
    if (assigned && created) {
      ctx.addIssue({
        code: "custom",
        message: `Segment "${decision.segmentKey}" set both assignToTopicId and createNewTitle. Set exactly one.`,
      });
    }
    if (!assigned && !created) {
      ctx.addIssue({
        code: "custom",
        message: `Segment "${decision.segmentKey}" set neither assignToTopicId nor createNewTitle. Set exactly one.`,
      });
    }
  });

export const routingBatchSchema = z.object({
  decisions: z
    .array(routingDecisionSchema)
    .describe("Exactly one decision per segment you were given, in the same order."),
});

export type RoutingDecision = z.infer<typeof routingDecisionSchema>;
export type RoutingBatch = z.infer<typeof routingBatchSchema>;

/* ────────────────────────────────────────────────────────────────────────── */
/* Step B — merge                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * A block the merge removed, and why.
 *
 * This field is what makes the loss-detector exact instead of heuristic. PLAN §5 Step B2
 * says a block that disappeared "without the `changeSummary` explicitly flagging it as
 * superseded" is a red flag — searching prose for a heading is a string match dressed up as
 * a check, so the claim is structured instead. Declaring a removal here is cheap and
 * honest; failing to declare one is a red flag that triggers the re-merge.
 */
export const blockRemovalSchema = z.object({
  blockKey: z
    .string()
    .describe(
      "The removed block's key, exactly as the input listed it in `currentBlockKeys` — e.g. 'note:pricing-intro' or 'keyTerm:price elasticity'.",
    ),
  reason: z
    .string()
    .describe(
      "Why it is gone. Only 'superseded by' reasons are legitimate — say what replaced it and where that content now lives.",
    ),
});

export const topicMergeSchema = z.object({
  title: z
    .string()
    .describe(
      "The topic's title. Keep the existing one unless this document shows it was plainly wrong.",
    ),
  page: topicPageSchema.describe("The COMPLETE new topic page — not a patch, not a diff."),
  changeSummary: z
    .string()
    .describe(
      "Two or three sentences a student reads in the history drawer: what this document added, refined, or superseded. Concrete — 'added the elasticity formula and two worked examples from Session 7', not 'updated the page'.",
    ),
  removals: z
    .array(blockRemovalSchema)
    .describe(
      "Every block from the current page that is NOT in your new page. [] means you kept every one of them — and that claim is checked automatically, so an undeclared removal will send this merge back to you.",
    ),
});

export type BlockRemoval = z.infer<typeof blockRemovalSchema>;
export type TopicMerge = z.infer<typeof topicMergeSchema>;

/* ────────────────────────────────────────────────────────────────────────── */
/* Step B2 — the critic                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/** PLAN §5 Step B2's three failure classes, plus the catch-all. */
export const CRITIC_ISSUE_KINDS = [
  "dropped-content",
  "unsupported-addition",
  "mangled-structure",
  "other",
] as const;

export const CRITIC_SEVERITIES = ["none", "minor", "major"] as const;

export const criticIssueSchema = z.object({
  kind: z
    .enum(CRITIC_ISSUE_KINDS)
    .describe(
      "'dropped-content' = meaningful material gone without justification; 'unsupported-addition' = a claim the segments do not support; 'mangled-structure' = the page's shape was damaged.",
    ),
  detail: z
    .string()
    .describe("What is wrong, specifically, naming the block or the claim. One or two sentences."),
  evidence: z
    .string()
    .describe(
      "Quote the text you are objecting to, or the text you say went missing. A claim without a quote is not actionable.",
    ),
});

export const mergeCriticSchema = z.object({
  ok: z
    .boolean()
    .describe(
      "true if this merge is safe to persist as-is. false if any 'major' issue exists. Be adversarial but not pedantic: rewording and reorganisation are the job, not defects.",
    ),
  severity: z
    .enum(CRITIC_SEVERITIES)
    .describe("'none' when ok; 'minor' for cosmetic concerns; 'major' when content was harmed."),
  issues: z
    .array(criticIssueSchema)
    .describe("Every problem found. [] when ok — an empty list is the common, correct answer."),
});

export type CriticIssue = z.infer<typeof criticIssueSchema>;
export type MergeCriticVerdict = z.infer<typeof mergeCriticSchema>;
