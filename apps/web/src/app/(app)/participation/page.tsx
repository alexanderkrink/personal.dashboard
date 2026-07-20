import { HandWaving } from "@phosphor-icons/react/dist/ssr";
import type { AttendanceStatus } from "@study/core";
import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { requireUserId } from "@/lib/auth/require-user";
import { sessionDayKey } from "@/lib/participation/day-key";
import { createClient } from "@/lib/supabase/server";
import {
  type CourseStanding,
  courseStandings,
  type LedgerAttendanceRow,
  type LedgerLogRow,
} from "@/server/participation/standing";

export const metadata: Metadata = { title: "Participation" };

/**
 * The participation ledger's home (PLAN Additional #4): today's class sessions
 * up top for two-tap logging, the sessions just around them for prep and
 * catch-up, and each course's standing — the attendance gate and the
 * participation pace, kept visibly separate because they are different
 * instruments: one is pass/fail, the other is graded.
 *
 * Class sessions are `calendar_occurrences` under `kind = 'class'` items —
 * this page creates nothing; it reads the calendar the hub already syncs.
 */
export default async function ParticipationPage() {
  const supabase = await createClient();
  await requireUserId(supabase);

  const now = new Date();
  const windowFrom = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const windowTo = new Date(now.getTime() + 7 * 86_400_000).toISOString();

  const [{ data: profile }, { data: occurrences }, { data: courses }] = await Promise.all([
    supabase.from("profiles").select("timezone").maybeSingle(),
    supabase
      .from("calendar_occurrences")
      .select(
        `id, starts_at,
         calendar_items!inner (id, title, kind, hidden, session_from, session_to, courses (id, title))`,
      )
      .eq("calendar_items.kind", "class")
      .eq("calendar_items.hidden", false)
      .neq("status", "cancelled")
      .gte("starts_at", windowFrom)
      .lte("starts_at", windowTo)
      .order("starts_at", { ascending: true })
      .limit(200),
    supabase
      .from("courses")
      .select("id, title, total_sessions, absence_fail_pct, participation_target")
      .eq("archived", false)
      .order("title"),
  ]);

  const timeZone = profile?.timezone ?? "Europe/Madrid";
  const sessions = occurrences ?? [];
  const sessionIds = sessions.map((session) => session.id);

  // Badges for the listed sessions; standings over the WHOLE term — the gate
  // measures a budget for the course, not for the visible fortnight.
  const [
    { data: sessionAttendance },
    { data: sessionLogs },
    { data: allAttendance },
    { data: allLogs },
  ] = await Promise.all([
    sessionIds.length > 0
      ? supabase
          .from("attendance_records")
          .select("occurrence_id, status")
          .in("occurrence_id", sessionIds)
      : Promise.resolve({ data: [] as { occurrence_id: string; status: string }[] }),
    sessionIds.length > 0
      ? supabase.from("participation_logs").select("occurrence_id").in("occurrence_id", sessionIds)
      : Promise.resolve({ data: [] as { occurrence_id: string }[] }),
    supabase
      .from("attendance_records")
      .select(
        "occurrence_id, status, calendar_occurrences!inner (starts_at, calendar_items!inner (course_id))",
      ),
    supabase
      .from("participation_logs")
      .select(
        "occurrence_id, calendar_occurrences!inner (starts_at, calendar_items!inner (course_id))",
      ),
  ]);

  const attendanceByOccurrence = new Map(
    (sessionAttendance ?? []).map((row) => [row.occurrence_id, row.status as AttendanceStatus]),
  );
  const logCountByOccurrence = new Map<string, number>();
  for (const row of sessionLogs ?? []) {
    logCountByOccurrence.set(
      row.occurrence_id,
      (logCountByOccurrence.get(row.occurrence_id) ?? 0) + 1,
    );
  }

  const attendanceRows: LedgerAttendanceRow[] = (allAttendance ?? []).flatMap((row) => {
    const courseId = row.calendar_occurrences.calendar_items.course_id;
    if (courseId === null) return [];
    return [
      {
        occurrenceId: row.occurrence_id,
        courseId,
        startsAt: row.calendar_occurrences.starts_at,
        status: row.status as AttendanceStatus,
      },
    ];
  });
  const logRows: LedgerLogRow[] = (allLogs ?? []).flatMap((row) => {
    const courseId = row.calendar_occurrences.calendar_items.course_id;
    if (courseId === null) return [];
    return [
      {
        occurrenceId: row.occurrence_id,
        courseId,
        startsAt: row.calendar_occurrences.starts_at,
      },
    ];
  });

  const standings = courseStandings(
    (courses ?? []).map((course) => ({
      id: course.id,
      title: course.title,
      totalSessions: course.total_sessions,
      absenceFailPct: course.absence_fail_pct,
      participationTarget: course.participation_target,
    })),
    attendanceRows,
    logRows,
  );
  const activeStandings = standings.filter(
    (standing) => standing.gate !== null || standing.pace.sessions > 0 || standing.absent > 0,
  );

  const todayKey = sessionDayKey(now.toISOString(), timeZone);
  const today = sessions.filter((s) => sessionDayKey(s.starts_at, timeZone) === todayKey);
  const upcoming = sessions.filter((s) => sessionDayKey(s.starts_at, timeZone) > todayKey);
  const recent = sessions.filter((s) => sessionDayKey(s.starts_at, timeZone) < todayKey).reverse();

  const timeFormat = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  });
  const dayFormat = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  });

  function sessionRow(session: (typeof sessions)[number]) {
    const attendance = attendanceByOccurrence.get(session.id) ?? null;
    const logCount = logCountByOccurrence.get(session.id) ?? 0;
    const item = session.calendar_items;
    const sessionLabel =
      item.session_from !== null
        ? item.session_to !== null && item.session_to !== item.session_from
          ? `Ses. ${item.session_from}–${item.session_to}`
          : `Ses. ${item.session_from}`
        : null;

    return (
      <li key={session.id}>
        <Link
          href={`/participation/${session.id}`}
          className="focus-ring flex min-h-11 items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-accent"
        >
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">{item.title}</span>
            <span className="truncate text-xs text-muted-foreground">
              {[item.courses?.title, sessionLabel].filter(Boolean).join(" · ")}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {logCount > 0 && <Badge variant="secondary">{logCount} logged</Badge>}
            {attendance === "absent" && <Badge variant="destructive">absent</Badge>}
            {attendance === "excused" && <Badge variant="outline">excused</Badge>}
            {attendance === "present" && logCount === 0 && <Badge variant="outline">silent</Badge>}
            <span className="font-mono text-xs text-muted-foreground">
              {dayFormat.format(new Date(session.starts_at))}{" "}
              {timeFormat.format(new Date(session.starts_at))}
            </span>
          </span>
        </Link>
      </li>
    );
  }

  return (
    <>
      <PageHeader
        title="Participation"
        lead="Log every contribution in two taps, and never let an attendance gate surprise you."
      />

      {sessions.length === 0 && activeStandings.length === 0 ? (
        <EmptyState
          icon={HandWaving}
          headline="No class sessions in the next week."
          body="Sessions come from your calendar feed — once classes are on the calendar, each one gets a two-tap logging screen here."
          points={[
            {
              term: "Log",
              detail: "Spoke strong / ok, cold-called, or silent — two taps, mid-class.",
            },
            { term: "Track", detail: "absences against the 80% attendance gate, per course." },
            {
              term: "Prepare",
              detail: "talking points the night before, ticked off as you use them.",
            },
          ]}
          cta={{ href: "/calendar", label: "Connect your calendar" }}
        />
      ) : (
        <div className="flex flex-col gap-8">
          <section aria-label="Today's classes" className="flex flex-col gap-2">
            <h2 className="text-sm font-medium text-muted-foreground">Today</h2>
            {today.length === 0 ? (
              <p className="text-sm text-muted-foreground">No classes today.</p>
            ) : (
              <ul className="flex flex-col">{today.map(sessionRow)}</ul>
            )}
          </section>

          {upcoming.length > 0 && (
            <section aria-label="Upcoming classes" className="flex flex-col gap-2">
              <h2 className="text-sm font-medium text-muted-foreground">
                Coming up — prep talking points
              </h2>
              <ul className="flex flex-col">{upcoming.map(sessionRow)}</ul>
            </section>
          )}

          {recent.length > 0 && (
            <section aria-label="Recent classes" className="flex flex-col gap-2">
              <h2 className="text-sm font-medium text-muted-foreground">Recent — catch up</h2>
              <ul className="flex flex-col">{recent.map(sessionRow)}</ul>
            </section>
          )}

          {activeStandings.length > 0 && (
            <section aria-label="Course standing" className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">Standing</h2>
              <ul className="grid gap-3 sm:grid-cols-2">
                {activeStandings.map((standing) => (
                  <StandingCard key={standing.course.id} standing={standing} />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </>
  );
}

const GATE_BADGE: Record<
  NonNullable<CourseStanding["gate"]>["status"],
  { label: string; variant: "outline" | "secondary" | "destructive" }
> = {
  ok: { label: "on track", variant: "outline" },
  warning: { label: "1 absence left", variant: "secondary" },
  at_limit: { label: "at the limit", variant: "destructive" },
  failed: { label: "gate failed", variant: "destructive" },
};

function StandingCard({ standing }: { standing: CourseStanding }) {
  const { course, gate, pace, streak } = standing;
  return (
    <li className="flex flex-col gap-2 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{course.title}</span>
        {gate && (
          <Badge variant={GATE_BADGE[gate.status].variant}>{GATE_BADGE[gate.status].label}</Badge>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Absences</dt>
        <dd className="text-right font-mono">
          {gate ? `${gate.absent} of ${gate.maxAbsences} allowed` : `${standing.absent} recorded`}
        </dd>
        <dt className="text-muted-foreground">Pace</dt>
        <dd className="text-right font-mono">
          {pace.sessions === 0
            ? "no sessions logged"
            : pace.target === null
              ? `${pace.perSession.toFixed(1)}/session`
              : `${pace.perSession.toFixed(1)} vs ${pace.target} target`}
        </dd>
        <dt className="text-muted-foreground">Streak</dt>
        <dd className="text-right font-mono">
          {streak} {streak === 1 ? "session" : "sessions"}
        </dd>
      </dl>
      {gate === null && (
        <p className="text-xs text-muted-foreground">
          No attendance gate yet — set the course's total sessions to measure against the 80% rule.
        </p>
      )}
    </li>
  );
}
