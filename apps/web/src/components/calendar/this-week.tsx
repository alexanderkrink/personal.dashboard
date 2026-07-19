import { CalendarCheck } from "@phosphor-icons/react/dist/ssr";
import { HORIZON_DAYS } from "@study/core";
import { createClient } from "@/lib/supabase/server";
import { buildExamStatuses } from "@/server/calendar/exam-status";
import { refreshStaleFeeds } from "@/server/calendar/refresh";
import { groupUnassigned, partitionUnassigned } from "@/server/calendar/unassigned";
import { buildWeekView, type WeekViewOccurrence } from "@/server/calendar/week-view";
import { DeadlineRow } from "./deadline-row";
import { ExamPanel } from "./exam-panel";
import { SyncStrip } from "./sync-strip";
import { UnassignedBucket } from "./unassigned-bucket";
import { formatDueIn } from "./urgency";
import { WeekGrid } from "./week-grid";

/**
 * The "This week" view (§7), top to bottom.
 *
 * ```
 * 1. Sync status strip
 * 2. Overdue            (danger red, pinned)
 * 3. Deadlines this week (ranked by §5.2 priority score, NOT chronologically)
 * 4. Week grid of classes (deliberately secondary)
 * 5. On the horizon      (next 14 days, weight ≥ Medium)
 * 6. Unassigned bucket   (only when non-empty)
 * ```
 *
 * One RSC. The occurrence query is a single indexed range scan over
 * `calendar_occurrences (user_id, starts_at)` — the index
 * `calendar_occurrences_user_starts_idx` exists for exactly this read — and
 * every section below is a partition of its result, computed in memory by
 * `buildWeekView`. RLS scopes all of it to the signed-in user, which is why no
 * `user_id` filter appears; its absence is not an oversight.
 *
 * ## ⚠ `now` is a parameter, and that is load-bearing
 *
 * **Today is 2026-07-18. The fall term starts 2026-08-31.** The live week window
 * is genuinely empty, so rendering this component today cannot distinguish
 * "correct and quiet" from "broken". `now` defaults to the wall clock in
 * production and is pinned in tests and during browser verification, so the
 * ranked path is actually exercised against real synced data.
 *
 * The empty state is a **first-class output**, not a fallback: §7 requires it to
 * show the horizon explicitly — *"clear this week, exam in 9 days"* — and never
 * false calm. When even the horizon is empty, as it is today, it reaches past it
 * and names the next thing on the calendar at all.
 */
