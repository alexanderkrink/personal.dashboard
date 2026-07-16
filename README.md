# StudyOS

A personal study dashboard that consolidates an entire academic life: deadlines, lecture
notes, exam prep, and coding practice. Built solo-first, architected multi-user from day one.

See [PLAN.md](./PLAN.md) for the full product and technical plan.

## Stack

| Layer | Choice |
| --- | --- |
| Monorepo | Turborepo + pnpm workspaces (with version catalog) |
| Web app | Next.js 16 (App Router, RSC, Server Actions, Turbopack), React 19 |
| Styling | Tailwind CSS v4, shadcn/ui (Base UI primitives, Nova preset), dark mode via next-themes |
| Database & Auth | Supabase (Postgres, Auth, Storage) with RLS on every table |
| AI | Vercel AI SDK + Anthropic provider (`packages/ai`) |
| Validation | Zod everywhere data crosses a boundary; t3-env for env vars |
| Quality | TypeScript strict, Biome (lint + format), Vitest, Playwright, Husky + lint-staged, commitlint |
| Hosting | Vercel |

## Repository layout

```
apps/
  web/                  Next.js app (the dashboard)
packages/
  core/                 Framework-free business logic (pure TS)
  db/                   Supabase clients, generated DB types, SQL migrations
  ai/                   All LLM interaction: providers, prompts, output schemas
  ui/                   Shared UI components (populated when reuse demands it)
  typescript-config/    Shared tsconfig bases
```

Internal packages are consumed as TypeScript source (just-in-time compilation via
`transpilePackages`) — no build step, no dist folders.

## Getting started

Prerequisites: Node 24+ (`.nvmrc`), pnpm 11 (`npm i -g pnpm`), [Supabase CLI](https://supabase.com/docs/guides/cli)
for database work.

1. **Install dependencies**

   ```sh
   pnpm install
   ```

2. **Create a Supabase project** at [supabase.com/dashboard](https://supabase.com/dashboard),
   then copy the env template and fill in values from *Project Settings → API Keys*:

   ```sh
   cp apps/web/.env.example apps/web/.env.local
   ```

   The build fails on missing/malformed env vars by design (t3-env + Zod).

3. **Apply database migrations**

   ```sh
   cd packages/db
   supabase link --project-ref YOUR_PROJECT_REF
   pnpm db:push
   ```

   For local development against a local Supabase stack: `pnpm db:start && pnpm db:reset`.

4. **Run the app**

   ```sh
   pnpm dev
   ```

   Sign in with a magic link (Supabase Auth email OTP).

## Commands

All commands run from the repo root.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Start the web app (Turbopack) |
| `pnpm build` | Build everything (Turborepo-cached) |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm lint` / `pnpm lint:fix` | Biome check (read-only / with fixes) |
| `pnpm test` | Vitest unit tests in every package |
| `pnpm test:e2e` | Playwright E2E tests (`pnpm exec playwright install` once first) |
| `pnpm db:migration <name>` | Create a new SQL migration |
| `pnpm db:push` | Push migrations to the linked Supabase project |
| `pnpm db:types` | Regenerate `packages/db/src/types/database.ts` from the local stack |

## Auth notes

Magic-link auth is wired for the default Supabase email template via the PKCE flow
(`/auth/callback`). For the (recommended) token-hash flow, edit the *Magic Link* email
template in the Supabase dashboard to link to
`{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email` — the `/auth/confirm`
route already handles it. Session refresh happens in `apps/web/src/proxy.ts`
(Next 16's middleware).

## Deployment (Vercel)

Create a Vercel project pointing at this repo with:

- **Root Directory**: `apps/web` (enable "Include files outside the root directory")
- **Framework**: Next.js (auto-detected; `apps/web/vercel.json` sets `turbo-ignore` so
  unaffected pushes skip builds)
- **Environment variables**: everything in `apps/web/.env.example`

CI (GitHub Actions) runs typecheck, lint, test, and build on every PR and push to `main`.
