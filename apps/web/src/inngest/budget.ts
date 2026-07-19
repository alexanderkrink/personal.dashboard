/**
 * The per-document money guard (PLAN "Document & Notes Pipeline" §7).
 *
 * > **Money guard:** per-document LLM spend estimated from token usage and logged to
 * > processing events; a document exceeding a sanity ceiling (~$5) aborts with `failed`
 * > rather than looping.
 *
 * This is a **different** guard from `packages/ai`'s §6 budget guard, and the distinction is
 * worth stating because having two is otherwise redundant-looking:
 *
 * | | §6 `guardDecision` | this |
 * | --- | --- | --- |
 * | scope | the month, across the whole product | one document, one run |
 * | question | "can we afford more work?" | "has this document gone wrong?" |
 * | failure mode it catches | a busy month | a **loop** — a pathological file re-reading itself |
 *
 * A document that has spent $5 has not merely been expensive; something about it is
 * wrong — a 600-page book routed into 200 topics, an extraction that produced a page of
 * garbage the merger keeps trying to integrate. The measured envelope is ~$0.25 per
 * document against §10's $0.43–0.76, so the ceiling sits roughly **twenty times** a normal
 * document. It is a fuse for a fault, not a budget.
 *
 * ## What it measures, and why it over-reports
 *
 * Spend is read back from `ai_generations` rather than accumulated in process, for the
 * reason `extract` gives: that table is what §6 bills against, so if the two disagree the
 * table is right and the in-memory number is a story.
 *
 * `ai_generations` has no `document_id`, so the query is scoped by user, by the pipeline's
 * own job set, and by *this run's start time*. Two documents in the same course cannot
 * overlap — the function's `concurrency: [{ key: "event.data.courseId", limit: 1 }]`
 * serializes them, measured at 1.48 s apart rather than in parallel — but two documents in
 * **different** courses can, and this will then attribute some of one to the other.
 *
 * That over-reports rather than under-reports, which is the correct direction for a fuse: a
 * guard that occasionally trips early on a genuinely expensive pair of simultaneous uploads
 * is a nuisance, while one that misses a runaway is the thing it was built to prevent.
 * Stated here rather than fixed, because fixing it properly means a `document_id` column on
 * `ai_generations` and a migration that touches the hottest table in the product.
 */

import type { SupabaseAdminClient } from "@study/db";
import { NonRetriableError } from "inngest";
import { logProcessingEvent, setDocumentStatus } from "@/inngest/documents";

/**
 * §7's sanity ceiling. Measured normal is ~$0.25/document, so this is ~20×.
 *
 * Deliberately not derived from `AI_MONTHLY_BUDGET_USD`: that is a *budget*, and this is a
 * *fault detector*. Tying them would mean a user who raised their monthly budget silently
 * raised the threshold at which a looping document gets stopped, which is backwards.
 */
export const DOCUMENT_SPEND_CEILING_USD = 5;

/** Every job the document pipeline can spend on. Kept explicit so a new job is a decision. */
export const PIPELINE_JOBS = [
  "doc-structuring",
  "topic-routing",
  "topic-merge",
  "merge-critic",
  "coverage-checklist",
  "deep-review-audit",
  "embed-segment",
  "embed-topic-title",
  "embed-topic-summary",
  "embed-chunk",
] as const;

export interface DocumentSpend {
  /** USD attributable to this run. A LOWER BOUND when `unpriced > 0`. */
  readonly costUsd: number;
  /** Attempts in this window the rollup could not price. Real spend, unknown amount. */
  readonly unpriced: number;
}

/**
 * What this run has spent so far.
 *
 * Returns a reading rather than a bare number, mirroring `SpendReading` in `packages/ai`
 * and for the same reason: a caller that only has a sum cannot tell "cheap" apart from
 * "unmeasured", and this one has to be able to.
 */
export async function documentSpend(
  admin: SupabaseAdminClient,
  userId: string,
  runStartedAt: string,
): Promise<DocumentSpend> {
  const { data, error } = await admin
    .from("ai_generations")
    .select("cost_usd")
    .eq("user_id", userId)
    .in("job", [...PIPELINE_JOBS])
    .gte("created_at", runStartedAt);

  // A failed read must not stop a document. The guard exists to catch a runaway, and a
  // transient PostgREST error is not one — reporting zero lets the run continue and the
  // next checkpoint re-reads.
  if (error !== null || data === null) return { costUsd: 0, unpriced: 0 };

  let costUsd = 0;
  let unpriced = 0;
  for (const row of data) {
    if (row.cost_usd === null) unpriced += 1;
    else costUsd += row.cost_usd;
  }
  return { costUsd, unpriced };
}

/**
 * Thrown when a document blows the ceiling. Non-retriable, and that is the whole point.
 *
 * §7 says the document "aborts with `failed` rather than looping". A retriable error would
 * hand it back to Inngest, which would run the same expensive document twice more — turning
 * a $5 fault into a $15 one through the very mechanism meant to stop it.
 */
export class DocumentBudgetExceededError extends NonRetriableError {
  constructor(
    readonly documentId: string,
    readonly spentUsd: number,
  ) {
    super(
      `Document ${documentId} spent $${spentUsd.toFixed(4)}, over the $${DOCUMENT_SPEND_CEILING_USD} per-document ceiling (PLAN §7). Aborted rather than continuing.`,
    );
    this.name = "DocumentBudgetExceededError";
  }
}

export interface BudgetCheckpointInput {
  readonly admin: SupabaseAdminClient;
  readonly userId: string;
  readonly documentId: string;
  readonly courseId: string;
  readonly runStartedAt: string;
  /** Where in the pipeline this check is, for the feed line. */
  readonly stage: string;
}

/**
 * A checkpoint. Reads the spend, logs it, and aborts the document if it is over the ceiling.
 *
 * Called *between* steps rather than inside them, so the abort happens before the next
 * expensive call rather than after it. Returns the reading so the caller can put it in the
 * run's summary.
 */
export async function budgetCheckpoint(input: BudgetCheckpointInput): Promise<DocumentSpend> {
  const spend = await documentSpend(input.admin, input.userId, input.runStartedAt);

  if (spend.costUsd <= DOCUMENT_SPEND_CEILING_USD) return spend;

  const message =
    `This file cost far more to process than a document should ($${spend.costUsd.toFixed(2)}), so it was stopped ` +
    "before it could spend more. That usually means it's much larger or more unusual than it looks — " +
    "try splitting it into smaller files.";

  // The row carries a sentence a person can read (§8), never the error text.
  await setDocumentStatus(input.admin, input.documentId, input.userId, {
    status: "failed",
    failureReason: message,
  });
  await logProcessingEvent(input.admin, {
    userId: input.userId,
    documentId: input.documentId,
    courseId: input.courseId,
    step: "budget",
    level: "error",
    detail: message,
  });

  throw new DocumentBudgetExceededError(input.documentId, spend.costUsd);
}
