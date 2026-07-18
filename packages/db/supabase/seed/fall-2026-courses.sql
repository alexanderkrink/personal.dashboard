-- Fall 2026 course roster for the real owner. MANUALLY APPLIED — see ./README.md.
--
-- This is USER DATA, not schema. It must never become a migration and must never
-- be added to `sql_paths` in config.toml: it hardcodes a user_id from the linked
-- project's auth.users, so `supabase db reset` against a fresh local database
-- would fail on the auth.users foreign key. Migrations must stay runnable against
-- an empty database; this file explicitly is not.
--
-- Source: the 7 real fall-2026 courses, as resolved from the live IE ICS feed by
-- the §5.1b normalizer. The raw feed shows 9 apparent name variants; after
-- stripping the trailing `|` and `, null` fragments it is 7 real courses
-- (MARKETING MANAGEMENT alone fragments across three variants holding
-- 10 + 3 + 2 = 15 events). The counts below are the normalized figures.
--
-- Idempotent: every insert is guarded by `where not exists` on (user_id, title).
-- There is no unique constraint on that pair — courses may legitimately repeat a
-- title across semesters — so the guard is a predicate, not `on conflict`.
-- Re-running this file is a no-op. It has been run twice to prove that.

begin;

-- Fail loudly rather than silently seeding against the wrong tenant or term.
-- The composite FK courses_semester_id_fkey (semester_id, user_id) would reject a
-- mismatched pair anyway, but a named assertion says WHY instead of surfacing a
-- constraint violation.
do $$
begin
  if not exists (
    select 1 from public.semesters
    where id = 'c91b9b1f-8908-4fa2-a62c-7835affb4b19'
      and user_id = '0092dd81-4436-452f-9517-235cc8ea4cf2'
  ) then
    raise exception
      'Seed aborted: semester c91b9b1f… is not owned by user 0092dd81…. Refusing to seed a cross-tenant roster.';
  end if;
end $$;

-- absence_fail_pct = 20 on all seven: IE's attendance rule is universal (students
-- who do not attend 80% of each class lose their 1st and 2nd call). It is a
-- pass/fail GATE worth zero points, and is deliberately NOT an assessments row —
-- attendance and participation are independent. Participation is a graded
-- component and lives in assessments with kind='participation'.
--
-- color: distinct keys from the curated 8-hue palette (courses_color_palette_key).
-- 7 courses over 8 hues, so all-distinct is achievable; 'rust' stays free.
--
-- total_sessions: the declared session count per course, the primary §5.1b exam
-- oracle. grading_scale is left at its 'ie_10' default — all seven are IE courses.
insert into public.courses (user_id, semester_id, title, total_sessions, absence_fail_pct, color)
select v.user_id, v.semester_id, v.title, v.total_sessions, v.absence_fail_pct, v.color
from (
  values
    ('0092dd81-4436-452f-9517-235cc8ea4cf2'::uuid, 'c91b9b1f-8908-4fa2-a62c-7835affb4b19'::uuid, 'ALGORITHMS & DATA STRUCTURES',                              30, 20::numeric, 'indigo'),
    ('0092dd81-4436-452f-9517-235cc8ea4cf2'::uuid, 'c91b9b1f-8908-4fa2-a62c-7835affb4b19'::uuid, 'MATHEMATICS FOR DATA MANAGEMENT AND ANALYSIS',              30, 20::numeric, 'violet'),
    ('0092dd81-4436-452f-9517-235cc8ea4cf2'::uuid, 'c91b9b1f-8908-4fa2-a62c-7835affb4b19'::uuid, 'PROGRAMMING FOR DATA MANAGEMENT & ANALYSIS',                30, 20::numeric, 'cyan'),
    ('0092dd81-4436-452f-9517-235cc8ea4cf2'::uuid, 'c91b9b1f-8908-4fa2-a62c-7835affb4b19'::uuid, 'PROBABILITY & STATISTICS FOR DATA MANAGEMENT AND ANALYSIS', 35, 20::numeric, 'teal'),
    ('0092dd81-4436-452f-9517-235cc8ea4cf2'::uuid, 'c91b9b1f-8908-4fa2-a62c-7835affb4b19'::uuid, 'MARKETING MANAGEMENT',                                     20, 20::numeric, 'pink'),
    ('0092dd81-4436-452f-9517-235cc8ea4cf2'::uuid, 'c91b9b1f-8908-4fa2-a62c-7835affb4b19'::uuid, 'BUILDING POWERFUL RELATIONSHIPS',                          25, 20::numeric, 'gold'),
    ('0092dd81-4436-452f-9517-235cc8ea4cf2'::uuid, 'c91b9b1f-8908-4fa2-a62c-7835affb4b19'::uuid, 'ATTENTION MANAGEMENT FOR LEARNING',                         2, 20::numeric, 'green')
) as v (user_id, semester_id, title, total_sessions, absence_fail_pct, color)
where not exists (
  select 1 from public.courses c
  where c.user_id = v.user_id
    and c.title = v.title
    and c.semester_id = v.semester_id
);

commit;
