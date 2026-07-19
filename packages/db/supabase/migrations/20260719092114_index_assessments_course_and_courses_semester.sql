-- Exact FK-covering indexes for assessments.course_id and courses.semester_id.
--
-- This is 20260718174739 applied to the two foundation tables it did not reach.
-- Same linter finding (`unindexed_foreign_keys`), same root cause, same fix.
--
-- ⚠ Note for the reader, because the naming is misleading: these two FKs were NOT
-- literally un-indexed. Both tables already carry a single-column index —
-- `assessments_course_idx (course_id)` and `courses_semester_idx (semester_id)`,
-- both from the foundation migration. What changed underneath them is
-- 20260718140050, which widened each FK to the tenant-scoped composite:
--
--   assessments.course_id   -> (course_id, user_id)   references courses (id, user_id)
--   courses.semester_id     -> (semester_id, user_id) references semesters (id, user_id)
--
-- A covering index has to lead with EVERY constrained column, so a one-column
-- index no longer covers a two-column key. Supabase reports both, with
-- `fkey_columns: [3, 2]` — attnums for exactly those pairs (verified against this
-- project 2026-07-19).
--
-- WHICH COLUMNS, AND WHY THIS ORDER: the referential-action query Postgres runs
-- when a parent row is deleted or its key updated is
-- `where <fk_column> = $1 and user_id = $2`, so the index must be
-- (fk_column, user_id) — fk_column FIRST. The reverse order, (user_id, fk_column),
-- is what the existing `*_user_idx` indexes already effectively are, and it is the
-- one the planner picked in the calendar case: it scanned every row the user owned
-- and applied the selective column as a filter. Leading with the selective column
-- is the entire point.
create index assessments_course_id_idx
  on public.assessments (course_id, user_id);

create index courses_semester_id_idx
  on public.courses (semester_id, user_id);

-- The old single-column indexes are now strictly redundant: a btree on
-- (course_id, user_id) serves every `where course_id = $1` lookup the (course_id)
-- index served, because course_id is its leading column. Keeping both would pay
-- two index writes per insert to answer one question, and would hand the
-- `unused_index` advisory two new entries the moment the planner stopped choosing
-- them.
--
-- Dropped rather than left in place, because a redundant index is not neutral —
-- it is a cost with no corresponding read, and the next person to look at this
-- table should not have to work out which of two overlapping indexes is load-
-- bearing.
drop index public.assessments_course_idx;

drop index public.courses_semester_idx;
