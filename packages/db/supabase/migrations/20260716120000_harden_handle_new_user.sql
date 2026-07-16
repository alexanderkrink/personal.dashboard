-- Trigger functions are invoked by triggers only — they must not be callable
-- through the PostgREST RPC API (Supabase security lints 0028/0029).
revoke execute on function public.handle_new_user() from anon, authenticated, public;
