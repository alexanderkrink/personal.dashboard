"use client";

import type { AttendanceStatus } from "@study/core";
import { useMemo, useState } from "react";
import {
  createTalkingPoint,
  deleteTalkingPoint,
  flushLedger,
} from "@/app/(app)/participation/actions";
import { Form } from "@/components/form/form";
import { FormField } from "@/components/form/form-field";
import { FormStatus } from "@/components/form/form-status";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { LedgerEntry, ParticipationKind } from "@/lib/participation/schemas";
import { useLedgerQueue } from "@/lib/participation/use-ledger-queue";
import { cn } from "@/lib/utils";

/**
 * The two-tap logger (PLAN Additional #4 b): four big thumb buttons, the
 * attendance toggle, talking points with "used it" checks.
 *
 * Every tap is optimistic — the UI updates immediately, the write goes into
 * the localStorage queue, and the queue flushes now if the network allows or
 * on 'online' if it does not. The queue survives a page close; the pending
 * badge is the honest account of what the server has not yet confirmed.
 *
 * Two domain rules are encoded here rather than in the database:
 *  - **Speaking implies presence.** Logging any contribution flips the
 *    attendance toggle to present if it is not already — you cannot comment in
 *    a class you missed, and making the user do both taps would double the
 *    cost of the common case.
 *  - **"Silent" writes attendance, not a log.** A session with an attendance
 *    record and zero contributions IS the recorded silence; the button exists
 *    so silence gets recorded in one tap instead of dying unmeasured (the
 *    plan's named failure mode: three quiet weeks and the grade is gone).
 */

export interface SessionLoggerLog {
  id: string;
  kind: ParticipationKind;
  quality: number | null;
}

export interface SessionLoggerTalkingPoint {
  id: string;
  body: string;
  used: boolean;
}

const TAP_BUTTONS: readonly {
  label: string;
  detail: string;
  kind: ParticipationKind;
  quality: 1 | 2 | 3 | null;
  emphasis?: boolean;
}[] = [
  { label: "Spoke", detail: "strong", kind: "comment", quality: 3, emphasis: true },
  { label: "Spoke", detail: "ok", kind: "comment", quality: 2 },
  { label: "Cold-called", detail: "held my own", kind: "cold_call", quality: null },
];

const ATTENDANCE_OPTIONS: readonly { status: AttendanceStatus; label: string }[] = [
  { status: "present", label: "Present" },
  { status: "absent", label: "Absent" },
  { status: "excused", label: "Excused" },
];

function logLabel(log: SessionLoggerLog): string {
  switch (log.kind) {
    case "comment":
      return log.quality === 3
        ? "Spoke (strong)"
        : log.quality === 1
          ? "Spoke (weak)"
          : "Spoke (ok)";
    case "question":
      return "Question";
    case "cold_call":
      return "Cold-called";
    case "presentation":
      return "Presentation";
  }
}

