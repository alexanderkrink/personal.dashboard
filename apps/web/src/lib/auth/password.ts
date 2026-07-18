import { z } from "zod";

/**
 * Password policy — the compensating control for Supabase's leaked-password
 * check (HIBP), which is a Pro-plan feature and is NOT available on this
 * project's Free plan. Since we cannot ask "has this password been breached?",
 * we raise the floor instead: 12 characters with all four character classes,
 * which is materially stronger than Supabase's own default of 6.
 *
 * The class definitions below deliberately mirror Supabase's
 * `lower_upper_letters_digits_symbols` requirement (see
 * `packages/db/supabase/config.toml`), so a password this module accepts is
 * never then rejected by GoTrue — the two validators cannot drift into
 * disagreeing about the same password.
 */

/** Supabase's `minimum_password_length`, mirrored in config.toml. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * bcrypt silently truncates beyond 72 BYTES, so anything longer gives a false
 * sense of strength. Rejecting is honest; GoTrue enforces the same ceiling.
 *
 * BYTES, not characters — the distinction is the whole point. `"é".length` is 1
 * but it is 2 bytes in UTF-8, and an emoji is 4; a 72-CHARACTER passphrase in
 * any non-ASCII script therefore sails past a `.length` check and is then
 * truncated by bcrypt, so everything the user typed past byte 72 silently stops
 * protecting the account. Counting characters here also disagreed with GoTrue,
 * which counts bytes — so such a password passed our schema and was rejected
 * downstream anyway.
 */
export const MAX_PASSWORD_BYTES = 72;

/** UTF-8 byte length, which is what bcrypt and GoTrue both measure. */
export function passwordByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** The exact symbol set GoTrue counts as a symbol. Order is irrelevant. */
const SYMBOLS = "!@#$%^&*()_+-=[]{};'\\:\"|<>?,./`~";

type PasswordRule = { readonly label: string; readonly test: (value: string) => boolean };

/**
 * The rules, in the order they are shown to the user. Exported so the live
 * checklist on the sign-up form and the server-side schema below are driven by
 * one list — a rule cannot exist in one place and not the other.
 */
export const PASSWORD_RULES: readonly PasswordRule[] = [
  {
    label: `At least ${MIN_PASSWORD_LENGTH} characters`,
    test: (value) => value.length >= MIN_PASSWORD_LENGTH,
  },
  { label: "A lowercase letter", test: (value) => /[a-z]/.test(value) },
  { label: "An uppercase letter", test: (value) => /[A-Z]/.test(value) },
  { label: "A number", test: (value) => /[0-9]/.test(value) },
  {
    label: "A symbol",
    test: (value) => Array.from(value).some((character) => SYMBOLS.includes(character)),
  },
];

/** Evaluates every rule at once, for the live checklist on the client. */
export function evaluatePassword(value: string): { label: string; satisfied: boolean }[] {
  return PASSWORD_RULES.map((rule) => ({ label: rule.label, satisfied: rule.test(value) }));
}

/**
 * The boundary schema. Every Server Action that accepts a new password parses
 * through this before it reaches Supabase.
 */
export const passwordSchema = z
  .string()
  .refine((value) => passwordByteLength(value) <= MAX_PASSWORD_BYTES, {
    message: `Use at most ${MAX_PASSWORD_BYTES} bytes — accented letters and emoji count as more than one each.`,
  })
  .superRefine((value, context) => {
    const unmet = PASSWORD_RULES.filter((rule) => !rule.test(value));
    if (unmet.length === 0) return;

    context.addIssue({
      code: "custom",
      message: `Password needs: ${unmet.map((rule) => rule.label.toLowerCase()).join(", ")}.`,
    });
  });

/** Sign-in only checks that *something* was typed — the policy is for new passwords. */
export const existingPasswordSchema = z.string().min(1, "Enter your password.");

export const emailSchema = z.email("That doesn't look like a valid email address.");
