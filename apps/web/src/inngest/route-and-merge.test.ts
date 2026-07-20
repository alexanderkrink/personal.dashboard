// @vitest-environment node
//
// Node, not the jsdom default: this module's import graph reaches `@/env`, and t3-env
// refuses to hand a server variable to anything with a `window` on it.

import type { StoredTopicPage } from "@study/ai";
import type { SupabaseAdminClient } from "@study/db";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditTopic } from "./topic-edits";

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

  /**
   * `create_topic_with_first_revision`, transcribed from migrations `20260720194417` and
   * `20260720213410`.
   *
   * Both inserts or neither — that atomicity is the whole point of the function, so a fake
   * that did them independently would test the opposite of the invariant. The revision is 0
   * (the empty page the create superseded), which is what keeps every later revision number
   * free — the rule `createAuditTopic`'s old revision-1 precedent broke, and the reason it
   * now routes through this RPC too. `p_source` defaults to 'merge' exactly as the SQL does.
   */
  createTopicWithFirstRevision(args: Row): { data: string | null; error: PgError | null } {
    const topicId = `generated-topics-${this.rows("topics").length + 1}`;
    const topic: Row = {
      id: topicId,
      user_id: args.p_user_id,
      course_id: args.p_course_id,
      title: args.p_title,
      slug: args.p_slug,
      summary: args.p_summary,
      page: args.p_page,
      revision: 1,
    };
    const revision: Row = {
      user_id: args.p_user_id,
      topic_id: topicId,
      revision: 0,
      page: args.p_previous_page,
      change_summary: args.p_change_summary,
      source: args.p_source ?? "merge",
      needs_review: args.p_needs_review,
      review_notes: args.p_review_notes ?? [],
      document_id: args.p_document_id,
      prompt_id: args.p_prompt_id,
      prompt_version: args.p_prompt_version,
      provider: args.p_provider,
      model: args.p_model,
      input_hash: args.p_input_hash,
    };

    const rejected = this.insert("topic_revisions", revision);
    if (rejected !== null) return { data: null, error: rejected };
    this.rows("topics").push(topic);
    return { data: topicId, error: null };
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
/** Topics whose merge fake emits a note block carrying NO citation of this document. */
let uncitedMergeFor = new Set<string>();
/** Topics whose merge fake returns a page far larger than the segments it was given. */
let bloatedMergeFor = new Set<string>();
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
        // NOT a hardcoded pass. A critic fake that always returns ok makes every merge test
        // green regardless of what the merge produced, which is how a suite ends up unable
        // to tell a working critic from an absent one — the Wave 4 shape exactly. This one
        // reads the page it was given and objects to a page with no citations at all.
        const proposed = String(vars.proposedPage);
        const blocks = (JSON.parse(proposed) as { notes?: unknown[] }).notes ?? [];
        if (blocks.length > 0 && Number(vars.citedPages) === 0) {
          return {
            status: "success",
            value: {
              ok: false,
              severity: "major" as const,
              issues: [
                {
                  kind: "bad-attribution" as const,
                  detail: "The proposed page cites no page of this document.",
                  evidence: proposed.slice(0, 80),
                },
              ],
            },
            stamp,
          };
        }
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
          page: {
            ...EMPTY_PAGE,
            summary: bloatedMergeFor.has(title)
              ? // The Wave 4 ratio, reproduced: a page an order of magnitude larger than the
                // material it was built from. The fixture's segments are ~40 characters.
                `${title}: ${"correct-looking statistics ".repeat(200)}`
              : `${title} merged from ${String(vars.documentLabel)}`,
            notes: uncitedMergeFor.has(title)
              ? [{ id: "orphan", heading: "Orphan", markdown: "content", sources: [] }]
              : [],
          },
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
  uncitedMergeFor = new Set();
  bloatedMergeFor = new Set();
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

const fakeAdmin = () =>
  ({
    from: (table: string) => new Query(db, table),
    rpc: (name: string, args: Row) => {
      if (name !== "create_topic_with_first_revision") {
        throw new Error(`fake db has no rpc ${name}`);
      }
      return Promise.resolve(db.createTopicWithFirstRevision(args));
    },
  }) as unknown as SupabaseAdminClient;

const pass = () =>
  runRouteAndMerge({
    admin: fakeAdmin(),
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

describe("runRouteAndMerge — a created topic carries its review flag", () => {
  /**
   * The defect, restated as code.
   *
   * `needs_review` is a column on `topic_revisions` and on no other table. The create branch
   * used to insert the topic and return — so on every FIRST merge, `verified.needsReview`
   * was computed and thrown away, along with the findings behind it.
   *
   * That is exactly inverted. The grounding checks and the expansion-ratio gate were built
   * for the Wave 4 failure: a thin input producing an ungrounded, newly created topic in a
   * course with no topics. The create path. The page most likely to be wrong was the only
   * one that could not be flagged.
   */
  function legacyCreate(db_: FakeDb, args: Row): string {
    // What the old branch did: the topic, and nothing else.
    const topicId = `legacy-topic-${db_.rows("topics").length + 1}`;
    db_.rows("topics").push({
      id: topicId,
      user_id: args.p_user_id,
      course_id: args.p_course_id,
      title: args.p_title,
      slug: args.p_slug,
      summary: args.p_summary,
      page: args.p_page,
      revision: 1,
    });
    return topicId;
  }

  it("RED: the old create branch left no row anywhere to carry the flag", () => {
    const legacyDb = new FakeDb();
    legacyCreate(legacyDb, {
      p_user_id: USER,
      p_course_id: COURSE,
      p_title: "Gamma",
      p_slug: "gamma",
      p_summary: "s",
      p_page: EMPTY_PAGE,
      // The verifier said this page needs review. There is nowhere to put that.
      p_needs_review: true,
      p_review_notes: ["[grounding] This page is 21× the size of the material…"],
    });

    expect(legacyDb.rows("topics")).toHaveLength(1);
    expect(legacyDb.rows("topic_revisions")).toEqual([]);

    // The flag and its reasons exist nowhere durable. A `warn` processing event is
    // document-scoped; no topic page can read it.
    const flagged = legacyDb.rows("topic_revisions").filter((row) => row.needs_review === true);
    expect(flagged).toEqual([]);
  });

  it("GREEN: a flagged create writes a revision-0 row carrying needs_review and why", async () => {
    bloatedMergeFor = new Set(["Gamma"]);

    const summary = await pass();

    // Gamma is the created topic in this fixture.
    const created = db.rows("topics").find((row) => row.title === "Gamma");
    expect(created).toBeDefined();

    const revisions = db.rows("topic_revisions").filter((row) => row.topic_id === created?.id);
    expect(revisions).toHaveLength(1);

    const first = revisions[0];
    // Revision 0 — the empty page this create superseded — so the next merge's snapshot at
    // revision 1 does not collide with it.
    expect(first?.revision).toBe(0);
    expect(first?.needs_review).toBe(true);
    expect(first?.review_notes).toEqual(
      expect.arrayContaining([expect.stringContaining("[grounding]")]),
    );
    const notes = (first?.review_notes ?? []) as string[];
    expect(notes.join(" ")).toContain("is not summarising it");

    const gamma = summary.topicOutcomes.find((outcome) => outcome.topicKey === created?.id);
    expect(gamma ?? { needsReview: true }).toMatchObject({ needsReview: true });
  });

  it("a clean create still writes its revision row, unflagged", async () => {
    await pass();

    const created = db.rows("topics").find((row) => row.title === "Gamma");
    const first = db.rows("topic_revisions").find((row) => row.topic_id === created?.id);

    // The row is the invariant, not the flag: a topic never exists without its first
    // revision, whether or not anything was wrong with it.
    expect(first).toBeDefined();
    expect(first?.revision).toBe(0);
    expect(first?.needs_review).toBe(false);
    expect(first?.review_notes).toEqual([]);
  });
});

describe("runRouteAndMerge — the critic actually gates", () => {
  /**
   * The companion to the critic fake above, and the reason it is not a hardcoded pass.
   *
   * Until Wave 5 this suite's `merge-critic` fake returned `{ok: true}` unconditionally, so
   * every assertion about the merge path held whether the critic worked, was misconfigured,
   * or had been deleted. That is the same failure the wave was investigating: a check whose
   * green test proves nothing about the check.
   */
  it("RED: a page with an uncited note is rejected, re-merged, and flagged", async () => {
    uncitedMergeFor = new Set(["Alpha"]);

    const summary = await pass();

    // The automatic re-merge fired: one `topic-merge-repair` call, and a fourth critic call
    // to judge its output.
    expect(countOf("topic-merge")).toBe(3);
    expect(countOf("topic-merge-repair")).toBe(1);
    expect(countOf("merge-critic")).toBe(4);

    const alpha = summary.topicOutcomes.find((outcome) => outcome.topicKey === TOPIC_ALPHA);
    expect(alpha).toMatchObject({ status: "merged", needsReview: true });

    // …and every other topic was untouched by it.
    const others = summary.topicOutcomes.filter((outcome) => outcome.topicKey !== TOPIC_ALPHA);
    expect(others.every((o) => o.status === "merged" && !o.needsReview)).toBe(true);
  });

  it("GREEN: the same run with citations present passes on the first attempt", async () => {
    const summary = await pass();

    expect(countOf("topic-merge")).toBe(3);
    expect(countOf("merge-critic")).toBe(3);
    expect(
      summary.topicOutcomes.every((outcome) => outcome.status === "merged" && !outcome.needsReview),
    ).toBe(true);
  });
});

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

    // Two updates and one create. Until Wave 5 this read `toHaveLength(2)` under the
    // comment "creates write no snapshot — there is no prior page to preserve", which
    // PINNED the defect: `needs_review` lives only on `topic_revisions`, so a create
    // writing none discarded its own review flag. The snapshot IS the prior page — the
    // empty one, at revision 0.
    expect(db.rows("topic_revisions")).toHaveLength(3);
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
    expect(db.rows("topic_revisions")).toHaveLength(3);
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
    expect(db.rows("topic_revisions")).toHaveLength(3);
    expect(db.rows("topic_sources")).toHaveLength(3);

    expect(second.outcome.status).toBe("ready");
    expect(second.outcome.mergedCount).toBe(3);

    // ── and the retry itself converges ────────────────────────────────────
    llmCalls.length = 0;
    await pass();
    expect(countOf("topic-merge")).toBe(0);
    expect(db.rows("topic_revisions")).toHaveLength(3);
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

describe("createAuditTopic — the audit's create must leave revision 1 free for the next merge", () => {
  /**
   * The latent landmine recorded in migration `20260720194417`'s header and PLAN §5.
   *
   * `createAuditTopic` used to write its first revision at revision 1, via two separate
   * PostgREST inserts. The NEXT merge into that topic reads `currentRevision = 1`, snapshots
   * the pre-merge page at revision 1, collides with `unique (topic_id, revision)` — and
   * `persistTopicMerge` swallows 23505 on that insert as "this exact step already ran". The
   * merge's snapshot — the only durable copy of the page as the deep review wrote it — is
   * silently lost, so a revert to revision 1 returns the audit's EMPTY create record instead
   * of the audit's content. Latent while Step D is unwired; a landmine under wiring it.
   *
   * Both tests below drive the REAL `createAuditTopic` shape against the REAL
   * `runRouteAndMerge`, on the fake db that enforces `unique (topic_id, revision)`.
   */
  const AUDIT_DOCUMENT = "44444444-4444-4444-8444-444444444444";
  const LEGACY_TOPIC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  const STAMP = {
    promptId: "deep-review-audit",
    promptVersion: 1,
    provider: "anthropic",
    model: "fake-opus",
    inputHash: "hash-deep-review-audit",
  };

  /** The page `createAuditTopic` builds from a `missing` finding, as the fake db stores it. */
  const auditPage = (): Row => ({
    ...EMPTY_PAGE,
    summary: "What the audit said Gamma is.",
    notes: [
      {
        id: "deep-review-intro",
        heading: "Gamma",
        markdown: "Consumer surplus, as the audit stated it.",
        sources: [{ documentId: AUDIT_DOCUMENT, page: 3 }],
      },
    ],
  });

  it("RED, pinned: the legacy revision-1 create loses the next merge's snapshot to the 23505 swallow", async () => {
    // What the old createAuditTopic did, transcribed: the topic at revision 1 and a
    // revision-1 history row, as two independent inserts.
    db.rows("topics").push({
      id: LEGACY_TOPIC,
      user_id: USER,
      course_id: COURSE,
      title: "Gamma",
      slug: "gamma",
      summary: "What the audit said Gamma is.",
      page: auditPage(),
      revision: 1,
      title_embedding: null,
      summary_embedding: null,
    });
    expect(
      db.insert("topic_revisions", {
        user_id: USER,
        topic_id: LEGACY_TOPIC,
        revision: 1,
        page: { ...EMPTY_PAGE },
        change_summary: "Deep review added this topic: Gamma.",
        source: "deep_review",
        needs_review: false,
        document_id: AUDIT_DOCUMENT,
      }),
    ).toBeNull();

    // The next merge: the fixture document's Gamma segment routes into the existing topic.
    await pass();

    // The merge ran — the topic moved on…
    expect(revisionOf(LEGACY_TOPIC)).toBe(2);

    // …but its pre-merge snapshot was swallowed by `unique (topic_id, revision)`. The only
    // revision-1 row is still the audit's empty-page create record, and the page as the
    // audit wrote it survives in NO snapshot: reverting returns the empty page.
    const rows = db.rows("topic_revisions").filter((row) => row.topic_id === LEGACY_TOPIC);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ revision: 1, source: "deep_review" });
    expect((rows[0]?.page as StoredTopicPage | undefined)?.notes).toEqual([]);
    const auditPageSnapshotted = rows.some((row) =>
      ((row.page as StoredTopicPage).notes ?? []).some((note) => note.id === "deep-review-intro"),
    );
    expect(auditPageSnapshotted).toBe(false);
  });

  it("GREEN: create at revision 0, so the next merge snapshots the audit's page at 1 cleanly", async () => {
    const { topicId } = await createAuditTopic({
      admin: fakeAdmin(),
      userId: USER,
      courseId: COURSE,
      documentId: AUDIT_DOCUMENT,
      title: "Gamma",
      summary: "What the audit said Gamma is.",
      markdown: "Consumer surplus, as the audit stated it.",
      page: 3,
      takenSlugs: new Set<string>(),
      stamp: STAMP,
    });

    // The create leaves the topic at revision 1, carrying the audit's content.
    expect(revisionOf(topicId)).toBe(1);

    // The next merge into it: the routing fake assigns the fixture's Gamma segment to the
    // existing topic by title.
    await pass();

    const revisions = db
      .rows("topic_revisions")
      .filter((row) => row.topic_id === topicId)
      .sort((a, b) => (a.revision as number) - (b.revision as number));

    // Two rows: the creation record (the empty page the audit superseded, attributed to the
    // deep review) and the merge's pre-merge snapshot (the page as the audit wrote it) —
    // the row the revision-1 create made structurally impossible to keep.
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({ revision: 0, source: "deep_review" });
    expect((revisions[0]?.page as StoredTopicPage | undefined)?.notes).toEqual([]);
    expect(revisions[1]).toMatchObject({ revision: 1, source: "merge" });
    const snapshotted = revisions[1]?.page as StoredTopicPage | undefined;
    expect(snapshotted?.notes.map((note) => note.id)).toContain("deep-review-intro");

    expect(revisionOf(topicId)).toBe(2);
  });
});
