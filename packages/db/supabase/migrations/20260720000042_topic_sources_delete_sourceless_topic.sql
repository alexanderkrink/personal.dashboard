-- A topic that has lost its last source is deleted with it.
--
-- ## Why this is a trigger and not four lines in the Server Action
--
-- Deleting a document cascades its `topic_sources` rows away (`topic_sources_document_id_fkey`
-- is `on delete cascade`). What does NOT follow is the topic those rows were the only
-- provenance for: `topics` has no FK to `documents`, so a topic built entirely by one
-- document survives that document as a page of text with nothing behind it — no sources, no
-- chunks (the document's chunks cascade too), and no way for the user to tell where it came
-- from. Re-uploading the same file then merges into that stale topic instead of creating a
-- fresh one, which is exactly the "a re-upload must behave like a first upload" property the
-- delete exists to provide.
--
-- The rule is structural, so it belongs here rather than in `deleteDocument`. The writers on
-- this table are not only Server Actions: the Inngest pipeline holds the service key, where
-- RLS and every application-level guard are out of the path. A `topic_sources` row deleted by
-- a background job, by a future strip, or by hand in the SQL editor must leave the same
-- invariant standing — "every topic has at least one source" — and only the database sees all
-- three writers.
--
-- ## Ordering, and the two triggers that already exist
--
-- `after delete` rather than `before`: the row must be gone before the `not exists` below can
-- be true, otherwise the topic's last source still counts itself and no topic is ever removed.
--
-- Deleting the topic then fires `topics_delete_synthesized_chunks` (`before delete on topics`),
-- which removes that topic's `source = 'topic_page'` chunks. Those chunks carry
-- `document_id is null` — verified on production data, 8 of them across 2 topics — so they are
-- reachable by NO cascade from `documents` and this is the only thing that collects them. The
-- document's own `source = 'document'` chunks are handled independently by
-- `document_chunks_document_id_fkey` on delete cascade.
--
-- Re-entrancy is safe. Deleting a topic directly cascades to its `topic_sources` rows, which
-- fires this trigger, which attempts to delete the same topic a second time. Postgres skips a
-- tuple already deleted by the same command, so the recursion terminates at depth one and the
-- statement is a no-op. The `not exists` guard makes that explicit rather than incidental.
--
-- Tenant scoping: the delete is keyed on `(id, user_id)` from the departing row, so it can
-- only ever reach the topic that row belonged to. `security definer` is deliberately NOT used
-- — see the note on the function.

create or replace function public.delete_sourceless_topic()
returns trigger
language plpgsql
-- NOT `security definer`. This runs with the privileges of whoever deleted the
-- `topic_sources` row, so the RLS policies on `topics` still apply to the cascade: an
-- authenticated user can only ever trigger the removal of their own topic, and the check does
-- not have to be restated here. A definer function would bypass `topics`' own policies and
-- turn this convenience into a way to delete across tenants.
set search_path = ''
as $$
begin
  -- `old.user_id` is carried into the predicate rather than trusted from the topic row, so
  -- the statement is tenant-scoped even if a topic id were ever reused across tenants.
  delete from public.topics t
   where t.id = old.topic_id
     and t.user_id = old.user_id
     and not exists (
       select 1
         from public.topic_sources ts
        where ts.topic_id = old.topic_id
          and ts.user_id = old.user_id
     );

  return old;
end;
$$;

comment on function public.delete_sourceless_topic() is
  'Removes a topic once its last topic_sources row is deleted. Keeps "every topic has at least one source" true for service-role writers as well as for Server Actions.';

drop trigger if exists topic_sources_delete_sourceless_topic on public.topic_sources;

create trigger topic_sources_delete_sourceless_topic
  after delete on public.topic_sources
  for each row
  execute function public.delete_sourceless_topic();
