-- Syllabus extraction runs and their proposed components (M1 item 11).
--
-- ## Why these tables exist at all
--
-- PLAN.md §Grade & Semester Cockpit (d) is explicit that this feature adds **no
-- columns** to `assessments` — and it doesn't. But the same section requires the
-- mandatory confirm step to show **the source snippet**, so the human checks the
-- claim against the document instead of rubber-stamping it. A snippet has to live
-- somewhere, and `assessments` is not allowed to grow a column for it.
--
-- So the provenance goes in a sidecar and points AT the assessment, rather than
-- the assessment pointing at its provenance. That direction is what keeps
-- `assessments` untouched: a manually-typed component simply has no row here.
-- It is also the §3 stamp landing on a persisted artifact, which §3 asks for
-- generally and which nothing in this repo had done before.
--
-- ## Why the run is a separate table from the components
--
-- One extraction proposes many components, and it also proposes ONE course-level
-- number: `total_sessions`. That number cannot be written to `courses` at
-- extraction time. §5.1b's exam chain reads `courses.total_sessions` to pick an
-- exam DATE, and dates are the *other* class reserved for a mandatory human
-- confirm (§2b) — so an unconfirmed AI session count must not reach the column
-- that moves a date on the dashboard. It waits here, on the run, until confirmed.
--
-- ## What is NOT here
--
-- No document reference. Item 5 (Wave 4) owns `documents`, storage and the
-- extraction pipeline; this table records the document only as a text label
-- (`source_label`). When `documents` exists, a nullable `document_id` FK is an
-- additive migration. Guessing its shape now would be worse than leaving the gap.

/* ────────────────────────────────────────────────────────────────────────── */
/* 1. syllabus_extractions — one row per run of the syllabus-components job    */
/* ────────────────────────────────────────────────────────────────────────── */

create table public.syllabus_extractions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid not null,

  -- How the document identified itself to the person who ran this, e.g. a file
  -- name. Free text on purpose: there is no `documents` table to point at yet.
  source_label text not null,

  -- What the document called itself. Kept even when it matches the course title,
  -- because "the document says it is a different course" is the single most
  -- useful thing the confirm screen can tell someone — and PLAN.md §5.1b's
  -- DISPROVEN block exists precisely because a plausible-looking syllabus->course
  -- guess turned out to be wrong.
  extracted_course_title text not null,

  -- The proposed `courses.total_sessions`. NOT written to `courses` until this
  -- run is confirmed; see the header note. Null when the document establishes no
  -- session count.
  proposed_total_sessions int
    constraint syllabus_extractions_total_sessions_positive
    check (proposed_total_sessions is null or proposed_total_sessions > 0),
  total_sessions_evidence text,

  -- Anything the model flagged that no column holds: a pass gate, weights that
  -- do not sum to 100, a re-take scheme it excluded.
  notes text,

  -- The §3 five-column stamp. `input_hash` is the SHA-256 the runtime computed
  -- over the rendered prompt, so a row here joins to its `ai_generations`
  -- attempts without a foreign key across a log that is append-only by design.
  prompt_id text not null,
  prompt_version int not null,
  provider text not null,
  model text not null,
  input_hash text not null,

  -- Null while the proposal is pending. Set when the human confirms; that same
  -- action flips the assessments rows to confirmed = true and, if a session
  -- count was proposed, writes it to courses with source = 'syllabus'.
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Tenant-scoped FK target for syllabus_extraction_components.extraction_id.
  constraint syllabus_extractions_id_user_key unique (id, user_id),

  -- Composite FK per the repo convention: a course_id alone would let a crafted
  -- write attach an extraction to another account's course.
  constraint syllabus_extractions_course_id_fkey
    foreign key (course_id, user_id)
    references public.courses (id, user_id)
    on delete cascade,

  -- Evidence without a claim, or a claim without evidence, are both incoherent.
  constraint syllabus_extractions_evidence_matches_count
    check ((proposed_total_sessions is null) = (total_sessions_evidence is null))
);

comment on table public.syllabus_extractions is
  'One run of the syllabus-components job: the §3 stamp, the proposed courses.total_sessions (held here until confirmed, never written straight to courses), and what the document called itself.';
comment on column public.syllabus_extractions.proposed_total_sessions is
  'Proposed courses.total_sessions. Deliberately NOT written to courses before confirmation: §5.1b reads that column to pick an exam date, and dates are a reserved human-confirm class (§2b).';
