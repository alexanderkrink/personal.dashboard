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
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    // Shared secret for the daily calendar-sync cron (§3.1). REQUIRED, and a
    // long one: `/api/cron/calendar-sync` is the one route reachable without a
    // session or the access-code gate, so this string is the entire thing
    // standing in front of it. Vercel Cron sends it as `Authorization: Bearer`.
    // Minimum 16 characters — a short shared secret on a public endpoint is a
    // guessable one, and failing the build beats discovering that in production.
    CRON_SECRET: z.string().min(16),
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
    CRON_SECRET: process.env.CRON_SECRET,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    SEND_EMAIL_HOOK_SECRET: process.env.SEND_EMAIL_HOOK_SECRET,
    EMAIL_FROM: process.env.EMAIL_FROM,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  },
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
