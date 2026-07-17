-- M1 foundation tables: semesters, courses, assessments.
-- Conventions per 20260716100000_init_profiles.sql: RLS on every table with
-- per-operation policies using the (select auth.uid()) subquery form,
-- updated_at maintained by the shared set_updated_at() trigger.

-- Academic terms; courses hang off them ("2026/27 Fall").
create table public.semesters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  starts_on date not null,
  ends_on date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint semesters_dates_ordered check (ends_on >= starts_on)
);

create index semesters_user_idx on public.semesters (user_id);

comment on table public.semesters is
  'Academic terms (e.g. "2026/27 Fall"); courses reference them.';

alter table public.semesters enable row level security;

create policy "Users can view own semesters"
  on public.semesters
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own semesters"
  on public.semesters
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own semesters"
  on public.semesters
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own semesters"
  on public.semesters
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create trigger semesters_set_updated_at
  before update on public.semesters
  for each row
  execute function public.set_updated_at();

-- Courses: the hub almost every feature table references.
create table public.courses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  semester_id uuid references public.semesters (id) on delete set null,
  code text,
  title text not null,
  color text not null default '#6366f1',
  credits numeric,
  target_grade numeric,
  grading_scale text not null default 'ie_10',
  exam_format_profile jsonb,
  participation_weight numeric,
  absence_fail_pct numeric,
  participation_target numeric,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index courses_user_idx on public.courses (user_id);
create index courses_semester_idx on public.courses (semester_id);

comment on table public.courses is
  'One row per course taken; referenced by documents, topics, calendar, cards, exams.';
comment on column public.courses.exam_format_profile is
  'Exam blueprint hints, e.g. {"mcq": 30, "numeric": 3, "open": 1, "duration_min": 90}.';

alter table public.courses enable row level security;

create policy "Users can view own courses"
  on public.courses
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own courses"
  on public.courses
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own courses"
  on public.courses
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own courses"
  on public.courses
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create trigger courses_set_updated_at
  before update on public.courses
  for each row
  execute function public.set_updated_at();

-- Graded components of a course (syllabus-derived or manual).
create table public.assessments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid not null references public.courses (id) on delete cascade,
  title text not null,
  kind text not null check (kind in ('exam', 'quiz', 'project', 'participation', 'paper', 'other')),
  weight_percent numeric(5,2) not null,
  due_hint text,
  confirmed boolean not null default true,
  source text not null default 'manual' check (source in ('manual', 'syllabus_extract')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint assessments_weight_range check (weight_percent >= 0 and weight_percent <= 100)
);

create index assessments_user_idx on public.assessments (user_id);
create index assessments_course_idx on public.assessments (course_id);

comment on table public.assessments is
  'Graded components of a course ("Midterm", "Group project"); confirmed=false marks unreviewed LLM extractions.';
comment on column public.assessments.due_hint is
  'Freeform timing from the syllabus ("week 9"); real dates live in calendar_items/exams.';

alter table public.assessments enable row level security;

create policy "Users can view own assessments"
  on public.assessments
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own assessments"
  on public.assessments
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own assessments"
  on public.assessments
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own assessments"
  on public.assessments
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create trigger assessments_set_updated_at
  before update on public.assessments
  for each row
  execute function public.set_updated_at();
