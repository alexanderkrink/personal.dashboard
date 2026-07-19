/**
 * The rolling sync horizon (§3.5).
 *
 * −30 days to +180 days, recomputed from `now` on **every** sync, which is what
 * makes the window roll forward on its own: the far edge advances a day each
 * day, so next semester's classes appear without anyone widening anything, and
 * the near edge lets last month stay readable without keeping the table
 * unbounded.
 *
 * Pure, and takes `now` as an argument, so a test can stand anywhere in time.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const HORIZON_PAST_DAYS = 30;
export const HORIZON_FUTURE_DAYS = 180;

export interface Horizon {
  fromUtc: string;
  toUtc: string;
}

export function calendarHorizon(now: Date): Horizon {
  return {
    fromUtc: new Date(now.getTime() - HORIZON_PAST_DAYS * DAY_MS).toISOString(),
    toUtc: new Date(now.getTime() + HORIZON_FUTURE_DAYS * DAY_MS).toISOString(),
  };
}
