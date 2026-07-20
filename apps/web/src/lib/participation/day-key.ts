/**
 * The calendar day (`YYYY-MM-DD`) an instant falls on in one timezone.
 *
 * "Today" on the ledger is the user's wall-clock day (`profiles.timezone`),
 * never the UTC day: Madrid runs ahead of UTC, so slicing the ISO string would
 * file tonight's 00:30 class under yesterday and make it unloggable on the day
 * it happens. `en-CA` is the locale whose date format IS `YYYY-MM-DD`, which
 * keeps the key lexicographically sortable and comparable with `===`.
 */
export function sessionDayKey(isoUtc: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(isoUtc));
}
