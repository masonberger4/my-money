-- Receipt capture: a photo of a receipt attached to a transaction, stored in
-- Supabase Storage, for tax substantiation (IRS Rev. Proc. 97-22 accepts
-- electronic images as legal substitutes for paper originals).
--
-- Adds:
--   * receipts             — one row per image, linking a storage object to a
--                            transaction. A TABLE, not a column: multi-page
--                            receipts exist and cost the same migration.
--                            USER-OWNED by construction — sync and the
--                            importers never touch it, so attachments survive
--                            re-pulls the same way user_category does.
--   * storage bucket 'receipts' + its storage.objects policy — the first
--                            Storage use in the app. PRIVATE bucket (financial
--                            documents; display goes through short-lived
--                            signed URLs, never public URLs). Object paths are
--                            <household_id>/<transaction_id>/<uuid>.jpg — the
--                            first path segment is the tenant, which is what
--                            lets the storage policy mirror the table RLS in
--                            one line.
--
-- NOTE: the storage *object* does NOT cascade when a receipts row (or its
-- transaction) is deleted — Storage objects aren't foreign-keyable. The UI
-- delete path removes the object first; anything else orphans a ~200 KB blob,
-- which at household scale is accepted rather than machinery.
--
-- Everything here is additive: paste in the Supabase SQL Editor BEFORE the
-- merge (old code ignores new tables/buckets). Same RLS shape as entities:
-- one for-all policy, household_id defaulting to current_household_id().

create table if not exists receipts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default current_household_id() references households(id) on delete cascade,
  transaction_id uuid not null references transactions(id) on delete cascade,
  storage_path text not null,
  mime text not null,
  created_at timestamptz not null default now()
);

alter table receipts enable row level security;

drop policy if exists receipts_all on receipts;
create policy receipts_all on receipts
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

-- The Tax tab asks "which transactions have a receipt?" for a whole year;
-- the table is tiny, but the FK lookup on delete-cascade wants this anyway.
create index if not exists receipts_transaction_idx on receipts (transaction_id);

-- Private bucket. Limits enforced server-side so a bypassed client can't
-- upload a 500 MB video: 5 MB cap, images only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Storage RLS lives on storage.objects, not on the bucket. Scope by the first
-- path segment = household id, mirroring the table policies.
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
