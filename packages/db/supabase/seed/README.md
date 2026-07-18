# Manually-applied seeds

Files in this directory are **user data**, not schema, and are **not run automatically**.

`config.toml` sets `[db.seed] sql_paths = ["./seed.sql"]` — an explicit list, not a glob.
Nothing here is picked up by `supabase db reset`. **Do not add this directory to
`sql_paths`.** These files hardcode `user_id` values from the linked project's
`auth.users`; against a fresh local database they would fail on the `auth.users`
foreign key and break `db reset` for everyone.

The rule this encodes: **migrations must be runnable against an empty database.**
Anything keyed to a real account belongs here instead.

## Applying

Run against the linked project — via the Supabase SQL editor, `psql`, or the Supabase
MCP `execute_sql` tool. There is no pnpm script on purpose; applying user data to a
live database should be a deliberate act, not a one-keystroke one.

Every file here is **idempotent**. Re-running is a no-op, so a partial application can
always be safely retried.

## Files

| File | Contents |
| --- | --- |
| `fall-2026-courses.sql` | The 7 real fall-2026 courses for the primary account, under semester `2026/27 Fall`. Guarded by an ownership assertion that aborts if the semester is not owned by the seeded user. |
