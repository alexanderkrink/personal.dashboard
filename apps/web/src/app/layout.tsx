import type { Metadata, Viewport } from "next";
import { Geist, JetBrains_Mono, Newsreader } from "next/font/google";
// Self-hosts KaTeX's stylesheet + woff2 through the bundler (no CDN request → CSP-clean).
// Global on purpose: the topic page and item 7's exam-review page both typeset math through
// the shared reading renderer, and math is unstyled without this.
import "katex/dist/katex.min.css";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

// Three families on clean contrast axes (PLAN.md "Typography"):
// Geist Sans = cockpit UI, Newsreader = reading register, JetBrains Mono = all data.
const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

// Reading register only (topic prose, exam synthesis, lesson text).
const newsreader = Newsreader({
  variable: "--font-serif",
  subsets: ["latin"],
});

// The signature data face. Tabular figures + slashed zero are applied in
// globals.css — the next/font loader cannot set OpenType features.
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Alex's Study Dashboard",
    template: "%s · Study Dashboard",
  },
  description: "Your entire academic life in one dashboard.",
  // iOS home-screen install (PLAN item 9, shared with the Today Queue). The
  // manifest covers Android; Safari reads these meta tags instead. Scope is
  // deliberately the install affordance alone — no service worker, no offline
  // beyond the participation logger's localStorage queue, no push. Later scope.
  appleWebApp: {
    capable: true,
    title: "Study",
    // "default" keeps the system status bar opaque. black-translucent draws
    // content underneath it and needs safe-area QA on a physical phone first.
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  // The MEASURED dark canvas — must agree with manifest.ts, which documents
  // why this is #04080b and not the ~#0b0e14 the token comment claims.
  themeColor: "#04080b",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${newsreader.variable} ${jetbrainsMono.variable}`}
    >
      <body className="font-sans antialiased">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
