-- ============================================================================
-- TOMBSTONE (2026-08-08). SUPERSEDED for fresh installs by the Supabase CLI
-- flow (`supabase db push`, replaying migrations/ in order) — docs/SETUP.md
-- Path A. This file remains Path B: the currently-VERIFIED fallback, kept
-- because the CLI path has not yet been rehearsed end-to-end on an empty DB.
--
-- IT IS STALE. It replays only through 20260731000001_receipts.sql, and its
-- final self-check stops at the same point — so it passes GREEN while the five
-- later migrations are missing. Paste those by hand afterwards (docs/SETUP.md
-- lists them).
--
-- STILL DESTRUCTIVE: it DROPS every my-money table. Never run on live data.
-- ============================================================================

-- ONE-PASTE SETUP for my-money.
--
-- Paste this entire file into the Supabase SQL Editor and click Run.
-- Repeatable ONLY on a project with no real data: every run DROPS and
-- recreates all my-money tables. Once real data exists, this file destroys it —
-- use individual migrations from migrations/ instead.
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
-- WARNING: this also drops simplefin_access. You'd need to re-claim a setup
-- token at SimpleFIN Bridge (Accounts → ⚡ SimpleFIN) afterwards.

drop publication if exists supabase_realtime;
create publication supabase_realtime;

drop table if exists budget_months cascade;
drop table if exists budgets cascade;
drop table if exists settings cascade;
-- Plaid is gone (20260728000002), but this wipe list must still name
-- plaid_tokens: a project created by an OLDER version of this file has the
-- table, and dropping institutions with CASCADE would only take its foreign
-- key, leaving an orphaned table full of stale access tokens behind.
drop table if exists plaid_tokens cascade;
drop table if exists simplefin_access cascade;
drop table if exists category_rules cascade;
drop table if exists receipts cascade;
drop table if exists mileage_log cascade;
drop table if exists entities cascade;
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
-- NOTE: replayed for fidelity, then dropped again by MIGRATION 10 below — the
-- same pattern as pull_jobs/mfa_prompts above, which MIGRATION 2 removes. A
-- fresh install does NOT end up with this table. What it DOES end up with, and
-- what must survive, are the two renames just above: accounts.plaid_account_id
-- and transactions.plaid_tx_id are the adapter-agnostic external-id columns
-- every feed writes: 'sfin:', 'csv:' (BOTH CSV and PDF -- there is no 'pdf:'
-- namespace; transactions.source tells those apart) and 'manual:'.
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

-- ============ MIGRATION 8: simplefin ============
-- See supabase/migrations/20260724000001_simplefin.sql for the full rationale.
-- simplefin_access holds the claimed access URL, which embeds HTTP Basic
-- credentials for the household's banks — so it gets the plaid_tokens
-- treatment: RLS enabled with ZERO policies (service_role only). household_id
-- has NO default on purpose: every write happens from api/ under service_role,
-- where current_household_id() is NULL, so a forgotten value fails loudly
-- instead of writing an orphan row.

create table if not exists simplefin_access (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  access_url text not null,
  last_pulled_at timestamptz,      -- data watermark; advanced only on success
  last_attempt_at timestamptz,     -- throttle; stamped before the request
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, access_url)
);

alter table simplefin_access enable row level security;

drop trigger if exists simplefin_access_touch_updated_at on simplefin_access;
create trigger simplefin_access_touch_updated_at
  before update on simplefin_access
  for each row execute function touch_updated_at();

-- institutions.simplefin_org_id doubles as the FEED DISCRIMINATOR:
--   null     => Plaid-fed (or the manual "Imported" institution)
--   not null => SimpleFIN-fed, skipped by the Plaid pass in api/sync.js
alter table institutions add column if not exists simplefin_org_id text;

create unique index if not exists institutions_household_simplefin_org_idx
  on institutions (household_id, simplefin_org_id)
  where simplefin_org_id is not null;

