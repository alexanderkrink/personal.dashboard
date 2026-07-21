// @vitest-environment node
//
// Node, not the jsdom default: this module's import graph reaches `@/env`, and t3-env
// refuses to hand a server variable to anything with a `window` on it.

import type { SupabaseAdminClient } from "@study/db";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { logProcessingEvent } from "@/inngest/documents";
import { extractionHash } from "@/lib/documents/extraction-hash";
import {
  describeWithWave7Section3,
  loadWave7Section3,
  WAVE7_ROUTING_HASH_PASS1,
  WAVE7_ROUTING_HASH_PASS2,
} from "@/test/wave7-section3-fixture";

/**
 * §3 resumability: a merge step that dies mid-loop must RESUME, not RE-ROUTE (Wave 7).
 *
 * The production failure (.local-fixtures/wave7-section3): pass 1 routed 48 segments on an
 * EMPTY index into 8 create targets, created 4, then died inside target 5. Inngest retried;
 * pass 2 re-read the extraction and RE-ROUTED all 48 into the 4 committed topics, skipped all
 * 4 as "already includes this file", and finalized `ready` — the 4 never-created topics and
 * ~24 pages gone.
 *
 * The harness below drives the REAL `runRouteAndMergeSteps` (frozen plan + one memoized step
 * per target) against a REAL Postgres-shaped fake and a memoizing fake step runner. Two
 * scenarios, differing only in old-vs-new code, are the Clause-1 mutation proof:
 *   - RED  (`runRouteAndMerge`, the pre-fix single step): retry re-routes, all skipped, only
 *     4 topics, status `ready`.
 *   - GREEN (`runRouteAndMergeSteps`): retry LOADS the frozen plan (zero routing), targets 1–4
 *     are memoized, only 5–8 execute, 8 topics + 8 sources, status genuinely complete.
 */

/* ────────────────────────────────────────────────────────────────────────── */
/* A Postgres small enough to assert against (incl. document_merge_plans)      */
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
    document_merge_plans: [],
  };

  rows(table: string): Row[] {
    const rows = this.tables[table];
    if (rows === undefined) throw new Error(`fake db has no table ${table}`);
    return rows;
  }

  /** `topic_revisions_one_merge_per_document`, transcribed from migration 20260719224933. */
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
      message: `document ${String(row.document_id)} is already merged into topic ${String(row.topic_id)}`,
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
    this.rows(table).push({ id: `generated-${table}-${this.rows(table).length + 1}`, ...row });
    return null;
  }

  /** `create_topic_with_first_revision`, transcribed from migrations 20260720194417/213410. */
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
      this.rows(table).push({ id: `generated-${table}-${this.rows(table).length + 1}`, ...row });
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
      const firstRow = found[0];
      return firstRow === undefined
        ? {
            data: null,
            error: this.op === "select" ? null : { code: "PGRST116", message: "no rows" },
          }
        : { data: firstRow, error: null };
    }
    return { data: found, error: null };
  }

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
/* A memoizing fake step runner, with a genuine mid-loop kill                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * `step.run` that memoizes by id in a Map (a completed id returns its cached value on a
 * retry, exactly like Inngest within a run) and can KILL the Nth non-cached `merge-target`
 * step by throwing OUT of it — the real worker-death shape, not the graceful per-topic
 * 'partial' the merge fake produces.
 */
class FakeStep {
  private readonly cache = new Map<string, unknown>();
  private mergeTargetRuns = 0;
  private readonly killedIds = new Set<string>();
  /** Kill the Nth non-cached `merge-target:` step (1-based). null = never kill. */
  killTargetOrdinal: number | null = null;
  /** Ids whose fn actually executed since the last {@link resetPass}. */
  executedThisPass: string[] = [];

  resetPass(): void {
    this.executedThisPass = [];
  }

  async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.cache.has(id)) return this.cache.get(id) as T;

    if (id.startsWith("merge-target:")) {
      this.mergeTargetRuns += 1;
      if (
        this.killTargetOrdinal !== null &&
        this.mergeTargetRuns === this.killTargetOrdinal &&
        !this.killedIds.has(id)
      ) {
        this.killedIds.add(id);
        throw new Error(`simulated worker kill at step ${id}`);
      }
    }

    this.executedThisPass.push(id);
    const result = await fn();
    this.cache.set(id, result);
    return result;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Fixture: an 8-target document routed off an EMPTY index                     */
/* ────────────────────────────────────────────────────────────────────────── */

