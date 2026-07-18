/**
 * Pulls a fixed set of fields out of a `FormData` as plain strings.
 *
 * One object then does two jobs, which is the point: it is what the Zod schema
 * parses, and it is what goes back in `FormState.values` so a failed submit
 * re-seeds every field (WCAG 2.2 SC 3.3.7). Building it once means the two can
 * never drift apart — the classic version of this bug is a validation failure
 * that preserves four fields out of five.
 *
 * A missing or non-string entry (a file input, a field the browser omitted)
 * becomes `""` rather than `undefined`, so schemas only ever have to reason
 * about strings, and "absent" and "left blank" mean the same thing — which, for
 * an HTML form, they do.
 *
 * **Never call this for a field holding a secret**, since the result is echoed
 * straight back into the document. See `FormState.values`.
 */
export function readFormValues(
  formData: FormData,
  names: readonly string[],
): Record<string, string> {
  const values: Record<string, string> = {};

  for (const name of names) {
    const raw = formData.get(name);
    values[name] = typeof raw === "string" ? raw : "";
  }

  return values;
}
