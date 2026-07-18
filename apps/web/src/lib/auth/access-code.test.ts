import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  gateCookieToken,
  isAccessCodeValid,
  isGateCookieValid,
} from "@/lib/auth/access-code";

const CODE = "correct-horse-battery";

describe("constantTimeEqual", () => {
  it("accepts identical strings", () => {
    expect(constantTimeEqual("a".repeat(64), "a".repeat(64))).toBe(true);
  });

  it("rejects a single differing character", () => {
    expect(constantTimeEqual(`${"a".repeat(63)}b`, "a".repeat(64))).toBe(false);
  });

  it("rejects differing lengths", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});

describe("isAccessCodeValid", () => {
  it("accepts the exact code", async () => {
    await expect(isAccessCodeValid(CODE, CODE)).resolves.toBe(true);
  });

  it("tolerates surrounding whitespace, which a paste routinely carries", async () => {
    await expect(isAccessCodeValid(`  ${CODE}\n`, CODE)).resolves.toBe(true);
  });

  it("rejects a wrong code", async () => {
    await expect(isAccessCodeValid("wrong-horse-battery", CODE)).resolves.toBe(false);
  });

  it("rejects a correct prefix", async () => {
    await expect(isAccessCodeValid(CODE.slice(0, -1), CODE)).resolves.toBe(false);
  });

  it("rejects an empty submission", async () => {
    await expect(isAccessCodeValid("", CODE)).resolves.toBe(false);
  });

  it("is case sensitive", async () => {
    await expect(isAccessCodeValid(CODE.toUpperCase(), CODE)).resolves.toBe(false);
  });
});

describe("gateCookieToken", () => {
  it("is a SHA-256 hex digest", async () => {
    await expect(gateCookieToken(CODE)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for one code", async () => {
    const [first, second] = await Promise.all([gateCookieToken(CODE), gateCookieToken(CODE)]);
    expect(first).toBe(second);
  });

  it("is not the bare hash of the code — the domain separator is applied", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CODE));
    const bare = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    await expect(gateCookieToken(CODE)).resolves.not.toBe(bare);
  });
});

describe("isGateCookieValid", () => {
  it("accepts a token minted from the same code", async () => {
    await expect(isGateCookieValid(await gateCookieToken(CODE), CODE)).resolves.toBe(true);
  });

  it("rejects a missing cookie", async () => {
    await expect(isGateCookieValid(undefined, CODE)).resolves.toBe(false);
  });

  it("rejects the raw access code used as a cookie value", async () => {
    await expect(isGateCookieValid(CODE, CODE)).resolves.toBe(false);
  });

  it("rejects a token minted from a rotated-away code — rotation revokes cookies", async () => {
    const stale = await gateCookieToken("the-old-code");
    await expect(isGateCookieValid(stale, CODE)).resolves.toBe(false);
  });
});
