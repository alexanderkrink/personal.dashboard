import { AppShell } from "@/components/shell/app-shell";
import { createClient } from "@/lib/supabase/server";

/**
 * The signed-in application shell. `/login` deliberately sits OUTSIDE this
 * route group — the auth surface carries no sidebar, no top bar and no palette.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const email = typeof data?.claims.email === "string" ? data.claims.email : null;

  return <AppShell email={email}>{children}</AppShell>;
}
