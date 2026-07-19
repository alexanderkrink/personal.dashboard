// @vitest-environment node
//
// Node, not the jsdom default: this module's import graph reaches `@/env`, and t3-env
// refuses to hand a server variable to anything with a `window` on it.

import type { SupabaseAdminClient } from "@study/db";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Convergence of a second pass over an already-merged document (PLAN §5).
 *
 * ## What this test is evidence for
 *
 * The final branch review measured that `runRouteAndMerge` re-reads `topics.revision` fresh,
 * so on a re-run `target.currentRevision` is already the value the previous pass bumped it
 * to. That made the `unique (topic_id, revision)` guard unreachable, and every re-run
 * appended a revision, bumped the counter again, re-billed the merge + critic per topic, and
 * handed the merge prompt a page that already contained this document's own contribution.
 *
 * Everything below runs the REAL `runRouteAndMerge` — real segmentation, real routing
 * plumbing, real duplicate guard, real loss-detector, real persist ordering. Only two things
 * are faked, and both are faked at the seam where the real thing costs money or a network:
 *
 * - **the model**, at `AIRuntime.generateStructured`. Faking one method rather than the
 *   `@study/ai` job functions keeps the prompts, the schemas and the job routing real, and
 *   makes "how many LLM calls did this pass make?" a directly countable number — which is
 *   the re-billing half of the defect.
 * - **Postgres**, as an in-memory store that enforces the three constraints this fix turns
 *   on: `topic_revisions unique (topic_id, revision)`, `topic_sources unique (topic_id,
 *   document_id)`, and the `topic_revisions_one_merge_per_document` trigger added in
 *   migration `20260719224933`.
 *
 * ⚠ The fake trigger is a re-implementation, so it proves the application *respects* the
 * rule; it does not prove the rule is deployed. That was proven separately by running the
 * defect, an identical re-run, a deep-review revision and a post-strip merge through the
 * real trigger on the live database inside a rolled-back transaction.
 */

/* ────────────────────────────────────────────────────────────────────────── */
/* A Postgres small enough to assert against                                  */
/* ────────────────────────────────────────────────────────────────────────── */

type Row = Record<string, unknown>;
interface PgError {
  readonly code: string;
  readonly message: string;
}

interface Filter {
  readonly kind: "eq" | "in" | "gte";
  readonly column: string;
  readonly value: unknown;
}

class FakeDb {
  readonly tables: Record<string, Row[]> = {
    documents: [],
    topics: [],
    topic_revisions: [],
    topic_sources: [],
    ai_generations: [],
  };

  rows(table: string): Row[] {
    const rows = this.tables[table];
    if (rows === undefined) throw new Error(`fake db has no table ${table}`);
    return rows;
  }

  /**
   * `topic_revisions_one_merge_per_document`, transcribed from the migration.
   *
   * Refuses a second `source = 'merge'` snapshot for a (topic, document) pair that
   * `topic_sources` already records as merged, unless the snapshot is the *same* one — a
   * snapshot holds the page BEFORE its merge, so the merge that wrote it left the topic at
   * `revision + 1`.
   */
  private trigger(row: Row): PgError | null {
    if (row.source !== "merge" || row.document_id === null) return null;
    const provenance = this.rows("topic_sources").find(
      (candidate) =>
        candidate.topic_id === row.topic_id && candidate.document_id === row.document_id,
    );
    if (provenance === undefined) return null;
    if (provenance.merged_at_revision === (row.revision as number) + 1) return null;
    return {
      code: "P0001",
      message: `document ${String(row.document_id)} is already merged into topic ${String(row.topic_id)} at revision ${String(provenance.merged_at_revision)}`,
    };
  }

  insert(table: string, row: Row): PgError | null {
    if (table === "topic_revisions") {
      const clash = this.rows(table).some(
        (candidate) => candidate.topic_id === row.topic_id && candidate.revision === row.revision,
      );
      if (clash) {
        return {
          code: "23505",
          message: "duplicate key value violates unique (topic_id, revision)",
        };
      }
      const rejected = this.trigger(row);
      if (rejected !== null) return rejected;
    }
    // `gen_random_uuid()`, near enough. The persist reads this back to key `topic_sources`,
    // so a fake that skipped it would make every created topic look brand new on the next
    // pass — which is the exact failure the test exists to detect.
    this.rows(table).push({ id: `generated-${table}-${this.rows(table).length + 1}`, ...row });
    return null;
  }

