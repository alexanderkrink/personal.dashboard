/**
 * Applying a tracked, revertible edit to a topic page (PLAN §5 Step D, §8's History drawer).
 *
 * Both of item 5e's page-writing features need the same thing: change a topic page in a way
 * a student can see, understand and undo. The syllabus checklist adds a `gap` open question;
 * the deep-review audit adds note blocks, open questions and whole topics. Neither may
 * silently overwrite anything.
 *
 * ## The three rules every edit here obeys
 *
 * 1. **History before mutation.** The pre-edit page is snapshotted into `topic_revisions` at
 *    the topic's *current* revision number, and only then is `topics` updated with
 *    `revision + 1`. A crash between the two leaves a recoverable page rather than an
 *    overwritten one with no snapshot to revert to. Same ordering, and same reason, as
 *    `persistTopicMerge`.
 * 2. **Additive only.** Nothing in this module removes or rewrites an existing block. A
 *    finding from a second reader is a *proposal*; the merge pipeline's own output is the
 *    incumbent. PLAN is explicit that a "correction" is sometimes the audit being wrong, and
 *    an additive-only writer makes that impossible to get wrong by accident rather than by
 *    discipline.
 * 3. **Every revision is stamped and sourced.** `topic_revisions.source` distinguishes
 *    `merge` from `deep_review`, so the History drawer can say "Deep review added this
 *    section" rather than attributing it to the lecture, and the §3 five-column stamp
 *    records which prompt and model produced it.
 *
 * ## Why the revision counter can still be a plain increment
 *
 * Everything here runs inside `process-document`, which carries
 * `concurrency: [{ key: "event.data.courseId", limit: 1 }]` — measured, not assumed. Two
 * runs against one course serialize, so read-then-write on `topics.revision` is safe. If
 * that key is ever removed, this becomes a lost-update bug exactly as `route-and-merge` says.
 */

import type { OpenQuestion, StoredTopicPage } from "@study/ai";
import { EMPTY_TOPIC_PAGE, storedTopicPageSchema } from "@study/ai";
import type { SupabaseAdminClient } from "@study/db";

/** The §3 five-column stamp, as the revision row wants it. */
export interface RevisionStamp {
  readonly promptId: string;
  readonly promptVersion: number;
  readonly provider: string;
  readonly model: string;
  readonly inputHash: string;
}

/** What `topic_revisions.source` permits, minus `revert` which the UI owns. */
export type RevisionSource = "merge" | "deep_review";

/** One additive change to a page. Deliberately a small, closed set. */
export type TopicPageEdit =
  | { readonly kind: "open-question"; readonly question: OpenQuestion }
  | {
      readonly kind: "note";
      readonly id: string;
      readonly heading: string;
      readonly markdown: string;
      readonly documentId: string;
      readonly page: number;
    };

/**
 * Applies edits to a page, additively.
 *
 * Pure, so the merge semantics are testable without a database. Returns the page unchanged
 * when every edit is a duplicate, which is what makes a re-run of the calling step a no-op
 * rather than a page that grows a copy of the same block every time.
 */
export function applyEdits(
  page: StoredTopicPage,
  edits: readonly TopicPageEdit[],
): StoredTopicPage {
  let notes = page.notes;
  let openQuestions = page.openQuestions;

  for (const edit of edits) {
    if (edit.kind === "open-question") {
      // Deduplicated on the question text: the checklist and the audit can both legitimately
      // notice the same gap, and two identical open questions is noise a student reads twice.
      const exists = openQuestions.some(
        (existing) => existing.question.trim() === edit.question.question.trim(),
      );
      if (!exists) openQuestions = [...openQuestions, edit.question];
      continue;
    }

    // Block identity is the `id`, exactly as the loss-detector uses it. An edit whose id is
    // already on the page is dropped rather than appended — re-running the step must not
    // duplicate the block, and must not overwrite whatever the merger has since done to it.
    const exists = notes.some((block) => block.id === edit.id);
    if (exists) continue;

    notes = [
      ...notes,
      {
        id: edit.id,
        heading: edit.heading,
        markdown: edit.markdown,
        sources: [{ documentId: edit.documentId, page: edit.page }],
      },
    ];
  }

  if (notes === page.notes && openQuestions === page.openQuestions) return page;
  return { ...page, notes, openQuestions };
}

export interface ApplyTopicEditsInput {
  readonly admin: SupabaseAdminClient;
  readonly userId: string;
  readonly topicId: string;
  readonly documentId: string;
  readonly edits: readonly TopicPageEdit[];
  readonly changeSummary: string;
  readonly source: RevisionSource;
  readonly stamp: RevisionStamp;
  /** True when the edit is a flag for a human rather than settled content. */
  readonly needsReview?: boolean;
}

export interface ApplyTopicEditsResult {
  readonly changed: boolean;
  readonly revision: number;
}

/**
 * Reads a topic, applies the edits, and writes the snapshot and the new page.
 *
 * Returns `changed: false` without writing anything when the edits were all duplicates.
 * That matters more than it looks: without it, a retried step would bump `topics.revision`
 * and add a `topic_revisions` row on every attempt, filling a student's History drawer with
 * entries that changed nothing.
 */
