-- Editable transaction dates (Mason, 2026-09-08): a purchase that posts a day
-- into the next month — or one the household simply wants counted in a
-- different month — moves by picking a date in the detail sheet.
--
-- transactions.user_date: nullable, USER-OWNED. null = the bank's date.
-- transactions.effective_date: STORED generated coalesce(user_date, date) —
-- the ONE month-bucketing verdict, the same precedence shape as
-- user_category over mapped_category and user_type over the derivation.
--
-- `date` stays the BANK's date, untouched: api/sync.js keeps restating it in
-- its uniform upsert (a pending row's date legitimately moves when it posts),
-- the CSV/PDF dedup ids keep hashing it, and the feed-coverage, reconciliation
-- and coverage-gap reads keep meaning "when the bank says it happened".
-- Only the month-bucketing reads (the range fetch, search, the account sheet,
-- the assistant's context) move onto effective_date — see the dataAdapter.js
-- key row for the list. A trigger that rewrote `date` in place was
-- considered and rejected (architect, 2026-09-08): it would have turned the
-- bank date into the user's pick at exactly those reads, invisibly.
--
-- User-owned like user_category / user_type: every feed writer omits
-- user_date (pinned in test/txDate.test.js), so it survives re-pulls, and a
-- re-pull restating `date` leaves effective_date = user_date by construction.
--
-- DEPLOY ORDER: additive, so the normal order — paste BEFORE the merge (old
-- code ignores new columns; the new code degrades client-side via
-- dataAdapter's transactionsHaveUserDate if the paste is late, and reads
-- `date` until then). The STORED generated column REWRITES the table under an
-- ACCESS EXCLUSIVE lock — seconds at household scale, but paste it when no
-- sync is running.
--
-- Replays clean on a fresh empty database: every statement is IF NOT EXISTS.

alter table transactions add column if not exists user_date date;
alter table transactions add column if not exists effective_date date
  generated always as (coalesce(user_date, date)) stored;

-- The month reads sort/range on effective_date now, so mirror the two
-- bank-date indexes from the init migration.
create index if not exists transactions_household_effective_date_idx
  on transactions(household_id, effective_date desc);
create index if not exists transactions_account_effective_date_idx
  on transactions(account_id, effective_date desc);

comment on column transactions.user_date is
  'User override of the month a row counts in; null = the bank''s date. Written only by the client''s updateTransaction; every feed writer omits it.';
comment on column transactions.effective_date is
  'Generated coalesce(user_date, date): the one date every month list, total and search reads. `date` stays the bank''s date.';

-- Verify (the SQL Editor hides notices — read this back):
--   select count(*) filter (where effective_date is distinct from date) as overridden,
--          count(*) filter (where effective_date is null) as missing
--   from transactions;
