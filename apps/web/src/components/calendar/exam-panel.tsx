import { CheckCircle, Info, Prohibit, Question, Warning } from "@phosphor-icons/react/dist/ssr";
import { CourseDot } from "@/components/courses/course-dot";
import { cn } from "@/lib/utils";
import type { ExamConfidence, ExamStatus } from "@/server/calendar/exam-status";
import { ExamConfirmButtons } from "./exam-confirm";

/**
 * Exam detection, surfaced with its provenance intact (§5.1b).
 *
 * The three outcomes are rendered **distinctly**, because conflating them is the
 * failure the REVISED chain exists to prevent:
 *
 * - **found** — a date, plus how much to trust it.
 * - **pending** — *"exam not yet published, expect session N"*. Not "no exam":
 *   the difference between "session 30 is the last one" and "session 30 is the
 *   last one published so far" is the whole point.
 * - **unknown** — nothing to go on. Said plainly rather than dressed up.
 *
 * ## 🚨 The honesty requirement
 *
 * `detectExam` reports `syllabus_total_sessions` for all 7 fall courses, which
 * looks authoritative. It is not: `courses.total_sessions_source` says
 * `feed_derived` on every one of them, because Agent 0 seeded those counts from
 * this same feed. Steps 1 and 3 are one oracle read twice, and their agreement
 * is a tautology.
 *
 * So the confidence chip here is driven by **`ExamStatus.confidence`**, which is
 * computed from the recorded provenance — never from the detection source alone.
 * A feed-derived count renders as "From the feed", not "From the syllabus", and
 * the panel says so in words underneath.
 *
 * Nothing on this panel is confirmed truth until the user presses Confirm: an
 * exam date is date-critical AND grade-critical, the two gates reserved by the
 * Human-reversible-AI principle.
 *
 * ## …and every state on it is reversible (2026-07-19)
 *
 * A **rejected** course keeps its row, saying so, with an undo and a session
 * picker beside it — it does not drop out of the panel. That matters more than
 * it sounds: this list is the only place a course's exam state is visible, so a
 * row that disappears is a decision that cannot be found again, let alone
 * changed. See `ExamConfirmButtons` for the full state table.
 *
 * The confidence chip is computed upstream from `courses.total_sessions_source`
 * and no control on this panel can reach it. Confirming a date is a statement
 * about *which session*, never about where the session count came from.
 */

const CONFIDENCE_CHIP: Record<ExamConfidence, { label: string; className: string }> = {
  syllabus: {
    label: "From the syllabus",
    className: "bg-accent-subtle text-accent-text",
  },
  manual: {
    label: "You set this",
    className: "bg-accent-subtle text-accent-text",
  },
  // Amber, not neutral: this is the state that needs a second look.
  //
  // ⚠ `--urgency-medium-text`, not `--urgency-medium`. This is 11px text on a
  // 10% wash of its own hue, and the painting token renders that at 4.55:1 of
  // sampled glyph — under the AA floor, on the one label that discloses the
  // exam-oracle circularity. The writing token measures 5.35:1. See globals.css.
  feed_derived: {
    label: "From the feed",
    className: "bg-urgency-medium/10 text-urgency-medium-text dark:bg-urgency-medium/20",
  },
};

export function ExamPanel({
  statuses,
  timeZone,
}: {
  statuses: readonly ExamStatus[];
  timeZone: string;
}) {
  if (statuses.length === 0) return null;

  const circular = statuses.filter((status) => status.confidence === "feed_derived").length;

  return (
    <section className="mb-6 rounded-lg border border-border bg-surface">
      <h2 className="flex flex-wrap items-baseline gap-x-2 border-border border-b px-4 py-2.5 font-medium text-foreground text-ui-base">
        Exam dates
        {/* Counts what the panel actually SHOWS a date for, not what the
            detector found. A course the user rejected is not resolved, and
            counting it would restate the detector's opinion over the user's. */}
        <span className="font-mono text-muted-foreground text-ui-sm tabular-nums">
          {statuses.filter((status) => status.exam !== null).length} of {statuses.length} resolved
        </span>
      </h2>

      {circular > 0 ? (
        // The disclosure, stated where it is acted on rather than buried in a
        // doc. A user who confirms a date is entitled to know the two "sources"
        // that agreed are the same source.
        <p className="flex items-start gap-2 border-border border-b bg-urgency-medium/8 px-4 py-2.5 text-muted-foreground text-ui-sm dark:bg-urgency-medium/12">
          <Info
            weight="fill"
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-urgency-medium"
          />
          <span>
            <strong className="font-medium text-foreground">
              {circular} of these were derived from the calendar feed itself
            </strong>{" "}
            — the session count and the exam date come from the same place, so them agreeing proves
            nothing. Load a syllabus for the course to get an independent check.
          </span>
        </p>
      ) : null}

      <ul className="divide-y divide-border">
        {statuses.map((status) => (
          <ExamRow key={status.course.id} status={status} timeZone={timeZone} />
        ))}
      </ul>
    </section>
  );
}

