-- Close the retag route into an active grade weight (M1 item 11, review gate 6).
--
-- `20260719121909_apply_syllabus_extraction.sql` made "never born active"
-- structural with a BEFORE INSERT trigger, and its own comment records the
-- reasoning: "Confirming is an UPDATE and stays untouched, which is the whole
-- point: the row can be promoted, it just cannot start promoted."
--
-- That is true of the row's BIRTH and false of its LABEL. `source` is mutable,
-- so the insert-time check is trivially sidestepped in two statements:
--
--   insert into assessments (..., source) values (..., 'manual');  -- confirmed defaults TRUE
--   update assessments set source = 'syllabus_extract' where id = ...;
--
-- The result is `source = 'syllabus_extract', confirmed = true` — a row that
-- claims to have come from a syllabus and claims to have been reviewed, having
-- passed neither the extractor nor the confirm gate. REPRODUCED against this
-- project on 2026-07-19 (fixture account; probe row inserted, retagged, and
-- deleted): the trigger did not fire and `confirmed` stayed `true`.
--
-- Today the only writer is `apply_syllabus_extraction`, which does not do this,
-- so nothing in the tree exploits it. It is closed now rather than in Wave 4
-- because Wave 4 is precisely when a second, service-role writer arrives (item
-- 5's document pipeline), and a service-role client bypasses RLS and Server
-- Actions alike. Wave 2 proved twice that an invariant only application code
-- respects is one a background job eventually walks through.
--
-- ## Why this does not break confirming
--
-- The discriminator is whether `source` is BEING CHANGED INTO
-- 'syllabus_extract', not whether it currently is. `confirm_syllabus_extraction`
-- issues `update assessments set confirmed = true` and never touches `source`,
-- so `old.source is not distinct from new.source` and this trigger returns the
-- row untouched. Promotion still works; relabelling no longer smuggles.
--
-- A plain `if new.source = 'syllabus_extract' then new.confirmed := false` on
-- UPDATE would have inverted the gate — it would make confirming impossible.
create function public.force_syllabus_extract_unconfirmed_on_retag()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Only a TRANSITION into the extracted label resets the review state. A row
  -- that was already 'syllabus_extract' is being promoted by the confirm gate,
  -- which is the one legitimate way `confirmed` becomes true here.
  if new.source = 'syllabus_extract' and old.source is distinct from new.source then
    new.confirmed := false;
  end if;
  return new;
end;
$$;

comment on function public.force_syllabus_extract_unconfirmed_on_retag() is
  'Forces confirmed = false when an assessments row is RETAGGED into source = ''syllabus_extract''. Companion to the BEFORE INSERT trigger: that one stops the row being born active, this one stops it being relabelled active. Deliberately keyed on the source transition, not on the source value, so confirm_syllabus_extraction (which updates confirmed and never source) is unaffected.';

create trigger assessments_syllabus_extract_unconfirmed_on_retag
  before update on public.assessments
  for each row
  execute function public.force_syllabus_extract_unconfirmed_on_retag();
