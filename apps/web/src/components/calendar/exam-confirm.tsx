"use client";

import { useActionState, useId, useState } from "react";
import { setExamDate } from "@/app/(app)/calendar/item-actions";
import { FormStatus } from "@/components/form/form-status";
import { FOCUS_RING } from "@/components/shell/focus-ring";
import { SubmitButton } from "@/components/submit-button";
import { IDLE_FORM_STATE } from "@/lib/forms/form-state";
import { cn } from "@/lib/utils";
import type { ExamSessionOption, ExamStatus } from "@/server/calendar/exam-status";

/**
 * The §5.1b exam-date controls — **the mandatory human confirm, and the way back
 * out of it**.
 *
 * Exam dates are date-critical *and* grade-critical, the two gates reserved by
 * the Human-reversible-AI principle, so a detected date stays a proposal until
 * someone presses Confirm. That gate is unchanged.
 *
 * ## 🔴 What was a dead end, and now is not (2026-07-19)
 *
 * There were exactly two things a user could do — accept the detector's session
 * or reject it — and both were terminal:
 *
 * - **Rejecting was a one-way door.** It cleared the flag with no marker saying
 *   a human had ruled, so the read path (which re-runs detection on every
 *   render) simply proposed the same session again. The button appeared to do
 *   nothing, and there was no "actually, yes it is" anywhere.
 * - **The wrong session could not be corrected.** If the detector picked
 *   session 24 and the exam is session 30, the only available answers were
 *   "yes" and "no". Neither is the right one.
 *
 * So the controls now cover the full round trip. Every state offers a move, and
 * **no state is terminal**:
 *
 * | state | offered |
 * |---|---|
 * | detected | Confirm · Not an exam · Change |
 * | chosen (confirmed) | Change · Not an exam |
 * | rejected | Set a date · Undo |
 * | pending / unknown | Set a date, when the feed has sessions to offer |
 *
 * ## 🚨 What these buttons deliberately do NOT do
 *
 * They do not touch the confidence chip. Confirming a date says *"session 30 is
 * the exam"*; it does not say where the number 30 came from, and on all seven
 * fall courses it came off this same feed. The chip and the panel's disclosure
 * are computed from `courses.total_sessions_source` and are unreachable from
 * here — a user agreeing with the calendar cannot turn the calendar into a
 * syllabus.
 */
export function ExamConfirmButtons({ status, timeZone }: { status: ExamStatus; timeZone: string }) {
  const [decideState, decide] = useActionState(setExamDate, IDLE_FORM_STATE);
  const [pickState, pick] = useActionState(setExamDate, IDLE_FORM_STATE);
  const [picking, setPicking] = useState(false);
  const selectId = useId();

  const { decision, exam, sessions } = status;
  const canPick = sessions.length > 0;

  return (
    <>
      <form action={decide} className="flex shrink-0 flex-wrap items-center gap-1.5">
        <input type="hidden" name="courseId" value={status.course.id} />
        {exam !== null ? <input type="hidden" name="itemId" value={exam.itemId} /> : null}

        {decision === "rejected" ? (
          <>
            <span className="text-muted-foreground text-ui-xs">No exam set</span>
            {/* The way back. `reset` drops the lock as well as the flag, so the
                detector is free to propose again — which is what "undo" has to
                mean here, rather than pinning the row to its rejected value. */}
            <SubmitButton variant="ghost" size="sm" name="intent" value="reset" pendingLabel="…">
              Undo
            </SubmitButton>
          </>
        ) : decision === "chosen" ? (
          <>
            <span className="text-muted-foreground text-ui-xs">Confirmed</span>
            <SubmitButton variant="ghost" size="sm" name="intent" value="reject" pendingLabel="…">
              Not an exam
            </SubmitButton>
          </>
        ) : exam !== null ? (
          <>
            <SubmitButton variant="outline" size="sm" name="intent" value="set" pendingLabel="…">
              Confirm
            </SubmitButton>
            <SubmitButton variant="ghost" size="sm" name="intent" value="reject" pendingLabel="…">
              Not an exam
            </SubmitButton>
          </>
        ) : null}

        {canPick ? (
          <button
            type="button"
            onClick={() => setPicking(!picking)}
            aria-expanded={picking}
            className={cn(
              "rounded-md px-2 py-1 text-muted-foreground text-ui-xs hover:text-foreground",
              FOCUS_RING,
            )}
          >
            {picking ? "Cancel" : exam === null ? "Set a date" : "Change"}
          </button>
        ) : null}
      </form>

      {/* Full-width below the row at every viewport: a select plus a button
          cannot share a 375px line with a course title and a date, and the
          picker is a deliberate second step rather than something to squeeze
          in. `basis-full` because this is a flex child of the row. */}
      {picking && canPick ? (
        <form action={pick} className="flex basis-full flex-wrap items-center gap-2 pt-1">
          <input type="hidden" name="intent" value="set" />
          <label htmlFor={selectId} className="text-muted-foreground text-ui-xs">
            Which session is the exam?
          </label>
          {/*
            A native `<select>`, matching the Unassigned bucket's reasoning: one
            of these renders per course, it works before hydration, and it is
            the better control on a phone regardless.
          */}
          <select
            id={selectId}
            name="itemId"
            required
            // ⚠ Keyed on the current exam. `defaultValue` is applied on mount
            // only, so after a successful change the RSC re-render would leave
            // this select still showing the session the user just moved away
            // from — the one thing on screen contradicting the row above it.
            key={exam?.itemId ?? "none"}
            defaultValue={exam?.itemId ?? ""}
            className={cn(
              "h-8 max-w-[16rem] rounded-md border border-input-border bg-input px-2 text-foreground text-ui-sm",
              FOCUS_RING,
            )}
          >
            <option value="" disabled>
              Choose a session…
            </option>
            {sessions.map((session) => (
              <option key={session.itemId} value={session.itemId}>
                {sessionLabel(session, timeZone)}
              </option>
            ))}
          </select>
          <SubmitButton variant="outline" size="sm" pendingLabel="Saving…">
            Set as exam
          </SubmitButton>
        </form>
      ) : null}

      {decideState.status === "error" || pickState.status === "error" ? (
        <FormStatus
          state={decideState.status === "error" ? decideState : pickState}
          className="basis-full text-ui-xs"
        />
      ) : null}
    </>
  );
}

function sessionLabel(session: ExamSessionOption, timeZone: string): string {
  const when = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone,
  }).format(new Date(session.startsAtUtc));

  return `Ses. ${session.sessionNumber} · ${when}`;
}
