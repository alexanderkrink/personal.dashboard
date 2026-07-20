// @vitest-environment node
//
// Node, not the jsdom default: this module's import graph reaches `@/env`, and t3-env
// refuses to hand a server variable to anything with a `window` on it.

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `deleteDocument` — the strip, the cascade, and the two properties that make a
 * re-upload behave like a first upload (PLAN §5, §8).
 *
 * ## What is real here and what is faked
 *
 * The Server Action runs for real: the Zod boundary, the plan built by
 * `@study/core`'s `planDocumentStrip`, the ordering (plan → delete row → strip
 * surviving pages → delete object), and the tenant predicates on every write.
 *
 * Postgres is faked, as a store small enough to assert against that enforces the
 * four rules this delete leans on:
 *
 *  - RLS — every read and write is bounded to the calling `user_id`;
 *  - `topic_sources`, `document_chunks` and `document_processing_events` cascade
 *    from `documents`;
 *  - `topic_sources_delete_sourceless_topic` — a topic whose last source row went
 *    with the document is deleted (migration `20260720000042`);
 *  - `topics_delete_synthesized_chunks` — that topic's `source = 'topic_page'`
 *    chunks go with it.
 *
 * ⚠ The last two are RE-IMPLEMENTATIONS of triggers, so these tests prove the
 * application behaves correctly *given* the rules; they do not prove the rules are
 * deployed. That was proven separately against the live database: a document with
 * one solo-sourced topic and one co-sourced topic was created under the fixture
 * tenant, deleted, and observed to remove the solo topic, its `topic_page` chunk,
 * both `topic_sources` rows and all `document` chunks, while leaving the co-sourced
 * topic and its remaining source standing.
 */

/* ────────────────────────────────────────────────────────────────────────── */
/* A Postgres small enough to assert against                                  */
/* ────────────────────────────────────────────────────────────────────────── */

type Row = Record<string, unknown>;
interface Filter {
  readonly column: string;
  readonly value: unknown;
  readonly kind: "eq" | "in";
}

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const COURSE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DOC = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER_DOC = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SOLO_TOPIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SHARED_TOPIC = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

class FakeDb {
  readonly tables: Record<string, Row[]> = {
    documents: [],
    topics: [],
    topic_sources: [],
    document_chunks: [],
    document_processing_events: [],
  };

  /** Object paths handed to `storage.remove`. */
  readonly removedObjects: string[] = [];
  /** The `user_id` RLS is currently scoped to. */
  callerId = TENANT;

  private matches(row: Row, filters: readonly Filter[]): boolean {
    return filters.every((filter) =>
      filter.kind === "in"
        ? (filter.value as unknown[]).includes(row[filter.column])
        : row[filter.column] === filter.value,
    );
  }

  /** Every read is RLS-bounded, exactly as the request-scoped client would be. */
  private visible(table: string): Row[] {
    return (this.tables[table] ?? []).filter((row) => row.user_id === this.callerId);
  }

  /**
   * `documents` cascade, then the two triggers, in the order Postgres runs them.
   *
   * `topic_sources` is cascaded first because the sourceless-topic trigger reads
   * it — running the topic sweep before the cascade would find every topic still
   * sourced and delete nothing.
   */
  private deleteDocumentRow(document: Row): void {
    const documentId = document.id;
    const userId = document.user_id;

    this.tables.documents = (this.tables.documents ?? []).filter((row) => row !== document);

    for (const table of ["topic_sources", "document_chunks", "document_processing_events"]) {
      this.tables[table] = (this.tables[table] ?? []).filter(
        (row) => !(row.document_id === documentId && row.user_id === userId),
      );
    }

    // topic_sources_delete_sourceless_topic
    const survivors = new Set(
      (this.tables.topic_sources ?? [])
        .filter((row) => row.user_id === userId)
        .map((row) => row.topic_id),
    );
    const doomed = (this.tables.topics ?? []).filter(
      (row) => row.user_id === userId && !survivors.has(row.id),
    );
    this.tables.topics = (this.tables.topics ?? []).filter((row) => !doomed.includes(row));

    // topics_delete_synthesized_chunks
    const doomedIds = new Set(doomed.map((row) => row.id));
    this.tables.document_chunks = (this.tables.document_chunks ?? []).filter(
      (row) => !(row.source === "topic_page" && doomedIds.has(row.topic_id)),
    );
  }

