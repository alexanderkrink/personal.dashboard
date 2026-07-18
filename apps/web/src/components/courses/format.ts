const WEIGHT_FORMAT = new Intl.NumberFormat("en-GB", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/**
 * A weight percentage as text: trailing zeros dropped ("30%", not "30.00%"),
 * but a real fraction kept intact ("33.33%").
 *
 * Deliberately in a module with **no `"use client"`** — it is called from the
 * server-rendered weight total and from the client-side row editor, and a plain
 * function imported out of a client module reaches a Server Component as a
 * client reference it cannot call.
 */
export function formatWeight(value: number): string {
  return WEIGHT_FORMAT.format(value);
}

const CREDIT_FORMAT = new Intl.NumberFormat("en-GB", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

export function formatCredits(value: number): string {
  return CREDIT_FORMAT.format(value);
}

/** "1 component" / "4 components" — the count, not the id, decides. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

const TERM_DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * A `date` column → "1 Sep 2026".
 *
 * Both the parse and the format are pinned to UTC. A bare `YYYY-MM-DD` is
 * parsed as UTC midnight, so formatting it in a local zone west of Greenwich
 * would render the day before — a term that visibly starts a day early.
 */
export function formatTermDate(iso: string): string {
  return TERM_DATE_FORMAT.format(new Date(`${iso}T00:00:00Z`));
}
