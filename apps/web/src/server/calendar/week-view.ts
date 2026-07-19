/**
 * The §7 "This week" view, assembled from one query's worth of rows.
 *
 * Pure: rows in, sections out, `now` a parameter. That is not stylistic — it is
 * the only way this feature can be verified at all right now.
 *
 * ⚠ **Today is 2026-07-18 and the fall term starts 2026-08-31.** Zero
 * occurrences fall inside the live week window, so loading the page proves
 * nothing about ranking, grouping, or the heat ramp: an empty list and a broken
 * list render identically. The tests beside this file pin 2026-09-15 and
 * 2026-12-07 — dates where the real synced feed actually has data — and that is
 * where the behaviour is actually established.
 *
 * The genuine empty state is a **first-class output**, not a fallback. §7 is
 * explicit that the correct feeling is *"clear this week, exam in 9 days"* and
 * never false calm, so `horizon` is populated independently of whether
 * `deadlines` is empty, and `nextBeyondHorizon` exists so a term that has not
 * started yet can still say when it does.
 */

import {
  type CalendarItemKind,
  occurrenceLabel,
  rankItems,
  resolveWeightPercent,
  type SessionDescriptor,
  type WeekWindow,
  weekWindow,
} from "@study/core";
import { isCancelledOccurrenceVisible, isTombstoneVisible } from "./diff";

/** §5.2 badge tiers, plus the pinned overdue tier. */
export type WeightTier = "overdue" | "high" | "medium" | "low" | "info";

/**
 * One row as the query returns it — `calendar_occurrences` joined up to its item
 * and that item's course.
 *
 * Deliberately structural rather than importing a generated Supabase type: the
 * tests build these by hand, and a shape they can construct is a shape they can
 * falsify.
 */
export interface WeekViewOccurrence {
  id: string;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  status: string;
  updated_at: string;
  completed_at: string | null;
  item: {
    id: string;
    kind: string;
    title: string;
    raw_summary: string | null;
    location: string | null;
    session_from: number | null;
    session_to: number | null;
    descriptor: string | null;
    hidden: boolean;
    missing_since: string | null;
    weight_override: number | null;
    is_exam_candidate: boolean;
    detection_source: string | null;
    /**
     * Not read by the week view itself — carried so the exam panel, which is
     * built from the same rows, can tell a user's recorded decision from an
     * untouched row. See `exam-decision.ts`.
     */
    user_locked_fields: string[];
    course: { id: string; title: string; color: string } | null;
    assessment: { id: string; title: string; weight_percent: number | null } | null;
  };
}

export interface WeekViewRow {
  occurrenceId: string;
  itemId: string;
  kind: CalendarItemKind;
  /** Composed by core's `occurrenceLabel` — "Session 4", "Sessions 24–25", … */
  label: string;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  cancelled: boolean;
  completed: boolean;
  isExamCandidate: boolean;
  /**
   * This row's `kind` came from `rankedKind`'s exam promotion, not from the feed.
   *
   * Load-bearing for the overdue rule: a promoted row is a *timetabled session*
   * the calendar believes is an exam. Once it is in the past it is something
   * that happened, not something left undone.
   */
  promotedFromClass: boolean;
  detectionSource: string | null;
  location: string | null;
  course: { id: string; title: string; color: string } | null;
  weightPercent: number;
  weightSource: "override" | "assessment" | "kind_default";
  tier: WeightTier;
  /** Fractional days; negative when overdue. */
  daysUntilDue: number;
  score: number;
}

export interface WeekViewClassDay {
  /** Local midnight, as a UTC instant. */
  dayStartUtc: string;
  rows: WeekViewRow[];
}

