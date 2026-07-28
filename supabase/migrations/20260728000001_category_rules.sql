-- Learned merchant → category rules.
--
-- Additive only — safe to paste into the Supabase SQL Editor on live data.
--
-- Why this exists: with Plaid retired, src/txClassify.js's keyword table is the
-- only categorizer, and it cannot know that "Rudys Columbia City" is a
-- barbershop. Correcting a transaction used to fix exactly one row —
-- `user_category` is per-transaction — so the same merchant landed in
-- Uncategorized again next month, forever. This table is the memory: correct a
-- merchant once and every future import and sync classifies it that way.
--
-- Precedence at write time (src/txClassify.js):
--   learned rule  →  keyword table  →  Uncategorized
-- and at read time `user_category` still wins over all of it, so a one-off
-- override on a single transaction is untouched by any rule.
--
-- merchant_key is the NORMALIZED descriptor (see merchantKey() in
-- src/txClassify.js): uppercased, punctuation flattened, and store numbers /
-- reference digits dropped, so "SAFEWAY #1234" and "SAFEWAY 8892" collapse to
-- "SAFEWAY" while "COSTCO GAS" and "COSTCO WHSE" stay distinct. Matching is
-- exact OR whole-token prefix, which lets a rule on "RUDYS" cover every
-- location without merging unrelated merchants that share a first word.
--
-- Written by the CLIENT (the confirm in the transaction sheet), so it takes the
-- budgets/settings RLS shape: household_id defaults to current_household_id(),
-- which resolves because auth.uid() is set on an authenticated connection. The
-- SimpleFIN sync reads it under service_role, which bypasses RLS.

create table if not exists category_rules (
  household_id uuid not null default current_household_id() references households(id) on delete cascade,
  merchant_key text not null,
  category text not null,
  -- How the rule came about, for a future "review learned rules" screen:
  -- 'user' = taught by correcting a transaction.
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
