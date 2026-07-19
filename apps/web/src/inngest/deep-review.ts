/**
 * Step D — the opt-in deep-review audit (PLAN §5 *Step D*, M1 item 5e).
 *
 * > After the normal pipeline finishes, an extra Inngest step runs an **independent second
 * > reader** on a *different model family from the Gemini extractor* (`claude-opus-4-8`)
 * > with a *different* objective — "list the concepts a student must know from this
 * > material" — and reconciles that list against the topics just built.
 *
 * Runs only when `documents.deep_review = 'requested'` (the upload dialog's toggle). At
 * ~$0.80–2.00 on a big book it is deliberately not a default.
 *
 * ## The risk split is the feature
 *
 * PLAN divides the findings by how much damage a wrong one could do, and this module's whole
 * shape is that division:
 *
 * | verdict | applied as | if the audit is wrong |
 * | --- | --- | --- |
 * | `missing` | a **new topic** | a spurious page, revertible, costs a scroll |
 * | `refine` | an **appended note block** | a redundant section, revertible, visible |
 * | `conflict` | an **`openQuestion`** | a student reads a disagreement and decides |
 * | `covered` | nothing | nothing |
 *
 * **No verdict overwrites anything.** A "correction" is sometimes the audit being wrong —
 * the pages were built from this document *and others*, and a later session legitimately
 * refines an earlier one — so a contradiction is surfaced with both sides rather than
 * resolved by whichever model spoke last. `topic-edits.ts` enforces that structurally: it
 * has no code path that removes or rewrites a block.
 *
 * ## One tracked, revertible batch
 *
 * Every change goes through `applyTopicEdits` / `createAuditTopic` with
 * `topic_revisions.source = 'deep_review'`, so the History drawer attributes them correctly
 * ("Deep review added this section") and each is individually revertible. The status card
 * gets "Deep review changed N things" from the count this returns.
 */

import type { AuditFinding, CompletenessTopic } from "@study/ai";
import { auditDocument, storedExtractionSchema } from "@study/ai";
import type { SupabaseAdminClient } from "@study/db";
import { logProcessingEvent } from "@/inngest/documents";
import { applyTopicEdits, createAuditTopic, type RevisionStamp } from "@/inngest/topic-edits";
import type { createStudyAIRuntime } from "@/lib/ai/runtime";

/**
 * How much of the document the auditor is shown.
 *
 * Opus 4.8's context is far larger than this; the cap is a *cost* control, not a capability
 * one. §10 budgets the audit at $0.80–2.00 and input tokens are the term that scales with
 * document size, so a 600-page book gets its first ~150K characters rather than an
 * open-ended bill. Stated as a known limitation: on a very large book this audits the front
 * of it. Splitting a book into per-chapter audits is the right answer and is not M1.
 */
const MAX_MATERIAL_CHARS = 150_000;

export interface DeepReviewInput {
  readonly admin: SupabaseAdminClient;
  readonly userId: string;
  readonly documentId: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly filename: string;
  readonly sessionLabel: string | null;
  readonly runtime: ReturnType<typeof createStudyAIRuntime>;
}

export interface DeepReviewSummary {
  readonly ran: boolean;
  readonly conceptsReviewed: number;
  readonly topicsCreated: number;
  readonly refinementsApplied: number;
  readonly conflictsRaised: number;
  /** What the status card counts: "Deep review changed N things". */
  readonly changes: number;
  readonly note: string | null;
  readonly elapsedMs: number;
}

const NOTHING: Omit<DeepReviewSummary, "elapsedMs"> = {
  ran: false,
  conceptsReviewed: 0,
  topicsCreated: 0,
  refinementsApplied: 0,
  conflictsRaised: 0,
  changes: 0,
  note: null,
};

/** A stable, content-derived block id, so a re-run appends nothing the first run added. */
function auditBlockId(concept: string): string {
  const slug =
    concept
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "concept";
  return `deep-review-${slug}`;
}

