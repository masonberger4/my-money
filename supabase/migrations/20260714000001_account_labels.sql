-- Migration 3: user-assigned account labels.
-- nickname: a short unique-to-you identifier ("Mason CC", "Joint checking")
--   shown as a badge on every transaction so you can tell accounts apart.
-- color: badge color. Null means the app picks a default from its palette.
--
-- Safe on synced data: api/sync.js upserts accounts without these columns,
-- so Plaid syncs never overwrite them.

alter table accounts add column nickname text;
alter table accounts add column color text;
