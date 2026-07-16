# StudyOS — repo conventions

Personal study dashboard. Solo project, built production-grade. Read PLAN.md before
starting feature work — it defines every feature, the data model, and the roadmap.

## Architecture rules

- **Package boundaries** (enforce these when writing code):
  - `apps/web` — all Next.js/React code. May import any `@studyos/*` package.
  - `packages/core` — pure TypeScript business logic. No framework imports, no I/O,
    no `process.env`. Must stay runnable anywhere (browser, node, edge, WASM).
  - `packages/db` — Supabase clients, generated types, SQL migrations. Never reads
    `process.env`; apps inject config.
  - `packages/ai` — ALL LLM interaction lives here: providers, prompt templates,
    Zod output schemas, model tier registry. No direct `@ai-sdk/*` or model-ID usage
    outside this package (exception: UI streaming hooks like `useChat` from
    `@ai-sdk/react` live in apps/web, against endpoints backed by this package).
    Never reads `process.env`.
  - `packages/ui` — shared React components; only add here when something is needed
    beyond apps/web.
  - Packages never import from apps. `core` imports nothing from other workspace packages.
- **Internal packages are just-in-time**: they export `./src/index.ts` directly (no build
  step). New packages must be added to `transpilePackages` in `apps/web/next.config.ts`.
- **Env vars**: defined once in `apps/web/src/env.ts` (t3-env + Zod). Adding a var means
  updating: `env.ts`, `apps/web/.env.example`, the `env` list in `turbo.json`, and the CI
  placeholders in `.github/workflows/ci.yml`. Build fails on missing vars — that is
  intentional; never bypass with `SKIP_ENV_VALIDATION` outside Docker-style builds.
- **Validation**: Zod at every boundary — form input, Server Actions, route handlers,
  LLM outputs, external APIs. Internal function signatures rely on TypeScript.

## Database

- Migrations: `pnpm db:migration <name>` creates a file in
  `packages/db/supabase/migrations/`. Write SQL by hand; never edit an applied migration.
- **Every user-owned table**: `user_id uuid not null references auth.users (id) on delete cascade`,
  RLS enabled, per-operation policies using `(select auth.uid())` (subquery form, for
  per-statement caching). Follow the pattern in `20260716100000_init_profiles.sql`.
- Functions: `set search_path = ''`, fully qualified names, `security definer` only with
  a written justification comment.
- After every migration: regenerate types (`pnpm db:types` against local stack, or
  `db:types:remote` against the linked project) and commit the result.

## Supabase clients (apps/web)

- Server Components / Server Actions / Route Handlers: `createClient()` from
  `@/lib/supabase/server` — one per request, never cached across requests.
- Client Components: `createClient()` from `@/lib/supabase/client`.
- Background jobs only: `createAdminSupabaseClient` (bypasses RLS — never in request
  handlers acting for a user).
- Session refresh lives in `src/proxy.ts` (Next 16 renamed middleware to proxy).
  Don't add logic between client creation and `getClaims()` in `proxy-session.ts`.

## AI

- Model selection by tier (`fast` / `balanced` / `deep`) via `MODELS` in `packages/ai` —
  never hardcode model IDs at call sites.
- Every production prompt is a versioned `definePrompt` template; bump `version` on any
  semantic change. LLM calls that produce data (not prose) must use a Zod schema.

## Tooling

- **TypeScript**: strict, `noUncheckedIndexedAccess`, no `any` (Biome errors on it).
  Pinned to 5.9.x — TS 7 drops the JS compiler API Next.js still needs; revisit later.
- **Biome** is the only linter/formatter (no ESLint/Prettier). `pnpm lint:fix` before
  committing; pre-commit hook runs lint-staged. CSS is excluded from Biome (Tailwind v4
  at-rules unsupported).
- **shadcn/ui**: add components with `pnpm dlx shadcn@latest add <name>` from `apps/web`.
  Components use **Base UI** primitives (Nova preset) — triggers take a `render` prop,
  not Radix's `asChild`. Generated files in `src/components/ui/` may be edited, but
  prefer wrapping in `src/components/`.
- **Versions**: shared dep versions live in the `catalog:` section of
  `pnpm-workspace.yaml`; reference them with `"catalog:"` in package.json.
- **Tests**: Vitest, colocated `*.test.ts` next to source. E2E: Playwright in
  `apps/web/e2e/` (config-only smoke test for now).
- **Commits**: Conventional Commits, enforced by commitlint (`feat:`, `fix:`, `chore:`,
  `docs:`, `ci:`, `refactor:`, `test:`). Scope by package when useful: `feat(web): ...`.

## Commands

Root: `pnpm dev | build | typecheck | lint | lint:fix | test | test:e2e | db:migration | db:push | db:types`.
Verify work with `pnpm typecheck && pnpm lint && pnpm test && pnpm build` before calling
anything done.
