/**
 * The caps `validate` enforces, and the arithmetic that turns one into a
 * sentence a person can act on.
 *
 * PLAN "Document & Notes Pipeline" §2 / §4.1 / §7, and the ✅ DECIDED note of
 * 2026-07-18 under open question 1: files over the cap are **not** split and
 * **not** re-compressed by the pipeline. The whole user-facing response to an
 * oversized file is the message built here, so it has to carry the three things
 * that make a rejection actionable: what the file actually is, what the limit
 * actually is, and what to do next.
 */

/**
 * 50 MB, binary — 50 × 1024 × 1024 = 52,428,800 bytes.
 *
 * Binary rather than decimal because that is what the ceiling it mirrors
 * actually is: Supabase's per-file upload limit on the Free plan is configured
 * in bytes as 52428800. Matching it exactly means our message is the one the
 * user sees, rather than Storage rejecting the transfer first with an opaque
 * error at some point mid-upload. PLAN's "Kotler 156 MB" figure is binary for
 * the same reason, and `formatBytes` below stays binary so every number in the
 * message is measured the same way.
 */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

/**
 * Zip-bomb guard, PLAN §4.2: "reject archives that inflate > 200 MB or > 1,000
 * entries".
 *
 * Both numbers are checked against what the archive's own central directory
 * *declares*, never against a decompression attempt — see `zip.ts`. A real
 * lecture deck is a few hundred entries inflating to tens of megabytes, so
 * these sit well clear of the corpus while still refusing anything built to
 * exhaust memory.
 */
export const MAX_ARCHIVE_INFLATED_BYTES = 200 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 1000;

/**
 * Bytes as a short binary-prefixed string: `156 MB`, `1.5 MB`, `812 KB`.
 *
 * One decimal place below 10 units and none above, because "156.32 MB" reads as
 * precision the user has no use for while "0.2 MB" hides the fact that the file
 * is tiny. Deliberately never returns bare bytes above 1 KB — the point is a
 * quantity someone can compare against "50 MB" at a glance.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "an unknown size";
  if (bytes < 1024) return `${Math.round(bytes)} bytes`;

  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const unit = units[unitIndex] ?? "TB";
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${unit}`;
}

/** `50 MB`, formatted the same way every other size in a message is. */
export const MAX_DOCUMENT_LABEL = formatBytes(MAX_DOCUMENT_BYTES);
