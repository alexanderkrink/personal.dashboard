import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

const ORIGIN = "https://studydash.app";

describe("safeNext", () => {
  it("passes through an ordinary same-origin path", () => {
    expect(safeNext("/courses", ORIGIN, "/")).toBe("/courses");
  });

  it("keeps the query string", () => {
    expect(safeNext("/login?status=expired", ORIGIN, "/")).toBe("/login?status=expired");
  });

  it("falls back when next is absent or empty", () => {
    expect(safeNext(null, ORIGIN, "/")).toBe("/");
    expect(safeNext(undefined, ORIGIN, "/")).toBe("/");
    expect(safeNext("", ORIGIN, "/fallback")).toBe("/fallback");
  });

  /**
   * The one that concatenation gets wrong: `${origin}${next}` yields
   * "https://studydash.app@evil.com", whose host is evil.com — the real origin
   * is demoted to userinfo. This is the case the helper exists for.
   */
  it("rejects the userinfo trick", () => {
    expect(safeNext("@evil.com", ORIGIN, "/")).toBe("/@evil.com");
    expect(safeNext("@evil.com/path", ORIGIN, "/")).toBe("/@evil.com/path");
  });

  it("rejects protocol-relative and absolute off-origin URLs", () => {
    expect(safeNext("//evil.com", ORIGIN, "/")).toBe("/");
    expect(safeNext("https://evil.com", ORIGIN, "/")).toBe("/");
    expect(safeNext("http://evil.com", ORIGIN, "/")).toBe("/");
    expect(safeNext("https://studydash.app.evil.com", ORIGIN, "/")).toBe("/");
  });

  it("rejects a scheme change on the same host", () => {
    expect(safeNext("http://studydash.app/courses", ORIGIN, "/")).toBe("/");
  });

  it("rejects non-http schemes", () => {
    expect(safeNext("javascript:alert(1)", ORIGIN, "/")).toBe("/");
    expect(safeNext("data:text/html,<script>", ORIGIN, "/")).toBe("/");
  });

  it("normalises backslash and traversal attempts to a same-origin path", () => {
    // Whatever these resolve to, the guarantee is that they stay on-origin.
    for (const candidate of ["/\\evil.com", "/../../etc/passwd", "\\\\evil.com"]) {
      expect(safeNext(candidate, ORIGIN, "/")).toMatch(/^\//);
    }
  });
});
