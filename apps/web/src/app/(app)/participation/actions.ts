"use server";

import type { FlushResult } from "@study/core";
import type { SupabaseServerClient } from "@study/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUserId } from "@/lib/auth/require-user";
import { type FormState, formError, toFormState } from "@/lib/forms/form-state";
import { readFormValues } from "@/lib/forms/form-values";
import { flushOutcomeForError } from "@/lib/participation/flush-outcome";
import {
  LEDGER_BATCH_LIMIT,
  type LedgerEntry,
  ledgerEntrySchema,
  TALKING_POINT_FIELDS,
  talkingPointSchema,
} from "@/lib/participation/schemas";
import { createClient } from "@/lib/supabase/server";

/**
 * The ledger's write path. Two kinds of action live here:
 *
 *  - `flushLedger` — the ONE endpoint the offline queue talks to. Both the
 *    tap-time write and the reconnect replay go through it, so there is a
 *    single code path to get right. It never throws for a bad entry and never
 *    redirects: its caller is a background flush, and its contract is a
 *    per-entry verdict (`delivered` / `rejected` / `failed`) the queue folds
 *    back into itself. A thrown error would read as "the whole batch failed",
 *    which is exactly wrong when one entry was the problem.
 *
 *  - Talking-point CRUD — ordinary FormState actions. Prep is typed the night
 *    before on real wifi; it does not need the queue's paranoia.
 *
 * Note what is deliberately ABSENT: an ownership pre-check. The composite FKs
 * `(occurrence_id, user_id) → calendar_occurrences (id, user_id)` make the
 * database refuse a write against another tenant's session (SQLSTATE 23503,
 * mapped to `rejected`), and RLS covers the rows themselves. The application
 * could only re-implement that check worse.
 */

const batchShapeSchema = z.array(z.unknown());

/** The lenient probe: an entry too broken to validate may still be addressable. */
const clientIdProbe = z.object({ clientId: z.uuid() });

export async function flushLedger(input: unknown): Promise<FlushResult[]> {
  const batch = batchShapeSchema.safeParse(input);
  if (!batch.success) return [];

  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const sub = data?.claims.sub;
  const userId = typeof sub === "string" && sub.length > 0 ? sub : null;

  const results: FlushResult[] = [];
  // Sequential on purpose, twice over: entries are applied in tap order (the
  // last attendance toggle must win), and entries past the batch limit get NO
  // result — the queue keeps them for the next flush. Backpressure, not error.
  for (const raw of batch.data.slice(0, LEDGER_BATCH_LIMIT)) {
    const probe = clientIdProbe.safeParse(raw);
    // No clientId at all: unaddressable, and impossible for a legitimate
    // queue to produce. There is nothing to answer.
    if (!probe.success) continue;
    const clientId = probe.data.clientId;

    if (userId === null) {
      // Session expired mid-batch. Retryable: taps must survive a re-login.
      results.push({ clientId, outcome: "failed" });
      continue;
    }

    const entry = ledgerEntrySchema.safeParse(raw);
    if (!entry.success) {
      results.push({ clientId, outcome: "rejected" });
      continue;
    }

    results.push({ clientId, outcome: await writeEntry(supabase, userId, entry.data) });
  }
  return results;
}

async function writeEntry(
  supabase: SupabaseServerClient,
  userId: string,
  entry: LedgerEntry,
): Promise<FlushResult["outcome"]> {
  switch (entry.type) {
    case "participation": {
      // The clientId IS the primary key: replaying a half-delivered batch hits
      // ignoreDuplicates instead of double-logging a graded contribution.
      const { error } = await supabase.from("participation_logs").upsert(
        {
          id: entry.clientId,
          user_id: userId,
          occurrence_id: entry.occurrenceId,
          kind: entry.kind,
          quality: entry.quality,
        },
        { onConflict: "id", ignoreDuplicates: true },
      );
      return flushOutcomeForError(error);
    }
    case "attendance": {
      // One row per (occurrence, user); a re-toggle updates it. Last write
      // wins because the batch is applied in tap order.
      const { error } = await supabase
        .from("attendance_records")
        .upsert(
          { user_id: userId, occurrence_id: entry.occurrenceId, status: entry.status },
          { onConflict: "occurrence_id,user_id" },
        );
      return flushOutcomeForError(error);
    }
    case "talking_point_used": {
      const { data, error } = await supabase
        .from("talking_points")
        .update({ used: entry.used })
        .eq("id", entry.talkingPointId)
        .select("id")
        .maybeSingle();
      if (error) return flushOutcomeForError(error);
      // Vanished (deleted in another tab, or never this tenant's): no retry
      // can ever land it.
      return data === null ? "rejected" : "delivered";
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Talking points — night-before prep, ordinary forms                         */
/* -------------------------------------------------------------------------- */

const SAVE_FAILED = "That didn’t save. Try again — nothing you typed was lost.";
const NO_SESSION = "That class session no longer exists.";
const NOT_FOUND = "That talking point no longer exists. It may have been deleted in another tab.";

const occurrenceIdSchema = z.uuid();

export async function createTalkingPoint(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const values = readFormValues(formData, TALKING_POINT_FIELDS);
  const occurrenceId = occurrenceIdSchema.safeParse(formData.get("occurrenceId"));
  if (!occurrenceId.success) return formError(NO_SESSION, values);

  const parsed = talkingPointSchema.safeParse(values);
  if (!parsed.success) return toFormState(parsed.error, values);

  const supabase = await createClient();
  const userId = await requireUserId(supabase);

  const { error } = await supabase.from("talking_points").insert({
    user_id: userId,
    occurrence_id: occurrenceId.data,
    body: parsed.data.body,
  });

  // 23503 is the composite FK saying the occurrence is not this tenant's (or
  // is gone) — the same refusal either way, and the same honest message.
  if (error) return formError(error.code === "23503" ? NO_SESSION : SAVE_FAILED, values);

  revalidatePath(`/participation/${occurrenceId.data}`);

  return { status: "success", message: "Added.", values: { body: "" } };
}

export async function deleteTalkingPoint(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const id = z.uuid().safeParse(formData.get("talkingPointId"));
  const occurrenceId = occurrenceIdSchema.safeParse(formData.get("occurrenceId"));
  if (!id.success || !occurrenceId.success) return formError(NOT_FOUND);

  const supabase = await createClient();
  await requireUserId(supabase);

  const { data, error } = await supabase
    .from("talking_points")
    .delete()
    .eq("id", id.data)
    .select("id")
    .maybeSingle();

  if (error) return formError(SAVE_FAILED);
  if (!data) return formError(NOT_FOUND);

  revalidatePath(`/participation/${occurrenceId.data}`);

  return { status: "info", message: "Deleted." };
}
