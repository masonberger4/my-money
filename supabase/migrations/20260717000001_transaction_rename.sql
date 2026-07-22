-- User-supplied display name for a transaction. Overrides merchant_name /
-- description everywhere in the UI. For bank descriptors that arrive masked
-- (e.g. "******* ******" from some Amazon card processors).
-- Additive only; Plaid sync upserts omit it, so renames survive re-syncs.

alter table transactions add column user_description text;