export async function applyTopicEdits(input: ApplyTopicEditsInput): Promise<ApplyTopicEditsResult> {
  const { admin, userId, topicId } = input;

  const { data: row, error } = await admin
    .from("topics")
    .select("page, revision")
    .eq("id", topicId)
    .eq("user_id", userId)
    .single();

  if (error !== null || row === null) {
    throw new Error(`Could not load topic ${topicId}: ${error?.message ?? "no row"}`);
  }

  // Boundary rule: a stored page is an external input to every future version of this code.
  const parsed = storedTopicPageSchema.safeParse(row.page);
  const current: StoredTopicPage = parsed.success ? parsed.data : EMPTY_TOPIC_PAGE;
  const next = applyEdits(current, input.edits);

  if (next === current) return { changed: false, revision: row.revision };

  // (1) History first. A duplicate (topic_id, revision) means this exact step already ran
  // and its snapshot is stored — the re-run case, and not an error.
  const { error: revisionError } = await admin.from("topic_revisions").insert({
    user_id: userId,
    topic_id: topicId,
    revision: row.revision,
    page: current,
    change_summary: input.changeSummary,
    source: input.source,
    needs_review: input.needsReview ?? false,
    document_id: input.documentId,
    prompt_id: input.stamp.promptId,
    prompt_version: input.stamp.promptVersion,
    provider: input.stamp.provider,
    model: input.stamp.model,
    input_hash: input.stamp.inputHash,
  });

  if (revisionError !== null && revisionError.code !== "23505") {
    throw new Error(`Could not snapshot topic ${topicId}: ${revisionError.message}`);
  }

  // (2) The page itself.
  const { error: updateError } = await admin
    .from("topics")
    .update({ page: next, summary: next.summary, revision: row.revision + 1 })
    .eq("id", topicId)
    .eq("user_id", userId);

  if (updateError !== null) {
    throw new Error(`Could not update topic ${topicId}: ${updateError.message}`);
  }

  return { changed: true, revision: row.revision + 1 };
}

/** `Neural Networks` → `neural-networks`, uniquified against the course's taken slugs. */
export function slugFor(title: string, taken: ReadonlySet<string>): string {
  const base =
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "topic";

  if (!taken.has(base)) return base;
  for (let n = 2; n < 500; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface CreateAuditTopicInput {
  readonly admin: SupabaseAdminClient;
  readonly userId: string;
  readonly courseId: string;
  readonly documentId: string;
  readonly title: string;
  readonly summary: string;
  readonly markdown: string;
  readonly page: number;
  readonly takenSlugs: Set<string>;
  readonly stamp: RevisionStamp;
}

/**
 * Creates a topic from a `missing` audit finding.
 *
 * PLAN calls this "additive, safe, revertible". Additive and safe are properties of not
 * touching anything that exists; **revertible** is the one that takes work, and it is why a
 * `topic_revisions` row is written for a brand-new topic even though there is no prior page
 * to snapshot. The snapshot is the *empty* page, which is exactly what reverting this
 * creation means: the History drawer offers "revert" and reverting returns the topic to
 * having no content, labelled as having come from the deep review.
 *
 * ## Why this goes through `create_topic_with_first_revision`, at revision ZERO
 *
 * The same reasons as `persistTopicMerge`'s create branch, and one more:
 *
 * 1. **Atomicity.** Two PostgREST inserts are two transactions; a crash between them leaves
 *    a topic with no revision row — the state migration `20260720194417` exists to forbid.
 * 2. **Revision 0, not 1.** This function used to write its first revision at revision 1,
 *    which was a latent snapshot-loss bug: the NEXT merge into this topic reads
 *    `currentRevision = 1`, snapshots the pre-merge page at revision 1, collides with
 *    `unique (topic_id, revision)` — and `persistTopicMerge` swallows that 23505 as "this
 *    exact step already ran", silently discarding the only durable copy of the page as the
 *    audit wrote it. Revision 0 for the create keeps every later revision number free;
 *    `route-and-merge.test.ts` pins both halves of this.
 * 3. **`p_source: 'deep_review'`** (migration `20260720213410`) keeps the attribution the
 *    History drawer depends on — "Deep review added this topic", not a lecture — and keeps
 *    this row invisible to `loadPriorContributions`, which reads only `source = 'merge'`.
 */
export async function createAuditTopic(
  input: CreateAuditTopicInput,
): Promise<{ readonly topicId: string; readonly slug: string }> {
  const slug = slugFor(input.title, input.takenSlugs);

  const page: StoredTopicPage = {
    ...EMPTY_TOPIC_PAGE,
    summary: input.summary,
    notes: [
      {
        id: "deep-review-intro",
        heading: input.title,
        markdown: input.markdown,
        sources: [{ documentId: input.documentId, page: Math.max(1, input.page) }],
      },
    ],
  };

  const { data, error } = await input.admin.rpc("create_topic_with_first_revision", {
    p_user_id: input.userId,
    p_course_id: input.courseId,
    p_title: input.title,
    p_slug: slug,
    p_summary: input.summary,
    p_page: page,
    // The page this create superseded — empty, supplied by the app so the two never drift.
    p_previous_page: EMPTY_TOPIC_PAGE,
    p_change_summary: `Deep review added this topic: ${input.title}.`,
    p_needs_review: false,
    p_review_notes: [],
    p_document_id: input.documentId,
    p_prompt_id: input.stamp.promptId,
    p_prompt_version: input.stamp.promptVersion,
    p_provider: input.stamp.provider,
    p_model: input.stamp.model,
    p_input_hash: input.stamp.inputHash,
    p_source: "deep_review",
  });

  if (error !== null || data === null) {
    throw new Error(`Could not create topic “${input.title}”: ${error?.message ?? "no row"}`);
  }

  input.takenSlugs.add(slug);
  return { topicId: data, slug };
}
