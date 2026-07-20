import type { FlushOutcome } from "@study/core";

/**
 * Classify one ledger write's error into the queue's three outcomes.
 *
 * The split decides whether a tap is retried or surfaced-and-dropped, and both
 * directions of getting it wrong lose graded data: call a transient error
 * "rejected" and a wifi blip silently discards a contribution; call a
 * constraint violation "failed" and the queue wedges forever behind an entry
 * the database will never take.
 *
 * So the default direction is the design: **only errors proven permanent are
 * rejected; everything else stays queued.** An unrecognised SQLSTATE, an
 * expired JWT (PGRST301 — re-login fixes it), a statement timeout, a missing
 * code entirely — all "failed", all retried.
 */

/** The shape shared by PostgrestError and anything else with a SQLSTATE. */
export interface LedgerWriteError {
  code?: string | null;
}

/**
 * SQLSTATEs that no retry can ever fix — the entry itself is unwritable:
 * 23502 not-null, 23503 FK (the occurrence is gone, or was never this
 * tenant's — the composite-FK refusal surfaces as this code), 23514 check
 * (bad kind/quality/status), 22P02 malformed uuid, 42501 explicit RLS refusal.
 */
const REJECTED_CODES = new Set(["23502", "23503", "23514", "22P02", "42501"]);

export function flushOutcomeForError(error: LedgerWriteError | null | undefined): FlushOutcome {
  if (!error) return "delivered";
  // Duplicate key: the row is already there. This is the idempotent-replay
  // path working — half a batch landed before the connection died, the whole
  // batch was replayed, and the survivors answer 23505.
  if (error.code === "23505") return "delivered";
  if (typeof error.code === "string" && REJECTED_CODES.has(error.code)) return "rejected";
  return "failed";
}
