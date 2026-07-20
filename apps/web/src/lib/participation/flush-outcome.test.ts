import { describe, expect, it } from "vitest";
import { flushOutcomeForError } from "./flush-outcome";

/**
 * The rejected/failed split is what decides whether a tap is retried or
 * surfaced-and-dropped, so both directions of getting it wrong lose data:
 * treat a transient error as rejected and a wifi blip silently discards a
 * graded contribution; treat a constraint violation as failed and the queue
 * wedges forever behind an entry the database will never take. Each boundary
 * here was proven red against the everything-is-rejected scaffold first.
 */

describe("flushOutcomeForError", () => {
  it("no error is delivered", () => {
    expect(flushOutcomeForError(null)).toBe("delivered");
    expect(flushOutcomeForError(undefined)).toBe("delivered");
  });

  it("a duplicate key means the row is already there: delivered, not a failure", () => {
    // The idempotent-replay path: half a batch landed before the connection
    // died, the whole batch is replayed, and the survivors answer 23505.
    expect(flushOutcomeForError({ code: "23505" })).toBe("delivered");
  });

  it("constraint and authorization violations are rejected — retrying cannot fix them", () => {
    expect(flushOutcomeForError({ code: "23503" })).toBe("rejected"); // FK: occurrence gone or not yours
    expect(flushOutcomeForError({ code: "23514" })).toBe("rejected"); // check: bad kind/quality/status
    expect(flushOutcomeForError({ code: "23502" })).toBe("rejected"); // not-null
    expect(flushOutcomeForError({ code: "22P02" })).toBe("rejected"); // malformed uuid
    expect(flushOutcomeForError({ code: "42501" })).toBe("rejected"); // RLS refusal
  });

  it("an UNRECOGNISED error is failed (kept for retry), never rejected", () => {
    // The default direction is the whole game: everything not proven
    // permanent must stay queued.
    expect(flushOutcomeForError({ code: "57014" })).toBe("failed"); // statement timeout
    expect(flushOutcomeForError({ code: "PGRST301" })).toBe("failed"); // JWT expired mid-batch
    expect(flushOutcomeForError({ code: undefined })).toBe("failed"); // transport error, no SQLSTATE
    expect(flushOutcomeForError({ code: null })).toBe("failed");
    expect(flushOutcomeForError({})).toBe("failed");
  });
});