export async function ThisWeek({
  now = new Date(),
  heading = "This week",
  showExams = true,
  showUnassigned = true,
}: {
  /** ⚠ Injectable so tests and verification can stand where the data is. */
  now?: Date;
  heading?: string;
  showExams?: boolean;
  showUnassigned?: boolean;
}) {
  const supabase = await createClient();

  const [
    { data: profile },
    { data: feeds },
    { data: courses },
    { data: assessments },
    { data: semesters },
    { data: unassigned },
  ] = await Promise.all([
    supabase.from("profiles").select("timezone").maybeSingle(),
    supabase
      .from("calendar_feeds")
      .select("id, label, active, last_synced_at, last_sync_status, last_sync_error")
      .order("created_at", { ascending: true }),
    supabase
      .from("courses")
      .select("id, code, title, color, total_sessions, total_sessions_source")
      .eq("archived", false)
      .order("title", { ascending: true }),
    // §5.1b steps 2 and 3, fetched here rather than hardcoded to `[]`.
    //
    // The sync path has always loaded both (`store.loadContext`); the read path
    // did not, and since the chain is deliberately re-run at read time the two
    // were answering the same question from different inputs. `assessments` has
    // 0 rows today, so step 2 stays dormant — but it is dormant for want of
    // syllabi now, rather than structurally unreachable.
    //
    // ⚠ `semesters` is NOT inert: there are 2 rows (2026/27 Fall and Spring), so
    // wiring it actually switches guard 2 on. With `[]` the guard returned
    // `{ unbounded: true, outsideSemester: false }` for every date — a constant
    // dressed as a check.
    //
    // Both are RLS-scoped and unbounded by the week window on purpose: an
    // assessment's relevance is to its course, not to a date range, and a
    // semester filtered by "overlaps this week" would drop exactly the terms
    // guard 2 needs to test a future exam against.
    showExams
      ? supabase
          .from("assessments")
          // `confirmed` travels to the detector, which drops unconfirmed rows (§2b).
          .select("id, course_id, title, kind, session_number, confirmed")
      : { data: null },
    showExams
      ? supabase.from("semesters").select("starts_on, ends_on").order("starts_on")
      : { data: null },
    // The Unassigned bucket is queried SEPARATELY and is deliberately NOT
    // bounded by the week window.
    //
    // It is a maintenance surface about the whole feed, not a view of this
    // week: on the live database its 220 rows are 2025/26 spring events
    // running 19 Jan → 26 Jun, so scoping it to the week's −30d/+180d range
    // would hide almost all of them and report an empty bucket while 220 rows
    // sat unmatched. Filing a pattern is also inherently about every event of
    // that course, past ones included.
    showUnassigned
      ? supabase
          .from("calendar_items")
          .select("id, raw_summary, title, calendar_occurrences (starts_at)")
          .is("course_id", null)
          .eq("hidden", false)
          .limit(2000)
      : { data: null },
  ]);

  const timeZone = profile?.timezone ?? "Europe/Madrid";

  // §3.1 step 1: render from the database NOW, refresh in the background. This
  // returns immediately — the sync runs in `after()`, once the response has been
  // flushed — so nothing on this page waits on a university HTTP endpoint.
  refreshStaleFeeds(feeds ?? [], now);

  // Overdue is carried forward "until completed or dismissed", so the lower
  // bound is the sync horizon's own past edge rather than the week's start.
  const from = new Date(now.getTime() - 30 * 86_400_000).toISOString();

  const { data: occurrences } = await supabase
    .from("calendar_occurrences")
    .select(
      `id, starts_at, ends_at, all_day, status, updated_at, completed_at,
       calendar_items!inner (
         id, kind, title, raw_summary, location, session_from, session_to, descriptor,
         hidden, missing_since, weight_override, is_exam_candidate, detection_source,
         user_locked_fields,
         courses (id, title, color),
         assessments (id, title, weight_percent)
       )`,
    )
    .gte("starts_at", from)
    // The far edge is the horizon end, plus enough slack for the empty state to
    // name what comes after it. Today that slack is the only reason the page can
    // say "term starts 31 August" instead of "nothing".
    .lte("starts_at", new Date(now.getTime() + 180 * 86_400_000).toISOString())
    .order("starts_at", { ascending: true })
    .limit(1000);

  const rows: WeekViewOccurrence[] = (occurrences ?? []).map((occurrence) => ({
    id: occurrence.id,
    starts_at: occurrence.starts_at,
    ends_at: occurrence.ends_at,
    all_day: occurrence.all_day,
    status: occurrence.status,
    updated_at: occurrence.updated_at,
    completed_at: occurrence.completed_at,
    item: {
      id: occurrence.calendar_items.id,
      kind: occurrence.calendar_items.kind,
      title: occurrence.calendar_items.title,
      raw_summary: occurrence.calendar_items.raw_summary,
      location: occurrence.calendar_items.location,
      session_from: occurrence.calendar_items.session_from,
      session_to: occurrence.calendar_items.session_to,
      descriptor: occurrence.calendar_items.descriptor,
      hidden: occurrence.calendar_items.hidden,
      missing_since: occurrence.calendar_items.missing_since,
      weight_override: occurrence.calendar_items.weight_override,
      is_exam_candidate: occurrence.calendar_items.is_exam_candidate,
      detection_source: occurrence.calendar_items.detection_source,
      user_locked_fields: occurrence.calendar_items.user_locked_fields,
      course: occurrence.calendar_items.courses,
      assessment: occurrence.calendar_items.assessments,
    },
  }));

  const view = buildWeekView({ occurrences: rows, now, timezone: timeZone });

  const todayIndex = view.window.dayStartsUtc.findIndex((dayStart, index) => {
    const next = view.window.dayStartsUtc[index + 1] ?? view.window.endUtc;
    return now.getTime() >= Date.parse(dayStart) && now.getTime() < Date.parse(next);
  });

  const range = formatRange(view.window.startUtc, view.window.endUtc, timeZone);

  return (
    <>
      {/* 1 — sync status */}
      <SyncStrip
        feeds={(feeds ?? []).map((feed) => ({
          id: feed.id,
          label: feed.label,
          active: feed.active,
          lastSyncedAt: feed.last_synced_at,
          lastSyncStatus: feed.last_sync_status,
          lastSyncError: feed.last_sync_error,
        }))}
        now={now}
      />

      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="font-medium text-foreground text-ui-lg">{heading}</h2>
        <span className="font-mono text-muted-foreground text-ui-sm tabular-nums">{range}</span>
      </div>

      {/* 2 — overdue, pinned above everything */}
      {view.overdue.length > 0 ? (
        <section className="mb-6 overflow-hidden rounded-lg border border-urgency-overdue/40 bg-surface">
          <h3 className="border-urgency-overdue/30 border-b bg-urgency-overdue/8 px-4 py-2 font-medium text-urgency-overdue-text text-ui-sm dark:bg-urgency-overdue/12">
            Overdue
            <span className="ml-2 font-mono tabular-nums">{view.overdue.length}</span>
          </h3>
          <ol className="divide-y divide-border">
            {view.overdue.map((row) => (
              <DeadlineRow
                key={row.occurrenceId}
                row={row}
                timeZone={timeZone}
                courses={courses ?? []}
              />
            ))}
          </ol>
        </section>
      ) : null}

      {/* 3 — this week's deadlines, ranked */}
      {view.deadlines.length > 0 ? (
        <section className="mb-6 overflow-hidden rounded-lg border border-border bg-surface">
          <h3 className="flex items-baseline gap-2 border-border border-b px-4 py-2 font-medium text-foreground text-ui-sm">
            Deadlines
            <span className="font-mono text-muted-foreground tabular-nums">
              {view.deadlines.length}
            </span>
            <span className="ml-auto text-muted-foreground text-ui-xs">by grade impact</span>
          </h3>
          <ol className="divide-y divide-border">
            {view.deadlines.map((row) => (
              <DeadlineRow
                key={row.occurrenceId}
                row={row}
                timeZone={timeZone}
                courses={courses ?? []}
              />
            ))}
          </ol>
        </section>
      ) : (
        <EmptyWeek view={view} timeZone={timeZone} />
      )}

      {/* 4 — classes, deliberately secondary */}
      <WeekGrid days={view.classDays} timeZone={timeZone} todayIndex={todayIndex} />

      {/* 5 — on the horizon */}
      {view.horizon.length > 0 ? (
        <section className="mb-6 overflow-hidden rounded-lg border border-border bg-surface">
          <h3 className="flex items-baseline gap-2 border-border border-b px-4 py-2 font-medium text-foreground text-ui-sm">
            On the horizon
            <span className="text-muted-foreground text-ui-xs">
              next {HORIZON_DAYS} days, medium weight and up
            </span>
          </h3>
          <ol className="divide-y divide-border">
            {view.horizon.map((row) => (
              <DeadlineRow
                key={row.occurrenceId}
                row={row}
                timeZone={timeZone}
                courses={courses ?? []}
              />
            ))}
          </ol>
        </section>
      ) : null}

      {showExams ? (
        <ExamPanel
          statuses={buildExamStatuses({
            courses: courses ?? [],
            items: rows.map((row) => ({
              id: row.item.id,
              course_id: row.item.course?.id ?? null,
              // The item id stands in for the ICS UID here. `detectExam` only
              // needs a stable key to hand back so the resolved event can be
              // found again, and the real `ics_uid` is not selected by this
              // query. Where one item has several occurrences they collapse to
              // the same key, and `eventCoveringSession` resolves the tie by
              // earliest date — which is the guard's specified behaviour anyway.
              ics_uid: row.item.id,
              raw_summary: row.item.raw_summary,
              starts_at: row.starts_at,
              is_exam_candidate: row.item.is_exam_candidate,
              detection_source: row.item.detection_source,
              // ⚠ This was hardcoded `[]`, which silently disabled the entire
              // decision layer: a rejection is recorded as a LOCK on
              // `is_exam_candidate`, so an empty array makes every rejected
              // course read as "never touched" and re-proposes the date the
              // user just declined.
              user_locked_fields: row.item.user_locked_fields,
            })),
            assessments: assessments ?? [],
            semesters: semesters ?? [],
          })}
          timeZone={timeZone}
        />
      ) : null}

      {/* 6 — the unassigned bucket, only when non-empty.
          Partitioned against the SAME injectable `now` the rest of the view
          uses, so a pinned verification date moves the bucket's idea of "still
          to come" with it rather than reading the wall clock behind its back. */}
      {showUnassigned ? (
        <UnassignedBucket
          {...partitionUnassigned(
            groupUnassigned(
              (unassigned ?? []).map((item) => ({
                id: item.id,
                raw_summary: item.raw_summary,
                title: item.title,
                // An item always has at least one occurrence, but the join is
                // typed as an array; the earliest is what dates the group.
                starts_at:
                  item.calendar_occurrences.map((occurrence) => occurrence.starts_at).sort()[0] ??
                  new Date(0).toISOString(),
              })),
            ),
            now,
          )}
          courses={courses ?? []}
        />
      ) : null}
    </>
  );
}

