/**
 * The validation boundary for calendar feed forms (CLAUDE.md: *Zod at every
 * boundary*).
 *
 * Parses strings, because that is all an HTML form sends. Field names are
 * camelCase and match the schema keys one-for-one, so `fieldErrors` lands on
 * the right control without a mapping table.
 */

import { z } from "zod";
import { icsUrlSchema } from "@/server/calendar/config";

export const FEED_FIELDS = ["label", "url"] as const;

/** Adding a feed. The URL is required, because a feed without one is nothing. */
export const feedCreateSchema = z.object({
  label: z
    .string()
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .min(1, "Give the feed a name — “IE Agenda”, say.")
        .max(80, "Keep this under 80 characters."),
    ),
  url: icsUrlSchema,
});

/**
 * Editing a feed. The URL is **optional here, and that is a security decision
 * rather than a convenience.**
 *
 * The stored URL is a capability token. An edit form that pre-filled it would
 * have to send the secret to the browser and echo it back in the HTML — and
 * `FormState.values` is round-tripped through the document, which is exactly
 * where a secret must never go. So the field renders empty, like a password
 * field, and **blank means "keep the one on file"**. Re-entering a URL replaces
 * it; that is how a rotated subscription link gets updated.
 */
export const feedUpdateSchema = z.object({
  label: feedCreateSchema.shape.label,
  url: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.union([z.literal(""), icsUrlSchema]))
    .transform((value): string | null => (value === "" ? null : value)),
});

export const feedIdSchema = z.uuid();

export type FeedCreateInput = z.infer<typeof feedCreateSchema>;
export type FeedUpdateInput = z.infer<typeof feedUpdateSchema>;