export function SessionLogger({
  userId,
  occurrenceId,
  initialAttendance,
  initialLogs,
  talkingPoints,
}: {
  userId: string;
  occurrenceId: string;
  initialAttendance: AttendanceStatus | null;
  initialLogs: readonly SessionLoggerLog[];
  talkingPoints: readonly SessionLoggerTalkingPoint[];
}) {
  const { pendingCount, rejected, push, dismissRejected } = useLedgerQueue(userId, flushLedger);

  const [attendance, setAttendance] = useState<AttendanceStatus | null>(initialAttendance);
  const [added, setAdded] = useState<readonly SessionLoggerLog[]>([]);
  const [usedOverrides, setUsedOverrides] = useState<Readonly<Record<string, boolean>>>({});
  const [notice, setNotice] = useState<string | null>(null);

  // Server-known logs win over the optimistic copy of themselves: after a
  // revalidation the same id can arrive in both lists.
  const logs = useMemo(() => {
    const known = new Set(initialLogs.map((log) => log.id));
    return [...initialLogs, ...added.filter((log) => !known.has(log.id))];
  }, [initialLogs, added]);

  function setAttendanceStatus(status: AttendanceStatus, tellUser = true) {
    setAttendance(status);
    push({
      type: "attendance",
      clientId: crypto.randomUUID(),
      occurrenceId,
      status,
    } satisfies LedgerEntry);
    if (tellUser) setNotice(`Marked ${status}.`);
  }

  /** Speaking implies presence — flip the toggle with the contribution. */
  function ensurePresent() {
    if (attendance !== "present") setAttendanceStatus("present", false);
  }

  function logContribution(kind: ParticipationKind, quality: 1 | 2 | 3 | null, label: string) {
    const clientId = crypto.randomUUID();
    ensurePresent();
    push({ type: "participation", clientId, occurrenceId, kind, quality } satisfies LedgerEntry);
    setAdded((previous) => [...previous, { id: clientId, kind, quality }]);
    setNotice(`${label} logged.`);
  }

  function markSilent() {
    ensurePresent();
    setNotice(
      logs.length === 0
        ? "Marked present with nothing logged — that IS the record of a silent session."
        : "Marked present. Contributions already logged for this session still count.",
    );
  }

  function toggleUsed(point: SessionLoggerTalkingPoint) {
    const used = !(usedOverrides[point.id] ?? point.used);
    setUsedOverrides((previous) => ({ ...previous, [point.id]: used }));
    push({
      type: "talking_point_used",
      clientId: crypto.randomUUID(),
      talkingPointId: point.id,
      used,
    } satisfies LedgerEntry);
  }

  return (
    <div className="flex flex-col gap-8">
      {/* The two-tap grid. 4rem rows: these are pressed mid-class, at arm's length. */}
      <section aria-label="Log a contribution" className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          {TAP_BUTTONS.map((tap) => (
            <Button
              key={`${tap.kind}-${tap.quality}`}
              type="button"
              size="lg"
              variant={tap.emphasis ? "default" : "secondary"}
              className="h-16 flex-col gap-0"
              onClick={() => logContribution(tap.kind, tap.quality, `${tap.label} (${tap.detail})`)}
            >
              <span className="text-base font-semibold">{tap.label}</span>
              <span
                className={cn(
                  "text-xs font-normal",
                  tap.emphasis ? "text-primary-foreground/80" : "text-muted-foreground",
                )}
              >
                {tap.detail}
              </span>
            </Button>
          ))}
          <Button
            type="button"
            size="lg"
            variant="outline"
            className="h-16 flex-col gap-0"
            onClick={markSilent}
          >
            <span className="text-base font-semibold">Silent</span>
            <span className="text-xs font-normal text-muted-foreground">present, said nothing</span>
          </Button>
        </div>

        {/* One polite live region for tap feedback; taps are frequent, so
            never role="alert". */}
        <p role="status" className="min-h-5 text-sm text-muted-foreground">
          {notice}
        </p>
      </section>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium text-muted-foreground">Attendance</legend>
        <div className="grid grid-cols-3 gap-2">
          {ATTENDANCE_OPTIONS.map((option) => (
            <Button
              key={option.status}
              type="button"
              variant={attendance === option.status ? "default" : "outline"}
              aria-pressed={attendance === option.status}
              className="h-11"
              onClick={() => setAttendanceStatus(option.status)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Attendance is a pass/fail gate — it earns nothing and can cost everything. Participation
          is graded separately.
        </p>
      </fieldset>

      {(pendingCount > 0 || rejected.length > 0) && (
        <section aria-label="Sync status" className="flex flex-col gap-2">
          {pendingCount > 0 && (
            <p role="status" className="font-mono text-sm text-muted-foreground">
              ● {pendingCount} {pendingCount === 1 ? "tap" : "taps"} queued — syncs the moment
              you're back online.
            </p>
          )}
          {rejected.length > 0 && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 text-sm text-destructive"
            >
              <span>
                {rejected.length} {rejected.length === 1 ? "tap was" : "taps were"} refused by the
                server and won't retry.
              </span>
              <Button type="button" variant="ghost" size="sm" onClick={dismissRejected}>
                Dismiss
              </Button>
            </div>
          )}
        </section>
      )}

      {logs.length > 0 && (
        <section aria-label="Logged this session" className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">Logged this session</h2>
          <ul className="flex flex-col gap-1">
            {logs.map((log) => (
              <li key={log.id} className="text-sm">
                {logLabel(log)}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Talking points" className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">Talking points</h2>
        {talkingPoints.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Nothing prepared. Type 1–2 points the night before — walking in with ammunition is how
            participation stops depending on courage in the moment.
          </p>
        )}
        {talkingPoints.length > 0 && (
          <ul className="flex flex-col gap-2">
            {talkingPoints.map((point) => {
              const used = usedOverrides[point.id] ?? point.used;
              return (
                <li key={point.id} className="flex items-start gap-3">
                  {/* A native checkbox: "used it" is genuinely a checkbox, and the
                      44px hit area comes from the label wrapping it. */}
                  <label className="flex min-h-11 flex-1 cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      checked={used}
                      onChange={() => toggleUsed(point)}
                      className="size-5 shrink-0 accent-primary"
                    />
                    <span className={cn("text-sm", used && "text-muted-foreground line-through")}>
                      {point.body}
                    </span>
                  </label>
                  <Form action={deleteTalkingPoint} className="shrink-0">
                    {() => (
                      <>
                        <input type="hidden" name="talkingPointId" value={point.id} />
                        <input type="hidden" name="occurrenceId" value={occurrenceId} />
                        <SubmitButton
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete talking point: ${point.body}`}
                          pendingLabel="…"
                        >
                          Delete
                        </SubmitButton>
                      </>
                    )}
                  </Form>
                </li>
              );
            })}
          </ul>
        )}

        <Form action={createTalkingPoint} className="gap-2">
          {(state) => (
            <>
              <input type="hidden" name="occurrenceId" value={occurrenceId} />
              <FormField name="body" label="Add a talking point" state={state}>
                {(control) => (
                  <Input
                    {...control}
                    placeholder="One point you plan to make"
                    autoComplete="off"
                    maxLength={500}
                  />
                )}
              </FormField>
              <FormStatus state={state} />
              <SubmitButton variant="secondary" pendingLabel="Adding…">
                Add point
              </SubmitButton>
            </>
          )}
        </Form>
      </section>
    </div>
  );
}
