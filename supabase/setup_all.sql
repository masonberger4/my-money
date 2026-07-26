-- ONE-PASTE SETUP for my-money.
--
-- Paste this entire file into the Supabase SQL Editor and click Run.
-- Safe to run repeatedly: it DROPS and recreates all my-money tables
-- (fine before you have real data; after that, use individual migrations).
--
-- Recommended order:
--   1. Authentication → Users → Add user (email + household password,
--      Auto Confirm ON) — do this FIRST.
--   2. Run this script. It auto-creates the household and links it to the
--      first auth user it finds, so you can skip the manual UUID step.
--   3. Check the output of the final SELECT: it should list your tables
--      and show household_linked = true.

-- Drops everything created by the migrations.
-- Use during development when you want a clean slate.
-- Does NOT delete users from auth.users — do that in the Auth UI.
-- WARNING: this also drops plaid_tokens. You'd need to re-link every
-- institution through Plaid Link afterwards.

drop publication if exists supabase_realtime;
create publication supabase_realtime;

drop table if exists budgets cascade;
drop table if exists settings cascade;
drop table if exists plaid_tokens cascade;
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

-- ============ MIGRATION 1: init ============
-- my-money initial schema
-- Cloud-canonical store for the scraper-based finance app.
-- Multi-device viewer (laptop + phones) reads from here.
-- Local scraper daemon writes accounts/transactions and listens for MFA prompts.

-- =============================================================================
-- Extensions
-- =============================================================================
create extension if not exists pgcrypto;

-- =============================================================================
-- Households (multi-user grouping; v1 has one user per household)
-- =============================================================================
create table households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table household_members (
  household_id uuid not null references households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create index household_members_user_id_idx on household_members(user_id);

-- =============================================================================
-- Helper: current user's household
-- security definer so it can read household_members regardless of RLS.
-- =============================================================================
create or replace function current_household_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select household_id
  from household_members
  where user_id = auth.uid()
  limit 1;
$$;

-- =============================================================================
-- Institutions (one row per connected bank/CC/etc.)
-- =============================================================================
create table institutions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default current_household_id() references households(id) on delete cascade,
  adapter_id text not null,
  name text not null,
  display_name text,
  status text not null default 'active' check (status in ('active', 'needs_reauth', 'disabled', 'error')),
  sync_state jsonb not null default '{}'::jsonb,
  last_successful_pull_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index institutions_household_id_idx on institutions(household_id);

-- =============================================================================
-- Accounts (individual accounts within an institution)
-- =============================================================================
create table accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default current_household_id() references households(id) on delete cascade,
  institution_id uuid not null references institutions(id) on delete cascade,
  adapter_account_id text not null,
  name text not null,
  official_name text,
  type text not null check (type in ('depository', 'credit', 'loan', 'investment', 'other')),
  subtype text,
  mask text,
  current_balance numeric(14, 2),
  available_balance numeric(14, 2),
  currency text not null default 'USD',
  hidden boolean not null default false,
  last_balance_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (institution_id, adapter_account_id)
);

create index accounts_household_id_idx on accounts(household_id);
create index accounts_institution_id_idx on accounts(institution_id);

-- =============================================================================
-- Transactions
-- synthetic_id = hash(account_id|date|amount|normalized_description),
-- NOT unique on purpose: conservative dedup (keep all, flag possible duplicates
-- in UI by detecting shared synthetic_id within an account).
-- =============================================================================
create table transactions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default current_household_id() references households(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  synthetic_id text not null,
  date date not null,
  amount numeric(14, 2) not null,
  merchant_name text,
  description text not null,
  raw_category text,
  mapped_category text,
  pending boolean not null default false,
  pulled_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index transactions_household_date_idx on transactions(household_id, date desc);
create index transactions_account_date_idx on transactions(account_id, date desc);
create index transactions_account_synthetic_idx on transactions(account_id, synthetic_id);

-- =============================================================================
-- Pending items
-- Fully replaced each successful pull; not deduped across pulls.
-- =============================================================================
create table pending_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default current_household_id() references households(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  date date not null,
  amount numeric(14, 2) not null,
  description text not null,
  expected_post_date date,
  pulled_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index pending_items_account_id_idx on pending_items(account_id);

-- =============================================================================
-- Pull jobs (the event bus for the scraper)
-- =============================================================================
create table pull_jobs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default current_household_id() references households(id) on delete cascade,
  institution_id uuid not null references institutions(id) on delete cascade,
  requested_by uuid references auth.users(id),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'awaiting_mfa', 'done', 'failed', 'cancelled')),
  scope jsonb not null default '{"balances": true, "transactions": true, "pending": true}'::jsonb,
  manual_override boolean not null default false,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create index pull_jobs_household_status_idx on pull_jobs(household_id, status);
