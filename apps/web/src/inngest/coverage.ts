/**
 * The `coverage` step (PLAN §5 *Completeness & coverage*, §8's terminal card).
 *
 * Two halves that answer two different questions, and the split between them is the design:
 *
 * | | asks | how |
 * | --- | --- | --- |
 * | **coverage map** | "did any of this document fail to reach a page?" | deterministic, free |
 * | **syllabus checklist** | "does the *course* still miss something it must teach?" | one Flash-Lite call |
 *
 * The first is the honest one and it runs always. It is pure arithmetic in `@study/core`
 * over three inputs — the file's own page count, what the extractor returned, and which
 * pages actually reached a topic via `topic_sources` — and it is written to assume the
 * extractor's `skipped[]` ledger is *unaudited*, because it is. See `packages/core`'s
 * `coverage.ts` for what that defensiveness costs and buys.
 *
 * The second only runs when the course has a syllabus, and it is the "importance oracle":
 * page counts cannot tell you that the one concept nobody uploaded slides for is the one the
 * exam is on. A syllabus can.
 *
 * ## Where an uncovered objective goes
 *
 * ⚠ PLAN says "Uncovered objectives surface as `openQuestions` of `kind: 'gap'`", and that
 * is only implementable for *partially* covered ones. `openQuestions` is a field on
 * `topics.page`, so an open question needs a topic page to live on — and an objective with
 * **no** covering topic has, by definition, no page. Writing it onto an arbitrary nearby
 * topic would file a warning about concept A on the page for concept B, which is worse than
 * not filing it.
 *
 * So the split, recorded as a ⚠ CORRECTED note in PLAN §5:
 * - `partial` → a real `gap` open question on the covering topic, as a tracked revision.
 *   This is the case the plan describes and it works exactly as written.
 * - `none` → `documents.coverage.missingObjectives`, which §8's terminal card already
 *   promises to render ("click to see the gaps **and any syllabus objectives still
 *   missing**"). It is the same product surface, reached the only way it can be.
 */

import type { CompletenessTopic } from "@study/ai";
import { checkSyllabusCoverage, storedExtractionSchema } from "@study/ai";
import { type CoverageMap, computeCoverage, coverageSummary } from "@study/core";
import type { Json, SupabaseAdminClient } from "@study/db";
import { logProcessingEvent } from "@/inngest/documents";
import { applyTopicEdits } from "@/inngest/topic-edits";
import type { createStudyAIRuntime } from "@/lib/ai/runtime";

/** How much syllabus text the checklist call is given. Generous — §5.1b's table sits deep. */
const MAX_SYLLABUS_CHARS = 120_000;

export interface CoverageInput {
  readonly admin: SupabaseAdminClient;
  readonly userId: string;
  readonly documentId: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly runtime: ReturnType<typeof createStudyAIRuntime>;
}

export interface CoverageSummaryResult {
  readonly map: CoverageMap;
  readonly summary: string;
  /** Objectives checked. 0 when the course has no syllabus. */
  readonly objectivesChecked: number;
  readonly objectivesMissing: number;
  /** `gap` open questions written onto covering topics for partial coverage. */
  readonly gapsFiled: number;
  readonly elapsedMs: number;
}

/**
 * Reads the syllabus this course has, if it has one.
 *
 * A syllabus is an ordinary `documents` row with `kind = 'syllabus'` that has been through
 * the pipeline, so its text is in `documents.extraction`. The most recently processed one
 * wins: a course that has had two syllabi uploaded has been re-issued one, and the newer
 * document is the authority.
 */
async function loadSyllabusText(
  admin: SupabaseAdminClient,
  userId: string,
  courseId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("documents")
    .select("extraction, processed_at")
    .eq("user_id", userId)
    .eq("course_id", courseId)
    .eq("kind", "syllabus")
    .not("extraction", "is", null)
    .order("processed_at", { ascending: false, nullsFirst: false })
    .limit(1);

  if (error !== null || data === null || data.length === 0) return null;

  const row = data[0];
  if (row === undefined) return null;

  // Boundary rule: through the schema, never through a cast.
  const parsed = storedExtractionSchema.safeParse(row.extraction);
  if (!parsed.success) return null;

  const text = parsed.data.extraction.pages
    .map((page) => `[p.${page.page}] ${page.title ?? ""}\n${page.markdown}`)
    .join("\n\n")
    .slice(0, MAX_SYLLABUS_CHARS);

  return text.trim() === "" ? null : text;
}