export interface WeekView {
  window: WeekWindow;
  nowUtc: string;
  timezone: string;
  /** Incomplete past-due deadlines, carried forward. Pinned above everything. */
  overdue: WeekViewRow[];
  /** This week's deadlines, sorted by §5.2 priority score — NOT chronologically. */
  deadlines: WeekViewRow[];
  /** This week's classes, bucketed Mon…Sun. Context, not payload. */
  classDays: WeekViewClassDay[];
  /** The next 14 days beyond this week, weight ≥ Medium only. */
  horizon: WeekViewRow[];
  /**
   * The soonest thing at all beyond the horizon, when everything above is
   * empty.
   *
   * §7's empty state must show the horizon rather than declaring calm. On
   * 2026-07-18 the horizon is *also* empty, because term starts in six weeks —
   * so without this the honest answer ("nothing until 31 August") would be
   * indistinguishable from "nothing, ever".
   */
  nextBeyondHorizon: WeekViewRow | null;
  /** True when nothing at all lands in the week — overdue, deadlines or classes. */
  isEmpty: boolean;
}

const KINDS = new Set<string>(["deadline", "class", "event"]);
const DESCRIPTORS = new Set<string>(["regular", "extra", "retake", "final_exam"]);

function asKind(value: string): CalendarItemKind {
  return KINDS.has(value) ? (value as CalendarItemKind) : "event";
}

/**
 * The kind a row is **ranked and placed** as, which is not always the kind the
 * feed gave it.
 *
 * 🔴 **An exam candidate ranks as a deadline even though the feed calls it a
 * class.** Found while verifying against the real December data: every one of
 * the 374 synced IE events classifies as `kind = 'class'` — the feed publishes a
 * timetable, and a final exam is simply the last *session* of a course. Taken
 * literally that put all seven finals into §7 part 4, the week grid, which is
 * explicitly the "deliberately visually secondary" section, and left part 3, the
 * ranked deadline list, permanently empty.
 *
 * That inverts the whole view. §7 says *classes are context, deadlines are the
 * payload* — and an exam is not context. It is the single most grade-critical
 * thing in the term, and "On the horizon" exists precisely so that *"a big exam
 * never ambushes from just outside the window"*, which it cannot do if exams are
 * filtered out of the horizon for being classes.
 *
 * So `is_exam_candidate` promotes a row to `deadline` for ranking, weighting and
 * placement. It also lifts its default weight from a class's 0% to a deadline's
 * 5%, which is the honest floor until a syllabus supplies the real number — a
 * 0%-weight final would sort below a 5% homework task.
 */
function rankedKind(item: WeekViewOccurrence["item"]): CalendarItemKind {
  const kind = asKind(item.kind);
  return item.is_exam_candidate && kind === "class" ? "deadline" : kind;
}

function asDescriptor(value: string | null): SessionDescriptor | null {
  return value !== null && DESCRIPTORS.has(value) ? (value as SessionDescriptor) : null;
}

/**
 * `assessments.weight_percent` is `numeric`, which PostgREST hands back as a
 * string. Passing that straight into the weight resolver makes `Number.isFinite`
 * false and silently drops the syllabus weight to the kind default — the item
 * would render "Low" while the syllabus says it is worth 30%.
 */