-- ============ MIGRATION 9: learned category rules ============
-- See supabase/migrations/20260728000001_category_rules.sql. Written by the
-- CLIENT (the confirm in the transaction sheet), so it takes the
-- budgets/settings RLS shape rather than the service_role-only shape above.

create table if not exists category_rules (
  household_id uuid not null default current_household_id() references households(id) on delete cascade,
  merchant_key text not null,
  category text not null,
  source text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (household_id, merchant_key)
);

alter table category_rules enable row level security;

drop policy if exists category_rules_all on category_rules;
create policy category_rules_all on category_rules
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

-- ============ MIGRATION 10: remove plaid ============
-- See supabase/migrations/20260728000002_remove_plaid.sql for the full
-- rationale and for the ordering rule that matters on LIVE data (that file is
-- pasted AFTER the code deploy, not before — it drops, it doesn't add).
-- Here it is just the tail of the replay: undo the Plaid-shaped parts of
-- MIGRATION 2. accounts.plaid_account_id and transactions.plaid_tx_id are NOT
-- Plaid-shaped despite the names and are deliberately left alone.

drop table if exists plaid_tokens;

alter table institutions drop column if exists plaid_credential_key;
alter table institutions drop column if exists plaid_item_id;

-- 'needs_reauth' was a Plaid-only status (api/sync.js set it on
-- ITEM_LOGIN_REQUIRED). Nothing can write or clear it now, so it leaves the
-- allowed set. Drop by name first so this file stays re-runnable, then sweep
-- any differently-named check that still permits the value.
alter table institutions drop constraint if exists institutions_status_check;

do $$
declare
  c text;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'institutions'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%needs_reauth%'
  loop
    execute format('alter table public.institutions drop constraint %I', c);
  end loop;
end $$;

update institutions set status = 'error' where status = 'needs_reauth';

alter table institutions
  add constraint institutions_status_check
  check (status in ('active', 'disabled', 'error'));

-- ============ MIGRATION 11: envelope budgeting ============
-- budget_months adds the per-(category, month) grain the flat budgets table
-- lacked: `assigned` is how many real dollars the household gave a category in
-- that month. A MISSING ROW MEANS assigned 0 — never a fallback to
-- budgets.monthly_limit, which would manufacture a rolled-over balance out of
-- months nobody actually budgeted.
--
-- budgets keeps one row per category but monthly_limit now means the rule-2
-- funding *target* rather than a spending cap, and it gains rollover (rule 3),
-- target_kind ('monthly' | 'by_date') and target_date. monthly_limit becomes
-- nullable so a category can carry rollover settings without a target amount.

create table budget_months (
  household_id uuid not null default current_household_id() references households(id) on delete cascade,
  category text not null,
  -- Always the first of the month; the check keeps the primary key honest so
  -- two writers can't create '2026-07-01' and '2026-07-15' for one month.
  month date not null check (month = date_trunc('month', month)::date),
  assigned numeric(12, 2) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (household_id, category, month)
);

alter table budget_months enable row level security;

create policy budget_months_all on budget_months
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

alter table budgets add column if not exists rollover boolean not null default true;
alter table budgets add column if not exists target_kind text not null default 'monthly'
  check (target_kind in ('monthly', 'by_date'));
alter table budgets add column if not exists target_date date;
alter table budgets alter column monthly_limit drop not null;

-- ============ MIGRATION 12: rental tracking + tax prep ============
-- entities = rental properties ('business' allowed for a future side-business).
-- accounts.entity_id is the account-level default; transactions.entity_id the
-- per-row override (user-owned — sync/import never write either). The capital
-- columns keep improvements off the Schedule E expense lines; mileage_log is
-- hand-entered (SimpleFIN has no mileage, a PWA has no background GPS).

create table entities (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default current_household_id() references households(id) on delete cascade,
  name text not null,
  kind text not null default 'rental' check (kind in ('rental', 'business')),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

alter table entities enable row level security;

create policy entities_all on entities
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

alter table accounts
  add column if not exists entity_id uuid references entities(id) on delete set null;

alter table transactions
  add column if not exists entity_id uuid references entities(id) on delete set null;
alter table transactions
  add column if not exists is_capital boolean not null default false;
alter table transactions
  add column if not exists placed_in_service date;
alter table transactions
  add column if not exists useful_life_years integer;

create index if not exists transactions_entity_idx
  on transactions (entity_id)
  where entity_id is not null;

create table mileage_log (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default current_household_id() references households(id) on delete cascade,
  entity_id uuid references entities(id) on delete cascade,
  on_date date not null,
  miles numeric(7, 1) not null check (miles > 0),
  purpose text,
  created_at timestamptz not null default now()
);

alter table mileage_log enable row level security;

create policy mileage_log_all on mileage_log
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

-- Receipt photos attached to transactions (tax substantiation). See
-- supabase/migrations/20260731000001_receipts.sql — images live in the private
-- 'receipts' Storage bucket, this table is the index; the bucket + its
-- storage.objects policy are created below.
create table receipts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default current_household_id() references households(id) on delete cascade,
  transaction_id uuid not null references transactions(id) on delete cascade,
  storage_path text not null,
  mime text not null,
  created_at timestamptz not null default now()
);

alter table receipts enable row level security;

create policy receipts_all on receipts
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

create index receipts_transaction_idx on receipts (transaction_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- CREATE/DROP POLICY require OWNERSHIP of storage.objects, which on hosted
-- Supabase belongs to supabase_storage_admin — the SQL Editor's postgres role
-- may not have it (42501 "must be owner of table objects"). The DO block turns
-- that into a loud NOTICE instead of a half-applied paste: if it fires, create
-- this exact policy in Dashboard -> Storage -> Policies (bucket 'receipts',
-- all operations, authenticated, USING and WITH CHECK both
--   (storage.foldername(name))[1] = current_household_id()::text
-- ), then verify an upload + signed URL round-trips before merging. Until the
-- policy exists uploads fail with an RLS violation (private bucket denies by
-- default — an availability gap, never a leak).
do $storage_policy$
begin
  drop policy if exists receipts_objects_all on storage.objects;
  create policy receipts_objects_all on storage.objects
    for all to authenticated
    using (
      bucket_id = 'receipts'
      and (storage.foldername(name))[1] = current_household_id()::text
    )
    with check (
      bucket_id = 'receipts'
      and (storage.foldername(name))[1] = current_household_id()::text
    );
exception when insufficient_privilege then
  raise notice 'Could not create the storage.objects policy (not table owner). Create policy receipts_objects_all by hand in Dashboard -> Storage -> Policies — see the comment above this block.';
end $storage_policy$;

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
  stale   text[] := '{}';
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
  if to_regclass('public.simplefin_access') is null then
    missing := array_append(missing, 'simplefin_access table (20260724)');
  end if;
  if not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'simplefin_access'
        and column_name = 'last_attempt_at') then
    missing := array_append(missing, 'simplefin_access.last_attempt_at (20260724)');
  end if;
  if not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'institutions'
        and column_name = 'simplefin_org_id') then
    missing := array_append(missing, 'institutions.simplefin_org_id (20260724)');
  end if;
  if to_regclass('public.category_rules') is null then
    missing := array_append(missing, 'category_rules table (20260728)');
  end if;
  if to_regclass('public.budget_months') is null then
    missing := array_append(missing, 'budget_months table (20260729)');
  end if;
  if not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'budgets'
        and column_name = 'rollover') then
    missing := array_append(missing, 'budgets.rollover (20260729)');
  end if;
  if not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'budgets'
        and column_name = 'target_kind') then
    missing := array_append(missing, 'budgets.target_kind (20260729)');
  end if;
  if not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'budgets'
        and column_name = 'target_date') then
    missing := array_append(missing, 'budgets.target_date (20260729)');
  end if;
  -- monthly_limit must be NULLABLE after 20260729 — a category can carry
  -- rollover settings without a target amount.
  if exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'budgets'
        and column_name = 'monthly_limit' and is_nullable = 'NO') then
    missing := array_append(missing, 'budgets.monthly_limit still NOT NULL (20260729)');
  end if;
  if to_regclass('public.entities') is null then
    missing := array_append(missing, 'entities table (20260730)');
  end if;
  if to_regclass('public.mileage_log') is null then
    missing := array_append(missing, 'mileage_log table (20260730)');
  end if;
  if not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'accounts'
        and column_name = 'entity_id') then
    missing := array_append(missing, 'accounts.entity_id (20260730)');
  end if;
  if not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'transactions'
        and column_name = 'entity_id') then
    missing := array_append(missing, 'transactions.entity_id (20260730)');
  end if;
  if not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'transactions'
        and column_name = 'is_capital') then
    missing := array_append(missing, 'transactions.is_capital (20260730)');
  end if;
  if not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'transactions'
        and column_name = 'placed_in_service') then
    missing := array_append(missing, 'transactions.placed_in_service (20260730)');
  end if;
  if not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'transactions'
        and column_name = 'useful_life_years') then
    missing := array_append(missing, 'transactions.useful_life_years (20260730)');
  end if;

  if to_regclass('public.receipts') is null then
    missing := array_append(missing, 'receipts table (20260731)');
  end if;

  -- The two adapter-agnostic external-id columns. Plaid-named, NOT Plaid-owned:
  -- every feed writes them ('sfin:', 'csv:', 'manual:') and they carry
  -- the upsert conflict targets that make a re-pull idempotent. Asserted PRESENT
  -- so a future "finish the Plaid cleanup" edit that drops them fails here
  -- instead of silently breaking every sync and import.
  if not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'transactions'
        and column_name = 'plaid_tx_id') then
    missing := array_append(missing, 'transactions.plaid_tx_id (20260606) — adapter-agnostic, must never be dropped');
  end if;
  if not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'accounts'
        and column_name = 'plaid_account_id') then
    missing := array_append(missing, 'accounts.plaid_account_id (20260606) — adapter-agnostic, must never be dropped');
  end if;

  -- ---- ABSENCE assertions (20260728000002_remove_plaid) --------------------
  -- Everything above asks "is it there?". Plaid removal is a DROP migration, so
  -- these ask the opposite: if any of them still exists, this file replayed the
  -- Plaid blocks without replaying the removal that undoes them.
  if to_regclass('public.plaid_tokens') is not null then
    stale := array_append(stale, 'plaid_tokens table still exists (20260728000002)');
  end if;
  if exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'institutions'
        and column_name = 'plaid_credential_key') then
    stale := array_append(stale, 'institutions.plaid_credential_key still exists (20260728000002)');
  end if;
  if exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'institutions'
        and column_name = 'plaid_item_id') then
    stale := array_append(stale, 'institutions.plaid_item_id still exists (20260728000002)');
  end if;
  if exists (
    select 1 from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'institutions'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%needs_reauth%'
  ) then
    stale := array_append(stale, e'institutions.status still permits \'needs_reauth\' (20260728000002)');
  end if;

  if array_length(missing, 1) > 0 then
    raise exception 'setup_all.sql is out of sync with migrations/: missing %',
      array_to_string(missing, ', ');
  end if;
  if array_length(stale, 1) > 0 then
    raise exception 'setup_all.sql is out of sync with migrations/: not removed: %',
      array_to_string(stale, ', ');
  end if;
  raise notice 'Schema check passed: all migrations present, Plaid artifacts removed.';
end $$;

select (select count(*) > 0 from household_members) as household_linked;
