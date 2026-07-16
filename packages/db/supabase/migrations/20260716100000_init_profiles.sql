-- StudyOS initial migration: profiles + conventions.
--
-- Conventions established here apply to every future table:
--   1. Every user-owned table has a user_id (or is keyed by auth.users.id).
--   2. RLS is enabled on every table, with per-operation policies scoped to
--      `(select auth.uid())` (subquery form for per-statement caching).
--   3. Functions pin `search_path = ''` and use fully qualified names.
--   4. updated_at is maintained by the shared set_updated_at() trigger.

-- Shared trigger to maintain updated_at columns.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- One row per auth user; app-level profile and preferences.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  locale text not null default 'en',
  timezone text not null default 'Europe/Madrid',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'App profile for each auth user. Created automatically on signup by handle_new_user().';

alter table public.profiles enable row level security;

create policy "Users can view own profile"
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

create policy "Users can update own profile"
  on public.profiles
  for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();

-- Create a profile automatically when a user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();
