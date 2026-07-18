-- The calendar spine: calendar_feeds, calendar_items, calendar_occurrences,
-- course_matchers (PLAN "Deadlines & Calendar Hub" §2).
--
-- ORDERING IS THE WHOLE STORY OF THIS FILE. Every foreign key below that crosses
-- between two user-owned tables is composite (fk_column, user_id) against an
-- (id, user_id) unique key on the parent — the RLS-strategy-rule-7 pattern
-- established by 20260718140050. A composite FK cannot be declared until the
-- parent's matching unique key exists, so the tables are created in dependency
-- order and each one declares its own (id, user_id) key inline, before any child
-- references it:
--
--   semesters.(id, user_id)           -- 20260718140050
--   courses.(id, user_id)             -- 20260718140050
--   assessments.(id, user_id)         -- 20260718161329
--   calendar_feeds.(id, user_id)      -- HERE, before calendar_items.feed_id
--   calendar_items.(id, user_id)      -- HERE, before calendar_occurrences.item_id
--
-- Why composite at all, restated because it is the reason this migration is
-- shaped the way it is: RLS validates only the row being WRITTEN, never the row
-- being POINTED AT, and calendar sync runs under createAdminSupabaseClient,
-- which bypasses RLS entirely. For these four tables the database constraints
-- are not a second line of defence — on the sync path they are the only one.
--
-- Safe to apply as written: all four tables are new, and the one ALTER (courses.
-- total_sessions_source) adds a nullable column with an explicit backfill.

/* ========================================================================== */
/* 1. calendar_feeds — one row per subscribed feed                            */
/* ========================================================================== */

create table public.calendar_feeds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null default 'ics' check (provider in ('ics')),
  label text not null,
  -- { url, courseId? }, validated by the provider's Zod configSchema.
  --
  -- The URL embeds a capability token: anyone holding it can read the calendar.
  -- It is therefore treated exactly like a password — RLS-protected here, masked
  -- in the UI, and never written to last_sync_error or any log. It lives per-user
  -- in this column and NOT in an env var, so revoking one user's feed is a row
  -- update rather than a redeploy.
  config jsonb not null,
  -- { etag, lastModified, contentHash } — the three skip layers of §3.2.
  -- Opaque to the engine, which stores and returns it verbatim; only the
  -- provider interprets it.
  sync_cursor jsonb,
  last_synced_at timestamptz,
  -- PLAN §2 lists this column without a check. Added here per the data-model
  -- convention "enums as text + check constraints" — the same omission
  -- 20260718140050 closed for courses.grading_scale. See the ⚠ marker in §2.
  last_sync_status text check (last_sync_status in ('ok', 'unchanged', 'error')),
  -- Human-readable failure reason, surfaced in the UI. NEVER the feed URL:
  -- writing the token here would persist a secret into a column the client
  -- reads back. The sync engine redacts before it writes.
  last_sync_error text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Parent lookup key for calendar_items.feed_id. Strictly redundant with the
  -- primary key (id is unique, so (id, user_id) trivially is), but a foreign key
  -- must target a unique constraint covering exactly its referenced columns.
  constraint calendar_feeds_id_user_key unique (id, user_id)
);

comment on table public.calendar_feeds is
  'Subscribed calendar feeds (ICS today). config.url embeds a capability token — treat as a secret: RLS-protected, masked in the UI, never logged in full.';

comment on column public.calendar_feeds.config is
  'Provider config { url, courseId? }. Contains a capability token. Never log, never echo to a client in full, never copy into last_sync_error.';

comment on column public.calendar_feeds.sync_cursor is
  'Opaque provider cursor { etag, lastModified, contentHash } — the three §3.2 skip layers. The engine stores and returns it verbatim.';

/* ========================================================================== */
/* 2. calendar_items — one row per VEVENT master, or per manual entry         */
/* ========================================================================== */

