-- Drops everything created by the migrations.
-- Use during development when you want a clean slate.
-- Does NOT delete users from auth.users — do that in the Auth UI.
-- WARNING: this also drops simplefin_access. You'd need to re-claim a setup
-- token at SimpleFIN Bridge (Accounts → ⚡ SimpleFIN) afterwards.

drop publication if exists supabase_realtime;
create publication supabase_realtime;

drop table if exists budgets cascade;
drop table if exists settings cascade;
-- Plaid is gone (20260728000002), but this line stays: a database created
-- before that migration still has the table, and `drop table institutions
-- cascade` would only remove its foreign key, stranding the table itself —
-- full of stale access tokens — after the "clean slate" reset.
drop table if exists plaid_tokens cascade;
drop table if exists simplefin_access cascade;
drop table if exists category_rules cascade;
drop table if exists mfa_prompts cascade;
drop table if exists pull_jobs cascade;
drop table if exists pending_items cascade;
drop table if exists transactions cascade;
drop table if exists accounts cascade;
drop table if exists institutions cascade;
drop table if exists household_members cascade;
drop table if exists households cascade;

drop function if exists current_household_id();
drop function if exists touch_updated_at() cascade;
drop function if exists check_pull_job_constraints() cascade;
