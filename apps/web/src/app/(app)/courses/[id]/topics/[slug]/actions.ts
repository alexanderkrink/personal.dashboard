"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUserId } from "@/lib/auth/require-user";
import { createClient } from "@/lib/supabase/server";
import { parseStoredPage } from "@/lib/topics/topic-view";

/**
 * The two writes a topic page offers: revert to a stored revision, and override the exam
 * weight.
 *
 * Both go through the request-scoped `createClient()`, never the admin client — these are
 * a user acting on their own row, so RLS is the authorization and the `.eq("user_id", …)`
 * restatements below are belt-and-braces on the statements where a policy regression would
 * be unrecoverable rather than merely wrong.
 */

const REVERT = z.object({
  topicId: z.uuid(),
  revisionId: z.uuid(),
  courseId: z.uuid(),
  slug: z.string().min(1),
});

const WEIGHT = z.object({
  topicId: z.uuid(),
  courseId: z.uuid(),
  slug: z.string().min(1),
  /** null clears the override and hands the topic back to the computed weight. */
  weight: z.number().min(0).max(1).nullable(),
});

type ActionResult = { ok: boolean; message?: string };

/**
 * Restores a stored snapshot as the current page (PLAN §8's one-click revert).
 *
 * ## A revert is an append, never a rewind
 *
 * `topic_revisions` is immutable history and the data model names it as such, so this does
 * NOT delete the revisions after the one being restored. It snapshots the *current* page
 * into a new row with `source: 'revert'` and then writes the old page over the live one.
 * That way the history still contains the version being reverted away from — which is the
 * version a student will want back the moment they discover the revert was the mistake.
 *
 * The five-column AI stamp is carried over from the revision being restored rather than
 * invented: the restored bytes really were produced by that prompt and that model, and
 * stamping a revert with today's prompt version would falsify the audit trail that column
 * exists to keep.
 */
export async function revertTopicRevision(input: unknown): Promise<ActionResult> {
  const parsed = REVERT.safeParse(input);
  if (!parsed.success) return { ok: false, message: "That revision no longer exists." };

  const supabase = await createClient();
  const userId = await requireUserId(supabase);

  const { data: revision } = await supabase
    .from("topic_revisions")
    .select("id, topic_id, revision, page, prompt_id, prompt_version, provider, model, input_hash")
    .eq("id", parsed.data.revisionId)
    .eq("topic_id", parsed.data.topicId)
    .maybeSingle();

  if (revision === null) return { ok: false, message: "That revision no longer exists." };

  const { data: topic } = await supabase
    .from("topics")
    .select("id, page, revision, summary")
    .eq("id", parsed.data.topicId)
    .maybeSingle();

  if (topic === null) return { ok: false, message: "That topic no longer exists." };

  const restored = parseStoredPage(revision.page);

  // (1) history first: snapshot what is about to be overwritten, so the revert itself is
  //     revertible. Ordering matters — a crash between the two must leave history ahead of
  //     the page, never behind it.
  const { error: snapshotError } = await supabase.from("topic_revisions").insert({
    user_id: userId,
    topic_id: topic.id,
    revision: topic.revision,
    page: topic.page,
    change_summary: `Reverted to revision ${revision.revision}.`,
    source: "revert",
    needs_review: false,
    document_id: null,
    prompt_id: revision.prompt_id,
    prompt_version: revision.prompt_version,
    provider: revision.provider,
    model: revision.model,
    input_hash: revision.input_hash,
  });

  if (snapshotError !== null && snapshotError.code !== "23505") {
    return { ok: false, message: "That revert didn’t go through. Nothing was changed." };
  }

  // (2) then the page.
  const { error } = await supabase
    .from("topics")
    .update({
      page: restored as never,
      summary: restored.summary,
      revision: topic.revision + 1,
    })
    .eq("id", topic.id)
    .eq("user_id", userId);

  if (error) return { ok: false, message: "That revert didn’t go through." };

  revalidatePath(`/courses/${parsed.data.courseId}/topics/${parsed.data.slug}`);
  revalidatePath(`/courses/${parsed.data.courseId}`);
  return { ok: true, message: `Reverted to revision ${revision.revision}.` };
}

/**
 * Sets or clears `topics.exam_weight_override` (PLAN §9(d) — it "wins outright when set").
 *
 * `exam_weight` itself is never touched: it is the computed value and it recomputes after
 * every merge. Writing the override into it would destroy the thing the override is
 * supposed to be distinguishable from.
 */
export async function setExamWeightOverride(input: unknown): Promise<ActionResult> {
  const parsed = WEIGHT.safeParse(input);
  if (!parsed.success) return { ok: false, message: "That weight isn’t between 0 and 1." };

  const supabase = await createClient();
  const userId = await requireUserId(supabase);

  const { error } = await supabase
    .from("topics")
    .update({ exam_weight_override: parsed.data.weight })
    .eq("id", parsed.data.topicId)
    .eq("user_id", userId);

  if (error) return { ok: false, message: "That didn’t save. Try again." };

  revalidatePath(`/courses/${parsed.data.courseId}/topics/${parsed.data.slug}`);
  revalidatePath(`/courses/${parsed.data.courseId}`);
  return {
    ok: true,
    message: parsed.data.weight === null ? "Override cleared." : "Override set.",
  };
}
