/**
 * Kind classification (§4) — ordered rules, first hit wins.
 *
 * **Rules 1 and 1b resolve the entire IE feed on their own**, because it has no
 * recurrence, no `CATEGORIES` and no "due" tokens. Rules 2 and 3 are generic
 * provider capability for other feeds, kept because a format change upstream
 * would need them overnight.
 */

import type { CalendarItemKind, NormalizedOccurrence } from "./provider";
import type { NormalizedSummary } from "./summary";

export interface ClassifyKindInput {
  normalized: NormalizedSummary;
  occurrences: readonly NormalizedOccurrence[];
  hasRrule: boolean;
  categories: readonly string[];
  /** `courses.title` values, for rule 1b. */
  knownCourseNames: readonly string[];
}

const DEADLINE_CATEGORY = /\b(?:assignment|homework|test|quiz|exam|deadline|task)\b/i;

function hasDuration(occurrences: readonly NormalizedOccurrence[]): boolean {
  return occurrences.some((occurrence) => {
    if (!occurrence.endsAtUtc) {
      return false;
    }
    return Date.parse(occurrence.endsAtUtc) > Date.parse(occurrence.startsAtUtc);
  });
}

function isAllDayOnly(occurrences: readonly NormalizedOccurrence[]): boolean {
  return occurrences.length > 0 && occurrences.every((occurrence) => occurrence.allDay);
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function classifyKind(input: ClassifyKindInput): CalendarItemKind {
  const { normalized, occurrences, hasRrule, categories, knownCourseNames } = input;

  // Rule 1 — session-token rule, THE IE path. A `(Ses. N)` / `(Ses. N-M)` token
  // or an Extra / Retake / Final Exam descriptor means a class. A
  // recurrence-based rule would misfile every pre-expanded IE VEVENT as `event`.
  if (normalized.sessionFrom !== undefined || normalized.descriptor !== "regular") {
    return "class";
  }

  // Rule 1b — known-course fallback. No session token, but the normalizer
  // matched a known course name and the event has real duration. Catches the
  // feed's tokenless course rows (`COST ACCOUNTING   |`) that rule 1 alone
  // would drop to `event`.
  if (normalized.courseName.length > 0 && hasDuration(occurrences)) {
    const courseName = normalizeName(normalized.courseName);
    if (knownCourseNames.some((known) => normalizeName(known) === courseName)) {
      return "class";
    }
  }

  // Rule 2 — zero-duration or all-day VEVENT whose summary says "due", or an
  // assignment-style CATEGORIES value. Generic: the IE feed emits neither, so
  // its deadlines come from quick-add and `assessments`, never from the feed.
  const zeroDurationOrAllDay = !hasDuration(occurrences) || isAllDayOnly(occurrences);
  if (zeroDurationOrAllDay && /\bdue\b/i.test(normalized.rawSummary)) {
    return "deadline";
  }
  if (categories.some((category) => DEADLINE_CATEGORY.test(category))) {
    return "deadline";
  }

  // Rule 3 — an RRULE plus a duration. Generic capability for feeds that
  // publish real recurrence; the IE feed has none (§3.5).
  if (hasRrule && hasDuration(occurrences)) {
    return "class";
  }

  // Rule 4 — everything else.
  return "event";
}
