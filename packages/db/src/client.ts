import {
  type CookieMethodsBrowser,
  type CookieMethodsServer,
  createBrowserClient,
  createServerClient,
} from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseAdminConfig, SupabaseConfig } from "./config";
import type { Database } from "./types/database";

/** Browser client for client components. Singleton-managed by @supabase/ssr. */
export function createBrowserSupabaseClient(
  config: SupabaseConfig,
  cookies?: CookieMethodsBrowser,
) {
  return createBrowserClient<Database>(config.url, config.publishableKey, {
    cookies,
  });
}

/**
 * Server client for RSC, Server Actions, Route Handlers, and middleware.
 * The caller supplies a cookie adapter bound to the current request
 * (see apps/web/src/lib/supabase/server.ts).
 */
export function createServerSupabaseClient(config: SupabaseConfig, cookies: CookieMethodsServer) {
  return createServerClient<Database>(config.url, config.publishableKey, {
    cookies,
  });
}

/**
 * Admin client for trusted server-side jobs (background processing, cron).
 * Bypasses RLS — never expose to request handlers acting on behalf of a user.
 */
export function createAdminSupabaseClient(config: SupabaseAdminConfig) {
  return createClient<Database>(config.url, config.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type SupabaseServerClient = ReturnType<typeof createServerSupabaseClient>;
export type SupabaseBrowserClient = ReturnType<typeof createBrowserSupabaseClient>;
export type SupabaseAdminClient = ReturnType<typeof createAdminSupabaseClient>;
