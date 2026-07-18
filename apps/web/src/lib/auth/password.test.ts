import { describe, expect, it } from "vitest";
import {
  evaluatePassword,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  passwordByteLength,
  passwordSchema,
} from "@/lib/auth/password";

const VALID = "Correct-Horse9";

describe("passwordSchema", () => {
  it("accepts a password meeting every rule", () => {
    expect(passwordSchema.safeParse(VALID).success).toBe(true);
  });

  it.each([
    ["too short", "Short-9a"],
    ["no lowercase", "CORRECT-HORSE9"],
    ["no uppercase", "correct-horse9"],
    ["no digit", "Correct-Horsey"],
    ["no symbol", "CorrectHorse99"],
  ])("rejects a password with %s", (_label, candidate) => {
    expect(passwordSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects beyond the bcrypt truncation ceiling", () => {
    const overlong = `${VALID}${"a".repeat(MAX_PASSWORD_BYTES)}`;
    expect(passwordSchema.safeParse(overlong).success).toBe(false);
  });

  /**
   * The ceiling is 72 BYTES, not 72 characters. A `.length` check passes this
   * password — it is 40 characters — while bcrypt truncates it at byte 72 and
   * silently discards the tail, so the strength the user thinks they have is
   * not the strength they get. GoTrue counts bytes too, so a character-based
   * check also let through passwords the backend then rejected.
   */
  it("measures the ceiling in bytes, so a multi-byte password cannot slip past it", () => {
    // 34 x 2-byte "é" + a 6-character ASCII suffix that satisfies every rule.
    const multibyte = `${"é".repeat(34)}Aa9-zZ`;

    expect(multibyte.length).toBeLessThanOrEqual(MAX_PASSWORD_BYTES);
    expect(passwordByteLength(multibyte)).toBeGreaterThan(MAX_PASSWORD_BYTES);
    expect(passwordSchema.safeParse(multibyte).success).toBe(false);
  });

  it("accepts a multi-byte password that does fit inside 72 bytes", () => {
    const multibyte = `${"é".repeat(20)}Aa9-zZ`;

    expect(passwordByteLength(multibyte)).toBeLessThanOrEqual(MAX_PASSWORD_BYTES);
    expect(passwordSchema.safeParse(multibyte).success).toBe(true);
  });

  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    expect(passwordByteLength("abc")).toBe(3);
    expect(passwordByteLength("é")).toBe(2);
    // One astral-plane code point: 2 UTF-16 units, 4 UTF-8 bytes.
    expect("🔐".length).toBe(2);
    expect(passwordByteLength("🔐")).toBe(4);
  });

  it("names every unmet rule in one message", () => {
    const result = passwordSchema.safeParse("short");
    expect(result.success).toBe(false);
    const message = result.error?.issues[0]?.message ?? "";
    expect(message).toContain("uppercase");
    expect(message).toContain("number");
    expect(message).toContain("symbol");
  });

  it("enforces a floor well above Supabase's own default of 6", () => {
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(12);
  });
});

describe("evaluatePassword", () => {
  it("reports every rule as unmet for an empty string", () => {
    expect(evaluatePassword("").every((rule) => !rule.satisfied)).toBe(true);
  });

  it("agrees with the schema on a valid password", () => {
    expect(evaluatePassword(VALID).every((rule) => rule.satisfied)).toBe(true);
    expect(passwordSchema.safeParse(VALID).success).toBe(true);
  });

  it("agrees with the schema on an invalid one — the two cannot drift", () => {
    const candidate = "nouppercase-9";
    expect(evaluatePassword(candidate).some((rule) => !rule.satisfied)).toBe(true);
    expect(passwordSchema.safeParse(candidate).success).toBe(false);
  });
});
