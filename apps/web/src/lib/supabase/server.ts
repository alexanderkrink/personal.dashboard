import { createServerSupabaseClient } from "@study/db";
import { cookies } from "next/headers";
import { env } from "@/env";

/**
 * Supabase client for Server Components, Server Actions, and Route Handlers.
 * Create a fresh client per request — never share across requests.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerSupabaseClient(
    {
      url: env.NEXT_PUBLIC_SUPABASE_URL,
      publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    },
    {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // Safe to ignore: the proxy (middleware) refreshes sessions.
        }
      },
    },
  );
}