/** Every topic of the course, as the checklist's index. */
async function loadTopics(
  admin: SupabaseAdminClient,
  userId: string,
  courseId: string,
): Promise<{ topics: CompletenessTopic[]; count: number }> {
  const { data } = await admin
    .from("topics")
    .select("id, title, summary, page")
    .eq("user_id", userId)
    .eq("course_id", courseId);

  const rows = data ?? [];
  const topics = rows.map((row) => {
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

  return { topics, count: rows.length };
}

/**
 * Which pages of this document actually reached a topic page.
 *
 * Read from `topic_sources.locators` rather than from the merge step's in-process result,
 * for the reason `extract` gives about costs: that table is the persisted truth about what
 * this document contributed, and if the two disagree the table is right. It is also what
 * makes the coverage map correct after a *partial* run — the pages of a topic that failed to
 * merge genuinely did not reach a page, and reading the table reports that rather than the
 * intention.
 */
async function loadMappedPages(
  admin: SupabaseAdminClient,
  userId: string,
  documentId: string,
): Promise<{ pages: number[]; topicCount: number }> {
  const { data } = await admin
    .from("topic_sources")
    .select("topic_id, locators")
    .eq("user_id", userId)
    .eq("document_id", documentId);

  const rows = data ?? [];
  const pages = new Set<number>();
  for (const row of rows) {
    const locators = row.locators as { page?: unknown }[] | null;
    for (const locator of locators ?? []) {
      if (typeof locator.page === "number" && Number.isInteger(locator.page)) {
        pages.add(locator.page);
      }
    }
  }

  return { pages: [...pages].sort((a, b) => a - b), topicCount: rows.length };
}

/**
 * `CoverageMap` → the `jsonb` value that goes in `documents.coverage`.
 *
 * Written out field by field rather than cast, and that is worth a note because a cast is
 * two characters shorter and would compile. `CoverageMap` is an `interface` with `readonly`
 * arrays, so it is not assignable to the generated `Json` type — interfaces get no implicit
 * index signature and `readonly T[]` is not a `Json[]`. That is a genuine type error, not a
 * technicality: the compiler is pointing out that a pure-core value and a database column
 * are different things, and this is the boundary between them.
 *
 * Spelling the mapping out means adding a field to `CoverageMap` without deciding whether it
 * is persisted is a **compile error** rather than a silent schema change to a column the UI
 * reads. `as unknown as Json` would have made every future field persist by accident.
 */
function coverageToJson(map: CoverageMap): Json {
  return {
    checked: map.checked,
    pagesTotal: map.pagesTotal,
    pagesMapped: map.pagesMapped,
    pagesSkipped: map.pagesSkipped,
    pagesUndeclared: map.pagesUndeclared,
    pagesUnmapped: map.pagesUnmapped,
    topicCount: map.topicCount,
    trustworthy: map.trustworthy,
    gaps: map.gaps.map((gap) => ({
      fromPage: gap.fromPage,
      toPage: gap.toPage,
      kind: gap.kind,
      reason: gap.reason,
    })),
    warnings: [...map.warnings],
    missingObjectives: [...map.missingObjectives],
  };
}

export async function runCoverage(input: CoverageInput): Promise<CoverageSummaryResult> {
  const { admin, userId, documentId, courseId } = input;
  const startedAt = Date.now();

  await logProcessingEvent(admin, {
    userId,
    documentId,
    courseId,
    step: "coverage",
    detail: "Checking coverage.",
  });

  // ── The deterministic half ────────────────────────────────────────────────
  const { data: row, error } = await admin
    .from("documents")
    .select("extraction")
    .eq("id", documentId)
    .eq("user_id", userId)
    .single();

  if (error) throw new Error(`Could not read the extraction for ${documentId}: ${error.message}`);

  const parsed = storedExtractionSchema.safeParse(row.extraction);
  if (!parsed.success) {
    throw new Error(
      `documents.extraction for ${documentId} did not match storedExtractionSchema: ${parsed.error.message}`,
    );
  }
  const stored = parsed.data;

  const mapped = await loadMappedPages(admin, userId, documentId);

  // ── The syllabus checklist, when there is a syllabus ──────────────────────
  const syllabusText = await loadSyllabusText(admin, userId, courseId);
  const { topics } = await loadTopics(admin, userId, courseId);

  let objectivesChecked = 0;
  let objectivesMissing = 0;
  let gapsFiled = 0;
  const missingObjectives: string[] = [];

  if (syllabusText !== null && topics.length > 0) {
    const verdict = await checkSyllabusCoverage({
      runtime: input.runtime,
      courseTitle: input.courseTitle,
      topics,
      syllabusText,
    });

    if (verdict.status === "dead-letter") {
      // Not fatal, and not even degrading. The deterministic map is the load-bearing half of
      // this step; the checklist is an enrichment, and a document whose page coverage is
      // perfectly measured should not be marked `partial` because an optional Flash-Lite
      // call failed.
      await logProcessingEvent(admin, {
        userId,
        documentId,
        courseId,
        step: "coverage",
        level: "warn",
        detail:
          "Couldn’t check your notes against the course syllabus this time. Page coverage below is unaffected.",
      });
    } else {
      const known = new Set(topics.map((topic) => topic.id));
      objectivesChecked = verdict.value.objectives.length;

      for (const objective of verdict.value.objectives) {
        if (objective.coverage === "full") continue;

        // A topic id the model invented cannot be written to. An objective claiming a
        // partial match against a non-existent page is treated as uncovered, which is the
        // conservative direction: it surfaces on the card rather than vanishing.
        const topicId =
          objective.topicId !== null && known.has(objective.topicId) ? objective.topicId : null;

        if (objective.coverage === "none" || topicId === null) {
          objectivesMissing += 1;
          missingObjectives.push(objective.objective);
          continue;
        }

        // `partial` with a real topic — the case PLAN describes, filed as a `gap` open
        // question on the page that partly covers it.
        try {
          const applied = await applyTopicEdits({
            admin,
            userId,
            topicId,
            documentId,
            edits: [
              {
                kind: "open-question",
                question: {
                  question: `The syllabus expects: “${objective.objective}”. This page covers it only partly.`,
                  context: objective.detail,
                  kind: "gap",
                  sources: [],
                },
              },
            ],
            changeSummary: `Coverage check: flagged a syllabus objective this page only partly covers.`,
            source: "merge",
            needsReview: true,
            stamp: {
              promptId: verdict.stamp.promptId,
              promptVersion: verdict.stamp.promptVersion,
              provider: verdict.stamp.provider,
              model: verdict.stamp.model,
              inputHash: verdict.stamp.inputHash,
            },
          });
          if (applied.changed) gapsFiled += 1;
        } catch (gapError) {
          // One page failing to take a flag must not lose the rest of the checklist.
          console.error(`[coverage] could not file a gap on topic ${topicId}:`, gapError);
        }
      }
    }
  }

  // ── Assemble, persist, narrate ────────────────────────────────────────────
  const map = computeCoverage({
    sourceUnits: stored.sourceUnits,
    extractedPages: stored.extraction.pages.map((page) => page.page),
    skipped: stored.extraction.skipped,
    mappedPages: mapped.pages,
    topicCount: mapped.topicCount,
    missingObjectives,
  });

  const summary = coverageSummary(map);

  const { error: writeError } = await admin
    .from("documents")
    .update({ coverage: coverageToJson(map) })
    .eq("id", documentId)
    .eq("user_id", userId);

  if (writeError !== null) {
    throw new Error(`Could not store coverage for ${documentId}: ${writeError.message}`);
  }

  await logProcessingEvent(admin, {
    userId,
    documentId,
    courseId,
    step: "coverage",
    // An untrustworthy map is a warning even when the numbers look fine, because that is
    // precisely the case a reassuring number would hide.
    level: map.trustworthy ? "info" : "warn",
    detail: `${summary}.${map.warnings.length === 0 ? "" : ` ${map.warnings[0]}`}${
      objectivesMissing === 0
        ? ""
        : ` ${objectivesMissing} syllabus objective${objectivesMissing === 1 ? " has" : "s have"} no page yet.`
    }`,
  });

  return {
    map,
    summary,
    objectivesChecked,
    objectivesMissing,
    gapsFiled,
    elapsedMs: Date.now() - startedAt,
  };
}
