import { describe, expect, it } from "vitest";
import {
  evaluatePassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
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
    const overlong = `${VALID}${"a".repeat(MAX_PASSWORD_LENGTH)}`;
    expect(passwordSchema.safeParse(overlong).success).toBe(false);
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