const USER = "11111111-1111-4111-8111-111111111111";
const COURSE = "22222222-2222-4222-8222-222222222222";
const DOCUMENT = "33333333-3333-4333-8333-333333333333";
const TARGET_COUNT = 8;

/** N headed pages → N segments (`seg-1`…`seg-N`), one create target each on an empty index. */
function extractionOf(pageCount: number): Row {
  const pages = Array.from({ length: pageCount }, (_, index) => ({
    page: index + 1,
    title: `Concept ${index + 1}`,
    markdown: `Distinct material about concept ${index + 1}.`,
  }));
  return {
    route: "pdf-native",
    fidelity: "visual",
    sourceUnits: pageCount,
    wordsPerSlide: null,
    extraction: {
      sessionLabel: null,
      summary: "An eight-section deck.",
      pages,
      headings: pages.map((page) => ({ text: page.title, level: 1, page: page.page })),
      definitions: [],
      formulas: [],
      workedExamples: [],
      examSignals: [],
      skipped: [],
    },
  };
}

const EMPTY_PAGE = {
  summary: "",
  keyTerms: [],
  notes: [],
  formulas: [],
  workedExamples: [],
  openQuestions: [],
};

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
let failMergeFor = new Set<string>();
/** When true, the router returns NO decision for the last segment — a lost-segment scenario. */
let omitLastDecision = false;
/** When true, the critic rejects every merge with a multi-line, >400-char chain-of-thought. */
let criticCot = false;
let db: FakeDb;

