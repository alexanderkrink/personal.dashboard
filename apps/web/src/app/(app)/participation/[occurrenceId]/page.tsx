import type { AttendanceStatus } from "@study/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { PageHeader } from "@/components/page-header";
import {
  SessionLogger,
  type SessionLoggerLog,
  type SessionLoggerTalkingPoint,
} from "@/components/participation/session-logger";
import { requireUserId } from "@/lib/auth/require-user";
import type { ParticipationKind } from "@/lib/participation/schemas";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Log session" };

type Params = Promise<{ occurrenceId: string }>;

/**
 * One class session's logging screen — the surface the "< 5 seconds from a
 * phone" DoD clause is about. The server renders what is already on file
 * (attendance, logs, talking points); every write from here on goes through
 * `SessionLogger`'s offline queue.
 *
 * The query pins `calendar_items.kind = 'class'`: the ledger attaches to class
 * sessions only, so a deadline's occurrence 404s here rather than growing an
 * attendance record. RLS makes another tenant's occurrence indistinguishable
 * from a missing one — same 404, no oracle.
 */
export default async function SessionPage({ params }: { params: Params }) {
  const { occurrenceId } = await params;
  if (!z.uuid().safeParse(occurrenceId).success) notFound();

  const supabase = await createClient();
  const userId = await requireUserId(supabase);

  const { data: occurrence } = await supabase
    .from("calendar_occurrences")
    .select(
      `id, starts_at, ends_at, status,
       calendar_items!inner (
         id, title, kind, session_from, session_to,
         courses (id, title)
       )`,
    )
    .eq("id", occurrenceId)
    .eq("calendar_items.kind", "class")
    .maybeSingle();

  if (!occurrence) notFound();

  const [{ data: attendance }, { data: logs }, { data: points }] = await Promise.all([
    supabase
      .from("attendance_records")
      .select("status")
      .eq("occurrence_id", occurrenceId)
      .maybeSingle(),
    supabase
      .from("participation_logs")
      .select("id, kind, quality")
      .eq("occurrence_id", occurrenceId)
      .order("created_at", { ascending: true }),
    supabase
      .from("talking_points")
      .select("id, body, used")
      .eq("occurrence_id", occurrenceId)
      .order("created_at", { ascending: true }),
  ]);

  const item = occurrence.calendar_items;
  const course = item.courses;

  const { data: profile } = await supabase.from("profiles").select("timezone").maybeSingle();
  const timeZone = profile?.timezone ?? "Europe/Madrid";
  const when = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(occurrence.starts_at));

  const sessionLabel =
    item.session_from !== null
      ? item.session_to !== null && item.session_to !== item.session_from
        ? `Sessions ${item.session_from}–${item.session_to}`
        : `Session ${item.session_from}`
      : null;

  return (
    <>
      <PageHeader
        title={item.title}
        lead={[course?.title, sessionLabel, when].filter(Boolean).join(" · ")}
      />
      <SessionLogger
        userId={userId}
        occurrenceId={occurrence.id}
        initialAttendance={(attendance?.status ?? null) as AttendanceStatus | null}
        initialLogs={(logs ?? []).map(
          (log): SessionLoggerLog => ({
            id: log.id,
            kind: log.kind as ParticipationKind,
            quality: log.quality,
          }),
        )}
        talkingPoints={(points ?? []) as SessionLoggerTalkingPoint[]}
      />
    </>
  );
}