  from(table: string) {
    const filters: Filter[] = [];
    let mode: "select" | "delete" | "update" = "select";
    let patch: Row = {};
    let head = false;

    const builder = {
      select(_columns?: string, options?: { count?: string; head?: boolean }) {
        head = options?.head === true;
        return builder;
      },
      update(next: Row) {
        mode = "update";
        patch = next;
        return builder;
      },
      delete() {
        mode = "delete";
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push({ column, value, kind: "eq" });
        return builder;
      },
      in(column: string, value: unknown[]) {
        filters.push({ column, value, kind: "in" });
        return builder;
      },
      maybeSingle: async () => {
        const found = this.visible(table).filter((row) => this.matches(row, filters));
        return { data: found[0] ?? null, error: null };
      },
      // PostgREST builders are awaited directly — `await supabase.from(t).select().eq(...)`,
      // with no terminal method — so a fake that is not thenable cannot stand in for one.
      // biome-ignore lint/suspicious/noThenProperty: a PostgREST stand-in must be thenable.
      then: (resolve: (value: { data: Row[] | null; error: null; count?: number }) => unknown) => {
        const rows = this.visible(table).filter((row) => this.matches(row, filters));

        if (mode === "delete") {
          if (table === "documents") for (const row of [...rows]) this.deleteDocumentRow(row);
          else this.tables[table] = (this.tables[table] ?? []).filter((row) => !rows.includes(row));
          return resolve({ data: null, error: null });
        }

        if (mode === "update") {
          for (const row of rows) Object.assign(row, patch);
          return resolve({ data: null, error: null });
        }

        return resolve({ data: head ? null : rows, error: null, count: rows.length });
      },
    };

    return builder;
  }

  storage = {
    from: () => ({
      remove: async (paths: string[]) => {
        this.removedObjects.push(...paths);
        return { error: null };
      },
    }),
  };
}

let db: FakeDb;

