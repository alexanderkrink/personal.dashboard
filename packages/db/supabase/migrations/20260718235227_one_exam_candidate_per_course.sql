-- Make "at most one exam candidate per course" a structural fact.
--
-- Problem this closes: `calendar_items.is_exam_candidate` is a per-row boolean
-- with nothing tying it to at-most-one-per-course, while the READ path
-- (`buildExamStatuses` -> `items.find(isUserChosen)`) assumes exactly that. When
-- two rows of one course are flagged, the panel silently shows whichever row
-- Postgres returned first — a different exam date on different page loads, with
-- no error anywhere.
--
-- The pure planner (`planExamDecision`) is correct and unit-tested: a `set`
-- clears every other flagged row of the course in the same plan. But the action
-- applies that plan as N separate, non-transactional UPDATEs, which leaves two
-- holes that application code cannot close:
--
--   1. CONCURRENCY. Two `set`s on different sessions of one course, interleaved,
--      both read a one-candidate world, both plan correctly against it, and both
--      apply. Result: two rows at detection_source='manual'. Verified with a
--      throwaway concurrent test before this migration was written.
--   2. NO CONCURRENCY NEEDED. The planner deliberately leaves never-flagged,
--      never-locked rows unlocked, so that rejecting one course's exam does not
--      freeze thirty ordinary lectures against future detection. That is the
--      right call for detection — but it means that if the detector's answer
--      MOVES after a manual pick (a feed publishes a later session), the next
--      sync flags a second row of a course that already has a user-chosen one.
--
-- Hole 2 is the one that matters most here, because the sync engine runs under
-- `createAdminSupabaseClient`. That client bypasses RLS *and* never passes
-- through the Server Action layer, so neither of the two places the invariant is
-- currently expressed can see its writes. This is the same reasoning as the
-- tenant-scoped FKs in 20260718140050: an invariant that background/service-role
-- writers can violate belongs in the database, because the database is the only
-- layer all writers share.
--
-- Shape notes, each deliberate:
--
--   * (course_id, user_id), not (course_id) alone. Redundant for uniqueness —
--     course_id is a primary key, so it already implies its owner — but it
--     matches the composite tenant-scoped key used by every other index and FK
--     on this table, and it keeps the index directly usable for the user-scoped
--     course lookups the read path already issues.
--   * WHERE is_exam_candidate. A partial index, so it constrains only the rows
--     the invariant is about and stays roughly 6 entries wide instead of 374.
--     Unflagged rows are not "the absence of an exam" competing for a slot; they
--     are simply out of scope.
--   * course_id IS NULL rows are intentionally NOT constrained. Postgres treats
--     NULLs as distinct in a unique index, so unmatched items each get their own
--     slot. That is the correct semantics rather than an oversight: "one exam
--     per course" says nothing about a row with no course, and `nulls not
--     distinct` here would be an actual bug — it would collapse every unmatched
--     item in the account into a single shared slot and start rejecting
--     unrelated writes. (`setExamDate` refuses a null-course item outright, and
--     the detector only runs per course, so today this set is empty anyway:
--     verified 0 rows with is_exam_candidate and course_id is null.)
--
-- Safe to apply as written: verified immediately before applying that no
-- (course_id, user_id) pair has more than one flagged row. The 6 real exam
-- candidates are one per course across 6 courses, so the index builds clean with
-- nothing to backfill or reject.
--
-- Ordering consequence for writers: because a unique INDEX cannot be DEFERRABLE
-- (only a unique CONSTRAINT can, and a partial unique key cannot be expressed as
-- a constraint), a "move the exam to a different session" must clear the old row
-- BEFORE setting the new one. `setExamDate` sorts its patches so every clear is
-- applied ahead of every set; see the comment there.

create unique index calendar_items_one_exam_per_course
  on public.calendar_items (course_id, user_id)
  where is_exam_candidate;

comment on index public.calendar_items_one_exam_per_course is
  'At most one exam candidate per course per owner. The read path assumes it; '
  'the sync engine runs as service_role and bypasses both RLS and the Server '
  'Action that used to be the only thing enforcing it.';
