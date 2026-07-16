-- Migration 4: user edits on transactions.
-- user_category: manual override of the Plaid-derived mapped_category.
--   Effective category everywhere = coalesce(user_category, mapped_category).
-- excluded: removes the transaction from spending/income totals and charts
--   (still visible, dimmed, in transaction lists).
--
-- Non-destructive: adds columns only. Safe on a live database.
-- Plaid syncs never overwrite these — api/sync.js upserts omit both columns.

alter table transactions add column user_category text;
alter table transactions add column excluded boolean not null default false;