create index pull_jobs_institution_status_idx on pull_jobs(institution_id, status);
create index pull_jobs_institution_completed_idx on pull_jobs(institution_id, completed_at desc);

-- =============================================================================
-- MFA prompts (back-channel for the scraper to ask, UI to answer)
-- =============================================================================
create table mfa_prompts (
  id uuid primary key default gen_random_uuid(),
  pull_job_id uuid not null references pull_jobs(id) on delete cascade,
  household_id uuid not null default current_household_id() references households(id) on delete cascade,
  type text not null check (type in ('sms', 'email', 'totp', 'push', 'security_question', 'other')),
  prompt text not null,
  options jsonb,
  response text,
  responded_at timestamptz,
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  created_at timestamptz not null default now()
);

create index mfa_prompts_pull_job_id_idx on mfa_prompts(pull_job_id);
create index mfa_prompts_household_id_idx on mfa_prompts(household_id);

-- =============================================================================
-- updated_at triggers
-- =============================================================================
create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger institutions_touch_updated_at
  before update on institutions
  for each row execute function touch_updated_at();

create trigger accounts_touch_updated_at
  before update on accounts
  for each row execute function touch_updated_at();

create trigger transactions_touch_updated_at
  before update on transactions
  for each row execute function touch_updated_at();

-- =============================================================================
-- Pull job constraints
-- 1. Block if another non-terminal job exists for this institution.
-- 2. Block if a successful pull happened in the last 24h (unless manual_override).
-- =============================================================================
create or replace function check_pull_job_constraints()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from pull_jobs
    where institution_id = new.institution_id
      and id <> new.id
      and status in ('queued', 'running', 'awaiting_mfa')
  ) then
    raise exception 'pull_in_progress: institution % already has an active pull job', new.institution_id
      using errcode = 'P0001';
  end if;

  if not new.manual_override and exists (
    select 1 from pull_jobs
    where institution_id = new.institution_id
      and id <> new.id
      and status = 'done'
      and completed_at > now() - interval '24 hours'
  ) then
    raise exception 'rate_limit: institution % already pulled successfully in the last 24 hours', new.institution_id
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger enforce_pull_job_constraints
  before insert on pull_jobs
  for each row execute function check_pull_job_constraints();

-- =============================================================================
-- Row Level Security
-- Everything namespaced by household. Members can read/write their household
-- only. service_role bypasses RLS (used by server-side admin ops if any).
-- =============================================================================
alter table households enable row level security;
alter table household_members enable row level security;
alter table institutions enable row level security;
alter table accounts enable row level security;
alter table transactions enable row level security;
alter table pending_items enable row level security;
alter table pull_jobs enable row level security;
alter table mfa_prompts enable row level security;

-- households: members can see their household; only service_role can insert
create policy households_select on households
  for select to authenticated
  using (id = current_household_id());

-- household_members: see your own memberships
create policy household_members_select on household_members
  for select to authenticated
  using (user_id = auth.uid() or household_id = current_household_id());

-- institutions
create policy institutions_all on institutions
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

-- accounts
create policy accounts_all on accounts
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

-- transactions
create policy transactions_all on transactions
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

-- pending_items
create policy pending_items_all on pending_items
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

