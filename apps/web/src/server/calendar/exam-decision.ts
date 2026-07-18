/**
 * What a user's exam decision does to `calendar_items` — as a pure function.
 *
 * §5.1b gives the user three moves on a course's exam date: **set** this
 * session as the exam, **reject** the exam entirely, or **reset** back to
 * letting detection propose. This module turns one of those into the exact list
 * of row patches, and it exists as a separate pure function for one reason:
 *
 * ## 🔒 The one-candidate-per-course invariant is enforced HERE, not in the UI
 *
 * `is_exam_candidate` is a per-row boolean with no database constraint tying it
 * to at-most-one-per-course, and the read path (`buildExamStatuses`) assumes
 * exactly that. A UI that "only ever offers one choice" is not an enforcement
 * mechanism — a double submit, a stale page, or a sync racing a click all
 * produce two candidates, and the panel would then silently show whichever row
 * came back first.
 *
 * So `set` does not just flag the chosen row: it **clears every other flagged
 * row of the same course in the same operation**, and `planExamDecision` is
 * unit-tested to assert the invariant holds over its own output. The action
 * layer applies the patches; it does not decide them.
 *
 * ## How a decision is recorded, and why it needs no new column
 *
 * Two existing columns already carry the two facts, so this adds no migration
 * and no new `detection_source` enum value:
 *
 * - **`detection_source = 'manual'` + `is_exam_candidate = true`** — *the user
 *   chose this session.* No oracle writes `'manual'`; sync writes the oracle
 *   that answered (`syllabus_total_sessions`, …). So the value is unambiguous.
 * - **`is_exam_candidate` in `user_locked_fields` + `is_exam_candidate = false`**
 *   — *the user said this is not the exam.* Sync never writes a lock, so the
 *   lock is by construction a human's fingerprint. This is what makes a
 *   rejection distinguishable from "never touched", which a bare
 *   `is_exam_candidate = false` is not — and that indistinguishability is
 *   exactly why rejection used to vanish without trace.
 *
 * Every patch that records a decision also locks `is_exam_candidate`, so the
 * next sync cannot re-derive the flag (§3.3: *if the user edited it, sync never
 * writes it again*). `reset` is the one move that **removes** the lock — that is
 * what "go back to letting detection propose" means, and leaving the lock behind
 * would pin the row to the reset value forever, which is the opposite.
 */

import { withLockedField } from "./diff";

/** The column this module locks and unlocks. */
export const EXAM_CANDIDATE_FIELD = "is_exam_candidate";

/** The three moves a user has on a course's exam date. */
export type ExamDecision =
  /** This session is the exam. Every other session of the course stops being one. */
  | { intent: "set"; itemId: string }
  /** This course has no exam. Nothing of the course stays flagged. */
  | { intent: "reject"; itemId: string }
  /** Undo the decision entirely and let detection propose again. */
  | { intent: "reset" };

/** One `calendar_items` row, reduced to the columns a decision reads. */
export interface ExamDecisionItem {
  id: string;
  is_exam_candidate: boolean;
  detection_source: string | null;
  user_locked_fields: readonly string[];
}

/** One row update. Applied verbatim by the action; nothing else is written. */
export interface ExamItemPatch {
  id: string;
  is_exam_candidate: boolean;
  detection_source: string | null;
  user_locked_fields: string[];
}

/** True when the user has explicitly said "this session is the exam". */
export function isUserChosen(item: ExamDecisionItem): boolean {
  return item.is_exam_candidate && item.detection_source === "manual";
}

/** True when the user has explicitly said "this is not an exam". */
export function isUserRejected(item: ExamDecisionItem): boolean {
  return !item.is_exam_candidate && item.user_locked_fields.includes(EXAM_CANDIDATE_FIELD);
}

function unlocked(fields: readonly string[]): string[] {
  return fields.filter((field) => field !== EXAM_CANDIDATE_FIELD);
}

/** Emits a patch only when it actually changes the row — no no-op round trips. */
function changed(item: ExamDecisionItem, patch: Omit<ExamItemPatch, "id">): ExamItemPatch[] {
  const sameLocks =
    item.user_locked_fields.length === patch.user_locked_fields.length &&
    patch.user_locked_fields.every((field) => item.user_locked_fields.includes(field));

  if (
    item.is_exam_candidate === patch.is_exam_candidate &&
    item.detection_source === patch.detection_source &&
    sameLocks
  ) {
    return [];
  }
  return [{ id: item.id, ...patch }];
}

/**
 * Turns a decision into row patches over **all items of one course**.
 *
 * `items` must be the course's complete item list — that is what lets the
 * invariant be enforced rather than hoped for. Passing a subset would let a
 * flagged row outside the subset survive as a second candidate.
 */
export function planExamDecision(
  items: readonly ExamDecisionItem[],
  decision: ExamDecision,
): ExamItemPatch[] {
  if (decision.intent === "reset") {
    // Clear the decision AND the lock. Rows the user never touched are already
    // in this state and produce no patch.
    return items
      .filter((item) => item.user_locked_fields.includes(EXAM_CANDIDATE_FIELD))
      .flatMap((item) =>
        changed(item, {
          is_exam_candidate: false,
          detection_source: null,
          user_locked_fields: unlocked(item.user_locked_fields),
        }),
      );
  }

  const patches: ExamItemPatch[] = [];

  for (const item of items) {
    const isTarget = item.id === decision.itemId;

    if (decision.intent === "set" && isTarget) {
      patches.push(
        ...changed(item, {
          is_exam_candidate: true,
          detection_source: "manual",
          user_locked_fields: withLockedField(item.user_locked_fields, EXAM_CANDIDATE_FIELD),
        }),
      );
      continue;
    }

    // Everything that is not the chosen row is cleared — including rows the
    // detector flagged, rows a previous `set` chose, and (on `reject`) the
    // target itself. This sweep is the invariant: after `set` exactly one row
    // is flagged, after `reject` none is.
    //
    // A row that is already unflagged and untouched is left alone rather than
    // locked, so rejecting one course's exam does not quietly freeze thirty
    // ordinary lectures against future detection.
    const mustRecord = isTarget || item.is_exam_candidate || item.detection_source === "manual";
    if (!mustRecord) continue;

    patches.push(
      ...changed(item, {
        is_exam_candidate: false,
        detection_source: null,
        user_locked_fields: withLockedField(item.user_locked_fields, EXAM_CANDIDATE_FIELD),
      }),
    );
  }

  return patches;
}