create table public.calendar_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- null = manual quick-add. Manual items are NEVER touched by sync (§3.3), and
  -- this null is the only thing that marks them, so the composite FK below is
  -- deliberately nullable.
  feed_id uuid,
  source text not null check (source in ('ics', 'manual')),
  -- VEVENT UID; a generated uuid for manual items.
  ics_uid text not null,
  -- ICS SEQUENCE. A bump means the upstream event was edited.
  sequence int not null default 0,
  kind text not null check (kind in ('deadline', 'class', 'event')),
  -- Normalized, course-prefix-stripped title (§5.1b).
  title text not null,
  -- Verbatim SUMMARY, kept so the normalizer can be re-run after a rule fix
  -- without refetching the feed.
  raw_summary text,
  description text,
  location text,
  rrule text,
  original_tzid text,
  course_id uuid,
  assessment_id uuid,
  -- §5.1b session grammar. Null for feeds without a session grammar, and for
  -- manual items. session_to = session_from for a single session; a (Ses. N-M)
  -- range spans both.
  session_from int,
  session_to int,
  descriptor text check (descriptor in ('regular', 'extra', 'retake', 'final_exam')),
  is_exam_candidate boolean not null default false,
  -- Which oracle answered the §5.1b exam-detection chain.
  --
  -- ⚠ CORRECTED 2026-07-18 (Wave 2). PLAN §2 originally listed
  -- ('syllabus_header','syllabus_body','max_session','manual'). The first two
  -- describe WHERE IN A DOCUMENT a number was found — a document-extraction
  -- concern with no distinct producer anywhere in the code. The values below are
  -- packages/core's ExamDetectionSource, which distinguishes WHICH ORACLE
  -- ANSWERED, and that is what the UI has to label. 'manual' is retained for a
  -- user-set exam flag, which no oracle produces.
  --
  -- There is deliberately no 'pending' value: the pending outcome produces no
  -- row at all, only an expected session number, so a row carrying a detection
  -- source is by construction a resolved one.
  detection_source text check (detection_source in (
    'syllabus_total_sessions',
    'assessment_session_number',
    'feed_max_session',
    'manual'
  )),
  -- Retakes are hidden by default and NEVER deleted (§5.1b).
  hidden boolean not null default false,
  -- Manual grade-impact override; wins over every derived weight.
  weight_override numeric(5, 2),
  -- Fields sync must not clobber. Populated whenever the user edits a field the
  -- feed also supplies (§3.3). Column names, snake_case, matching this table.
  user_locked_fields text[] not null default '{}',
  -- Tombstone (§3.3): the moment this UID stopped appearing in the feed
  -- snapshot. Hidden from views at 24 h, hard-deleted after 7 days of continuous
  -- absence, and CLEARED if the UID comes back. The IE feed emits no
  -- STATUS:CANCELLED at all (379/379 CONFIRMED, verified 2026-07-18), so a
  -- cancelled lecture simply vanishes — this column is the only mechanism that
  -- can detect one, which makes it load-bearing rather than a safety net.
  missing_since timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Sync identity (§3.3), applied via upsert, which is what makes re-running a
  -- sync idempotent by construction. feed_id is nullable and NULLs are distinct
  -- in a unique constraint, so manual rows never collide here — intentional:
  -- their ics_uid is a generated uuid and needs no cross-row uniqueness.
  constraint calendar_items_feed_uid_key unique (feed_id, ics_uid),
  -- Parent lookup key for calendar_occurrences.item_id.
  constraint calendar_items_id_user_key unique (id, user_id),
  -- Tenant-scoped composite FKs (RLS strategy rule 7).
  constraint calendar_items_feed_id_fkey foreign key (feed_id, user_id)
    references public.calendar_feeds (id, user_id) on delete cascade,
  -- ON DELETE SET NULL (course_id) names the column deliberately. The bare form
  -- would try to null every referencing column INCLUDING user_id, which is NOT
  -- NULL, so deleting a course would fail outright instead of orphaning its
  -- calendar items. The column list is PostgreSQL 15+; this project runs 17.6.
  --
  -- course_id stays nullable and the FK keeps MATCH SIMPLE (the default), so an
  -- unmatched item — a synced event with no course assigned yet — skips the
  -- check entirely rather than being rejected.
  constraint calendar_items_course_id_fkey foreign key (course_id, user_id)
    references public.courses (id, user_id) on delete set null (course_id),
  constraint calendar_items_assessment_id_fkey foreign key (assessment_id, user_id)
    references public.assessments (id, user_id) on delete set null (assessment_id)
);

comment on table public.calendar_items is
  'One row per VEVENT master or manual quick-add. feed_id null = manual, and manual items are never touched by sync.';