/**
 * §7's empty state.
 *
 * *"The correct feeling is 'clear this week, exam in 9 days', never false
 * calm."* So this always says what is coming — from the horizon when there is
 * one, and from beyond it when there is not.
 *
 * ⚠ Today (2026-07-18) both are empty and the honest reading is "term has not
 * started", which is why `nextBeyondHorizon` exists at all: "nothing this week"
 * and "nothing until 31 August" are different messages and only one of them is
 * true.
 */
function EmptyWeek({
  view,
  timeZone,
}: {
  view: ReturnType<typeof buildWeekView>;
  timeZone: string;
}) {
  const next = view.horizon[0] ?? view.nextBeyondHorizon;

  return (
    <section className="mb-6 rounded-lg border border-border bg-surface px-4 py-5">
      <p className="flex items-center gap-2 font-medium text-foreground text-ui-base">
        <CalendarCheck weight="duotone" aria-hidden="true" className="size-4.5 text-accent" />
        {view.classDays.some((day) => day.rows.length > 0)
          ? "No deadlines this week."
          : "Nothing scheduled this week."}
      </p>

      {next ? (
        <p className="mt-1.5 text-muted-foreground text-ui-md">
          Next up: <span className="text-foreground">{next.course?.title ?? next.label}</span>
          {next.isExamCandidate ? " exam" : ""} on{" "}
          <span className="font-mono tabular-nums">
            {new Intl.DateTimeFormat("en-GB", {
              weekday: "long",
              day: "numeric",
              month: "long",
              timeZone,
            }).format(new Date(next.startsAt))}
          </span>{" "}
          <span className="font-mono text-muted-foreground tabular-nums">
            ({formatDueIn(next.daysUntilDue)})
          </span>
          .
        </p>
      ) : (
        <p className="mt-1.5 text-muted-foreground text-ui-md">
          Nothing on the calendar for the next six months either. If that looks wrong, sync the
          feed.
        </p>
      )}
    </section>
  );
}

function formatRange(startUtc: string, endUtc: string, timeZone: string): string {
  const format = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone });
  // The window's end is exclusive (next Monday 00:00), so the displayed Sunday
  // is a millisecond before it.
  return `${format.format(new Date(startUtc))} – ${format.format(new Date(Date.parse(endUtc) - 1))}`;
}
