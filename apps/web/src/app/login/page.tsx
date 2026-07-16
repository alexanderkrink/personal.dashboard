import { login } from "@/app/auth/actions";
import { SubmitButton } from "@/components/submit-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const STATUS_MESSAGES: Record<string, string> = {
  sent: "Check your inbox — a sign-in link is on its way.",
  "invalid-email": "That doesn't look like a valid email address.",
  "rate-limited": "A link was already sent recently — check your inbox, or try again in a minute.",
  error: "Something went wrong. Please try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const message = status ? STATUS_MESSAGES[status] : undefined;

  return (
    <main className="flex min-h-svh items-center justify-center p-8">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Alex&apos;s Study Dashboard</CardTitle>
          <CardDescription>Sign in with a magic link sent to your email.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={login} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="you@example.com"
                required
                autoComplete="email"
              />
            </div>
            <SubmitButton>Send magic link</SubmitButton>
            {message ? <p className="text-muted-foreground text-sm">{message}</p> : null}
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
