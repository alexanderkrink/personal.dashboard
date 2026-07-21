import { EXTRACTION_FIDELITIES, EXTRACTION_ROUTES } from "@study/ai";
import type { SupabaseAdminClient } from "@study/db";
import { describe, expect, it } from "vitest";
import { recomputeExamWeights } from "@/inngest/exam-weights";

/**
 * The pipeline recompute (G3). The pure blend and mapping are exhaustively covered in
 * `@study/core`; this pins the two things only the pipeline layer can get wrong: that the
 * harvested `examSignals` and `topic_sources` actually reach the blend, and — the guard — that
 * the write only ever touches `exam_weight`, never the user's `exam_weight_override`.
 */

type FakeRow = Record<string, unknown>;
interface CapturedUpdate {
  table: string;
  payload: FakeRow;
  filters: FakeRow;
}

/** A chainable, thenable stand-in for the Supabase admin client — just enough for this module. */
function fakeAdmin(
  tables: Record<string, FakeRow[]>,
  updates: CapturedUpdate[],
): SupabaseAdminClient {
  const from = (table: string) => {
    const state = { isUpdate: false, payload: {} as FakeRow, filters: {} as FakeRow };
    const q = {
      select: () => q,
      update: (payload: FakeRow) => {
        state.isUpdate = true;
        state.payload = payload;
        return q;
      },
      eq: (column: string, value: unknown) => {
        state.filters[column] = value;
        return q;
      },
      in: () => q,
      // biome-ignore lint/suspicious/noThenProperty: a thenable IS the point — this stubs the Supabase query builder, which resolves to `{ data, error }` when awaited.
      then: (resolve: (result: { data: FakeRow[] | null; error: null }) => unknown) => {
        if (state.isUpdate) {
          updates.push({ table, payload: state.payload, filters: { ...state.filters } });
          return Promise.resolve({ data: null, error: null }).then(resolve);
        }
        return Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve);
      },
    };
    return q;
  };
  return { from } as unknown as SupabaseAdminClient;
}

/** A minimal valid `documents.extraction` envelope carrying the given exam signals. */
function extraction(examSignals: { quote: string; page: number; topic: string }[]): FakeRow {
  return {
    route: EXTRACTION_ROUTES[0],
    fidelity: EXTRACTION_FIDELITIES[0],
    sourceUnits: 10,
    wordsPerSlide: null,
    extraction: {
      sessionLabel: null,
      summary: "",
      pages: [],
      headings: [],
      definitions: [],
      formulas: [],
      workedExamples: [],
      examSignals,
      skipped: [],
    },
  };
}

const TABLES = (): Record<string, FakeRow[]> => ({
  topics: [
    {
      id: "topic-regression",
      title: "Linear Regression",
      summary: "Fitting a line to data.",
      exam_weight: 0.5, // the inert default — recompute should move it
      page: {
        formulas: [{ name: "OLS", latex: "\\beta", explanation: "the coefficient", sources: [] }],
        workedExamples: [{ problem: "fit a line", solution: "…", sources: [] }],
      },
    },
    {
      id: "topic-elasticity",
      title: "Price Elasticity",
      summary: "How demand responds to price.",
      exam_weight: 0.5,
      page: {},
    },
  ],
  documents: [
    { id: "doc-1", created_at: "2026-01-01T00:00:00Z", extraction: extraction([]) },
    // Newer, and it carries the exam signal on page 5.
    {
      id: "doc-2",
      created_at: "2026-02-01T00:00:00Z",
      extraction: extraction([{ quote: "on the exam", page: 5, topic: "regression" }]),
    },
  ],
  topic_sources: [
    // Regression is fed by the newer doc's page 5 — the signal page-matches it.
    { topic_id: "topic-regression", document_id: "doc-2", locators: [{ page: 4 }, { page: 5 }] },
    { topic_id: "topic-elasticity", document_id: "doc-1", locators: [{ page: 1 }] },
  ],
});

describe("recomputeExamWeights", () => {
  it("harvests the exam signal so the signalled topic outweighs the un-signalled one", async () => {
    const updates: CapturedUpdate[] = [];
    const result = await recomputeExamWeights({
      admin: fakeAdmin(TABLES(), updates),
      userId: "user-1",
      courseId: "course-1",
    });

    expect(result.topicsConsidered).toBe(2);
    expect(result.signalsMapped).toBe(1);

    const byTopic = new Map(updates.map((u) => [u.filters.id, u.payload.exam_weight as number]));
    const regression = byTopic.get("topic-regression");
    const elasticity = byTopic.get("topic-elasticity");
    expect(regression).toBeDefined();
    expect(elasticity).toBeDefined();
    // The signal (+ the formula and worked example) lift regression well above elasticity.
    expect(regression as number).toBeGreaterThan(elasticity as number);
    // Both moved off the inert 0.5 default.
    expect(regression as number).not.toBe(0.5);
    expect(elasticity as number).not.toBe(0.5);
  });

  // The guard, two-clause: RED if a recompute ever wrote the override column. Adding
  // `exam_weight_override` to the update payload in the source flips this from pass to fail.
  it("NEVER writes exam_weight_override — only the computed column", async () => {
    const updates: CapturedUpdate[] = [];
    await recomputeExamWeights({
      admin: fakeAdmin(TABLES(), updates),
      userId: "user-1",
      courseId: "course-1",
    });

    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      expect(update.table).toBe("topics");
      expect(Object.keys(update.payload)).toEqual(["exam_weight"]);
      expect(update.payload).not.toHaveProperty("exam_weight_override");
      // Every write is tenant-scoped.
      expect(update.filters.user_id).toBe("user-1");
    }
  });

  it("no-ops cleanly on a course with no topics", async () => {
    const updates: CapturedUpdate[] = [];
    const result = await recomputeExamWeights({
      admin: fakeAdmin({ topics: [], documents: [], topic_sources: [] }, updates),
      userId: "user-1",
      courseId: "course-1",
    });
    expect(result).toEqual({ topicsConsidered: 0, topicsWritten: 0, signalsMapped: 0 });
    expect(updates).toHaveLength(0);
  });
});
