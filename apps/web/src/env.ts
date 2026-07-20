import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/**
 * Type-safe environment variables. Imported by next.config.ts so the build
 * fails fast on missing or malformed values. Set SKIP_ENV_VALIDATION=1 only
 * for things like Docker builds where env is injected at runtime.
 */
export const env = createEnv({
  server: {
    SUPABASE_SECRET_KEY: z.string().min(1),
    // The single shared access code guarding the whole auth surface. Required —
    // an empty or missing code would silently open /login and /signup to the
    // internet, so the build must fail instead. Rotating = changing this value;
    // every issued gate cookie is derived from it and dies with it.
    ACCESS_CODE: z.string().min(8),
    // Provider keys for the two-provider AI core (PLAN.md §AI Strategy §1b). Both are
    // injected into `packages/ai` via `createAIRuntime` — that package never reads
    // process.env, which is what keeps it runnable in node, edge, a test or a script.
    // Optional for the same reason ANTHROPIC_API_KEY always was: an unset key costs an AI
    // feature, never safety, and local dev plus CI must still build without them.
    // OpenAI is deliberately absent — a deferred third family, §1b.
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1).optional(),
    // Voyage AI, for `pgvector` embeddings (§1 "Embeddings", Wave 4). Embeddings stay
    // single-vendor regardless of the two-provider LLM split — mixing embedding models
    // breaks vector comparability (§5), so this is a retrieval decision, not a generation
    // one. REQUIRED since Wave 6: routing and retrieval run on these vectors, so an unset
    // key is not a degraded feature — it is a pipeline that accepts documents and then
    // fails them at runtime. Fail-closed at build beats discovering that per upload.
    // CI builds with a placeholder (see ci.yml); only a real deploy needs a real key.
    VOYAGE_API_KEY: z.string().min(1),
    // CloudConvert, for the PPTX→PDF visual path (§4.2). Not an optional nicety: PLAN's
    // 🔴 measured block shows four of five Marketing decks below the 40 words/slide
    // threshold, so for that course this key is what stands between real topic pages and
    // mostly-empty ones. REQUIRED since Wave 6, for the same fail-closed reason as
    // VOYAGE_API_KEY: the step already refuses to silently downgrade to text-only (a
    // silent downgrade IS the mostly-empty-pages outcome), so a missing key only ever
    // surfaces as runtime document failures — the build is the cheaper place to fail.
    // Token scopes are `task.read` + `task.write` only — deliberately no `webhook.write`,
    // which is why the conversion is polled inside the Inngest step.
    CLOUDCONVERT_API_KEY: z.string().min(1),
    // ── The §6 kill switch and budget guard ─────────────────────────────────────
    // All three are read HERE and injected into `packages/ai` (which never reads
    // process.env). That boundary is the whole point of item 2b: one place to swap
    // models or providers, one place to version prompts, one place to kill spend.
    //
    // The runaway-cost circuit breaker. Flip it in Vercel, redeploy, and every
    // metered call fails fast before a token is spent. Enumerated rather than
    // coerced, following the INNGEST_DEV precedent: `z.coerce.boolean()` would read
    // the string "false" as TRUE, which on this particular var means "the app is
    // silently dead" — and a truthiness bug on a switch whose whole job is to be
    // trusted is not a bug you want to find in production. A typo fails the build.
    AI_KILL_SWITCH: z
      .enum(["0", "1", "true", "false"])
      .default("false")
      .transform((value) => value === "1" || value === "true"),
    // Clamps every job's resolved model rank. `deep` is the top rank, so the default
    // is "no clamp, circuit breaker only" — set it to `fast` to keep the app alive
    // cheaply (Flash-Lite / Haiku) while investigating a spend spike.
    AI_MAX_TIER: z.enum(["fast", "balanced", "deep"]).default("deep"),
    // Soft cap, checked against the ai_daily_cost rollup before each call. §4's
    // planning range is $35–60/month; §6's default cap is 75. Positive and finite:
    // a zero or negative budget makes spendPosture() halt everything, so a typo'd
    // `0` would take AI down rather than uncap it — but failing the build is still
    // the clearer outcome.
    AI_MONTHLY_BUDGET_USD: z.coerce.number().positive().finite().default(75),
    // Shared secret for the daily calendar-sync cron (§3.1). REQUIRED, and a
    // long one: `/api/cron/calendar-sync` is the one route reachable without a
    // session or the access-code gate, so this string is the entire thing
    // standing in front of it. Vercel Cron sends it as `Authorization: Bearer`.
    // Minimum 16 characters — a short shared secret on a public endpoint is a
    // guessable one, and failing the build beats discovering that in production.
    CRON_SECRET: z.string().min(16),
    // Inngest signing key (§3). REQUIRED, and for the same reason CRON_SECRET
    // is: `/api/inngest` sits in UNGATED_PATHS, so it is reachable with no
    // session and no access-code cookie, and unlike every other route in the
    // app it accepts POST and PUT. This key is the ENTIRE authentication
    // boundary on it — Inngest signs each invocation and the serve handler
    // verifies that signature. An unset key is not a degraded feature, it is an
    // open endpoint, so the build must fail rather than deploy one.
    // Minimum 32: real keys are `signkey-{prod,test}-<64 hex>` (76 chars), and
    // anything short enough to fail this is a typo or a truncated paste.
    INNGEST_SIGNING_KEY: z.string().min(32),
    // Inngest event key. OPTIONAL, deliberately — this one points OUTWARD (it
    // authenticates us to Inngest when sending events), so it follows the
    // ANTHROPIC_API_KEY pattern rather than the CRON_SECRET one: no inbound
    // request is trusted because of it, and leaving it unset costs availability,
    // not safety. Optional also keeps `inngest-cli dev` and CI buildable, since
    // the dev server issues its own local key and ignores this value entirely.
    INNGEST_EVENT_KEY: z.string().min(1).optional(),
    // Inngest dev mode. LOCAL ONLY, and validated here even though the SDK reads
    // it straight off `process.env` rather than through this file — because the
    // SDK's parse is dangerously lenient. `Inngest.mode` tries `parseAsBoolean`
    // first, and if that yields `undefined` it falls through to `explicitDevUrl`,
    // which runs the raw value through `new URL(normalizeUrl(value))`. Almost any
    // non-empty string survives that: `INNGEST_DEV=yes` becomes `http://yes`,
    // which is a valid URL, which means DEV MODE — and dev mode skips signature
    // verification entirely, turning the `/api/inngest` gate carve-out into an
    // unauthenticated, RLS-bypassing write endpoint. Confirmed by experiment
    // against a production build, not inferred.
    //
    // Constraining the value to the four strings `parseAsBoolean` actually
    // understands means a typo fails the build instead of silently opening the
    // endpoint. The runtime half of this defence is the production assertion in
    // `src/inngest/client.ts`.
    INNGEST_DEV: z.enum(["0", "1", "true", "false"]).optional(),
    // Auth emails via Resend (Supabase Send Email Hook). Optional so local dev
    // and CI build without them; the hook route 500s with a clear message if unset.
    RESEND_API_KEY: z.string().min(1).optional(),
    SEND_EMAIL_HOOK_SECRET: z.string().min(1).optional(),
    EMAIL_FROM: z.string().min(1).optional(),
  },
  client: {
    NEXT_PUBLIC_SUPABASE_URL: z.url(),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  },
  runtimeEnv: {
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    ACCESS_CODE: process.env.ACCESS_CODE,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    VOYAGE_API_KEY: process.env.VOYAGE_API_KEY,
    CLOUDCONVERT_API_KEY: process.env.CLOUDCONVERT_API_KEY,
    AI_KILL_SWITCH: process.env.AI_KILL_SWITCH,
    AI_MAX_TIER: process.env.AI_MAX_TIER,
    AI_MONTHLY_BUDGET_USD: process.env.AI_MONTHLY_BUDGET_USD,
    CRON_SECRET: process.env.CRON_SECRET,
    INNGEST_SIGNING_KEY: process.env.INNGEST_SIGNING_KEY,
    INNGEST_EVENT_KEY: process.env.INNGEST_EVENT_KEY,
    INNGEST_DEV: process.env.INNGEST_DEV,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    SEND_EMAIL_HOOK_SECRET: process.env.SEND_EMAIL_HOOK_SECRET,
    EMAIL_FROM: process.env.EMAIL_FROM,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  },
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
