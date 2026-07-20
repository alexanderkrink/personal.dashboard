/**
 * Participation pace and streak — the GRADED side of the ledger, measured
 * against `courses.participation_target` (contributions per session). The
 * attendance gate (attendance.ts) is a separate pass/fail concern; neither
 * reads the other.
 *
 * Input is one number per LOGGED session — a session enters the denominator by
 * having an attendance record, which is how "recorded silence" (attended,
 * contributed nothing, drags the pace down) stays distinct from "never logged"
 * (not in the array at all, moves nothing). That distinction is the whole
 * defence against the failure mode the plan names: participation grades dying
 * from three quiet, unmeasured weeks.
 *
 * Pure by construction: no I/O, no clock, no environment.
 */

export interface ParticipationPace {
  /** Logged sessions — the denominator. */
  sessions: number;
  /** Total contributions across them. */
  contributions: number;
  /** contributions / sessions; 0 when nothing is logged yet. */
  perSession: number;
  /** The per-session target, or null when the course has none. */
  target: number | null;
  /** perSession − target. Null without a target or without evidence. */
  delta: number | null;
  /**
   * Meeting the target EXACTLY is on pace — the target is "aim ≥ N", not
   * "beat N". Null when there is no target, and null on zero logged sessions:
   * an empty ledger is missing evidence, not a verdict of "behind".
   */
  onPace: boolean | null;
}

export function participationPace(
  sessionContributions: readonly number[],
  target?: number | null,
): ParticipationPace {
  for (const count of sessionContributions) {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(
        `session contribution counts must be non-negative integers, got ${count}`,
      );
    }
  }

  const resolvedTarget = target ?? null;
  if (resolvedTarget !== null && (!Number.isFinite(resolvedTarget) || resolvedTarget <= 0)) {
    throw new RangeError(`participation target must be a positive number, got ${resolvedTarget}`);
  }

  const sessions = sessionContributions.length;
  const contributions = sessionContributions.reduce((sum, n) => sum + n, 0);
  const perSession = sessions === 0 ? 0 : contributions / sessions;
  const hasEvidence = sessions > 0 && resolvedTarget !== null;

  return {
    sessions,
    contributions,
    perSession,
    target: resolvedTarget,
    delta: hasEvidence ? perSession - resolvedTarget : null,
    onPace: hasEvidence ? perSession >= resolvedTarget : null,
  };
}

/**
 * Consecutive contributing sessions counted back from the NEWEST session.
 * A streak is momentum, and momentum is only ever measured from now: after
 * [spoke, spoke, silent] the streak is 0, however strong last week looked.
 */
export function contributionStreak(sessionContributions: readonly number[]): number {
  let streak = 0;
  for (let i = sessionContributions.length - 1; i >= 0; i -= 1) {
    const count = sessionContributions[i];
    if (count === undefined || count < 1) break;
    streak += 1;
  }
  return streak;
}
