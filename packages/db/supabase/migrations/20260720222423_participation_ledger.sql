-- Participation & Attendance Ledger (PLAN "Additional #4", M1 item 9):
-- attendance_records, participation_logs, talking_points.
--
-- Class sessions are NOT a new table. They are the calendar hub's
-- calendar_occurrences rows whose parent calendar_items.kind = 'class'; this
-- migration only attaches ledger rows to them. No courses extensions either:
-- participation_weight, absence_fail_pct and participation_target have existed
-- since 20260717161053.
--
-- Every FK between user-owned tables is composite (fk_column, user_id) against
-- an (id, user_id) unique key on the parent — the RLS-strategy-rule-7 pattern
-- established by 20260718140050 and restated at length in 20260718174222. The
-- short version: RLS validates only the row being WRITTEN, never the row being
-- POINTED AT, so without the composite key a logged-in user could attach an
-- attendance record to another tenant's class session. With it, the database
-- refuses — no application code involved.
--
-- ## Referential actions are the design decision in this file
--
-- attendance_records and participation_logs are GRADED HISTORY. The Wave-3
-- tombstone correction (PLAN, 🔴 DISPROVEN 2026-07-19 marker) exists precisely
-- because a vanished past occurrence used to be hard-deleted, which from
-- September would have silently destroyed this table's contents. The corrected
-- sync rule retains past items permanently — so on a correctly-behaving system
-- no occurrence carrying graded history is ever deleted, and these two FKs use
-- ON DELETE NO ACTION: if the retain rule ever regresses, the delete fails
-- loudly instead of the history vanishing silently.
--
-- NO ACTION rather than RESTRICT, deliberately: account deletion is a diamond
-- cascade (auth.users → attendance_records.user_id directly, and auth.users →
-- calendar_feeds → calendar_items → calendar_occurrences on the other path).
-- NO ACTION is checked at end of statement, after both cascade legs have run,
-- so deleting a user still works; RESTRICT checks immediately and would abort
-- the account delete depending on cascade order.
--
-- talking_points cascade instead: they are prep notes ("typed the night
-- before"), routinely attached to FUTURE occurrences — exactly the rows the
-- 7-day tombstone legitimately deletes when a class is cancelled. A note for a
-- class that will never happen dies with it; blocking the sweep over one would
-- make a throwaway note able to wedge feed sync.

/* ========================================================================== */
/* 0. Parent lookup key: calendar_occurrences.(id, user_id)                   */
/* ========================================================================== */

-- Strictly redundant with the primary key (id is unique, so (id, user_id)
-- trivially is), but a composite FK must target a unique constraint covering
-- exactly its referenced columns. Same move as calendar_feeds_id_user_key.
alter table public.calendar_occurrences
  add constraint calendar_occurrences_id_user_key unique (id, user_id);

comment on constraint calendar_occurrences_id_user_key on public.calendar_occurrences is
  'Lookup key for the tenant-scoped ledger FKs (attendance_records, participation_logs, talking_points).';

/* ========================================================================== */
/* 1. attendance_records — one row per (user, class session)                  */
/* ========================================================================== */

create table public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  occurrence_id uuid not null,
  -- 'present' is the UI default (the toggle starts there); 'excused' exists so
  -- a justified absence can be recorded without counting toward the 80% gate —
  -- how it counts is packages/core's decision, not the schema's.
  status text not null default 'present'
    check (status in ('present', 'absent', 'excused')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- PLAN d) says unique (user_id, occurrence_id); this is that constraint with
  -- the columns in FK-covering order (occurrence_id leading), so the one index
  -- both enforces one-record-per-session and covers the FK's referential scan.
  constraint attendance_records_occurrence_user_key unique (occurrence_id, user_id),
  constraint attendance_records_occurrence_id_fkey foreign key (occurrence_id, user_id)
    references public.calendar_occurrences (id, user_id) on delete no action
);

comment on table public.attendance_records is
  'Attendance per class session (a calendar_occurrences row under a kind=''class'' item). Graded history: the occurrence FK is NO ACTION so a regression in the tombstone retain rule fails loudly instead of deleting it.';

comment on column public.attendance_records.status is
  'present | absent | excused. Attendance is a pass/fail gate worth zero points (80% required, absence_fail_pct = 20) — independent of participation, which is graded.';

/* ========================================================================== */
/* 2. participation_logs — one row per contribution (or cold call)            */
/* ========================================================================== */