function ExamRow({ status, timeZone }: { status: ExamStatus; timeZone: string }) {
  const chip = CONFIDENCE_CHIP[status.confidence];

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      {/* The basis is load-bearing, and it is spelled out rather than written
          `flex-1` on purpose. `flex-1` is `flex: 1 1 0%`, so on a wrapping row
          this span claims NO intrinsic width and every `shrink-0` sibling — the
          date, the chip, the buttons — takes its full size first. At 375px that
          left the course title and its provenance sentence a few pixels wide,
          rendering one word per line down a 250px-tall column that overlapped
          the date. A `w-full` here does nothing to fix it: `flex-basis` beats
          `width` on a flex item, which is why the basis itself has to change.
          Full line below `sm`, shared row above it. */}
      <span className="flex min-w-0 shrink grow basis-full items-center gap-2 sm:basis-0">
        <CourseDot color={status.course.color} />
        <span className="min-w-0">
          <span className="block truncate text-foreground text-ui-base">{status.course.title}</span>
          <span className="block text-muted-foreground text-ui-xs">{status.provenanceLabel}</span>
        </span>
      </span>

      <ExamOutcome status={status} timeZone={timeZone} />

      <span
        className={cn(
          "inline-flex h-5 shrink-0 items-center rounded-4xl px-2 font-medium text-ui-xs",
          chip.className,
        )}
      >
        {chip.label}
      </span>

      {status.conflict ? (
        <span className="inline-flex w-full items-center gap-1.5 text-urgency-overdue-text text-ui-xs sm:w-auto">
          <Warning weight="fill" aria-hidden="true" className="size-3.5" />
          Syllabus says {status.conflict.declaredSessions} sessions, feed has{" "}
          {status.conflict.feedMaxSession}
        </span>
      ) : null}

      {/* §5.1b guard 2. A softer colour than `conflict` on purpose: a session-count
          disagreement means one of two numbers is wrong, whereas a date outside the
          term is usually a real resit or a term boundary we have slightly off. It
          is a "look at this", not a "this is broken" — and it never hides the date,
          because guard 2 is skip-and-flag. */}
      {status.outsideSemester ? (
        <span className="inline-flex w-full items-center gap-1.5 text-urgency-medium-text text-ui-xs sm:w-auto">
          <Warning weight="fill" aria-hidden="true" className="size-3.5" />
          Falls outside your semester dates
        </span>
      ) : null}

      <ExamConfirmButtons status={status} timeZone={timeZone} />
    </li>
  );
}

function ExamOutcome({ status, timeZone }: { status: ExamStatus; timeZone: string }) {
  const { detection, exam } = status;

  /**
   * ⚠ A rejected course keeps its row and says so, rather than vanishing.
   *
   * A course that disappears from this panel is a course the user cannot get
   * back — and "I clicked the wrong button" is the single most likely reason a
   * row would be rejected in the first place. The state is named, and the
   * controls beside it offer both a session picker and an undo.
   */
  if (status.decision === "rejected") {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-ui-sm">
        <Prohibit weight="bold" aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">You said this course has no exam</span>
      </span>
    );
  }

  if (exam !== null) {
    const when = new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
    }).format(new Date(exam.startsAtUtc));

    return (
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-ui-sm tabular-nums">
        {status.confirmed ? (
          <CheckCircle weight="fill" aria-hidden="true" className="size-3.5 text-urgency-done" />
        ) : null}
        <span className="text-foreground">{when}</span>
        {exam.sessionNumber > 0 ? (
          <span className="text-muted-foreground">· Ses. {exam.sessionNumber}</span>
        ) : null}
      </span>
    );
  }

  if (detection.outcome === "pending") {
    // NOT "no exam". The feed simply has not published session N yet, and saying
    // so is the entire reason the chain was reordered.
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-ui-sm">
        <Question weight="fill" aria-hidden="true" className="size-3.5 text-urgency-medium" />
        <span className="text-muted-foreground">
          Not published yet — expect session{" "}
          <span className="font-mono tabular-nums">{detection.expectedSessionNumber}</span>
        </span>
      </span>
    );
  }

  return (
    <span className="shrink-0 text-muted-foreground text-ui-sm">
      No session numbers in the feed
    </span>
  );
}
