import type { Metadata } from "next";
import { GateForm } from "@/components/auth/gate-form";
import { Wordmark } from "@/components/shell/wordmark";

export const metadata: Metadata = {
  title: "Access",
  // Nothing here should ever be indexed, and the gate should not advertise the
  // routes it is protecting.
  robots: { index: false, follow: false },
};

/**
 * The access-code gate.
 *
 * Served at the domain root by a rewrite in `proxy.ts`, so the URL stays `/`
 * and this route is never linked to. Spare on purpose: a wordmark, one input,
 * one line of copy. It confirms nothing about what is behind it and does not
 * mention sign-in or sign-up at all.
 */
export default function GatePage() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-12 px-6 py-16">
      <Wordmark />
      {/* A rejected code used to come back as `?status=invalid`, which remounted
          this page and wiped the field. The rejection is form state now, so the
          URL stays clean and nothing is retyped. */}
      <GateForm />
      <p className="text-center text-muted-foreground text-ui-sm">By invitation.</p>
    </main>
  );
}
