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

  /**
   * Simulate the TOCTOU race the per-course concurrency lane normally prevents: while > 0, a
   * `findCreatedTopic` lookup (a topics select filtering on create_plan_key) returns NOTHING,
   * as if the winner's create had not yet committed when the loser read. Decrements per use.
   * This is what lets a loser reach the create RPC and hit the unique-marker 23505.
   */
  blindCreatePlanKeyLookups = 0;

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

  /** `create_topic_with_first_revision`, transcribed from migrations 20260720194417/213410
   *  /20260721133109 (the last adds the atomic create_plan_key marker + its unique index). */
  createTopicWithFirstRevision(args: Row): { data: string | null; error: PgError | null } {
    const planKey = (args.p_create_plan_key ?? null) as string | null;

    // `unique index topics_create_plan_key_idx (user_id, course_id, create_plan_key) where
    // create_plan_key is not null`, transcribed. Checked BEFORE any write so the whole RPC is
    // atomic: on a marker collision neither the topic nor its revision lands, exactly as the
    // real transaction rolls back. Two null markers never collide (the partial predicate).
    if (planKey !== null) {
      const clash = this.rows("topics").some(
        (candidate) =>
          candidate.user_id === args.p_user_id &&
          candidate.course_id === args.p_course_id &&
          candidate.create_plan_key === planKey,
      );
      if (clash) {
        return {
          data: null,
          error: {
            code: "23505",
            message: "duplicate key value violates unique index topics_create_plan_key_idx",
          },
        };
      }
    }

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
      create_plan_key: planKey,
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
    // Race window: blind the loser's `findCreatedTopic` (a topics select on create_plan_key).
    if (
      this.op === "select" &&
      this.table === "topics" &&
      this.filters.some((filter) => filter.column === "create_plan_key") &&
      this.db.blindCreatePlanKeyLookups > 0
    ) {
      this.db.blindCreatePlanKeyLookups -= 1;
      return { data: this.one ? null : [], error: null };
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

/** A deck with the given headings, one page each — for scripted-routing scenarios. */
function extractionWithHeadings(headings: readonly string[]): Row {
  const pages = headings.map((title, index) => ({
    page: index + 1,
    title,
    markdown: `Distinct material under ${title}.`,
  }));
  return {
    route: "pdf-native",
    fidelity: "visual",
    sourceUnits: headings.length,
    wordsPerSlide: null,
    extraction: {
      sessionLabel: null,
      summary: "A mixed deck.",
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
  return Array.from({ length: 16 }, (_, offset) => {
    const value = Math.sin(hash + offset + 1) * 10000;
    return (value - Math.floor(value)) * 2 - 1;
  });
}

const llmCalls: string[] = [];
let failMergeFor = new Set<string>();
/** When true, the router returns NO decision for the last segment — a lost-segment scenario. */
let omitLastDecision = false;
/** When true, the critic rejects every merge with a multi-line, >400-char chain-of-thought. */
let criticCot = false;
/** Optional scripted routing: heading → assign to a topic id, or create a titled topic. */
let scriptedRouting: Record<string, { assign?: string; create?: string }> | null = null;
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
        // A scripted routing (heading → assign-to-id | create-with-title) drives a realistic
        // mix — assigns into existing topics, multi-segment creates (same title twice),
        // singleton coalesce (a lone create adjacent to a multi-segment one).
        const existing = db.rows("topics").filter((row) => row.course_id === COURSE);
        const firstExisting = existing[0]?.id as string | undefined;
        const decisions = seen.map((match) => {
          const segmentKey = match[1] ?? "";
          const heading = (match[2] ?? "").trim();
          const script = scriptedRouting?.[heading];
          if (script !== undefined) {
            return {
              segmentKey,
              assignToTopicId: script.assign ?? null,
              createNewTitle: script.create ?? null,
              rationale: `scripted ${heading}`,
            };
          }
          // Default: on an empty index each heading creates its own topic; on a non-empty index
          // every segment is dumped into the first existing topic (the §3 pass-2 over-assign).
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
  scriptedRouting = null;
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
    // and, via the durable create_plan_key marker, resolves every create to a skip — no dupes.
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
/* BLOCKER — create-duplication across a fresh run when the write-back is lost  */
/* ────────────────────────────────────────────────────────────────────────── */

const ROUTING_PROMPT_VERSION = 5;

/** Seed the post-create state with the plan write-back LOST: the topic is committed (with its
 *  durable marker, as the fixed create does), but the frozen plan's target is still an
 *  unresolved create (topicId=null, no resolvedTopicId) — the state a swallowed write-back or
 *  a worker death between the committed create and the write-back leaves behind. */
async function seedLostWriteBack(): Promise<void> {
  const CREATED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  db.tables.documents = [{ id: DOCUMENT, user_id: USER, extraction: extractionOf(1) }];
  const hash = await extractionHash(extractionOf(1));

  db.rows("topics").push({
    id: CREATED,
    user_id: USER,
    course_id: COURSE,
    title: "Concept 1",
    slug: "concept-1",
    summary: "Concept 1 merged from deck.pdf",
    page: EMPTY_PAGE,
    revision: 1,
    create_plan_key: `${DOCUMENT}:new:seg-1`,
  });
  db.rows("topic_sources").push({
    user_id: USER,
    topic_id: CREATED,
    document_id: DOCUMENT,
    locators: [{ page: 1 }],
    merged_at_revision: 1,
  });
  db.rows("topic_revisions").push({
    user_id: USER,
    topic_id: CREATED,
    revision: 0,
    source: "merge",
    needs_review: false,
    document_id: DOCUMENT,
  });
  db.rows("document_merge_plans").push({
    user_id: USER,
    document_id: DOCUMENT,
    extraction_hash: hash,
    prompt_version: ROUTING_PROMPT_VERSION,
    plan: {
      version: 1,
      // The write-back never landed: still a create, no resolvedTopicId.
      targets: [
        { topicKey: "new:seg-1", topicId: null, title: "Concept 1", segmentKeys: ["seg-1"] },
      ],
      unaccountedPages: [],
      coverageChecked: true,
      backstopFindings: [],
      segments: 1,
      segmentsMerged: 1,
      topicsTouched: 1,
      coercions: 0,
      singletonFolds: 0,
    },
  });
}

describe("§3 BLOCKER: a fresh run must not re-create a topic when the write-back was lost", () => {
  /**
   * The guard-that-cannot-fire the review found: cross-run create idempotency depended ENTIRELY
   * on the best-effort `resolvedTopicId` write-back. Lose it, and a fresh Inngest run (no step
   * memoization) loads the frozen plan with an unresolved create, `planMergeWork` pushes any
   * null-topicId target to `toMerge`, and `create_topic_with_first_revision` runs again —
   * `slugFor` uniquifies the slug and the (topic_id, document_id) trigger sees a new topic_id,
   * so nothing objects. Because the plan is loaded (zero routing) the duplicate guard never
   * runs. Two topic pages, same content.
   *
   * RED against the code as it stands: with only the write-back, the fresh run CREATES A
   * SECOND topic. GREEN: the durable `create_plan_key` marker (written atomically with the
   * create) is looked up and the create resolves to a skip.
   */
  it("resolves the create to a skip (exactly one topic), never a duplicate", async () => {
    await seedLostWriteBack();

    // Fresh run: new FakeStep, empty memo — the "Retry the rest" button.
    const summary = await runRouteAndMergeSteps({
      admin: fakeAdmin(),
      ...INPUT,
      step: new FakeStep(),
    });

    // Loaded the frozen plan, so no re-route could collapse the duplicate.
    expect(countOf("topic-routing")).toBe(0);
    // The property: EXACTLY ONE topic. The pre-fix code produces two here.
    expect(db.rows("topics")).toHaveLength(1);
    expect(db.rows("topics")[0]?.id).toBe("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    // No second merge was paid for, and the run is clean.
    expect(countOf("topic-merge")).toBe(0);
    expect(summary.outcome.status).toBe("ready");
  });
});

describe("§3 the unique marker makes a losing create race a graceful skip", () => {
  /**
   * The structural belt: `unique index (user_id, course_id, create_plan_key)` refuses a second
   * topic carrying the same marker even if `findCreatedTopic` misses. This replays the TOCTOU
   * the per-course concurrency lane normally prevents — the loser's pre-check reads BEFORE the
   * winner is visible (blinded once), reaches the create RPC, and hits 23505. The catch in
   * persistTopicMerge resolves it to the winner: one topic, no throw, a clean `ready`.
   *
   * RED by mutation: remove the 23505-catch and the losing create throws, `mergeTopics` fails
   * that one topic, and the run finalizes `partial` instead of `ready`.
   */
  it("a create whose marker already exists resolves to the winner (one topic, no throw)", async () => {
    db.tables.documents = [{ id: DOCUMENT, user_id: USER, extraction: extractionOf(1) }];

    // Winner: creates the topic (with its marker) and freezes the plan.
    await runRouteAndMergeSteps({ admin: fakeAdmin(), ...INPUT, step: new FakeStep() });
    expect(db.rows("topics")).toHaveLength(1);
    const winnerId = db.rows("topics")[0]?.id;

    // Loser: its findCreatedTopic pre-check is blinded once, so it reaches the create RPC and
    // collides on the unique marker. The catch resolves it to the winner.
    llmCalls.length = 0;
    db.blindCreatePlanKeyLookups = 1;
    const loser = await runRouteAndMergeSteps({
      admin: fakeAdmin(),
      ...INPUT,
      step: new FakeStep(),
    });

    // Exactly one topic — the winner. No duplicate, no throw, and a clean (non-partial) run.
    expect(db.rows("topics")).toHaveLength(1);
    expect(db.rows("topics")[0]?.id).toBe(winnerId);
    expect(loser.outcome.status).toBe("ready");
    expect(loser.outcome.failedTopics).toEqual([]);
    // The losing create was resolved to a skip, not counted as a new topic.
    expect(loser.topicsCreated).toBe(0);
  });
});

describe("§3 fresh-run resume actually LOADS the frozen plan from the DB", () => {
  /**
   * The headline "resumes at target 5" test above passes on FakeStep in-memory memoization of
   * the resolve-merge-plan step, which is NOT the production mechanism for a genuinely new
   * Inngest run re-entering a half-built index. This one uses a FRESH FakeStep (empty memo) so
   * the ONLY way routing stays at zero and the half-built 4-of-8 index is not re-routed into a
   * funnel is the DB frozen-plan LOAD + durable-marker skip. Null out `loadFrozenPlan` and this
   * goes red (routing re-runs; the 4-topic index over-assigns).
   */
  it("resumes a persisted 4-of-8 state on a fresh run without re-routing or duplicating", async () => {
    // Pass 1: kill after 4 → 4 topics committed (with markers) + the frozen plan persisted.
    const killed = new FakeStep();
    killed.killTargetOrdinal = 5;
    await expect(
      runRouteAndMergeSteps({ admin: fakeAdmin(), ...INPUT, step: killed }),
    ).rejects.toThrow(/simulated worker kill/);
    expect(db.rows("topics")).toHaveLength(4);
    expect(db.rows("document_merge_plans")).toHaveLength(1);

    // A genuinely NEW run — fresh step, no memoized resolve-merge-plan or targets.
    llmCalls.length = 0;
    const summary = await runRouteAndMergeSteps({
      admin: fakeAdmin(),
      ...INPUT,
      step: new FakeStep(),
    });

    // Zero routing is only possible via the DB frozen-plan load (nothing is memoized here).
    expect(countOf("topic-routing")).toBe(0);
    // Targets 1–4 resolve to skip via their durable markers; 5–8 are created. No funnel, no dupes.
    expect(db.rows("topics")).toHaveLength(8);
    expect(new Set(db.rows("topics").map((row) => row.id)).size).toBe(8);
    expect(db.rows("topic_sources")).toHaveLength(8);
    expect(countOf("topic-merge")).toBe(4);
    expect(summary.outcome.status).toBe("ready");
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* MAJOR — a realistic steps-path run: assign + multi-segment + coalesce + kill */
/* ────────────────────────────────────────────────────────────────────────── */

describe("§3 steps-path handles a realistic mix, resumed on a fresh run", () => {
  const EXIST = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

  /** One existing topic + a deck that assigns into it, builds two multi-segment creates, and
   *  drops a singleton the coalesce folds into a deck-adjacent create. */
  function seedMixedDeck(): void {
    db.tables.documents = [
      {
        id: DOCUMENT,
        user_id: USER,
        extraction: extractionWithHeadings(["Alpha", "Beta", "Beta2", "Gamma", "Gamma2", "Solo"]),
      },
    ];
    db.rows("topics").push({
      id: EXIST,
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
    scriptedRouting = {
      Alpha: { assign: EXIST }, // assign into the existing topic
      Beta: { create: "Beta Topic" }, // multi-segment create (Beta + Beta2)
      Beta2: { create: "Beta Topic" },
      Gamma: { create: "Gamma Topic" }, // multi-segment create (Gamma + Gamma2)
      Gamma2: { create: "Gamma Topic" },
      Solo: { create: "Solo Topic" }, // singleton → coalesces into deck-adjacent Gamma Topic
    };
  }

  it("assigns, coalesces, survives a kill, and resumes fresh with no loss and no duplicate", async () => {
    seedMixedDeck();

    // Pass 1: kill the 3rd target (the Gamma create) after the EXIST assign and the Beta create.
    const killed = new FakeStep();
    killed.killTargetOrdinal = 3;
    await expect(
      runRouteAndMergeSteps({ admin: fakeAdmin(), ...INPUT, step: killed }),
    ).rejects.toThrow(/simulated worker kill/);

    // A genuinely fresh run resumes from the persisted state — no memoization.
    llmCalls.length = 0;
    const summary = await runRouteAndMergeSteps({
      admin: fakeAdmin(),
      ...INPUT,
      step: new FakeStep(),
    });
    expect(countOf("topic-routing")).toBe(0); // frozen plan loaded

    const titles = db.rows("topics").map((row) => row.title);
    // Three topics: the existing one (updated) + the two creates. The singleton never siloed.
    expect(db.rows("topics")).toHaveLength(3);
    expect(new Set(db.rows("topics").map((row) => row.id)).size).toBe(3); // no duplicate
    expect(titles).toContain("Existing");
    expect(titles).toContain("Beta Topic");
    expect(titles).toContain("Gamma Topic");
    expect(titles).not.toContain("Solo Topic");

    // The existing topic really was merged into (assign path), reaching revision 2.
    expect(db.rows("topics").find((row) => row.id === EXIST)?.revision).toBe(2);

    // The coalesce folded Solo (page 6) into Gamma Topic's provenance.
    const gamma = db.rows("topics").find((row) => row.title === "Gamma Topic");
    const gammaSource = db.rows("topic_sources").find((row) => row.topic_id === gamma?.id);
    const gammaPages = ((gammaSource?.locators ?? []) as { page: number }[]).map((l) => l.page);
    expect(gammaPages).toEqual([4, 5, 6]);

    // Every segment reached a topic; the document is complete.
    expect(summary.segmentsMerged).toBe(summary.segments);
    expect(summary.outcome.status).toBe("ready");
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* MAJOR — the reference and the production path cannot silently diverge       */
/* ────────────────────────────────────────────────────────────────────────── */

describe("§3 runRouteAndMerge (reference) and runRouteAndMergeSteps agree on a clean run", () => {
  /**
   * `runRouteAndMerge` is now production-dead — it survives only as the single-invocation
   * reference the rich merge-internals suite drives. This differential guard fails if the
   * steps path ever diverges from it on the shared internals (segmentation, routing, guard,
   * coalesce, merge, verify, persist), which no other test would catch.
   */
  function snapshot(): { titles: string[]; sources: number; revisions: number } {
    return {
      titles: db
        .rows("topics")
        .map((row) => String(row.title))
        .sort(),
      sources: db.rows("topic_sources").length,
      revisions: db.rows("topic_revisions").length,
    };
  }

  it("produce the same topics, provenance and history from the same document", async () => {
    // Reference path on its own db.
    db = new FakeDb();
    db.rows("documents").push({
      id: DOCUMENT,
      user_id: USER,
      extraction: extractionOf(TARGET_COUNT),
    });
    const reference = await runRouteAndMerge({ admin: fakeAdmin(), ...INPUT });
    const referenceSnapshot = snapshot();

    // Steps path on a fresh db.
    db = new FakeDb();
    db.rows("documents").push({
      id: DOCUMENT,
      user_id: USER,
      extraction: extractionOf(TARGET_COUNT),
    });
    const steps = await runRouteAndMergeSteps({
      admin: fakeAdmin(),
      ...INPUT,
      step: new FakeStep(),
    });
    const stepsSnapshot = snapshot();

    expect(stepsSnapshot).toEqual(referenceSnapshot);
    expect(steps.outcome.status).toBe(reference.outcome.status);
    expect(steps.topicsCreated).toBe(reference.topicsCreated);
    expect(steps.topicsTouched).toBe(reference.topicsTouched);
    expect(steps.segmentsMerged).toBe(reference.segmentsMerged);
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