-- pull_jobs
create policy pull_jobs_all on pull_jobs
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

-- mfa_prompts
create policy mfa_prompts_all on mfa_prompts
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

-- =============================================================================
-- Realtime publication
-- Scraper subscribes to pull_jobs (new queued jobs) and mfa_prompts (responses).
-- UI subscribes to pull_jobs (status changes) and mfa_prompts (new prompts).
-- =============================================================================
alter publication supabase_realtime add table pull_jobs;
alter publication supabase_realtime add table mfa_prompts;
alter publication supabase_realtime add table accounts;
alter publication supabase_realtime add table transactions;

-- ============ MIGRATION 2: plaid ============
-- Migration 2: reshape schema for Plaid as the data source (scraper plan dropped).
--
-- Changes:
--   * Drop scraper-era tables: pull_jobs, mfa_prompts, pending_items.
--   * institutions: adapter_id → plaid_credential_key + plaid_item_id.
--     plaid_credential_key records which Plaid developer account (client_id/
--     secret pair in the PLAID_CREDENTIALS env var) linked this Item — an
--     access_token only works with the credential that created it.
--   * New plaid_tokens table for access tokens. RLS enabled with NO policies:
--     only service_role (the api/ routes) can read them. Clients never see
--     access tokens.
--   * accounts.adapter_account_id → plaid_account_id.
--   * transactions.synthetic_id → plaid_tx_id, now unique per account
--     (Plaid IDs are stable, so upsert replaces conservative dedup).
--   * New settings table (household-scoped key/value) for dashboard prefs,
--     replacing the Dexie settings store.

-- ---- Drop scraper artifacts -------------------------------------------------
drop table if exists mfa_prompts cascade;
drop table if exists pull_jobs cascade;
drop table if exists pending_items cascade;
drop function if exists check_pull_job_constraints() cascade;

-- ---- institutions -----------------------------------------------------------
alter table institutions drop column if exists adapter_id;
alter table institutions add column plaid_credential_key text not null default 'main';
alter table institutions add column plaid_item_id text unique;

-- ---- accounts ---------------------------------------------------------------
alter table accounts rename column adapter_account_id to plaid_account_id;

-- ---- transactions -----------------------------------------------------------
alter table transactions rename column synthetic_id to plaid_tx_id;

-- Seed data (and any scraper-era rows) may contain duplicates that the new
-- unique constraint would reject; keep one row per (account_id, plaid_tx_id).
delete from transactions t
using transactions keep
where t.account_id = keep.account_id
  and t.plaid_tx_id = keep.plaid_tx_id
  and t.ctid > keep.ctid;

drop index if exists transactions_account_synthetic_idx;
alter table transactions
  add constraint transactions_account_plaid_tx_unique unique (account_id, plaid_tx_id);

-- ---- plaid_tokens (service_role only) ---------------------------------------
create table plaid_tokens (
  institution_id uuid primary key references institutions(id) on delete cascade,
  access_token text not null,
  created_at timestamptz not null default now()
);

-- RLS on, no policies: authenticated users get nothing; service_role bypasses.
alter table plaid_tokens enable row level security;

-- ---- settings (dashboard preferences, household-scoped) ----------------------
create table settings (
  household_id uuid not null default current_household_id() references households(id) on delete cascade,
  key text not null,
  value text,
  updated_at timestamptz not null default now(),
  primary key (household_id, key)
);

alter table settings enable row level security;

create policy settings_all on settings
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

-- ============ MIGRATION 3: account labels ============
-- Migration 3: user-assigned account labels.
-- nickname: a short unique-to-you identifier ("Mason CC", "Joint checking")
--   shown as a badge on every transaction so you can tell accounts apart.
-- color: badge color. Null means the app picks a default from its palette.
--
-- Safe on synced data: api/sync.js upserts accounts without these columns,
-- so Plaid syncs never overwrite them.

alter table accounts add column nickname text;
alter table accounts add column color text;

