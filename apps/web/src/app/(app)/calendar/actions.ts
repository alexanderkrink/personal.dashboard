"use server";

import { createAdminSupabaseClient } from "@study/db";
import { revalidatePath } from "next/cache";
import { env } from "@/env";
import { requireUserId } from "@/lib/auth/require-user";
import {
  FEED_FIELDS,
  feedCreateSchema,
  feedIdSchema,
  feedUpdateSchema,
} from "@/lib/calendar/schemas";
import { redactSecrets } from "@/lib/calendar/secret";
import { type FormState, formError, toFormState } from "@/lib/forms/form-state";
import { readFormValues } from "@/lib/forms/form-values";
import { createClient } from "@/lib/supabase/server";
import { formatRetryAfter, rateLimitRemainingMs } from "@/server/calendar/staleness";
import { createSupabaseCalendarStore } from "@/server/calendar/store-supabase";
import { syncFeed } from "@/server/calendar/sync";

/**
 * Feed writes.
 *
 * 🔒 **The feed URL is a capability token.** Two rules govern every line below:
 *
 *  1. It is never echoed back into `FormState.values`. That object is
 *     round-tripped through the HTML document, so anything in it is one "view
 *     source" away from being read — `readFormValues` is called for the label
 *     only, and the URL is pulled out separately.
 *  2. It never reaches an error message. Everything user-facing here is a
 *     literal written in this file; the one place a database error string could
 *     carry a URL goes through `redactSecrets` first.
 */

const SAVE_FAILED = "That didn’t save. Try again — nothing you typed was lost.";
const NOT_FOUND = "That feed no longer exists. It may have been deleted in another tab.";

/** Blank strings for every field — what a successful create echoes back. */
const CLEARED = Object.fromEntries(FEED_FIELDS.map((field) => [field, ""]));

/**
 * Form values that are safe to send back to the browser.
 *
 * The URL is deliberately excluded, even on a failed submit — which does cost
 * the user retyping it when the label is what failed validation. That is the
 * right trade: WCAG 2.2 SC 3.3.7 asks us not to make people re-enter
 * information, and it explicitly exempts data that would be a security risk to
 * repopulate. A capability token is exactly that.
 */
function safeValues(label: string): Record<string, string> {
  return { label, url: "" };
}

export async function createFeed(_previous: FormState, formData: FormData): Promise<FormState> {
  const label = readFormValues(formData, ["label"]).label ?? "";
  const url = typeof formData.get("url") === "string" ? String(formData.get("url")) : "";

  const parsed = feedCreateSchema.safeParse({ label, url });
  if (!parsed.success) return toFormState(parsed.error, safeValues(label));

  const supabase = await createClient();
  const userId = await requireUserId(supabase);

  const { error } = await supabase.from("calendar_feeds").insert({
    user_id: userId,
    label: parsed.data.label,
    // The token lands in `config`, per-user and RLS-protected — never in an
    // env var, so revoking one feed is a row update rather than a redeploy.
    config: { url: parsed.data.url },
  });

  if (error) return formError(SAVE_FAILED, safeValues(label));

  revalidatePath("/calendar");
  return {
    status: "success",
    message: `${parsed.data.label} added. Sync it to pull your timetable in.`,
    values: CLEARED,
  };
}

export async function updateFeed(_previous: FormState, formData: FormData): Promise<FormState> {
  const label = readFormValues(formData, ["label"]).label ?? "";
  const id = feedIdSchema.safeParse(formData.get("feedId"));
  if (!id.success) return formError(NOT_FOUND, safeValues(label));

  // One form, several submitters: the `intent` convention from the semester and
  // assessment rows.
  const intent = formData.get("intent");
  if (intent === "delete") return deleteFeed(id.data);
  if (intent === "toggle") return toggleFeed(id.data);
  if (intent === "sync") return syncNow(id.data);

  const url = typeof formData.get("url") === "string" ? String(formData.get("url")) : "";
  const parsed = feedUpdateSchema.safeParse({ label, url });
  if (!parsed.success) return toFormState(parsed.error, safeValues(label));

  const supabase = await createClient();
  await requireUserId(supabase);

  const patch: { label: string; config?: { url: string }; sync_cursor?: null } = {
    label: parsed.data.label,
  };
  if (parsed.data.url !== null) {
    patch.config = { url: parsed.data.url };
    // A new URL is a new feed as far as caching is concerned. Keeping the old
    // ETag and content hash would let the first sync against the new
    // subscription decide nothing had changed and skip it entirely.
    patch.sync_cursor = null;
  }

  const { data, error } = await supabase
    .from("calendar_feeds")
    .update(patch)
    .eq("id", id.data)
    .select("id")
    .maybeSingle();

  if (error) return formError(SAVE_FAILED, safeValues(label));
  if (!data) return formError(NOT_FOUND, safeValues(label));

  revalidatePath("/calendar");
  return { status: "success", message: "Saved.", values: safeValues(parsed.data.label) };
}