function asNumber(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Rows the user should not see at all: retakes, items whose tombstone has aged
 * past 24 h, and cancellations older than a week (§3.3, §3.6).
 *
 * A *cancelled* occurrence inside its window is deliberately kept — "this
 * lecture is not happening" is information, and a silent gap does not convey it.
 */
export function isVisible(occurrence: WeekViewOccurrence, nowUtc: string): boolean {
  if (occurrence.item.hidden) return false;
  if (!isTombstoneVisible(occurrence.item.missing_since, nowUtc)) return false;
  if (occurrence.status === "cancelled") {
    return isCancelledOccurrenceVisible(occurrence.updated_at, nowUtc);
  }
  return true;
}

/**
 * Turns rows into scored, labelled view models.
 *
 * Ranking runs through core's `rankItems` rather than being re-derived here, so
 * the dashboard, the calendar page and the future exam planner cannot drift into
 * three different opinions about what matters most. `rankItems` **excludes
 * completed items** (§5.2), so completion is re-attached afterwards for the rows
 * that still need to render struck through.
 */
function toRows(
  occurrences: readonly WeekViewOccurrence[],
  nowUtc: string,
): Map<string, WeekViewRow> {
  const ranked = new Map(
    rankItems(
      occurrences.map((occurrence) => ({
        id: occurrence.id,
        kind: rankedKind(occurrence.item),
        dueUtc: occurrence.starts_at,
        weightOverride: asNumber(occurrence.item.weight_override),
        assessmentWeightPercent: asNumber(occurrence.item.assessment?.weight_percent ?? null),
        completedAt: occurrence.completed_at,
      })),
      nowUtc,
    ).map((row) => [row.id, row]),
  );

  const rows = new Map<string, WeekViewRow>();

  for (const occurrence of occurrences) {
    const item = occurrence.item;
    const kind = rankedKind(item);
    const score = ranked.get(occurrence.id);

    // Completed rows are absent from `ranked` by design (§5.2 excludes them
    // from ranking). They still render — struck through, with their badge — so
    // their weight is resolved directly rather than defaulted to zero.
    const fallbackWeight = score
      ? null
      : resolveWeightPercent({
          kind,
          weightOverride: asNumber(item.weight_override),
          assessmentWeightPercent: asNumber(item.assessment?.weight_percent ?? null),
        });

    rows.set(occurrence.id, {
      occurrenceId: occurrence.id,
      itemId: item.id,
      kind,
      label: occurrenceLabel({
        title: item.title,
        sessionFrom: item.session_from,
        sessionTo: item.session_to,
        descriptor: asDescriptor(item.descriptor),
      }),
      startsAt: occurrence.starts_at,
      endsAt: occurrence.ends_at,
      allDay: occurrence.all_day,
      cancelled: occurrence.status === "cancelled",
      completed: occurrence.completed_at !== null,
      isExamCandidate: item.is_exam_candidate,
      promotedFromClass: asKind(item.kind) === "class" && kind === "deadline",
      detectionSource: item.detection_source,
      location: item.location,
      course: item.course,
      weightPercent: score?.weightPercent ?? fallbackWeight?.weightPercent ?? 0,
      weightSource: score?.weightSource ?? fallbackWeight?.source ?? "kind_default",
      tier: score?.tier ?? (kind === "class" ? "info" : "low"),
      daysUntilDue: score?.daysUntilDue ?? 0,
      score: score?.score ?? 0,
    });
  }

  return rows;
}

/** §5.2: **Medium** is 5% and up. What "On the horizon" filters on. */
const HORIZON_MIN_TIER = new Set<WeightTier>(["overdue", "high", "medium"]);

export interface BuildWeekViewInput {
  occurrences: readonly WeekViewOccurrence[];
  /** ⚠ Injected, never `Date.now()` — see the module header. */
  now: Date;
  /** `profiles.timezone`. The week boundary is a local wall clock (§7). */
  timezone: string;
}

export function buildWeekView(input: BuildWeekViewInput): WeekView {
  const nowUtc = input.now.toISOString();
  const window = weekWindow(input.now, input.timezone);
  const nowMs = input.now.getTime();
  const weekStartMs = Date.parse(window.startUtc);
  const weekEndMs = Date.parse(window.endUtc);
  const horizonEndMs = Date.parse(window.horizonEndUtc);

  const visible = input.occurrences.filter((occurrence) => isVisible(occurrence, nowUtc));
  const rows = toRows(visible, nowUtc);

  const overdue: WeekViewRow[] = [];
  const deadlines: WeekViewRow[] = [];
  const classes: WeekViewRow[] = [];
  const horizon: WeekViewRow[] = [];
  const beyond: WeekViewRow[] = [];

  for (const occurrence of visible) {
    const row = rows.get(occurrence.id);
    if (!row) continue;

    const startsMs = Date.parse(row.startsAt);

    // Overdue first, and it is deliberately NOT bounded by the week: §7 says
    // past-due deadlines are carried forward until completed or dismissed, so a
    // thing missed three weeks ago still surfaces today. Completed and cancelled
    // rows drop out — a done item competing for attention is noise.
    //
    // 🔴 **A promoted exam is exempt.** `rankedKind` lifts an exam candidate to
    // `deadline` so it ranks and warns ahead of time — that is the whole point
    // of the promotion. Carrying it *backwards* into the overdue pin is a
    // different claim entirely: it says the user failed to do something. An exam
    // is a session you sit, not a task you submit, and the feed cannot know
    // whether it was attended. Without this exemption the week after finals
    // opens with six exams pinned in danger red reading "3 days ago" — measured
    // on the real feed at 2026-12-21 — directly beneath the line "Nothing
    // scheduled this week". False alarms at that volume teach the user to
    // ignore the colour that matters most.
    //
    // A genuine `kind = 'deadline'` row — quick-added by hand, or a real
    // deadline once the feed carries one — is unaffected and still carries
    // forward.
    if (row.kind === "deadline" && startsMs < nowMs && !row.promotedFromClass) {
      if (!row.completed && !row.cancelled) overdue.push(row);
      continue;
    }

    if (startsMs >= weekStartMs && startsMs < weekEndMs) {
      if (row.kind === "class") classes.push(row);
      else deadlines.push(row);
      continue;
    }

    if (startsMs >= weekEndMs && startsMs < horizonEndMs) {
      // "so a big exam never ambushes from just outside the window" — classes
      // and low-weight items would drown that signal, so only Medium and up.
      if (row.kind !== "class" && HORIZON_MIN_TIER.has(row.tier) && !row.completed) {
        horizon.push(row);
      }
      continue;
    }

    if (startsMs >= horizonEndMs && !row.completed) beyond.push(row);
  }

  // §7: sorted by the priority score, NOT chronologically. A 30% project due
  // Friday outranks a 2% quiz due Tuesday, which is how a student should triage.
  const byScore = (a: WeekViewRow, b: WeekViewRow) =>
    b.score - a.score || a.occurrenceId.localeCompare(b.occurrenceId);
  const byTime = (a: WeekViewRow, b: WeekViewRow) =>
    Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.occurrenceId.localeCompare(b.occurrenceId);

  overdue.sort(byScore);
  deadlines.sort(byScore);
  // The horizon and the class grid ARE chronological: both answer "when", not
  // "what first". Ranking the horizon would bury the nearest exam under a
  // heavier one three weeks out, which is the opposite of an early warning.
  horizon.sort(byTime);
  classes.sort(byTime);
  beyond.sort(byTime);

  const dayBoundaries = window.dayStartsUtc.map((day) => Date.parse(day));
  const classDays: WeekViewClassDay[] = window.dayStartsUtc.map((dayStartUtc) => ({
    dayStartUtc,
    rows: [],
  }));

  for (const row of classes) {
    const startsMs = Date.parse(row.startsAt);
    // The last boundary that is still <= this instant. Computed by scan rather
    // than by dividing the offset by 86 400 000, which is an hour wrong on the
    // 23- and 25-hour days of a DST weekend.
    let index = 0;
    for (let day = 0; day < dayBoundaries.length; day += 1) {
      const boundary = dayBoundaries[day];
      if (boundary !== undefined && startsMs >= boundary) index = day;
    }
    classDays[index]?.rows.push(row);
  }

  return {
    window,
    nowUtc,
    timezone: input.timezone,
    overdue,
    deadlines,
    classDays,
    horizon,
    nextBeyondHorizon: horizon.length === 0 ? (beyond[0] ?? null) : null,
    isEmpty: overdue.length === 0 && deadlines.length === 0 && classes.length === 0,
  };
}
