/**
 * The CAL-3 live parse — a LIVE, METERED model call, gated behind `QUICKADD_LIVE=1`.
 *
 * The unit suite proves the binding, the guards and the confirm gate; what it cannot prove
 * is the one thing PLAN's "run it once for real" rule exists for: that the real
 * `gemini-3.1-flash-lite`, handed the real schema through the real metered runtime,
 * resolves "friday" against an injected today and leaves a priced row in `ai_generations`.
 * (The topic schema's Grammar-400 rejection was exactly the class of failure no unit test
 * could see — `schemas/topics.ts` tells that story.)
 *
 * Run it with:
 *
 * ```
 * QUICKADD_LIVE=1 pnpm vitest run src/test/quick-add-live.test.ts
 * ```
 *
 * It costs (fractions of a cent of) real money and hits the network, so it is skipped by
 * default, like the Wave 5 routing replay it is modeled on. The metered row is attributed
 * to the disposable fixture tenant — NEVER to a real account.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAIRuntime, parseQuickAdd } from "@study/ai";
import { wallClockAt } from "@study/core";
import { createAdminSupabaseClient } from "@study/db";
import { describe, expect, it } from "vitest";
import { createGenerationLogger } from "@/lib/ai/generations";

const HERE = dirname(fileURLToPath(import.meta.url));

/** `wave3-syllabus-fixture@example.com` — the disposable fixture tenant, which owns the
 * three fixture courses the utterance's "marketing" hint resolves against. Every metered
 * row must be attributed to somebody, and it must never be a real account. */
const FIXTURE_USER_ID = "106826ab-3c5f-4e07-9539-6b49775f62c7";

const TIMEZONE = "Europe/Madrid";
const UTTERANCE = "marketing case write-up due friday at 23:59, worth 15%";

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Reads `.env.local` by hand — vitest does not load it, and `@/env` is Next-only. */
function localEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  let raw = "";
  try {
    raw = readFileSync(join(HERE, "..", "..", ".env.local"), "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const enabled = process.env.QUICKADD_LIVE === "1";

describe.skipIf(!enabled)("quick-add live parse (metered)", () => {
  it("parses a real utterance and lands a priced ai_generations row", {
    timeout: 120_000,
  }, async () => {
    const env = localEnv();
    const admin = createAdminSupabaseClient({
      url: env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      secretKey: env.SUPABASE_SECRET_KEY ?? "",
    });

    // The fixture tenant's REAL course list, so the "marketing" hint is resolved against
    // data the model could not have memorised an id for.
    const courses = await admin
      .from("courses")
      .select("id, title")
      .eq("user_id", FIXTURE_USER_ID)
      .eq("archived", false)
      .order("title", { ascending: true });
    if (courses.error) throw courses.error;
    const courseList = courses.data ?? [];
    expect(courseList.length).toBeGreaterThan(0);

    const wall = wallClockAt(Date.now(), TIMEZONE);
    const today = `${String(wall.year).padStart(4, "0")}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
    const weekday =
      WEEKDAY_NAMES[new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay()] ??
      "unknown";

    // The real metered path: this call must appear in `ai_generations` like any other,
    // billed, attributed and auditable. Same harness shape as the Wave 5 replay.
    const runtime = createAIRuntime({
      anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
      googleApiKey: env.GOOGLE_GENERATIVE_AI_API_KEY ?? "",
      maxRank: "deep",
      guard: {
        killSwitch: false,
        monthlyBudgetUsd: Number(env.AI_MONTHLY_BUDGET_USD ?? "50"),
        monthToDateSpend: async () => ({ costUsd: 0, unpricedCalls: 0 }),
      },
      log: createGenerationLogger(admin, FIXTURE_USER_ID),
    });

    const result = await parseQuickAdd({
      runtime,
      utterance: UTTERANCE,
      today,
      weekday,
      timezone: TIMEZONE,
      courses: courseList,
    });

    if (result.status !== "success") {
      throw new Error(`live parse dead-lettered: ${result.reason} ${result.message}`);
    }

    // The evidence file, following the Wave 5 replay's precedent: `.local-fixtures` is
    // gitignored, and `ai_generations` stores no response body, so this is the only
    // durable record of what the model actually proposed.
    writeFileSync(
      join(HERE, "..", "..", ".local-fixtures", "quick-add-live-parse.json"),
      JSON.stringify(
        { utterance: UTTERANCE, today, weekday, proposal: result.value, stamp: result.stamp },
        null,
        2,
      ),
    );

    // The date-critical bits: a deadline, on a Friday STRICTLY after the injected today,
    // at the stated time — not a date invented from the model's own idea of the calendar.
    const value = result.value;
    expect(value.kind).toBe("deadline");
    expect(value.time).toBe("23:59");
    expect(value.weightPercent).toBe(15);
    expect(value.date).not.toBeNull();
    const [year, month, day] = (value.date ?? "").split("-").map(Number);
    expect(new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)).getUTCDay()).toBe(5);
    expect((value.date ?? "") > today).toBe(true);
    // The course hint resolved to a PROVIDED id — the wrapper guarantees list membership.
    const marketing = courseList.find((course) => /marketing/i.test(course.title));
    expect(value.courseId).toBe(marketing?.id ?? null);

    // And the row: the M1 DoD's "every AI call appears in ai_generations with cost".
    const rows = await admin
      .from("ai_generations")
      .select(
        "user_id, prompt_id, prompt_version, provider, model, input_hash, job, outcome, input_tokens, output_tokens, cost_usd, latency_ms",
      )
      .eq("input_hash", result.stamp.inputHash)
      .eq("user_id", FIXTURE_USER_ID);
    if (rows.error) throw rows.error;

    // eslint-disable-next-line no-console
    console.log("[ai_generations]", JSON.stringify(rows.data, null, 2));

    const row = rows.data?.find((candidate) => candidate.outcome === "success");
    expect(row).toBeDefined();
    expect(row?.prompt_id).toBe("quick-add");
    expect(row?.prompt_version).toBe(1);
    expect(row?.provider).toBe("google");
    expect(row?.model).toBe("gemini-3.1-flash-lite");
    expect(row?.cost_usd ?? 0).toBeGreaterThan(0);
  });
});