comment on column public.calendar_items.user_locked_fields is
  'Column names the user has edited by hand. Sync overwrites every other field on a SEQUENCE bump or payload change, and never these (§3.3).';

comment on column public.calendar_items.missing_since is
  'Tombstone: when this UID stopped appearing in the feed. Hidden at 24 h, deleted after 7 days, cleared if the UID reappears.';

comment on column public.calendar_items.detection_source is
  'Which §5.1b oracle resolved the exam. Values are packages/core ExamDetectionSource plus manual — see the ⚠ CORRECTED 2026-07-18 marker in PLAN §2.';

/* ========================================================================== */
/* 3. calendar_occurrences — expanded instances inside the sync horizon       */
/* ========================================================================== */

-- This is the table every view queries. Recurrence is expanded once at sync
-- time over a rolling −30d/+180d window, so reads are indexed timestamptz range
-- scans and never RRULE math.

create table public.calendar_occurrences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  item_id uuid not null,
  -- ICS RECURRENCE-ID as a UTC ISO string, or '' for the sole instance of a
  -- non-recurring event. Not null with an empty-string default so it can take
  -- part in a unique constraint — a null here would make every sole instance
  -- distinct from every other and defeat the upsert.
  recurrence_id text not null default '',
  starts_at timestamptz not null,
  ends_at timestamptz,
  all_day boolean not null default false,
  status text not null default 'confirmed'
    check (status in ('confirmed', 'tentative', 'cancelled')),
  -- This instance was individually edited upstream (a RECURRENCE-ID override).
  overridden boolean not null default false,
  completed_at timestamptz,
  -- Row-diff bookkeeping (§3.2): the engine upserts only occurrences whose
  -- payload actually changed, so this timestamp stays meaningful.
  updated_at timestamptz not null default now(),
  constraint calendar_occurrences_item_recurrence_key unique (item_id, recurrence_id),
  constraint calendar_occurrences_item_id_fkey foreign key (item_id, user_id)
    references public.calendar_items (id, user_id) on delete cascade
);

comment on table public.calendar_occurrences is
  'Concrete instances expanded at sync time over a rolling −30d/+180d horizon. Every calendar view reads this table; none of them do recurrence math.';

/* ========================================================================== */
/* 4. course_matchers — learned course-matching rules                         */
/* ========================================================================== */

create table public.course_matchers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid not null,
  -- Substring, matched case-insensitively against the event's course hint.
  pattern text not null,
  created_at timestamptz not null default now(),
  -- Both columns are NOT NULL here, so this FK is always enforced; deleting a
  -- course takes its learned rules with it.
  constraint course_matchers_course_id_fkey foreign key (course_id, user_id)
    references public.courses (id, user_id) on delete cascade
);

comment on table public.course_matchers is
  'Learned course-matching rules, created when the user files an unmatched event. Insert/delete only — a rule is replaced, never edited, so it carries no updated_at.';

/* ========================================================================== */
/* 5. courses.total_sessions_source — provenance for the step-1 oracle        */
/* ========================================================================== */

-- Exam detection step 1 reads courses.total_sessions as "the syllabus declared
-- N sessions". Step 3 falls back to max(sessionTo) across the feed. The seven
-- seeded total_sessions values were DERIVED FROM THE FEED, so today steps 1 and
-- 3 read the same number by two routes and their agreement is a tautology —
-- circular, and invisible, because nothing recorded where the number came from.
--
-- This column is that record. A syllabus-declared 30 and a feed-derived 30 are
-- the same integer and completely different evidence, and only the first can
-- distinguish "session 30 is the last one" from "session 30 is the last one
-- published so far".
--
-- Nullable: a course with no total_sessions has no provenance to state.
alter table public.courses
  add column total_sessions_source text
  constraint courses_total_sessions_source_check
    check (total_sessions_source in ('syllabus', 'feed_derived', 'manual'));

comment on column public.courses.total_sessions_source is
  'Where total_sessions came from. syllabus = declared by a syllabus document (the real step-1 oracle); feed_derived = computed from the max session seen in the calendar feed (circular with step 3 — never treat as independent corroboration); manual = typed by the user.';

-- Backfill: every total_sessions currently on file was derived from the feed.
update public.courses
  set total_sessions_source = 'feed_derived'
  where total_sessions is not null
    and total_sessions_source is null;

/* ========================================================================== */
/* 6. Row-level security — four per-operation policies per table              */
/* ========================================================================== */

