"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { inngest } from "@/inngest/client";
import { AINotConfiguredError, createStudyAIRuntime } from "@/lib/ai/runtime";
import { requireUserId } from "@/lib/auth/require-user";
import { createClient } from "@/lib/supabase/server";

/**
 * The Regenerate button's Server Action (PLAN §9's on-demand generation).
 *
 * ## What it does NOT do
 *
 * It does not generate. It validates ownership, checks the §6 guard, and — if all is well —
 * publishes `course/review.requested`, which `generate-review` consumes. Generation is a
 * ~$0.50–1.50 Opus call, so it belongs in a serialized background function, not in a request
 * handler a double-click can fire twice.
 *
 * ## Surfacing "deferred/paused" here, synchronously
 *
 * `generate-review` guards itself, but a background function cannot tell the clicking student
 * anything — so the same two checks run here too, before the event is even sent: if
 * `AI_MAX_TIER` has clamped `exam-review` off its Opus tier, or the budget guard is deferring
 * deep-rank work, this returns a `deferred` result the dialog renders instead of enqueuing a
 * job that would only defer anyway. The pattern (and the admin-backed runtime in a Server
 * Action) mirrors `quick-add-parse.ts`.
 *
 * The double-bill guard proper lives in `generate-review` (concurrency 1 + a freshness skip);
 * this and the button's in-flight state are the first, cheaper line.
 */

const INPUT = z.object({ courseId: z.uuid() });

export type RequestReviewResult = { ok: true } | { ok: false; deferred?: boolean; message: string };

const DEFERRED_CLAMP =
  "AI is running in a reduced tier right now, so the Opus exam review is paused. It’ll be available again once the tier is restored.";
const DEFERRED_BUDGET =
  "AI spending is paused for this month, so the exam review can’t run right now. It’ll be available again once the budget resets.";

export async function requestExamReview(input: unknown): Promise<RequestReviewResult> {
  const parsed = INPUT.safeParse(input);
  if (!parsed.success) return { ok: false, message: "That course could not be found." };
  const { courseId } = parsed.data;

  const supabase = await createClient();
  const userId = await requireUserId(supabase);

  // Ownership through RLS: only enqueue an Opus run for a course the caller actually owns —
  // the event itself carries no owner (the function re-derives it), so this is the check.
  const { data: course } = await supabase
    .from("courses")
    .select("id")
    .eq("id", courseId)
    .maybeSingle();
  if (course === null) {
    return { ok: false, message: "That course could not be found." };
  }

  // Deferred/clamped, surfaced before the send. A runtime that cannot be configured (local/CI
  // without keys) is not a reason to block the request — the function guards too — so only a
  // genuine guard denial or clamp returns `deferred`.
  try {
    const runtime = createStudyAIRuntime({ userId });
    if (runtime.resolve("exam-review").rank !== "deep") {
      return { ok: false, deferred: true, message: DEFERRED_CLAMP };
    }
    const decision = await runtime.guardCheck("exam-review", "background");
    if (!decision.allowed) {
      return { ok: false, deferred: true, message: DEFERRED_BUDGET };
    }
  } catch (error) {
    if (!(error instanceof AINotConfiguredError)) {
      // An unexpected guard-read failure should not strand the user; the function will guard
      // again authoritatively. Log and fall through to the send.
      console.error(`[request-exam-review] guard check failed for course ${courseId}:`, error);
    }
  }

  await inngest.send({ name: "course/review.requested", data: { courseId } });
  revalidatePath(`/courses/${courseId}/reviews`);
  return { ok: true };
}
