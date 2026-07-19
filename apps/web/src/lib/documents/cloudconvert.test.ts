import { describe, expect, it, vi } from "vitest";
import { CloudConvertError, convertPptxToPdf } from "./cloudconvert";

/**
 * The PPTX→PDF conversion path (PLAN §4.2, the visual branch).
 *
 * Two things are worth testing here and the rest is plumbing:
 *
 *  1. **The task chain is built by reference** — `import/upload` → `convert` → `export/url`,
 *     each naming the previous task's id. It has to be the task API rather than the job API
 *     because the token is scoped `task.read` + `task.write` and nothing else, so a
 *     refactor that "simplifies" this into `/v2/jobs` would 403 in production and pass no
 *     test that did not check the URLs.
 *  2. **Retriability is classified correctly.** A 401 retried three times is three trips to
 *     learn the key is still wrong, and a 429 *not* retried is a deck that fails because
 *     CloudConvert was briefly busy. Both are silent-in-testing, expensive-in-production.
 */

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

interface StubOptions {
  /** Statuses returned by successive polls, in order. */
  readonly polls?: readonly string[];
  readonly overrides?: Record<string, () => Response>;
}

/** A fetch that walks the happy path unless an override says otherwise. */
function stubFetch({ polls = ["finished"], overrides = {} }: StubOptions = {}) {
  const calls: string[] = [];
  let pollIndex = 0;

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const impl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);

    for (const [fragment, override] of Object.entries(overrides)) {
      if (url.includes(fragment)) return override();
    }

    if (url.endsWith("/import/upload")) {
      return json({
        data: {
          id: "import-1",
          result: { form: { url: "https://upload.example/slot", parameters: { key: "abc" } } },
        },
      });
    }
    if (url === "https://upload.example/slot") return new Response(null, { status: 201 });
    if (url.endsWith("/convert")) return json({ data: { id: "convert-1" } });
    if (url.endsWith("/export/url")) return json({ data: { id: "export-1" } });
    if (url.includes("/tasks/export-1")) {
      const status = polls[Math.min(pollIndex, polls.length - 1)] ?? "finished";
      pollIndex += 1;
      return json({
        data: {
          id: "export-1",
          status,
          result:
            status === "finished"
              ? { files: [{ filename: "deck.pdf", url: "https://files.example/deck.pdf" }] }
              : null,
        },
      });
    }
    if (url === "https://files.example/deck.pdf") {
      return new Response(PDF.slice().buffer, { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  return { impl, calls };
}

const base = {
  apiKey: "test-key",
  pptxBytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
  filename: "s18-segmentation.pptx",
  // Never actually wait in a test.
  sleep: async () => {},
};

describe("convertPptxToPdf", () => {
  it("chains import → convert → export and returns the PDF bytes", async () => {
    const { impl, calls } = stubFetch();

    const result = await convertPptxToPdf({ ...base, fetchImpl: impl as unknown as typeof fetch });

    expect(result.pdfBytes).toEqual(PDF);
    expect(calls).toContain("https://api.cloudconvert.com/v2/import/upload");
    expect(calls).toContain("https://upload.example/slot");
    expect(calls).toContain("https://api.cloudconvert.com/v2/convert");
    expect(calls).toContain("https://api.cloudconvert.com/v2/export/url");
    // The task API, never the job API — the token has no `job.*` scope.
    expect(calls.some((url) => url.includes("/v2/jobs"))).toBe(false);
  });

  it("names the previous task as each step's input", async () => {
    const bodies: Record<string, unknown> = {};
    const { impl } = stubFetch();
    const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (init?.body !== undefined && typeof init.body === "string") {
        bodies[url] = JSON.parse(init.body);
      }
      return impl(input, init);
    });

    await convertPptxToPdf({ ...base, fetchImpl: spy as unknown as typeof fetch });

    expect(bodies["https://api.cloudconvert.com/v2/convert"]).toMatchObject({
      input: "import-1",
      input_format: "pptx",
      output_format: "pdf",
    });
    expect(bodies["https://api.cloudconvert.com/v2/export/url"]).toMatchObject({
      input: "convert-1",
    });
  });

  it("polls until the task finishes", async () => {
    const { impl, calls } = stubFetch({
      polls: ["waiting", "processing", "processing", "finished"],
    });

    const result = await convertPptxToPdf({ ...base, fetchImpl: impl as unknown as typeof fetch });

    expect(result.pdfBytes).toEqual(PDF);
    expect(calls.filter((url) => url.includes("/tasks/export-1"))).toHaveLength(4);
  });

  it("fails non-retriably when CloudConvert reports a task error", async () => {
    const { impl } = stubFetch({
      overrides: {
        "/tasks/export-1": () =>
          new Response(
            JSON.stringify({
              data: { id: "export-1", status: "error", message: "Unsupported font", result: null },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      },
    });

    await expect(
      convertPptxToPdf({ ...base, fetchImpl: impl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ name: "CloudConvertError", retriable: false });
  });

  it("treats 401 as non-retriable and 429 as retriable", async () => {
    for (const [status, retriable] of [
      [401, false],
      [403, false],
      [422, false],
      [429, true],
      [500, true],
      [503, true],
    ] as const) {
      const { impl } = stubFetch({
        overrides: { "/import/upload": () => new Response(null, { status }) },
      });

      await expect(
        convertPptxToPdf({ ...base, fetchImpl: impl as unknown as typeof fetch }),
      ).rejects.toMatchObject({ name: "CloudConvertError", retriable });
    }
  });

  it("keeps polling through a transient 5xx rather than failing the conversion", async () => {
    let polls = 0;
    const { impl } = stubFetch();
    const flaky = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/tasks/export-1")) {
        polls += 1;
        if (polls === 1) return new Response(null, { status: 503 });
      }
      return impl(input, init);
    });

    const result = await convertPptxToPdf({ ...base, fetchImpl: flaky as unknown as typeof fetch });

    expect(result.pdfBytes).toEqual(PDF);
    expect(polls).toBeGreaterThan(1);
  });

  it("rejects a finished task that produced no file", async () => {
    const { impl } = stubFetch({
      overrides: {
        "/tasks/export-1": () =>
          new Response(
            JSON.stringify({ data: { id: "export-1", status: "finished", result: { files: [] } } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      },
    });

    await expect(
      convertPptxToPdf({ ...base, fetchImpl: impl as unknown as typeof fetch }),
    ).rejects.toThrow(CloudConvertError);
  });

  /**
   * An external API is a boundary, so a response that does not match the contract must be
   * refused rather than destructured into `undefined` and carried onward.
   */
  it("refuses a malformed response instead of proceeding", async () => {
    const { impl } = stubFetch({
      overrides: {
        "/import/upload": () =>
          new Response(JSON.stringify({ data: { id: "import-1" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
    });

    await expect(
      convertPptxToPdf({ ...base, fetchImpl: impl as unknown as typeof fetch }),
    ).rejects.toThrow();
  });
});