-- The init_profiles pattern: per-operation policies (never FOR ALL), scoped
-- `to authenticated`, using the subquery form `(select auth.uid())` so the
-- planner evaluates auth.uid() once per statement instead of once per row.

alter table public.calendar_feeds enable row level security;

create policy "Users can view own calendar feeds"
  on public.calendar_feeds for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own calendar feeds"
  on public.calendar_feeds for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own calendar feeds"
  on public.calendar_feeds for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own calendar feeds"
  on public.calendar_feeds for delete to authenticated
  using ((select auth.uid()) = user_id);

alter table public.calendar_items enable row level security;

create policy "Users can view own calendar items"
  on public.calendar_items for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own calendar items"
  on public.calendar_items for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own calendar items"
  on public.calendar_items for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own calendar items"
  on public.calendar_items for delete to authenticated
  using ((select auth.uid()) = user_id);

alter table public.calendar_occurrences enable row level security;

create policy "Users can view own calendar occurrences"
  on public.calendar_occurrences for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own calendar occurrences"
  on public.calendar_occurrences for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own calendar occurrences"
  on public.calendar_occurrences for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own calendar occurrences"
  on public.calendar_occurrences for delete to authenticated
  using ((select auth.uid()) = user_id);

alter table public.course_matchers enable row level security;

create policy "Users can view own course matchers"
  on public.course_matchers for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own course matchers"
  on public.course_matchers for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own course matchers"
  on public.course_matchers for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own course matchers"
  on public.course_matchers for delete to authenticated
  using ((select auth.uid()) = user_id);

/* ========================================================================== */
/* 7. updated_at triggers                                                     */
/* ========================================================================== */

-- course_matchers is deliberately absent: it is insert/delete-only (a rule is
-- replaced, never edited), so it carries no updated_at and needs no trigger.

create trigger calendar_feeds_set_updated_at
  before update on public.calendar_feeds
  for each row execute function public.set_updated_at();

create trigger calendar_items_set_updated_at
  before update on public.calendar_items
  for each row execute function public.set_updated_at();

create trigger calendar_occurrences_set_updated_at
  before update on public.calendar_occurrences
  for each row execute function public.set_updated_at();

/* ========================================================================== */
/* 8. Indexes                                                                 */
/* ========================================================================== */

-- Every foreign key gets a covering index. An unindexed FK makes each parent
-- DELETE a sequential scan of the child table to enforce the referential
-- action, and these are the tables that grow.
--
-- Two FKs need no index of their own, because a unique constraint already
-- provides one with the FK's leading column first:
--   calendar_items.feed_id       -> calendar_items_feed_uid_key (feed_id, ics_uid)
--   calendar_occurrences.item_id -> calendar_occurrences_item_recurrence_key (item_id, …)

create index calendar_feeds_user_id_idx
  on public.calendar_feeds (user_id);

-- The scheduler's question (§3.1): which of this user's feeds are active and
-- stale — last_synced_at older than 30 minutes?
create index calendar_feeds_active_synced_idx
  on public.calendar_feeds (user_id, last_synced_at)
  where active;

create index calendar_items_user_id_idx
  on public.calendar_items (user_id);

create index calendar_items_course_id_idx
  on public.calendar_items (course_id, user_id);

create index calendar_items_assessment_id_idx
  on public.calendar_items (assessment_id, user_id);

-- The tombstone sweep (§3.3) reads only the small set of currently-absent rows,
-- so a partial index keeps it off the full table and stays empty in the normal
-- case, where nothing is missing at all.
create index calendar_items_missing_since_idx
  on public.calendar_items (missing_since)
  where missing_since is not null;

-- THE read path: "what is on between these two instants, for this user".
create index calendar_occurrences_user_starts_idx
  on public.calendar_occurrences (user_id, starts_at);

create index course_matchers_user_id_idx
  on public.course_matchers (user_id);

create index course_matchers_course_id_idx
  on public.course_matchers (course_id, user_id);

comment on constraint calendar_feeds_id_user_key on public.calendar_feeds is
  'Lookup key for the tenant-scoped calendar_items.feed_id foreign key.';

comment on constraint calendar_items_id_user_key on public.calendar_items is
  'Lookup key for the tenant-scoped calendar_occurrences.item_id foreign key.';