const requireUserId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/require-user", () => ({ requireUserId }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => db }));
vi.mock("@/inngest/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { deleteDocument, previewDocumentDelete } = await import("@/app/(app)/documents/actions");

/** A note block attributed to the given documents. */
function note(id: string, ...documentIds: string[]) {
  return { id, markdown: id, sources: documentIds.map((documentId) => ({ documentId })) };
}

/**
 * The shape of the real production run, in miniature: one document, one topic it
 * built alone, one topic it shares with a second document.
 */
function seed(): void {
  db = new FakeDb();
  db.callerId = TENANT;
  requireUserId.mockResolvedValue(TENANT);

  db.tables.documents = [
    {
      id: DOC,
      user_id: TENANT,
      course_id: COURSE,
      filename: "Sampling Distributions.pdf",
      storage_path: `${TENANT}/${COURSE}/${DOC}/Sampling Distributions.pdf`,
      content_hash: "a".repeat(64),
    },
    {
      id: OTHER_DOC,
      user_id: TENANT,
      course_id: COURSE,
      filename: "Second deck.pdf",
      storage_path: `${TENANT}/${COURSE}/${OTHER_DOC}/Second deck.pdf`,
      content_hash: "b".repeat(64),
    },
  ];

  db.tables.topics = [
    {
      id: SOLO_TOPIC,
      user_id: TENANT,
      course_id: COURSE,
      title: "Statistics Fundamentals",
      page: { summary: "solo", notes: [note("n1", DOC)] },
    },
    {
      id: SHARED_TOPIC,
      user_id: TENANT,
      course_id: COURSE,
      title: "Sampling Variance",
      page: { summary: "shared", notes: [note("n1", DOC), note("n2", OTHER_DOC)] },
    },
  ];

  db.tables.topic_sources = [
    { user_id: TENANT, topic_id: SOLO_TOPIC, document_id: DOC },
    { user_id: TENANT, topic_id: SHARED_TOPIC, document_id: DOC },
    { user_id: TENANT, topic_id: SHARED_TOPIC, document_id: OTHER_DOC },
  ];

  db.tables.document_chunks = [
    { user_id: TENANT, document_id: DOC, topic_id: null, source: "document" },
    { user_id: TENANT, document_id: DOC, topic_id: null, source: "document" },
    { user_id: TENANT, document_id: OTHER_DOC, topic_id: null, source: "document" },
    { user_id: TENANT, document_id: null, topic_id: SOLO_TOPIC, source: "topic_page" },
    { user_id: TENANT, document_id: null, topic_id: SHARED_TOPIC, source: "topic_page" },
  ];

  db.tables.document_processing_events = [
    { user_id: TENANT, document_id: DOC },
    { user_id: TENANT, document_id: OTHER_DOC },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

describe("previewDocumentDelete", () => {
  it("measures the blast radius without changing anything", async () => {
    const impact = await previewDocumentDelete({ documentId: DOC });

    expect(impact).not.toBeNull();
    expect(impact?.topicsRemoved).toEqual(["Statistics Fundamentals"]);
    expect(impact?.topicsRewritten).toEqual(["Sampling Variance"]);
    expect(impact?.blocksRemoved).toBe(1);
    expect(impact?.staleSummaries).toBe(1);
    expect(impact?.chunks).toBe(2);

    // Nothing moved.
    expect(db.tables.documents).toHaveLength(2);
    expect(db.tables.topics).toHaveLength(2);
    expect(db.removedObjects).toEqual([]);
  });

  it("returns null for another tenant's document rather than leaking its title", async () => {
    db.callerId = OTHER_TENANT;
    requireUserId.mockResolvedValue(OTHER_TENANT);

    expect(await previewDocumentDelete({ documentId: DOC })).toBeNull();
  });

  it("rejects a non-uuid at the boundary", async () => {
    expect(await previewDocumentDelete({ documentId: "not-a-uuid" })).toBeNull();
    expect(await previewDocumentDelete({})).toBeNull();
    expect(await previewDocumentDelete(null)).toBeNull();
  });
});

describe("deleteDocument", () => {
  it("removes the row, its provenance, its chunks and its events", async () => {
    const result = await deleteDocument({ documentId: DOC });

    expect(result.ok).toBe(true);
    expect(db.tables.documents?.map((row) => row.id)).toEqual([OTHER_DOC]);
    expect(db.tables.topic_sources?.every((row) => row.document_id !== DOC)).toBe(true);
    expect(db.tables.document_chunks?.every((row) => row.document_id !== DOC)).toBe(true);
    expect(db.tables.document_processing_events?.every((row) => row.document_id !== DOC)).toBe(
      true,
    );
  });

  it("deletes the storage object", async () => {
    await deleteDocument({ documentId: DOC });

    expect(db.removedObjects).toEqual([`${TENANT}/${COURSE}/${DOC}/Sampling Distributions.pdf`]);
  });

  it("removes a topic this document was the only source of, and its topic_page chunks", async () => {
    await deleteDocument({ documentId: DOC });

    expect(db.tables.topics?.map((row) => row.id)).toEqual([SHARED_TOPIC]);
    // The solo topic's synthesized chunk is reachable by no cascade from `documents`
    // — `document_id` is null on it — so only the topic trigger collects it.
    expect(db.tables.document_chunks?.filter((row) => row.topic_id === SOLO_TOPIC)).toHaveLength(0);
    expect(db.tables.document_chunks?.filter((row) => row.topic_id === SHARED_TOPIC)).toHaveLength(
      1,
    );
  });

  it("strips this document's blocks from a topic that survives", async () => {
    await deleteDocument({ documentId: DOC });

    const shared = db.tables.topics?.find((row) => row.id === SHARED_TOPIC);
    const page = shared?.page as { notes?: { id: string }[]; summary?: string };

    expect(page.notes?.map((block) => block.id)).toEqual(["n2"]);
    // The summary carries no provenance, so it is deliberately left standing — the
    // dialog says so rather than the delete guessing.
    expect(page.summary).toBe("shared");
  });

  it("leaves the other document completely intact", async () => {
    await deleteDocument({ documentId: DOC });

    expect(db.tables.documents?.map((row) => row.id)).toEqual([OTHER_DOC]);
    expect(db.tables.document_chunks?.filter((row) => row.document_id === OTHER_DOC)).toHaveLength(
      1,
    );
    expect(db.tables.topic_sources?.filter((row) => row.document_id === OTHER_DOC)).toHaveLength(1);
  });

  /* ── the property the whole feature exists for ─────────────────────────── */

  it("leaves nothing that would block or corrupt a re-upload of the same file", async () => {
    // Alexander is deleting and re-uploading the same deck to debug the routing
    // defect. After a delete, a re-upload must look like a genuine first upload.
    await deleteDocument({ documentId: DOC });

    // 1. `documents_dedupe (course_id, content_hash)` is free again.
    const clash = db.tables.documents?.filter(
      (row) => row.course_id === COURSE && row.content_hash === "a".repeat(64),
    );
    expect(clash).toHaveLength(0);

    // 2. No stale provenance survives to make the merge think it already ran.
    expect(db.tables.topic_sources?.filter((row) => row.document_id === DOC)).toHaveLength(0);

    // 3. No stale chunks survive to pollute retrieval.
    expect(db.tables.document_chunks?.filter((row) => row.document_id === DOC)).toHaveLength(0);

    // 4. No sourceless topic survives for the re-upload to merge into instead of
    //    creating fresh — the failure mode that made the old delete useless here.
    const sourced = new Set(db.tables.topic_sources?.map((row) => row.topic_id));
    expect(db.tables.topics?.every((row) => sourced.has(row.id))).toBe(true);
  });

  it("is idempotent — deleting twice is deleting once", async () => {
    expect((await deleteDocument({ documentId: DOC })).ok).toBe(true);
    const second = await deleteDocument({ documentId: DOC });

    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/no longer exists/i);
    expect(db.tables.documents?.map((row) => row.id)).toEqual([OTHER_DOC]);
  });

  /* ── tenant isolation ──────────────────────────────────────────────────── */

  it("cannot delete another tenant's document", async () => {
    db.callerId = OTHER_TENANT;
    requireUserId.mockResolvedValue(OTHER_TENANT);

    const result = await deleteDocument({ documentId: DOC });

    expect(result.ok).toBe(false);
    // Every row still standing, and no bytes touched.
    expect(db.tables.documents).toHaveLength(2);
    expect(db.tables.topics).toHaveLength(2);
    expect(db.tables.topic_sources).toHaveLength(3);
    expect(db.removedObjects).toEqual([]);
  });

  it("cannot strip another tenant's topic page", async () => {
    // The neighbour's topic shares an id space but not a tenant. A plan built for
    // our document must never reach it.
    db.tables.topics?.push({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      user_id: OTHER_TENANT,
      course_id: COURSE,
      title: "Neighbour",
      page: { notes: [note("n1", DOC)] },
    });
    db.tables.topic_sources?.push({
      user_id: OTHER_TENANT,
      topic_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      document_id: DOC,
    });

    await deleteDocument({ documentId: DOC });

    const neighbour = db.tables.topics?.find((row) => row.user_id === OTHER_TENANT);
    if (!neighbour) throw new Error("the neighbour's topic was deleted across tenants");
    expect((neighbour.page as { notes: unknown[] }).notes).toHaveLength(1);
  });

  it("rejects a non-uuid at the boundary before touching anything", async () => {
    const result = await deleteDocument({ documentId: "../../etc/passwd" });

    expect(result.ok).toBe(false);
    expect(db.tables.documents).toHaveLength(2);
    expect(db.removedObjects).toEqual([]);
  });

  it("deletes a document that never merged into a topic", async () => {
    db.tables.topic_sources = (db.tables.topic_sources ?? []).filter(
      (row) => row.document_id !== DOC,
    );

    const result = await deleteDocument({ documentId: DOC });

    expect(result.ok).toBe(true);
    // The solo topic is now sourceless independently of this document, and the
    // trigger collects it — which is the invariant, not a side effect of the delete.
    expect(db.tables.documents?.map((row) => row.id)).toEqual([OTHER_DOC]);
  });
});
