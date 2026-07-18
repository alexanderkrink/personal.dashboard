-- Prerequisites for the Wave 2 calendar spine: the parent lookup key that
-- calendar_items will reference, plus the two columns that carry the §5.1b
-- syllabus oracle's session grammar.
--
-- Nothing here creates calendar_items itself. This migration exists so that the
-- table CAN be created: a tenant-scoped composite foreign key needs its parent
-- unique key to exist first, and adding it in the same migration as the child
-- table would bury a schema invariant inside a feature migration.
--
-- Safe to apply as written: assessments and courses were both empty (0 rows,
-- verified against this project immediately before applying), so the new unique
-- key and the two check constraints have nothing to backfill or reject.

-- 1. The parent lookup key that 20260718140050 established for semesters and
--    courses, but not for assessments — because at that point nothing referenced
--    assessments. calendar_items.assessment_id does, so assessments now needs the
--    same treatment.
--
--    Like its two siblings this is strictly redundant with the primary key (id is
--    already unique, so (id, user_id) trivially is too). It exists because a
--    foreign key must target a unique constraint covering exactly its referenced
--    columns — Postgres will not resolve (assessment_id, user_id) against a
--    single-column key on id alone.
--
--    Without this, calendar_items cannot carry a tenant-scoped assessment_id at
--    all, and would fall back to a single-column FK — which is precisely the
--    cross-tenant hole 20260718140050 was written to close.
alter table public.assessments
  add constraint assessments_id_user_key unique (id, user_id);

-- 2. courses.total_sessions — the syllabus's declared total session count.
--
--    This is step 1 of the §5.1b exam-detection chain, which is syllabus-first:
--    the syllabus declares N total sessions -> find the calendar event carrying
--    session N -> that is the exam date. It is deliberately NOT derived from the
--    feed. max(sessionTo) over calendar rows is step 3, the fallback, and it
--    conflates "session N is the last one" with "session N is the last one
--    published so far" — a distinction that only a declared count can settle.
--
--    Nullable on purpose: a course with no syllabus on file has no declared
--    count, and must fall through to the feed fallback rather than guess.
alter table public.courses
  add column total_sessions int
  constraint courses_total_sessions_positive check (total_sessions > 0);

-- 3. assessments.session_number — which session this assessment falls on.
--
--    Real syllabi label exam sessions inline ("SESSION 19 ... In class Midterm
--    Exam", "SESSION 30 ... Final Exam"), so the syllabus yields more than a bare
--    total: it says WHICH session is WHICH assessment. That is the stronger
--    signal — the system learns the mapping and needs the calendar only to supply
--    the dates.
--
--    Nullable on purpose: most graded components have no single session
--    ("Participation", "5 Experiments"), and combined headings ("SESSIONS 28 &
--    29") resolve to a range this single column cannot express. Both cases stay
--    null and keep their freeform timing in due_hint.
alter table public.assessments
  add column session_number int
  constraint assessments_session_number_positive check (session_number > 0);

comment on constraint assessments_id_user_key on public.assessments is
  'Lookup key for the tenant-scoped calendar_items.assessment_id foreign key.';

comment on column public.courses.total_sessions is
  'Total sessions declared by the syllabus. Manual transcription surface for the §5.1b syllabus oracle (step 1 of the exam-detection chain); later auto-filled by the syllabus-components job. Null means no syllabus on file — fall through to the feed fallback.';

comment on column public.assessments.session_number is
  'Session this assessment falls on, when the syllabus states it inline. Manual transcription surface for the §5.1b syllabus oracle; later auto-filled by the syllabus-components job. Null for components with no single session (participation) or a session range (SESSIONS 28 & 29).';
