/**
 * The feed-config validation boundary (CLAUDE.md: *Zod at every boundary*).
 *
 * `calendar_feeds.config` is `jsonb`, so the database will accept any shape at
 * all. This schema is what actually constrains it — on the way in from a form,
 * and again on the way out before a provider is handed it, because a row could
 * have been written by an older version of this code.
 */

import { z } from "zod";
import { normalizeFeedUrl } from "@/lib/calendar/secret";

/**
 * An ICS subscription URL.
 *
 * `https` only, and that is a security requirement rather than tidiness: the
 * URL embeds a capability token, and over `http` that token is sent in
 * cleartext to every hop on the path. `webcal://` — what a university's
 * "subscribe" button usually produces — is accepted and rewritten, because
 * refusing the exact string the user was given would be obtuse; it is the same
 * URL with a scheme that means "hand this to a calendar app".
 */
export const icsUrlSchema = z
  .string()
  .trim()
  .min(1, "Paste the calendar feed URL.")
  .transform(normalizeFeedUrl)
  .pipe(z.url({ protocol: /^https$/, hostname: z.regexes.domain }))
  .refine((value) => !value.includes(".."), {
    message: "That URL doesn’t look like a calendar feed.",
  });

export const icsFeedConfigSchema = z.object({
  url: icsUrlSchema,
  /**
   * Pins this feed to a single course (§5.1 step 1) — the right answer for a
   * per-course feed, and zero inference. Absent for a global feed like IE's,
   * where matching falls through to the summary-based pipeline.
   */
  courseId: z.uuid().optional(),
});

export type IcsFeedConfig = z.infer<typeof icsFeedConfigSchema>;

/**
 * Reads a stored `config` column back into a typed value.
 *
 * Returns a `Result`-ish discriminated union rather than throwing: a malformed
 * config is a *feed* problem to report against that feed, not a reason to fail
 * the whole sync run and take every other feed down with it.
 */
export function parseStoredIcsConfig(
  config: unknown,
): { ok: true; config: IcsFeedConfig } | { ok: false; reason: string } {
  const parsed = icsFeedConfigSchema.safeParse(config);
  if (parsed.success) return { ok: true, config: parsed.data };

  // The issues are reported WITHOUT the offending value. Zod's default
  // formatting is happy to quote what it rejected, and what it rejected here is
  // the token.
  const reason = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "config"}: ${issue.code}`)
    .join(", ");
  return { ok: false, reason: `Feed configuration is not valid (${reason}).` };
}