const BASE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ACCESS_CODE: "test_access_code",
  CRON_SECRET: "test_cron_secret_long_enough",
  INNGEST_SIGNING_KEY: `signkey-test-${"a".repeat(64)}`,
  VOYAGE_API_KEY: "pa-test",
  CLOUDCONVERT_API_KEY: "cc-test",
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
        inputHash: `hash-${prompt.id}-${llmCalls.length}`,
      };

      if (prompt.id === "topic-routing") {
        const rendered = String(vars.segments);
        const all = [...rendered.matchAll(/### segmentKey: (\S+)\nHeading: (.+)/g)];
        // Drop the last segment's decision to model a lost segment (no routing decision).
        const seen = omitLastDecision ? all.slice(0, -1) : all;
        // The over-assign funnel: on a NON-empty index every segment is dumped into the first
        // existing topic (the §3 pass-2 behaviour). On an empty index each heading creates its
        // own topic.
        const existing = db.rows("topics").filter((row) => row.course_id === COURSE);
        const firstExisting = existing[0]?.id as string | undefined;
        const decisions = seen.map((match) => {
          const segmentKey = match[1] ?? "";
          const heading = (match[2] ?? "").trim();
          return firstExisting === undefined
            ? {
                segmentKey,
                assignToTopicId: null,
                createNewTitle: heading,
                rationale: `create ${heading}`,
              }
            : {
                segmentKey,
                assignToTopicId: firstExisting,
                createNewTitle: null,
                rationale: "funnelled",
              };
        });
        return { status: "success", value: { decisions }, stamp };
      }

      if (prompt.id === "merge-critic") {
        if (criticCot) {
          // Raw gemini-3.1-flash-lite output that leaks its reasoning: multi-line and long.
          const detail = [
            "Let me reason about the attribution step by step.",
            "First, the block cites p.1 but the claim is not on p.1.",
            `Therefore this is an unsupported addition: ${"reasoning ".repeat(60)}done.`,
          ].join("\n");
          return {
            status: "success",
            value: {
              ok: false,
              severity: "major" as const,
              issues: [{ kind: "unsupported-addition" as const, detail, evidence: "the block" }],
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
      const givenPages = [
        ...new Set([...String(vars.segments).matchAll(/\[p\.(\d+)\]/g)].map((m) => Number(m[1]))),
      ];
      return {
        status: "success",
        value: {
          title,
          page: {
            ...EMPTY_PAGE,
            summary: `${title} merged from ${String(vars.documentLabel)}`,
            notes:
              givenPages.length === 0
                ? []
                : [
                    {
                      id: "cited",
                      heading: title,
                      markdown: `What ${title} covers.`,
                      sources: givenPages.map((page) => ({
                        documentId: String(vars.documentId),
                        page,
                      })),
                    },
                  ],
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
let runRouteAndMergeSteps: typeof import("./route-and-merge").runRouteAndMergeSteps;
let sanitizeReviewNote: typeof import("./route-and-merge").sanitizeReviewNote;

beforeAll(async () => {
  for (const [key, value] of Object.entries(BASE_ENV)) vi.stubEnv(key, value);
  ({ runRouteAndMerge, runRouteAndMergeSteps, sanitizeReviewNote } = await import(
    "./route-and-merge"
  ));
});

beforeEach(() => {
  llmCalls.length = 0;
  failMergeFor = new Set();
  omitLastDecision = false;
  criticCot = false;
  vi.mocked(logProcessingEvent).mockClear();
  db = new FakeDb();
  db.rows("documents").push({
    id: DOCUMENT,
    user_id: USER,
    extraction: extractionOf(TARGET_COUNT),
  });
});

const fakeAdmin = () =>
  ({
    from: (table: string) => new Query(db, table),
    rpc: (name: string, args: Row) => {
      if (name !== "create_topic_with_first_revision")
        throw new Error(`fake db has no rpc ${name}`);
      return Promise.resolve(db.createTopicWithFirstRevision(args));
    },
  }) as unknown as SupabaseAdminClient;

const INPUT = {
  userId: USER,
  documentId: DOCUMENT,
  courseId: COURSE,
  courseTitle: "Statistics",
  filename: "deck.pdf",
  sessionLabel: null,
};

const countOf = (id: string) => llmCalls.filter((call) => call === id).length;

/* ────────────────────────────────────────────────────────────────────────── */
/* RED — the pre-fix single step re-routes on retry and loses the uncreated    */
/* ────────────────────────────────────────────────────────────────────────── */

describe("§3 RED: the pre-fix runRouteAndMerge re-routes on retry and finalizes ready", () => {
  it("creates 4 of 8, then a retry funnels the rest into the 4 and skips them all", async () => {
    // Pass 1: the last 4 creates fail (the mid-loop timeout), leaving 4 topics.
    failMergeFor = new Set(["Concept 5", "Concept 6", "Concept 7", "Concept 8"]);
    const first = await runRouteAndMerge({ admin: fakeAdmin(), ...INPUT });

    expect(first.outcome.status).toBe("partial");
    expect(db.rows("topics")).toHaveLength(4);

    // Pass 2: the retry. Routing now sees the 4 committed topics and (like production) dumps
    // every segment into the first — no creates proposed, so the 4 uncreated topics are gone.
    failMergeFor = new Set();
    llmCalls.length = 0;
    const second = await runRouteAndMerge({ admin: fakeAdmin(), ...INPUT });

    // The defect, pinned: the retry RE-ROUTED…
    expect(countOf("topic-routing")).toBe(1);
    // …merged nothing (all funnelled into an already-merged topic → skipped)…
    expect(countOf("topic-merge")).toBe(0);
    // …only 4 topics ever exist, and 4 planned topics + their pages are permanently lost…
    expect(db.rows("topics")).toHaveLength(4);
    // …yet the document finalizes `ready`.
    expect(second.outcome.status).toBe("ready");
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* GREEN — the resumable path loads the frozen plan and finishes 5–8           */
/* ────────────────────────────────────────────────────────────────────────── */

describe("§3 GREEN: runRouteAndMergeSteps resumes at target 5 after a mid-loop kill", () => {
  it("kills inside target 5, then a retry loads the frozen plan and creates all 8", async () => {
    const step = new FakeStep();
    step.killTargetOrdinal = 5;

    // Pass 1: routes 8 creates, persists the frozen plan, creates targets 1–4, dies inside 5.
    await expect(runRouteAndMergeSteps({ admin: fakeAdmin(), ...INPUT, step })).rejects.toThrow(
      /simulated worker kill/,
    );
    expect(countOf("topic-routing")).toBe(1);
    expect(db.rows("topics")).toHaveLength(4);
    // The frozen receipt was written, keyed by a hash of the extraction (index-independent).
    expect(db.rows("document_merge_plans")).toHaveLength(1);

    // Pass 2: the retry — SAME step (its cache is the run's memoized state).
    llmCalls.length = 0;
    step.resetPass();
    const second = await runRouteAndMergeSteps({ admin: fakeAdmin(), ...INPUT, step });

    // Loaded the frozen plan — ZERO routing calls.
    expect(countOf("topic-routing")).toBe(0);
    // Targets 1–4 were memoized by their completed step.run; only 5–8 re-executed.
    expect(step.executedThisPass).toEqual([
      "merge-target:new:seg-5",
      "merge-target:new:seg-6",
      "merge-target:new:seg-7",
      "merge-target:new:seg-8",
    ]);
    // Only four merges were paid for — the four that never persisted.
    expect(countOf("topic-merge")).toBe(4);
    // All eight topics now exist, each with its provenance row.
    expect(db.rows("topics")).toHaveLength(8);
    expect(db.rows("topic_sources")).toHaveLength(8);
    expect(second.outcome.status).toBe("ready");
    expect(second.topicsTouched).toBe(8);
  });

  it("updates an existing topic (assign + merge), once, through the resumable path", async () => {
    // The common production case: a later document expands an existing topic rather than
    // creating one. One page, one segment, routed into the one topic already in the course.
    const TOPIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    db.tables.documents = [{ id: DOCUMENT, user_id: USER, extraction: extractionOf(1) }];
    db.rows("topics").push({
      id: TOPIC,
      user_id: USER,
      course_id: COURSE,
      title: "Existing",
      slug: "existing",
      summary: "Existing so far",
      page: EMPTY_PAGE,
      revision: 1,
      title_embedding: embedText("Existing"),
      summary_embedding: embedText("Existing so far"),
    });

    const summary = await runRouteAndMergeSteps({
      admin: fakeAdmin(),
      ...INPUT,
      step: new FakeStep(),
    });

    expect(countOf("topic-merge")).toBe(1);
    expect(summary.topicsCreated).toBe(0);
    expect(db.rows("topics")).toHaveLength(1); // no new silo
    expect(db.rows("topics")[0]?.revision).toBe(2); // the existing topic moved on
    expect(db.rows("topic_sources")).toHaveLength(1);
    expect(summary.outcome.status).toBe("ready");
  });

  it("is a fixed point: a third full run re-routes nothing and creates nothing", async () => {
    const step = new FakeStep();
    await runRouteAndMergeSteps({ admin: fakeAdmin(), ...INPUT, step });
    expect(db.rows("topics")).toHaveLength(8);

    // A brand-new run (fresh step, no memoization) still loads the frozen plan from Postgres
    // and, via the resolved-create write-back, resolves every create to a skip — no dupes.
    llmCalls.length = 0;
    const fresh = new FakeStep();
    const third = await runRouteAndMergeSteps({ admin: fakeAdmin(), ...INPUT, step: fresh });

    expect(countOf("topic-routing")).toBe(0);
    expect(countOf("topic-merge")).toBe(0);
    expect(db.rows("topics")).toHaveLength(8);
    expect(third.outcome.status).toBe("ready");
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* The real production artifact                                               */
/* ────────────────────────────────────────────────────────────────────────── */

describeWithWave7Section3("§3 the frozen artifact (.local-fixtures/wave7-section3)", () => {
  it("proves the plan key must NOT be the routing input_hash: the two routing rows differ", () => {
    const corpus = loadWave7Section3();
    const routingRows = corpus.generations.filter((row) => row.job === "topic-routing");

    expect(routingRows).toHaveLength(2);
    // Same router version, different input — because the index changed between passes.
    expect(routingRows.every((row) => row.prompt_version === 5)).toBe(true);
    expect(WAVE7_ROUTING_HASH_PASS1).not.toBe(WAVE7_ROUTING_HASH_PASS2);
    expect(new Set(routingRows.map((row) => row.input_hash))).toEqual(
      new Set([WAVE7_ROUTING_HASH_PASS1, WAVE7_ROUTING_HASH_PASS2]),
    );
  });

  it("the extraction hash is stable across passes — the identity the frozen plan keys on", async () => {
    const corpus = loadWave7Section3();
    // The extraction column does not change between passes, so its hash is the SAME both
    // times — unlike the routing input_hash, which is why the plan keys on this instead.
    const hashA = await extractionHash(corpus.extractionColumn);
    const hashB = await extractionHash(corpus.extractionColumn);
    expect(hashA).toBe(hashB);
    expect(hashA).not.toBe(WAVE7_ROUTING_HASH_PASS1);
    expect(hashA).not.toBe(WAVE7_ROUTING_HASH_PASS2);
  });

  it("RED on real data: seeding the post-pass-1 state, the OLD code retry re-routes and loses", async () => {
    const corpus = loadWave7Section3();
    // Reconstruct the post-pass-1 state: the 4 committed topics, their provenance, their
    // snapshots. The real extraction drives real segmentation.
    db = new FakeDb();
    db.rows("documents").push({
      id: DOCUMENT,
      user_id: USER,
      extraction: corpus.extractionColumn,
    });
    for (const topic of corpus.topics) {
      db.rows("topics").push({
        id: topic.id,
        user_id: USER,
        course_id: COURSE,
        title: topic.title,
        slug: topic.slug,
        summary: topic.summary,
        page: topic.page,
        revision: topic.revision,
        title_embedding: embedText(topic.title),
        summary_embedding: embedText(topic.summary),
      });
    }
    for (const source of corpus.topicSources) {
      db.rows("topic_sources").push({
        user_id: USER,
        topic_id: source.topic_id,
        document_id: DOCUMENT,
        locators: source.locators,
        merged_at_revision: source.merged_at_revision,
      });
    }
    for (const revision of corpus.topicRevisions) {
      db.rows("topic_revisions").push({
        user_id: USER,
        topic_id: revision.topic_id,
        revision: revision.revision,
        source: revision.source,
        needs_review: revision.needs_review,
        document_id: DOCUMENT,
      });
    }

    llmCalls.length = 0;
    const retry = await runRouteAndMerge({ admin: fakeAdmin(), ...INPUT });

    // The bug on real data: routing re-ran, every segment funnelled into an already-merged
    // topic, nothing merged, the 4 committed topics are all that ever exist, `ready`.
    expect(countOf("topic-routing")).toBe(1);
    expect(countOf("topic-merge")).toBe(0);
    expect(db.rows("topics")).toHaveLength(4);
    expect(retry.outcome.status).toBe("ready");
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Fix (5): the segments-lost warn text is pinned                             */
/* ────────────────────────────────────────────────────────────────────────── */

describe("§3 fix (5): the 'sections reached a topic' warn is pinned", () => {
  it("emits the exact lost-segment text when a segment reaches no target", async () => {
    // The router drops the 8th segment's decision → 7 of 8 sections reach a topic.
    omitLastDecision = true;

    await runRouteAndMergeSteps({ admin: fakeAdmin(), ...INPUT, step: new FakeStep() });

    const warned = vi
      .mocked(logProcessingEvent)
      .mock.calls.map(([, event]) => event)
      .find((event) => String(event.detail).startsWith("7 of 8 sections"));

    expect(warned?.level).toBe("warn");
    expect(warned?.detail).toBe(
      "7 of 8 sections of this file reached a topic. 1 section did not, and its content is not in your notes.",
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Fix (4): critic-note sanitize                                              */
/* ────────────────────────────────────────────────────────────────────────── */

describe("sanitizeReviewNote", () => {
  it("flattens a multi-line chain-of-thought lead-in to a single capped line", () => {
    const cot = [
      "Let me think about this step by step.",
      "First, I weigh the sources.",
      `Then I conclude: ${"unsupported ".repeat(60)}claim.`,
    ].join("\n");
    const note = sanitizeReviewNote(`[critic:unsupported-addition] ${cot}`);

    expect(note).not.toContain("\n"); // multi-line CoT is folded to one line
    expect(note.length).toBeLessThanOrEqual(280); // hard cap
    expect(note.endsWith("…")).toBe(true); // ellipsis marks the truncation
    expect(note.startsWith("[critic:unsupported-addition] Let me think")).toBe(true);
  });

  it("leaves a short single-line note unchanged", () => {
    const note = "[critic:bad-attribution] The block cites p.2 but its content is from p.7.";
    expect(sanitizeReviewNote(note)).toBe(note);
  });

  it("collapses control characters and whitespace runs to single spaces", () => {
    expect(sanitizeReviewNote("a\t\t b\n\n\rc")).toBe("a b c");
  });

  it("integration: a critic detail with CoT + >400 chars persists sanitized", async () => {
    // One create, and a critic that returns a leaked-CoT rejection both times.
    db.tables.documents = [{ id: DOCUMENT, user_id: USER, extraction: extractionOf(1) }];
    criticCot = true;

    await runRouteAndMergeSteps({ admin: fakeAdmin(), ...INPUT, step: new FakeStep() });

    const created = db.rows("topics")[0];
    const revision = db.rows("topic_revisions").find((row) => row.topic_id === created?.id);
    const notes = (revision?.review_notes ?? []) as string[];

    expect(revision?.needs_review).toBe(true);
    const criticNote = notes.find((note) => note.startsWith("[critic:unsupported-addition]"));
    expect(criticNote).toBeDefined();
    // Persisted sanitized: one line, no CoT fold, capped.
    expect(criticNote).not.toContain("\n");
    expect((criticNote ?? "").length).toBeLessThanOrEqual(280);
    expect(criticNote?.endsWith("…")).toBe(true);
  });
});
