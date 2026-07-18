/**
 * The §7 week window, computed in the user's timezone.
 *
 * §7 defines "this week" as **Mon 00:00 → Sun 24:00 in `profiles.timezone`**,
 * and every boundary in the view derives from it: the deadline list, the class
 * grid, and the 14-day horizon that starts where the week ends.
 *
 * Two things make this worth a pure module rather than a few lines in the RSC:
 *
 * 1. **The boundary is a local wall clock, not an offset from UTC.** Madrid is
 *    +01:00 in winter and +02:00 in summer, so "Monday 00:00 local" is a
 *    different instant depending on which side of the transition the week falls.
 *    Subtracting a fixed offset puts the boundary an hour out twice a year — and
 *    an hour out at midnight moves a Sunday-evening deadline into the wrong
 *    week. `wallClockToUtcMs` already resolves that correctly; this composes it.
 *
 * 2. **`now` is a parameter.** ⚠ Today is 2026-07-18 and the fall term starts
 *    2026-08-31, so the live week window is genuinely empty — there is no
 *    occurrence within 21 days of it. A window function that read the wall clock
 *    itself could only ever be tested against that empty case. Injecting `now`
 *    is what lets the tests below pin 2026-09-15 and 2026-12-07, where the real
 *    feed actually has data.
 */

import { wallClockAt, wallClockToUtcMs } from "./timezone";

/** How far past the end of the week §7's "On the horizon" section looks. */
export const HORIZON_DAYS = 14;

const MS_PER_DAY = 86_400_000;

export interface WeekWindow {
  /** Monday 00:00 local, as a UTC instant. Inclusive. */
  startUtc: string;
  /** The following Monday 00:00 local — i.e. Sunday 24:00. **Exclusive.** */
  endUtc: string;
  /** `endUtc` + 14 days, the far edge of "On the horizon". Exclusive. */
  horizonEndUtc: string;
  /** Local midnight for each of Mon…Sun, as UTC instants — the grid's columns. */
  dayStartsUtc: string[];
}

/**
 * Monday-based day index for a wall-clock date: Mon = 0 … Sun = 6.
 *
 * ISO 8601 and every European timetable start the week on Monday; JavaScript's
 * `getUTCDay()` starts it on Sunday. `(day + 6) % 7` is the rotation, and doing
 * it here once is cheaper than remembering it at four call sites.
 */
function mondayIndex(year: number, month: number, day: number): number {
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

/**
 * The week containing `nowUtc`, expressed in `timezone`.
 *
 * Each day boundary is converted independently rather than by adding 24 h to
 * the previous one. That is deliberate: a DST weekend has a 23-hour and a
 * 25-hour day, so cumulative addition drifts the later boundaries off local
 * midnight — which is exactly the week the boundary matters most.
 *
 * @throws {UnknownTimezoneError} if `timezone` is not in the platform IANA database.
 */
export function weekWindow(nowUtc: string | number | Date, timezone: string): WeekWindow {
  const nowMs = nowUtc instanceof Date ? nowUtc.getTime() : new Date(nowUtc).getTime();
  const local = wallClockAt(nowMs, timezone);

  // Step back to Monday on the *calendar*, then convert. Going the other way —
  // subtracting milliseconds from the instant — would land on the wrong date
  // whenever the step crosses a transition.
  const mondayMs =
    Date.UTC(local.year, local.month - 1, local.day) -
    mondayIndex(local.year, local.month, local.day) * MS_PER_DAY;

  const dayStartsUtc: string[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(mondayMs + offset * MS_PER_DAY);
    dayStartsUtc.push(
      new Date(
        wallClockToUtcMs(
          {
            year: date.getUTCFullYear(),
            month: date.getUTCMonth() + 1,
            day: date.getUTCDate(),
            hour: 0,
            minute: 0,
            second: 0,
          },
          timezone,
        ),
      ).toISOString(),
    );
  }

  // The exclusive end is the NEXT Monday's local midnight, computed the same
  // way — not `dayStarts[6] + 24h`, which is an hour wrong on an autumn-back
  // week.
  const nextMonday = new Date(mondayMs + 7 * MS_PER_DAY);
  const endMs = wallClockToUtcMs(
    {
      year: nextMonday.getUTCFullYear(),
      month: nextMonday.getUTCMonth() + 1,
      day: nextMonday.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
    },
    timezone,
  );

  const horizonEnd = new Date(mondayMs + (7 + HORIZON_DAYS) * MS_PER_DAY);
  const horizonEndMs = wallClockToUtcMs(
    {
      year: horizonEnd.getUTCFullYear(),
      month: horizonEnd.getUTCMonth() + 1,
      day: horizonEnd.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
    },
    timezone,
  );

  const start = dayStartsUtc[0];
  if (start === undefined) {
    // Unreachable: the loop above always pushes seven entries. Present because
    // `noUncheckedIndexedAccess` is on and a non-null assertion would be a
    // worse way to say the same thing.
    throw new Error("weekWindow produced no day boundaries");
  }

  return {
    startUtc: start,
    endUtc: new Date(endMs).toISOString(),
    horizonEndUtc: new Date(horizonEndMs).toISOString(),
    dayStartsUtc,
  };
}
