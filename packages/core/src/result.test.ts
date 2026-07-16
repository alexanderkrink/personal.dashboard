import { describe, expect, it } from "vitest";
import { err, mapResult, ok, unwrap } from "./result";

describe("Result", () => {
  it("ok wraps a value", () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    expect(unwrap(result)).toBe(42);
  });

  it("err wraps an error", () => {
    const result = err(new Error("boom"));
    expect(result.ok).toBe(false);
  });

  it("unwrap throws the contained error", () => {
    expect(() => unwrap(err(new Error("boom")))).toThrow("boom");
  });

  it("unwrap wraps non-Error values before throwing", () => {
    expect(() => unwrap(err("plain string"))).toThrow("plain string");
  });

  it("mapResult transforms ok values and passes errors through", () => {
    expect(unwrap(mapResult(ok(2), (n) => n * 2))).toBe(4);
    const failed = mapResult(err(new Error("boom")), (n: number) => n * 2);
    expect(failed.ok).toBe(false);
  });
});
