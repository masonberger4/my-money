-- CSV import (Phase 1: standalone import).
-- Lets a bank CSV be turned into real transactions on a manual (non-Plaid)
-- account so the un-synced personal-account income becomes visible. Both
-- columns are additive and optional — the import path works without them
-- (see below), so this is safe to run on live data at any time.
--
-- accounts.is_manual: marks accounts created by CSV import rather than Plaid.
--   Belt-and-suspenders only: what actually keeps manual data safe from sync is
--   that the manual institution has no plaid_tokens row AND its status is
--   'disabled', so api/sync.js skips it either way. This flag just powers the
--   "Imported" UI badge and an extra sync guard if one is ever added.
--
-- transactions.source: 'plaid' (default, from api/sync.js) or 'csv' (this
--   feature). Lets a future undo/filter tell imported rows apart. Nothing
--   reads it yet; the importer sets it when the column exists and silently
--   omits it when it doesn't, so importing works before or after this lands.
--
-- Non-destructive: adds columns only. Plaid sync upserts never touch either
-- column, and the CSV importer omits the user-owned columns (nickname, color,
-- hidden, user_category, user_description, excluded) the same way, so re-imports
-- and re-syncs both preserve manual edits.

alter table accounts add column if not exists is_manual boolean not null default false;

alter table transactions add column if not exists source text not null default 'plaid';
