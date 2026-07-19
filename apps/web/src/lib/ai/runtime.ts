/**
 * The one place in the app that builds an `AIRuntime`.
 *
 * `packages/ai` never reads `process.env` — every knob it needs is injected here: both
 * provider keys, the `AI_MAX_TIER` clamp, the `AI_KILL_SWITCH` / `AI_MONTHLY_BUDGET_USD`
 * guard, and the `ai_generations` writer. That boundary is what makes "one place to kill
 * spend" literally true rather than aspirational.
 *
 * The factory takes a `userId` because both injected halves need one: a log row must be
 * owned by somebody, and a budget is per-user. There is deliberately no user-less variant
 * — a call nobody owns is a call the rollup cannot attribute and the guard cannot cap.
 */

import type { AIRuntime } from "@study/ai";
import { createAIRuntime } from "@study/ai";
import { createAdminSupabaseClient } from "@study/db";
import { env } from "@/env";
import { createGenerationLogger } from "./generations";
import { createCachedSpendReader } from "./spend";

/**
 * Thrown when a provider key is missing. Distinct from `AIPausedError`: paused means "not
 * now", this means "not configured".
 *
 * Both keys are `.optional()` in env.ts so local dev and CI still build without them, and
 * both are required here rather than one-at-a-time because the §2 ladder escalates
 * *cross-provider* — a runtime with only Anthropic wired would turn a recoverable schema
 * failure into a dead-letter, which is a worse failure than an honest one at startup.
 */
export class AINotConfiguredError extends Error {
  constructor(missing: readonly string[]) {
    super(
      `AI is not configured: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} unset. Both providers must be wired — the §2 failure ladder escalates across the provider boundary.`,
    );
    this.name = "AINotConfiguredError";
  }
}

export interface StudyAIRuntimeOptions {
  readonly userId: string;
  /**
   * Overrides for tests and for the verification script. Production passes nothing and
   * gets exactly what `env.ts` validated.
   */
  readonly overrides?: {
    /**
     * Can only ever turn the switch **ON**. `true` pauses AI regardless of the env var;
     * `false` (or omitted) defers to `AI_KILL_SWITCH` and cannot re-enable spend that the
     * environment has stopped.
     *
     * Asymmetric on purpose: an override that could set this to `false` would be a
     * documented, exported way to run AI with the production circuit breaker engaged, and
     * "production passes nothing" is a convention rather than a guarantee. Overrides may
     * tighten the guard; they may not loosen it.
     */
    readonly killSwitch?: boolean;
    /** Clamped to the smaller of the override and the configured budget — tighten only. */
    readonly monthlyBudgetUsd?: number;
  };
}

export function createStudyAIRuntime({ userId, overrides }: StudyAIRuntimeOptions): AIRuntime {
  const missing = [
    env.ANTHROPIC_API_KEY === undefined ? "ANTHROPIC_API_KEY" : undefined,
    env.GOOGLE_GENERATIVE_AI_API_KEY === undefined ? "GOOGLE_GENERATIVE_AI_API_KEY" : undefined,
  ].filter((name): name is string => name !== undefined);
  if (missing.length > 0) throw new AINotConfiguredError(missing);

  // Background/service client: metering and the budget read must work for jobs that have
  // no session. Every row it writes still carries `user_id`, per the RLS strategy.
  const admin = createAdminSupabaseClient({
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    secretKey: env.SUPABASE_SECRET_KEY,
  });

  return createAIRuntime({
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    googleApiKey: env.GOOGLE_GENERATIVE_AI_API_KEY ?? "",
    // AI_MAX_TIER. `deep` is the top rank, so the production value is a no-op clamp —
    // circuit breaker only, exactly as recorded in PLAN.md §6.
    maxRank: env.AI_MAX_TIER,
    guard: {
      // Tighten-only, both of them: OR for the switch, MIN for the budget. A caller can
      // make this runtime stricter than the environment, never laxer.
      killSwitch: env.AI_KILL_SWITCH || overrides?.killSwitch === true,
      monthlyBudgetUsd: Math.min(
        overrides?.monthlyBudgetUsd ?? Number.POSITIVE_INFINITY,
        env.AI_MONTHLY_BUDGET_USD,
      ),
      monthToDateSpend: createCachedSpendReader(admin, userId),
    },
    log: createGenerationLogger(admin, userId),
  });
}
