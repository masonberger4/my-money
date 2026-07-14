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