/** Renders the document's pages as the material the auditor reads. */
function renderMaterial(
  pages: readonly { page: number; title: string | null; markdown: string }[],
): string {
  return pages
    .map((page) => {
      const title = (page.title ?? "").trim();
      return `[p.${page.page}]${title === "" ? "" : ` ${title}`}\n${page.markdown}`;
    })
    .join("\n\n")
    .slice(0, MAX_MATERIAL_CHARS);
}

export async function runDeepReview(input: DeepReviewInput): Promise<DeepReviewSummary> {
  const { admin, userId, documentId, courseId } = input;
  const startedAt = Date.now();

  // ── Is it even requested? ─────────────────────────────────────────────────
  const { data: document, error } = await admin
    .from("documents")
    .select("deep_review, extraction")
    .eq("id", documentId)
    .eq("user_id", userId)
    .single();

  if (error !== null || document === null) {
    throw new Error(`Could not read ${documentId}: ${error?.message ?? "no row"}`);
  }

  // `'done'` is as much a skip as `'off'`: this step is re-entered on every retry of the
  // run, and a second Opus pass over a document that already had one is a pure duplicate
  // bill. The state machine is the idempotency key here, exactly as `content_hash` is for
  // re-uploads.
  if (document.deep_review !== "requested") {
    return { ...NOTHING, elapsedMs: Date.now() - startedAt };
  }

  const parsed = storedExtractionSchema.safeParse(document.extraction);
  if (!parsed.success) {
    return { ...NOTHING, elapsedMs: Date.now() - startedAt };
  }

  await admin
    .from("documents")
    .update({ deep_review: "running" })
    .eq("id", documentId)
    .eq("user_id", userId);

  await logProcessingEvent(admin, {
    userId,
    documentId,
    courseId,
    step: "deep-review",
    detail: "Reading this again as a second opinion, to check nothing important was missed.",
  });

  // ── The topic index the audit reconciles against ──────────────────────────
  const { data: topicRows } = await admin
    .from("topics")
    .select("id, title, summary, slug, page")
    .eq("user_id", userId)
    .eq("course_id", courseId);

  const topics: CompletenessTopic[] = (topicRows ?? []).map((row) => {
    const page = row.page as { keyTerms?: { term?: string }[] } | null;
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      keyTerms: (page?.keyTerms ?? [])
        .map((term) => term.term)
        .filter((term): term is string => typeof term === "string")
        .slice(0, 8),
    };
  });

  const takenSlugs = new Set((topicRows ?? []).map((row) => row.slug));
  const known = new Set(topics.map((topic) => topic.id));

  // ── The one Opus call ─────────────────────────────────────────────────────
  const verdict = await auditDocument({
    runtime: input.runtime,
    courseTitle: input.courseTitle,
    documentLabel: input.filename,
    sessionLabel: input.sessionLabel,
    topics,
    material: renderMaterial(parsed.data.extraction.pages),
  });

  if (verdict.status === "dead-letter") {
    // Terminal for the audit, not for the document. The pipeline already produced the topic
    // pages; a failed *optional* second opinion must not turn a `ready` document into a
    // `partial` one, so this returns rather than degrading.
    await admin
      .from("documents")
      .update({ deep_review: "requested" })
      .eq("id", documentId)
      .eq("user_id", userId);

    await logProcessingEvent(admin, {
      userId,
      documentId,
      courseId,
      step: "deep-review",
      level: "warn",
      detail:
        "The second-opinion review couldn’t be completed this time. Your topic pages are finished and unaffected — retry the document to try the review again.",
    });

    return { ...NOTHING, ran: true, elapsedMs: Date.now() - startedAt };
  }

  const stamp: RevisionStamp = {
    promptId: verdict.stamp.promptId,
    promptVersion: verdict.stamp.promptVersion,
    provider: verdict.stamp.provider,
    model: verdict.stamp.model,
    inputHash: verdict.stamp.inputHash,
  };

  // ── Apply, split by risk ──────────────────────────────────────────────────
  let topicsCreated = 0;
  let refinementsApplied = 0;
  let conflictsRaised = 0;

  const findings: readonly AuditFinding[] = verdict.value.concepts;

  for (const finding of findings) {
    if (finding.verdict === "covered") continue;

    // An id the model invented cannot be written to — the same rule `planMerges` applies,
    // and for the same reason: the alternative is writing into a row named by a
    // model-generated uuid through the RLS-bypassing admin client.
    const topicId = finding.topicId !== null && known.has(finding.topicId) ? finding.topicId : null;

    try {
      if (finding.verdict === "missing") {
        const markdown = (finding.markdown ?? "").trim();
        // A `missing` finding with no material is a claim without content. Creating an
        // empty topic page from it would put a heading with nothing under it in front of a
        // student, which reads as a bug rather than as a gap.
        if (markdown === "") continue;

        const created = await createAuditTopic({
          admin,
          userId,
          courseId,
          documentId,
          title: finding.concept,
          summary: finding.detail,
          markdown,
          page: finding.page,
          takenSlugs,
          stamp,
        });
        known.add(created.topicId);
        topicsCreated += 1;
        continue;
      }

      if (topicId === null) continue;

      if (finding.verdict === "refine") {
        const markdown = (finding.markdown ?? "").trim();
        if (markdown === "") continue;

        const applied = await applyTopicEdits({
          admin,
          userId,
          topicId,
          documentId,
          edits: [
            {
              kind: "note",
              id: auditBlockId(finding.concept),
              heading: finding.concept,
              markdown,
              documentId,
              page: Math.max(1, finding.page),
            },
          ],
          // §5's "glanceable change summary, never a silent overwrite". This string is what
          // the History drawer shows.
          changeSummary: `Deep review added detail on ${finding.concept}: ${finding.detail}`,
          source: "deep_review",
          stamp,
        });
        if (applied.changed) refinementsApplied += 1;
        continue;
      }

      // `conflict` — recorded, never resolved.
      const applied = await applyTopicEdits({
        admin,
        userId,
        topicId,
        documentId,
        edits: [
          {
            kind: "open-question",
            question: {
              question: `Deep review disagrees with this page about ${finding.concept}.`,
              context: `${finding.detail} The material says: “${finding.evidence}” (p.${finding.page}).`,
              kind: "conflict",
              sources: [{ documentId, page: Math.max(1, finding.page) }],
            },
          },
        ],
        changeSummary: `Deep review flagged a possible contradiction about ${finding.concept}. Nothing was overwritten.`,
        source: "deep_review",
        // A conflict is by definition unsettled, so the page carries the review chip.
        needsReview: true,
        stamp,
      });
      if (applied.changed) conflictsRaised += 1;
    } catch (applyError) {
      // One finding failing to apply must not lose the rest of the audit — the same
      // per-item isolation §7 asks of the merge step.
      console.error(
        `[deep-review] could not apply “${finding.concept}” (${finding.verdict}) for ${documentId}:`,
        applyError,
      );
    }
  }

  const changes = topicsCreated + refinementsApplied + conflictsRaised;

  await admin
    .from("documents")
    .update({ deep_review: "done", deep_reviewed_at: new Date().toISOString() })
    .eq("id", documentId)
    .eq("user_id", userId);

  await logProcessingEvent(admin, {
    userId,
    documentId,
    courseId,
    step: "deep-review",
    level: conflictsRaised > 0 ? "warn" : "info",
    detail:
      changes === 0
        ? `Second opinion: reviewed ${findings.length} concept${findings.length === 1 ? "" : "s"} and found nothing missing. ${verdict.value.summary}`
        : `Deep review changed ${changes} thing${changes === 1 ? "" : "s"}${
            topicsCreated === 0
              ? ""
              : ` — ${topicsCreated} new topic${topicsCreated === 1 ? "" : "s"}`
          }${refinementsApplied === 0 ? "" : `, ${refinementsApplied} page${refinementsApplied === 1 ? "" : "s"} expanded`}${
            conflictsRaised === 0
              ? ""
              : `, ${conflictsRaised} possible contradiction${conflictsRaised === 1 ? "" : "s"} flagged`
          }. ${verdict.value.summary}`,
  });

  return {
    ran: true,
    conceptsReviewed: findings.length,
    topicsCreated,
    refinementsApplied,
    conflictsRaised,
    changes,
    note: verdict.value.summary,
    elapsedMs: Date.now() - startedAt,
  };
}