comment on column public.syllabus_extractions.extracted_course_title is
  'The course title as printed in the document. Compared against courses.title so a mismatch is surfaced rather than silently accepted — see the DISPROVEN block in PLAN.md §5.1b.';
comment on column public.syllabus_extractions.input_hash is
  'SHA-256 over the rendered prompt, as computed by the AI runtime. Joins this row to its ai_generations attempts without an FK into an append-only log.';

create index syllabus_extractions_user_idx
  on public.syllabus_extractions (user_id);

-- Covers the composite FK, and answers the page query directly: "the pending
-- extractions for this course, newest first".
create index syllabus_extractions_course_pending_idx
  on public.syllabus_extractions (course_id, user_id, created_at desc);

alter table public.syllabus_extractions enable row level security;

create policy "Users can view own syllabus extractions"
  on public.syllabus_extractions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own syllabus extractions"
  on public.syllabus_extractions
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own syllabus extractions"
  on public.syllabus_extractions
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own syllabus extractions"
  on public.syllabus_extractions
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create trigger syllabus_extractions_set_updated_at
  before update on public.syllabus_extractions
  for each row
  execute function public.set_updated_at();

/* ────────────────────────────────────────────────────────────────────────── */
/* 2. syllabus_extraction_components — the per-assessment provenance sidecar   */
/* ────────────────────────────────────────────────────────────────────────── */

create table public.syllabus_extraction_components (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  extraction_id uuid not null,

  -- The assessments row this proposal created. NOT NULL: rows are born the
  -- moment the extraction lands (unconfirmed), so a component with no assessment
  -- would be a proposal that proposed nothing.
  --
  -- `on delete cascade` is the important half. Rejecting a proposal deletes the
  -- assessments row; the snippet describes a claim that no longer exists, so it
  -- goes with it rather than lingering as orphaned provenance.
  assessment_id uuid not null,

  -- The verbatim quote the human confirms against. This column IS the confirm
  -- gate — without it the review step degrades to rubber-stamping, which
  -- PLAN.md §Grade Cockpit (c) calls out as the thing to avoid.
  source_snippet text not null
    constraint syllabus_extraction_components_snippet_present
    check (length(btrim(source_snippet)) > 0),

  -- Session timing that assessments.session_number cannot hold: a range
  -- ('sessions 28/29' — real, from the LOES syllabus), or a vague placement.
  session_note text,

  created_at timestamptz not null default now(),

  constraint syllabus_extraction_components_extraction_id_fkey
    foreign key (extraction_id, user_id)
    references public.syllabus_extractions (id, user_id)
    on delete cascade,

  constraint syllabus_extraction_components_assessment_id_fkey
    foreign key (assessment_id, user_id)
    references public.assessments (id, user_id)
    on delete cascade,

  -- One provenance row per assessment. Structural, not conventional: the confirm
  -- screen renders "the snippet" for a component, and two snippets for one
  -- assessment would make that phrase meaningless — it would pick one at random.
  -- Application code cannot hold this line, because the writer is a service-role
  -- client that bypasses both RLS and Server Actions.
  constraint syllabus_extraction_components_assessment_key unique (assessment_id)
);

comment on table public.syllabus_extraction_components is
  'Provenance sidecar for assessments rows proposed by the syllabus-components job. Points AT the assessment rather than the reverse, which is what lets this feature add the source snippet the confirm gate needs while adding no columns to assessments (PLAN.md §Grade Cockpit (d)).';
comment on column public.syllabus_extraction_components.source_snippet is
  'Verbatim quote from the syllabus establishing this component and its weight. Shown beside the extracted values at the confirm step so the human checks the claim against the document.';
comment on column public.syllabus_extraction_components.session_note is
  'Session timing assessments.session_number cannot hold — notably a RANGE ("sessions 28/29"), which must not be collapsed to a single endpoint.';

create index syllabus_extraction_components_user_idx
  on public.syllabus_extraction_components (user_id);

-- Covers the composite FK and the "render this run" query in one.
create index syllabus_extraction_components_extraction_idx
  on public.syllabus_extraction_components (extraction_id, user_id);

alter table public.syllabus_extraction_components enable row level security;

create policy "Users can view own syllabus extraction components"
  on public.syllabus_extraction_components
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own syllabus extraction components"
  on public.syllabus_extraction_components
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own syllabus extraction components"
  on public.syllabus_extraction_components
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own syllabus extraction components"
  on public.syllabus_extraction_components
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);
