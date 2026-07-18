-- courses.color moves from a raw hex string to a design-system palette key.
--
-- The design system (PLAN.md "Identity & design") owns the actual OKLCH values
-- per theme, so the database must not store a theme-specific hex: '#6366f1'
-- has no dark-mode counterpart. Storing the key lets globals.css resolve the
-- light/dark pair via --course-*.
--
-- Conventions per 20260717161053_foundation_semesters_courses_assessments.sql.
-- RLS and the four per-operation policies on public.courses are unchanged by
-- this migration; only the column's default, values, and constraint change.

-- 1. Drop the hex default before rewriting values, so nothing re-introduces it.
alter table public.courses
  alter column color drop default;

-- 2. Normalize any value that is not one of the eight palette keys to the
--    default palette hue. Verified 0 rows at authoring time; the statement is
--    kept so the migration is correct against any environment.
update public.courses
set color = 'indigo'
where color is null
   or color not in ('indigo', 'violet', 'pink', 'gold', 'green', 'teal', 'cyan', 'rust');

-- 3. New default: the palette's default course hue.
alter table public.courses
  alter column color set default 'indigo';

-- 4. Constrain to exactly the curated 8-hue categorical set.
alter table public.courses
  add constraint courses_color_palette_key
  check (color in ('indigo', 'violet', 'pink', 'gold', 'green', 'teal', 'cyan', 'rust'));

comment on column public.courses.color is
  'Course palette key from the curated 8-hue categorical set; the theme-specific OKLCH values live in the design tokens (--course-*), not here.';
