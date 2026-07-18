-- Make cross-tenant references structurally impossible, and constrain grading_scale.
--
-- Problem this closes: RLS validates only the row being written
-- ((select auth.uid()) = user_id). It never validates the row being POINTED AT.
-- With single-column foreign keys, user B could insert an assessment owned by B
-- that references user A's course, and Postgres accepted it (verified against
-- this project: HTTP 201). The Server Actions guard this in application code, but
-- background jobs use createAdminSupabaseClient, which bypasses both RLS and the
-- application layer — so the check has to live in the database.
--
-- Fix: widen each FK to (fk_column, user_id) against a (id, user_id) unique key on
-- the parent. The parent pair only exists when both rows share an owner, so a
-- cross-tenant reference has nothing to resolve against and is rejected outright.
--
-- Safe to apply as written: semesters, courses and assessments were all empty
-- (0 rows each, verified immediately before applying), so the new unique keys and
-- FK validations have nothing to backfill or reject.

-- 1. Parent lookup keys. These are what the widened FKs reference. Both are
--    strictly redundant with the primary key (id is already unique, so (id, user_id)
--    trivially is too) — they exist because a foreign key must target a unique
--    constraint covering exactly its referenced columns.
alter table public.semesters
  add constraint semesters_id_user_key unique (id, user_id);

alter table public.courses
  add constraint courses_id_user_key unique (id, user_id);

-- 2. courses.semester_id -> semesters, scoped to the owner.
--
--    ON DELETE SET NULL (semester_id) names the column explicitly: the default
--    form would try to null every referencing column including user_id, which is
--    NOT NULL, so deleting a semester would fail. The column list is PostgreSQL 15+;
--    this project runs 17.6.
--
--    semester_id stays nullable and the FK keeps MATCH SIMPLE (the default), so a
--    course with no semester skips the check entirely — an unassigned course is
--    still valid.
alter table public.courses
  drop constraint courses_semester_id_fkey;

alter table public.courses
  add constraint courses_semester_id_fkey
  foreign key (semester_id, user_id)
  references public.semesters (id, user_id)
  on delete set null (semester_id);

-- 3. assessments.course_id -> courses, scoped to the owner. Both columns are
--    NOT NULL here, so this FK is always enforced. Cascade deletes the assessment
--    with its course, unchanged from the foundation migration.
alter table public.assessments
  drop constraint assessments_course_id_fkey;

alter table public.assessments
  add constraint assessments_course_id_fkey
  foreign key (course_id, user_id)
  references public.courses (id, user_id)
  on delete cascade;

-- 4. grading_scale was the one text enum in the foundation tables without a check
--    constraint, against the data-model convention ("enums as text + check
--    constraints"). kind, source and color all have one. The UI ships exactly these
--    two scales: ie_10 (IE's 10-point, 5 passes) and de_1_5 (the dual degree's
--    German half, 1.0 best / 4.0 passes). Adding a value here is a one-line
--    migration, which is the point of text + check over a Postgres enum.
alter table public.courses
  add constraint courses_grading_scale_check
  check (grading_scale in ('ie_10', 'de_1_5'));

comment on constraint semesters_id_user_key on public.semesters is
  'Lookup key for the tenant-scoped courses.semester_id foreign key.';
comment on constraint courses_id_user_key on public.courses is
  'Lookup key for the tenant-scoped assessments.course_id foreign key.';
