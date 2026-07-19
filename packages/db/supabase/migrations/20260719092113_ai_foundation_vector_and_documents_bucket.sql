-- Ground work for the AI stack: pgvector, and the private bucket documents land in.
--
-- Deliberately NO tables. `documents` and `document_processing_events` are item 5
-- (Wave 4) and are not created here — this migration creates only the two pieces
-- of platform infrastructure that a table migration cannot create for itself,
-- because both live outside the `public` schema.
--
-- Realtime publications are likewise out of scope. There is nothing to publish
-- until the tables exist, and a publication naming a missing table does not apply.

-- 1. pgvector.
--
--    Installed into `extensions`, not `public`, matching pgcrypto and uuid-ossp on
--    this project (verified 2026-07-19: both already sit there) and avoiding
--    Supabase's `extension_in_public` advisory.
--
--    The consequence for later migrations is that the type is `extensions.vector`,
--    not a bare `vector`. Embedding columns must spell it out, exactly as every
--    function in this repo spells out its `public.` prefixes under
--    `set search_path = ''`. That is the intended cost of not polluting `public`.
create extension if not exists vector with schema extensions;

-- 2. The `documents` bucket. PRIVATE — `public = false` is the whole point.
--
--    A syllabus is a graded-course document with the user's name on it; a public
--    bucket would make every uploaded file readable by anyone holding the URL,
--    with no auth check at all. Access goes through signed URLs issued after the
--    policies below have answered.
--
--    Path convention, enforced by the policies rather than merely documented:
--      {user_id}/{course_id}/{document_id}/{filename}
--
--    `file_size_limit` is left null so the bucket inherits the project-wide cap,
--    which `packages/db/supabase/config.toml` already sets to 50MiB. Restating it
--    here would create a second source of truth that could silently drift from the
--    first.
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

-- 3. Storage RLS, four per-operation policies, exactly as for a user-owned table.
--
--    The predicate is on the FIRST PATH SEGMENT, which is why the path convention
--    leads with `{user_id}`: `storage.objects` has no `user_id` column, so the only
--    thing available to key ownership on is the object's name. Putting the owner
--    first in the path turns the naming convention into an enforced invariant — a
--    file written under someone else's uid fails the with-check and never lands,
--    rather than landing and being mis-attributed.
--
--    `(select auth.uid())` in the subquery form, per repo convention: evaluated
--    once per statement rather than once per row.
--
--    `::text` because `storage.foldername()` returns `text[]` and `auth.uid()`
--    returns `uuid`; comparing them directly is an operator error, not a false.
--
--    `to authenticated` on all four: an anonymous caller has no uid, so every
--    predicate would be null anyway — naming the role makes that explicit and keeps
--    these policies off the `anon` role's plan entirely.
--
--    UPDATE takes both `using` and `with check`. `using` alone would let a user
--    rename their own object INTO another user's prefix, which is a write to a path
--    they could not have created directly.

create policy "documents: owner reads own files"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "documents: owner uploads under own prefix"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "documents: owner updates own files"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "documents: owner deletes own files"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
