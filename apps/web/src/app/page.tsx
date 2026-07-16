import { signOut } from "@/app/auth/actions";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";

export default async function HomePage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const email = typeof data?.claims.email === "string" ? data.claims.email : null;

  return (
    <main className="mx-auto flex min-h-svh max-w-4xl flex-col gap-8 p-8">
      <header className="flex items-center justify-between">
        <h1 className="font-medium font-mono text-lg tracking-tight">
          study<span className="text-primary">.</span>dashboard
        </h1>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <form action={signOut}>
            <Button type="submit" variant="ghost">
              Sign out
            </Button>
          </form>
        </div>
      </header>
      <section className="rounded-lg border p-6">
        <p className="text-muted-foreground text-sm">
          Signed in as <span className="font-medium text-foreground">{email ?? "unknown"}</span>.
        </p>
        <p className="mt-2 text-muted-foreground text-sm">
          The scaffold is ready. Features arrive milestone by milestone — see PLAN.md.
        </p>
      </section>
    </main>
  );
}