/**
 * Deletes a feed and, by `on delete cascade`, everything synced from it.
 *
 * Module-private and reached through `updateFeed`'s `intent`: every export of a
 * `"use server"` module is a callable endpoint, and this has no reason to be a
 * second one.
 */
async function deleteFeed(id: string): Promise<FormState> {
  const supabase = await createClient();
  await requireUserId(supabase);

  const { data, error } = await supabase
    .from("calendar_feeds")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();

  // 23503: an occurrence synced from this feed carries attendance or
  // participation rows, and the ledger's NO ACTION FKs (20260720222423) refuse
  // to let graded history vanish as a side effect of a feed delete. That is
  // the schema doing its job — but "Try again" would be a lie here, because no
  // retry can ever succeed while the history exists. Say why, terminally.
  if (error?.code === "23503") {
    return formError(
      "This feed’s classes have logged attendance or participation. That graded history is protected, so the feed can’t be removed while those records exist.",
    );
  }
  if (error) return formError(SAVE_FAILED);
  if (!data) return formError(NOT_FOUND);

  revalidatePath("/calendar");
  return {
    status: "info",
    message: "Feed removed, along with everything it had synced. Your own entries are untouched.",
  };
}

/** Pauses or resumes a feed without losing its URL or anything it has synced. */
async function toggleFeed(id: string): Promise<FormState> {
  const supabase = await createClient();
  await requireUserId(supabase);

  const current = await supabase.from("calendar_feeds").select("active").eq("id", id).maybeSingle();
  if (current.error) return formError(SAVE_FAILED);
  if (!current.data) return formError(NOT_FOUND);

  const next = !current.data.active;
  const { error } = await supabase.from("calendar_feeds").update({ active: next }).eq("id", id);
  if (error) return formError(SAVE_FAILED);

  revalidatePath("/calendar");
  return {
    status: "info",
    message: next ? "Feed resumed." : "Feed paused. Nothing already synced was removed.",
  };
}

/**
 * Runs a sync now.
 *
 * The ownership check is the important line here, and it is deliberately done
 * BEFORE the admin client appears. The engine runs under
 * `createAdminSupabaseClient`, which bypasses RLS — correct for a background
 * job, and a confused-deputy hole if a request handler hands it an id chosen by
 * whoever is calling. So the feed is first read through the *user's* client,
 * where RLS answers "is this yours?", and only an id that survived that is
 * passed on.
 */
async function syncNow(id: string): Promise<FormState> {
  const supabase = await createClient();
  await requireUserId(supabase);

  const owned = await supabase
    .from("calendar_feeds")
    .select("id, active, last_synced_at")
    .eq("id", id)
    .maybeSingle();
  if (owned.error) return formError(SAVE_FAILED);
  if (!owned.data) return formError(NOT_FOUND);
  if (!owned.data.active) {
    return formError("That feed is paused. Resume it first.");
  }

  // §3.1: "Sync now" is rate-limited to 1/min per user. The limiter's state is
  // `last_synced_at`, a column that already exists, is written by every run, and
  // is already per-user by RLS — so there is no counter table to maintain and no
  // in-memory map to lose on the next serverless invocation.
  //
  // This is a different guard from the engine's lease, which stops two runs
  // OVERLAPPING. Nothing overlaps if a user clicks once a second for a minute,
  // and without this that is sixty full fetches of the university's feed.
  const remainingMs = rateLimitRemainingMs(owned.data.last_synced_at, new Date());
  if (remainingMs > 0) {
    return {
      status: "info",
      message: `Just synced. Try again in ${formatRetryAfter(remainingMs)}.`,
    };
  }

  const store = createSupabaseCalendarStore(
    createAdminSupabaseClient({
      url: env.NEXT_PUBLIC_SUPABASE_URL,
      secretKey: env.SUPABASE_SECRET_KEY,
    }),
  );

  const result = await syncFeed(store, owned.data.id);
  revalidatePath("/calendar");

  switch (result.status) {
    case "ok":
      return {
        status: "success",
        message: `Synced. ${result.itemsWritten + result.occurrencesWritten === 0 ? "Nothing had changed." : `${result.itemsWritten} updated, ${result.deleted} removed.`}`,
      };
    case "unchanged":
      return { status: "info", message: "Already up to date." };
    case "skipped":
      return { status: "info", message: "A sync is already running for this feed." };
    default:
      // `result.message` is written by the engine and already redacted, but
      // this is the last gate before a string reaches the browser and it costs
      // nothing to close it here too.
      return formError(redactSecrets(result.message));
  }
}
