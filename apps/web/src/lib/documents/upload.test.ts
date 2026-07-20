// @vitest-environment node
//
// Node, not the jsdom default: this module's import graph reaches `@/env`, and t3-env
// refuses to hand a server variable to anything with a `window` on it. The function under
// test needs none of it — the env stubs below exist purely to let the module load.

import { DOCUMENT_MIME_TYPES } from "@study/core";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The declared Content-Type must never collide with the bucket's own allowlist.
 *
 * Migration `20260720213501` makes `storage.buckets.allowed_mime_types` check the
 * DECLARED type of every upload, and some pickers report `File.type` as `""` for a
 * `.pptx` the dialog's extension-based `accept` filter allowed. Before this helper,
 * that fell back to `application/octet-stream` — which the bucket now refuses,
 * surfaced to the student as a bogus "check your connection" error. The regression
 * pinned here: the extension the picker filtered on decides the declared type when
 * the browser declines to.
 */

const BASE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ACCESS_CODE: "test_access_code",
  CRON_SECRET: "test_cron_secret_long_enough",
  INNGEST_SIGNING_KEY: `signkey-test-${"a".repeat(64)}`,
  // Required since Wave 6 (fail-closed at build); tests satisfy them with fakes.
  VOYAGE_API_KEY: "pa-test",
  CLOUDCONVERT_API_KEY: "cc-test",
};

let declaredContentType: typeof import("./upload").declaredContentType;

beforeAll(async () => {
  for (const [key, value] of Object.entries(BASE_ENV)) vi.stubEnv(key, value);
  ({ declaredContentType } = await import("./upload"));
});

describe("declaredContentType", () => {
  it("passes a browser-reported type through untouched", () => {
    expect(declaredContentType({ name: "deck.pptx", type: DOCUMENT_MIME_TYPES.pptx })).toBe(
      DOCUMENT_MIME_TYPES.pptx,
    );
    expect(declaredContentType({ name: "notes.pdf", type: DOCUMENT_MIME_TYPES.pdf })).toBe(
      DOCUMENT_MIME_TYPES.pdf,
    );
  });

  it("derives the type from the extension when the browser reports none", () => {
    // The regression case: a .pptx on a machine whose MIME registry has no entry for it.
    // Declaring octet-stream here has the bucket refuse bytes `validateDocument` would
    // have accepted.
    expect(declaredContentType({ name: "Lecture 4 Deck.PPTX", type: "" })).toBe(
      DOCUMENT_MIME_TYPES.pptx,
    );
    expect(declaredContentType({ name: "syllabus.pdf", type: "" })).toBe(DOCUMENT_MIME_TYPES.pdf);
  });

  it("keeps the honest octet-stream for an unknown extension, so the bucket still refuses it", () => {
    expect(declaredContentType({ name: "lecture.mp4", type: "" })).toBe("application/octet-stream");
  });
});
