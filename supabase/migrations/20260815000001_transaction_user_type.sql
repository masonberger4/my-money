-- The 4-type override (Mason, 2026-08-15 — the YNAB-style redesign).
--
-- transactions.user_type: nullable, USER-OWNED. null = automatic (the
-- structural linked-boundary derivation). Non-null routes THROUGH the shared
-- model — isSpend / cashIncome read it and markInternalTransfers drops
-- overridden rows from its candidate pool — never a second predicate beside
-- isSpend. User-owned like user_category / entity_id: api/sync.js, CSV/PDF
-- import and manual quick-add never write it, so it survives re-pulls.
--
-- DEPLOY ORDER: additive, so the normal order — safe to paste BEFORE the
-- merge (old code ignores new columns). The new code degrades client-side if
-- the paste is late (dataAdapter's transactionsHaveUserType retry), but the
-- assistant context deliberately does not — paste first.
--
-- Replays clean on a fresh empty database: the column guard is IF NOT EXISTS
-- and the constraint is drop-then-add under a stable name, so running this
-- file twice is a no-op.

alter table transactions add column if not exists user_type text;

alter table transactions drop constraint if exists transactions_user_type_check;
alter table transactions add constraint transactions_user_type_check
  check (user_type is null
         or user_type in ('spending', 'inflow', 'transfer', 'card_payment'));

comment on column transactions.user_type is
  'User 4-type override (spending|inflow|transfer|card_payment); null = derive structurally. Written only by the client''s updateTransaction; every feed writer omits it.';
