import { z } from "zod";

/**
 * The validation boundary for the participation ledger (CLAUDE.md: *Zod at
 * every boundary*). Two kinds of traffic cross it:
 *
 *  - **Queue entries** — JSON built by the two-tap logger, held in
 *    localStorage across flaky wifi, and replayed at the `flushLedger` Server
 *    Action. localStorage is user-editable storage on a shared machine, so the
 *    server treats every entry as untrusted input no matter that our own code
 *    wrote it.
 *  - **Talking-point form fields** — ordinary `FormData` strings.
 *
 * `clientId` is generated at tap time and is the entry's identity end to end:
 * queue dedup key, flush-result address, and (for participation inserts) the
 * database primary key — which is what makes replaying a half-delivered batch
 * idempotent instead of double-logging a graded contribution.
 */

export const PARTICIPATION_KINDS = ["comment", "question", "cold_call", "presentation"] as const;
export type ParticipationKind = (typeof PARTICIPATION_KINDS)[number];

export const ATTENDANCE_STATUSES = ["present", "absent", "excused"] as const;

export const participationEntrySchema = z.object({
  type: z.literal("participation"),
  clientId: z.uuid(),
  occurrenceId: z.uuid(),
  kind: z.enum(PARTICIPATION_KINDS),
  /** Self-assessed 1–3 (3 = strong). Null for kinds without a self-grade. */
  quality: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(),
});

export const attendanceEntrySchema = z.object({
  type: z.literal("attendance"),
  clientId: z.uuid(),
  occurrenceId: z.uuid(),
  status: z.enum(ATTENDANCE_STATUSES),
});

export const talkingPointUsedEntrySchema = z.object({
  type: z.literal("talking_point_used"),
  clientId: z.uuid(),
  talkingPointId: z.uuid(),
  used: z.boolean(),
});

export const ledgerEntrySchema = z.discriminatedUnion("type", [
  participationEntrySchema,
  attendanceEntrySchema,
  talkingPointUsedEntrySchema,
]);

export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

/**
 * How many entries one flush call will process. The client sends its whole
 * queue; the server answers the first `LEDGER_BATCH_LIMIT` and stays silent on
 * the rest, and a silent entry stays queued for the next flush — backpressure
 * without a failure mode.
 */
export const LEDGER_BATCH_LIMIT = 200;

/** The night-before prep form. */
export const talkingPointSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "Write the point first — future-you is counting on it.")
    .max(500, "Keep it under 500 characters: a talking point, not the talk."),
});

export const TALKING_POINT_FIELDS = ["body"] as const;