  upsert(table: string, row: Row, onConflict: readonly string[]): PgError | null {
    const existing = this.rows(table).find((candidate) =>
      onConflict.every((column) => candidate[column] === row[column]),
    );
    if (existing === undefined) {
      this.rows(table).push({ ...row });
      return null;
    }
    Object.assign(existing, row);
    return null;
  }
}

function matches(row: Row, filters: readonly Filter[]): boolean {
  return filters.every((filter) => {
    if (filter.kind === "eq") return row[filter.column] === filter.value;
    if (filter.kind === "in") return (filter.value as unknown[]).includes(row[filter.column]);
    return String(row[filter.column]) >= String(filter.value);
  });
}

/** A chainable, thenable PostgREST-shaped query over {@link FakeDb}. */
class Query implements PromiseLike<{ data: Row[] | Row | null; error: PgError | null }> {
  private readonly filters: Filter[] = [];
  private op: "select" | "insert" | "update" | "upsert" = "select";
  private payload: Row = {};
  private conflict: string[] = [];
  private one = false;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  select(_columns?: string): this {
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }
  in(column: string, value: unknown[]): this {
    this.filters.push({ kind: "in", column, value });
    return this;
  }
  gte(column: string, value: unknown): this {
    this.filters.push({ kind: "gte", column, value });
    return this;
  }
  single(): this {
    this.one = true;
    return this;
  }
  maybeSingle(): this {
    this.one = true;
    return this;
  }
  insert(payload: Row): this {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Row): this {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  upsert(payload: Row, options?: { onConflict?: string }): this {
    this.op = "upsert";
    this.payload = payload;
    this.conflict = (options?.onConflict ?? "").split(",").filter(Boolean);
    return this;
  }

  private run(): { data: Row[] | Row | null; error: PgError | null } {
    if (this.op === "insert") {
      const error = this.db.insert(this.table, this.payload);
      if (error !== null) return { data: null, error };
      const inserted = this.db.rows(this.table).at(-1) ?? null;
      return { data: this.one ? inserted : [inserted as Row], error: null };
    }
    if (this.op === "upsert") {
      return { data: null, error: this.db.upsert(this.table, this.payload, this.conflict) };
    }
    if (this.op === "update") {
      for (const row of this.db.rows(this.table)) {
        if (matches(row, this.filters)) Object.assign(row, this.payload);
      }
      return { data: null, error: null };
    }
    const found = this.db.rows(this.table).filter((row) => matches(row, this.filters));
    if (this.one) {
      const first = found[0];
      return first === undefined
        ? { data: null, error: { code: "PGRST116", message: "no rows" } }
        : { data: first, error: null };
    }
    return { data: found, error: null };
  }

  // PostgREST builders are awaited directly — `await admin.from(t).select().eq(...)`, with no
  // terminal method — so a fake that is not thenable cannot stand in for one.
  // biome-ignore lint/suspicious/noThenProperty: a PostgREST stand-in must be thenable.
  then<TResult1, TResult2 = never>(
    onfulfilled?:
      | ((value: {
          data: Row[] | Row | null;
          error: PgError | null;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The fixture document                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

const USER = "11111111-1111-4111-8111-111111111111";
const COURSE = "22222222-2222-4222-8222-222222222222";
const DOCUMENT = "33333333-3333-4333-8333-333333333333";
const TOPIC_ALPHA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOPIC_BETA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Three headed pages → three segments, one per heading. */
const PAGES = [
  { page: 1, title: "Alpha", markdown: "Alpha content about elasticity." },
  { page: 2, title: "Beta", markdown: "Beta content about demand curves." },
  { page: 3, title: "Gamma", markdown: "Gamma content about consumer surplus." },
];

const EXTRACTION = {
  route: "pdf-native",
  fidelity: "visual",
  sourceUnits: 3,
  wordsPerSlide: null,
  extraction: {
    sessionLabel: "Session 7",
    summary: "A deck about pricing.",
    pages: PAGES,
    headings: PAGES.map((page) => ({ text: page.title, level: 1, page: page.page })),
    definitions: [],
    formulas: [],
    workedExamples: [],
    examSignals: [],
    skipped: [],
  },
};

/** Heading → where routing sends it. `null` means "create a new topic with this title". */
const ROUTING: Record<string, string | null> = {
  Alpha: TOPIC_ALPHA,
  Beta: TOPIC_BETA,
  Gamma: null,
};

const EMPTY_PAGE = {
  summary: "",
  keyTerms: [],
  notes: [],
  formulas: [],
  workedExamples: [],
  openQuestions: [],
};

/* ────────────────────────────────────────────────────────────────────────── */
/* Wiring                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * A deterministic stand-in for a real embedding.
 *
 * Content-derived and centred on zero, both deliberately. Index-derived vectors would make
 * every proposed new title identical to some existing topic's vector, and the duplicate
 * guard — which is real in this test — would coerce every create into an existing topic at
 * similarity 1.0, quietly turning a three-topic document into a two-topic one.
 */
function embedText(text: string): number[] {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return [1, 2, 3].map((offset) => {
    const value = Math.sin(hash + offset) * 10000;
    return (value - Math.floor(value)) * 2 - 1;
  });
}

const llmCalls: string[] = [];
/** Topic keys the fake model should fail the merge for, simulating a mid-loop timeout. */
let failMergeFor = new Set<string>();
let db: FakeDb;

const BASE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ACCESS_CODE: "test_access_code",
  CRON_SECRET: "test_cron_secret_long_enough",
  INNGEST_SIGNING_KEY: `signkey-test-${"a".repeat(64)}`,
};

vi.mock("@/inngest/documents", () => ({
  logProcessingEvent: vi.fn(async () => undefined),
  setDocumentStatus: vi.fn(async () => undefined),
}));

vi.mock("@/lib/ai/embeddings", () => ({
  createStudyEmbeddingClient: () => ({
    embed: async ({ texts }: { texts: readonly string[] }) => ({
      embeddings: texts.map((text) => embedText(text)),
    }),
  }),
  parseStoredVector: (value: unknown) => (Array.isArray(value) ? (value as number[]) : null),
  toStoredVector: (vector: readonly number[]) => [...vector],
}));

vi.mock("@/lib/ai/runtime", () => ({
  createStudyAIRuntime: () => ({
    generateStructured: async ({
      prompt,
      vars,
    }: {
      prompt: { id: string; version: number };
      vars: Record<string, unknown>;
    }) => {
      llmCalls.push(prompt.id);
      const stamp = {
        promptId: prompt.id,
        promptVersion: prompt.version,
        job: prompt.id,
        provider: "anthropic",
        model: "fake-model",
        inputHash: `hash-${prompt.id}`,
      };

      if (prompt.id === "topic-routing") {
        // Segment keys and headings are read back out of the rendered prompt, so the test
        // never has to guess what `segmentExtraction` produced.
        const rendered = String(vars.segments);
        const decisions = [...rendered.matchAll(/### segmentKey: (\S+)\nHeading: (.+)/g)].map(
          (match) => {
            const heading = (match[2] ?? "").trim();
            const assignTo = ROUTING[heading];
            // A topic created by an earlier pass is in the index now, so route to it by
            // title rather than proposing a duplicate — which is what the real model, and
            // failing that the duplicate guard, would do.
            const existing = db
              .rows("topics")
              .find((row) => row.title === heading && row.course_id === COURSE);
            return {
              segmentKey: match[1] ?? "",
              assignToTopicId: assignTo ?? (existing?.id as string | undefined) ?? null,
              createNewTitle: assignTo === undefined || assignTo !== null ? null : heading,
              rationale: `routed ${heading}`,
            };
          },
        );
        return { status: "success", value: { decisions }, stamp };
      }

      if (prompt.id === "merge-critic") {
        return { status: "success", value: { ok: true, severity: "none", issues: [] }, stamp };
      }

      // topic-merge / topic-merge-repair
      const title = String(vars.topicTitle);
      if (failMergeFor.has(title)) {
        return {
          status: "dead-letter",
          reason: "invalid-output",
          message: "simulated timeout",
          stamp,
        };
      }
      return {
        status: "success",
        value: {
          title,
          page: { ...EMPTY_PAGE, summary: `${title} merged from ${String(vars.documentLabel)}` },
          changeSummary: `added ${title}`,
          removals: [],
        },
        stamp,
      };
    },
  }),
}));

let runRouteAndMerge: typeof import("./route-and-merge").runRouteAndMerge;

beforeAll(async () => {
  for (const [key, value] of Object.entries(BASE_ENV)) vi.stubEnv(key, value);
  ({ runRouteAndMerge } = await import("./route-and-merge"));
});

beforeEach(() => {
  llmCalls.length = 0;
  failMergeFor = new Set();
  db = new FakeDb();
  db.rows("documents").push({ id: DOCUMENT, user_id: USER, extraction: EXTRACTION });
  for (const [id, title] of [
    [TOPIC_ALPHA, "Alpha"],
    [TOPIC_BETA, "Beta"],
  ] as const) {
    db.rows("topics").push({
      id,
      user_id: USER,
      course_id: COURSE,
      title,
      slug: title.toLowerCase(),
      summary: `${title} so far`,
      page: EMPTY_PAGE,
      revision: 1,
      title_embedding: embedText(title),
      summary_embedding: embedText(`${title} so far`),
    });
  }
});

const pass = () =>
  runRouteAndMerge({
    admin: {
      from: (table: string) => new Query(db, table),
    } as unknown as SupabaseAdminClient,
    userId: USER,
    documentId: DOCUMENT,
    courseId: COURSE,
    courseTitle: "Pricing",
    filename: "session-7.pdf",
    sessionLabel: "Session 7",
  });

const countOf = (id: string) => llmCalls.filter((call) => call === id).length;
const revisionOf = (topicId: string) =>
  db.rows("topics").find((row) => row.id === topicId)?.revision;

/* ────────────────────────────────────────────────────────────────────────── */
/* The tests                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

describe("runRouteAndMerge — the first pass", () => {
  it("merges every topic, snapshots the two it updated, and records provenance", async () => {
    const summary = await pass();

    expect(summary.outcome.status).toBe("ready");
    expect(summary.topicsTouched).toBe(3);
    expect(summary.topicsCreated).toBe(1);

    expect(countOf("topic-merge")).toBe(3);
    expect(countOf("merge-critic")).toBe(3);

    expect(revisionOf(TOPIC_ALPHA)).toBe(2);
    expect(revisionOf(TOPIC_BETA)).toBe(2);

    // Creates write no snapshot — there is no prior page to preserve.
    expect(db.rows("topic_revisions")).toHaveLength(2);
    expect(db.rows("topic_sources")).toHaveLength(3);
  });

  it("stamps every provenance row with the revision its merge produced", async () => {
    await pass();

    const byTopic = new Map(
      db.rows("topic_sources").map((row) => [row.topic_id, row.merged_at_revision]),
    );
    expect(byTopic.get(TOPIC_ALPHA)).toBe(2);
    expect(byTopic.get(TOPIC_BETA)).toBe(2);
    // The created topic starts at revision 1.
    expect([...byTopic.values()].filter((value) => value === 1)).toHaveLength(1);
  });
});

describe("runRouteAndMerge — a second pass over the same document", () => {
  /**
   * The headline property. Before the fix this run appended two more `topic_revisions` rows,
   * left Alpha and Beta at revision 3, and re-billed three merges and three critics.
   */
  it("converges: no new revisions, no bump, no re-billed merge", async () => {
    await pass();
    const revisionsAfterFirst = db.rows("topic_revisions").length;
    llmCalls.length = 0;

    const second = await pass();

    expect(countOf("topic-merge")).toBe(0);
    expect(countOf("merge-critic")).toBe(0);
    // Routing still runs: it is one call, and it is what tells this pass which topics the
    // document belongs to in the first place. That is the bounded, deliberate re-billing.
    expect(countOf("topic-routing")).toBe(1);

    expect(db.rows("topic_revisions")).toHaveLength(revisionsAfterFirst);
    expect(revisionOf(TOPIC_ALPHA)).toBe(2);
    expect(revisionOf(TOPIC_BETA)).toBe(2);
    expect(db.rows("topic_sources")).toHaveLength(3);

    // A converged re-run is a successful document, not a failed one.
    expect(second.outcome.status).toBe("ready");
    expect(second.outcome.mergedCount).toBe(3);
    expect(second.outcome.failedTopics).toEqual([]);
  });

  it("is still a fixed point on a third pass", async () => {
    await pass();
    await pass();
    llmCalls.length = 0;
    await pass();

    expect(countOf("topic-merge")).toBe(0);
    expect(db.rows("topic_revisions")).toHaveLength(2);
    expect(revisionOf(TOPIC_ALPHA)).toBe(2);
  });

  it("does not re-merge after another document has moved the topic on", async () => {
    await pass();

    // Someone else's upload bumps Alpha twice more.
    const alpha = db.rows("topics").find((row) => row.id === TOPIC_ALPHA);
    if (alpha !== undefined) alpha.revision = 4;
    llmCalls.length = 0;

    await pass();

    expect(countOf("topic-merge")).toBe(0);
    expect(revisionOf(TOPIC_ALPHA)).toBe(4);
  });
});

describe("runRouteAndMerge — the mid-loop retry", () => {
  /**
   * The trigger a user cannot see coming. The merge step makes two serial LLM calls per
   * topic and carries `retries: 3`, so a timeout after some topics have persisted is
   * ordinary. The retry must finish the unfinished topics and touch nothing else.
   */
  it("finishes only the topics that did not persist, and pays only for those", async () => {
    failMergeFor = new Set(["Beta", "Gamma"]);
    const first = await pass();

    expect(first.outcome.status).toBe("partial");
    expect(first.outcome.failedTopics.map((topic) => topic.topicKey)).toHaveLength(2);
    expect(revisionOf(TOPIC_ALPHA)).toBe(2);
    expect(revisionOf(TOPIC_BETA)).toBe(1);
    expect(db.rows("topic_sources")).toHaveLength(1);

    // ── the retry ─────────────────────────────────────────────────────────
    failMergeFor = new Set();
    llmCalls.length = 0;
    const second = await pass();

    // Alpha is skipped; Beta and the Gamma create are paid for once each.
    expect(countOf("topic-merge")).toBe(2);
    expect(countOf("merge-critic")).toBe(2);

    expect(revisionOf(TOPIC_ALPHA)).toBe(2);
    expect(revisionOf(TOPIC_BETA)).toBe(2);
    expect(db.rows("topic_revisions")).toHaveLength(2);
    expect(db.rows("topic_sources")).toHaveLength(3);

    expect(second.outcome.status).toBe("ready");
    expect(second.outcome.mergedCount).toBe(3);

    // ── and the retry itself converges ────────────────────────────────────
    llmCalls.length = 0;
    await pass();
    expect(countOf("topic-merge")).toBe(0);
    expect(db.rows("topic_revisions")).toHaveLength(2);
    expect(revisionOf(TOPIC_BETA)).toBe(2);
  });

  it("re-merges — and does not double-bump — when the page update never landed", async () => {
    // The crash between Step C's write (1) and write (2): the snapshot is stored, the page
    // is not. Reading only the snapshot would skip this topic and silently lose the merge.
    await pass();
    const alpha = db.rows("topics").find((row) => row.id === TOPIC_ALPHA);
    if (alpha !== undefined) alpha.revision = 1;
    db.tables.topic_sources = db
      .rows("topic_sources")
      .filter((row) => row.topic_id !== TOPIC_ALPHA);
    llmCalls.length = 0;

    await pass();

    // Alpha was merged again — correctly — and the duplicate snapshot at revision 1 was
    // absorbed by `unique (topic_id, revision)` rather than appended.
    expect(countOf("topic-merge")).toBe(1);
    expect(revisionOf(TOPIC_ALPHA)).toBe(2);
    expect(db.rows("topic_revisions").filter((row) => row.topic_id === TOPIC_ALPHA)).toHaveLength(
      1,
    );
  });

  it("repairs provenance a crash lost, without paying for a merge", async () => {
    // The crash between write (2) and write (3): the page is updated, the provenance row
    // never got written. `process-document` reads that table to decide which topics changed,
    // so leaving it missing would make a correctly-merged topic invisible downstream.
    await pass();
    db.tables.topic_sources = db
      .rows("topic_sources")
      .filter((row) => row.topic_id !== TOPIC_ALPHA);
    llmCalls.length = 0;

    await pass();

    expect(countOf("topic-merge")).toBe(0);
    expect(revisionOf(TOPIC_ALPHA)).toBe(2);
    const repaired = db.rows("topic_sources").find((row) => row.topic_id === TOPIC_ALPHA);
    expect(repaired?.merged_at_revision).toBe(2);
    expect(repaired?.locators).toEqual([{ page: 1 }]);
  });
});

describe("the database guard behind the gate", () => {
  /**
   * The application gate is a cost optimisation; the trigger is the invariant. This asserts
   * the compounding write is refused even when the gate is bypassed — the case that matters
   * because the writer here holds the service key and RLS is not in its path.
   */
  it("refuses a second merge snapshot for a document already merged into the topic", () => {
    db.rows("topic_sources").push({
      user_id: USER,
      topic_id: TOPIC_ALPHA,
      document_id: DOCUMENT,
      locators: [],
      merged_at_revision: 2,
    });

    const rejected = db.insert("topic_revisions", {
      user_id: USER,
      topic_id: TOPIC_ALPHA,
      revision: 2,
      source: "merge",
      document_id: DOCUMENT,
    });

    expect(rejected?.code).toBe("P0001");
    expect(db.rows("topic_revisions")).toHaveLength(0);
  });

  it("uses a code the persist does NOT swallow — 23505 is reserved for the identical re-run", () => {
    // `persistTopicMerge` treats 23505 as "this exact step already ran" and continues. If
    // the trigger borrowed unique_violation, the guard would be silent and the revision
    // bump would go through anyway.
    db.rows("topic_sources").push({
      user_id: USER,
      topic_id: TOPIC_ALPHA,
      document_id: DOCUMENT,
      locators: [],
      merged_at_revision: 2,
    });
    const rejected = db.insert("topic_revisions", {
      user_id: USER,
      topic_id: TOPIC_ALPHA,
      revision: 5,
      source: "merge",
      document_id: DOCUMENT,
    });
    expect(rejected?.code).not.toBe("23505");
  });

  it("still allows a deep-review revision on a topic this document merged into", () => {
    db.rows("topic_sources").push({
      user_id: USER,
      topic_id: TOPIC_ALPHA,
      document_id: DOCUMENT,
      locators: [],
      merged_at_revision: 2,
    });
    const rejected = db.insert("topic_revisions", {
      user_id: USER,
      topic_id: TOPIC_ALPHA,
      revision: 2,
      source: "deep_review",
      document_id: DOCUMENT,
    });
    expect(rejected).toBeNull();
  });

  it("re-opens once the provenance row is stripped — PLAN §5's release valve", () => {
    db.rows("topic_sources").push({
      user_id: USER,
      topic_id: TOPIC_ALPHA,
      document_id: DOCUMENT,
      locators: [],
      merged_at_revision: 2,
    });
    db.tables.topic_sources = [];

    const rejected = db.insert("topic_revisions", {
      user_id: USER,
      topic_id: TOPIC_ALPHA,
      revision: 5,
      source: "merge",
      document_id: DOCUMENT,
    });
    expect(rejected).toBeNull();
  });
});