create table public.participation_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  occurrence_id uuid not null,
  kind text not null
    check (kind in ('comment', 'question', 'cold_call', 'presentation')),
  -- 1–3 self-assessed quality. The two-tap UI writes 3 ("Spoke strong") or
  -- 2 ("Spoke ok"); 1 is reserved for a weak contribution. Nullable: a cold
  -- call is logged as the event it is, without forcing a self-grade.
  quality smallint check (quality between 1 and 3),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint participation_logs_occurrence_id_fkey foreign key (occurrence_id, user_id)
    references public.calendar_occurrences (id, user_id) on delete no action
);

comment on table public.participation_logs is
  'One contribution in one class session. "Silent" writes no row here — it is an attendance_records row with zero logs, which is how "recorded silence" stays distinct from "never logged". id may be client-generated: the offline queue''s retry idempotency rides on the primary key.';

comment on column public.participation_logs.quality is
  'Self-assessed 1–3 (3 = strong). Null for kinds logged without a self-grade (cold calls).';

/* ========================================================================== */
/* 3. talking_points — prepared ammunition for one session                    */
/* ========================================================================== */

-- PLAN d) also lists `case_brief_id uuid null → case_briefs`. That table does
-- not exist — the case-brief slice (item 10) was descoped to opportunistic on
-- 2026-07-18 — and a composite FK cannot point at a table that is not there.
-- The column arrives WITH case_briefs, in that feature's migration, rather
-- than as an unenforced uuid here.

create table public.talking_points (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  occurrence_id uuid not null,
  body text not null,
  used boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Cascade, unlike the two ledgers above: prep notes are routinely attached to
  -- future sessions, and a cancelled class legitimately takes its prep with it.
  constraint talking_points_occurrence_id_fkey foreign key (occurrence_id, user_id)
    references public.calendar_occurrences (id, user_id) on delete cascade
);

comment on table public.talking_points is
  'Prepared talking points for one class session, ticked off ("used") during class. Cascades with the occurrence: prep for a cancelled class is not graded history.';

/* ========================================================================== */
/* 4. Row-level security — four per-operation policies per table              */
/* ========================================================================== */

-- The init_profiles pattern: per-operation policies (never FOR ALL), scoped
-- `to authenticated`, subquery form `(select auth.uid())` for per-statement
-- caching.

alter table public.attendance_records enable row level security;

create policy "Users can view own attendance records"
  on public.attendance_records for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own attendance records"
  on public.attendance_records for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own attendance records"
  on public.attendance_records for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own attendance records"
  on public.attendance_records for delete to authenticated
  using ((select auth.uid()) = user_id);

alter table public.participation_logs enable row level security;

create policy "Users can view own participation logs"
  on public.participation_logs for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own participation logs"
  on public.participation_logs for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own participation logs"
  on public.participation_logs for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own participation logs"
  on public.participation_logs for delete to authenticated
  using ((select auth.uid()) = user_id);

alter table public.talking_points enable row level security;

create policy "Users can view own talking points"
  on public.talking_points for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own talking points"
  on public.talking_points for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own talking points"
  on public.talking_points for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own talking points"
  on public.talking_points for delete to authenticated
  using ((select auth.uid()) = user_id);

/* ========================================================================== */
/* 5. updated_at triggers                                                     */
/* ========================================================================== */

-- All three carry updated_at: attendance flips present↔absent when a plan
-- changes, a log's note gets edited after class, a talking point gets ticked.

create trigger attendance_records_set_updated_at
  before update on public.attendance_records
  for each row execute function public.set_updated_at();

create trigger participation_logs_set_updated_at
  before update on public.participation_logs
  for each row execute function public.set_updated_at();

create trigger talking_points_set_updated_at
  before update on public.talking_points
  for each row execute function public.set_updated_at();

/* ========================================================================== */
/* 6. Indexes                                                                 */
/* ========================================================================== */

-- Every FK gets a covering index with the FK's leading column first, so the
-- referential scan on an occurrence delete never walks the whole child table.
-- attendance_records already has one: attendance_records_occurrence_user_key.

create index attendance_records_user_id_idx
  on public.attendance_records (user_id);

create index participation_logs_occurrence_idx
  on public.participation_logs (occurrence_id, user_id);

-- THE per-course read path: "this user's contributions, newest first" — the
-- strip chart, the pace math and the weekly digest all slice this way before
-- joining occurrences.
create index participation_logs_user_created_idx
  on public.participation_logs (user_id, created_at);

create index talking_points_occurrence_idx
  on public.talking_points (occurrence_id, user_id);

create index talking_points_user_id_idx
  on public.talking_points (user_id);