-- ============ MIGRATION 4: transaction editing ============
-- Migration 4: user edits on transactions.
-- user_category: manual override of the Plaid-derived mapped_category.
--   Effective category everywhere = coalesce(user_category, mapped_category).
-- excluded: removes the transaction from spending/income totals and charts
--   (still visible, dimmed, in transaction lists).
-- Plaid syncs never overwrite these — api/sync.js upserts omit both columns.

alter table transactions add column user_category text;
alter table transactions add column excluded boolean not null default false;

-- ============ MIGRATION 5: transaction rename ============
-- User-supplied display name for a transaction. Overrides merchant_name /
-- description everywhere in the UI. For bank descriptors that arrive masked
-- (e.g. "******* ******" from some Amazon card processors).
-- Plaid sync upserts omit it, so renames survive re-syncs.

alter table transactions add column user_description text;

-- ============ MIGRATION 6: budgets ============
-- Per-category monthly budgets.
-- One row per (household, category); monthly_limit is the dollar cap for a
-- calendar month. No row = no budget for that category. Same RLS pattern as
-- the settings table.

create table budgets (
  household_id uuid not null default current_household_id() references households(id) on delete cascade,
  category text not null,
  monthly_limit numeric(12, 2) not null,
  updated_at timestamptz not null default now(),
  primary key (household_id, category)
);

alter table budgets enable row level security;

create policy budgets_all on budgets
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

-- ============ MIGRATION 7: csv import ============
-- accounts.is_manual: marks accounts created by CSV import rather than Plaid.
--   Belt-and-suspenders only: what actually keeps manual data safe from sync is
--   that the manual institution has no plaid_tokens row AND its status is
--   'disabled', so api/sync.js skips it either way.
-- transactions.source: 'plaid' (default, from api/sync.js) or 'csv'/'pdf'
--   (the importer). Lets a future undo/filter tell imported rows apart.

alter table accounts add column if not exists is_manual boolean not null default false;

alter table transactions add column if not exists source text not null default 'plaid';

-- ============ AUTO-CREATE HOUSEHOLD ============
-- Links the household to the first (usually only) auth user. If you haven't
-- created the user yet, this is skipped — create the user and re-run the
-- script (or just this block).
do $$
declare
  u uuid;
  hh uuid;
begin
  select id into u from auth.users order by created_at limit 1;
  if u is null then
    raise notice 'No auth user found. Create one in Authentication → Users, then re-run this script.';
  elsif exists (select 1 from household_members) then
    raise notice 'Household already linked — nothing to do.';
  else
    insert into households (name) values ('My Household') returning id into hh;
    insert into household_members (household_id, user_id, role) values (hh, u, 'owner');
    raise notice 'Household created and linked to user %.', u;
  end if;
end $$;

-- ============ FINAL CHECK ============
-- Asserts the schema matches ALL migrations in supabase/migrations/ — raises
-- (instead of printing a wrong-but-green count) if this file drifts behind.
-- When adding a migration here, extend these assertions to cover it.
do $$
declare
  missing text[] := '{}';
begin
  if to_regclass('public.budgets') is null then
    missing := array_append(missing, 'budgets table (20260720)');
  end if;
  if not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'transactions'
        and column_name = 'user_category') then
    missing := array_append(missing, 'transactions.user_category (20260715)');
  end if;
  if not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'transactions'
        and column_name = 'user_description') then
    missing := array_append(missing, 'transactions.user_description (20260717)');
  end if;
  if not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'transactions'
        and column_name = 'source') then
    missing := array_append(missing, 'transactions.source (20260722)');
  end if;
  if not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'accounts'
        and column_name = 'is_manual') then
    missing := array_append(missing, 'accounts.is_manual (20260722)');
  end if;
  if array_length(missing, 1) > 0 then
    raise exception 'setup_all.sql is out of sync with migrations/: missing %',
      array_to_string(missing, ', ');
  end if;
  raise notice 'Schema check passed: all migrations present.';
end $$;

select (select count(*) > 0 from household_members) as household_linked;
