import { createBrowserSupabaseClient } from "@studyos/db";
import { env } from "@/env";

/** Supabase client for Client Components. */
export function createClient() {
  return createBrowserSupabaseClient({
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}
