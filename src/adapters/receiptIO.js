// Receipt-photo I/O (migration 20260731000001) — the app's ONLY Supabase
// Storage use. Split out of dataAdapter.js (2026-08-04 code-health session);
// INTERNAL: only dataAdapter.js imports this module and re-exports its API.
//
// Images live in the PRIVATE 'receipts' Storage bucket; the receipts table is
// the index the app trusts (never storage.list()). Paths are
// <household_id>/<transaction_id>/<uuid>.<ext> — the first segment is what the
// storage policy scopes on. Display always goes through short-lived signed
// URLs minted per render; a signed URL is never stored. USER-OWNED like
// user_category: sync and the importers never touch any of this, so
// attachments survive re-pulls. Degrades to "not installed" pre-migration
// like the rental-tax reads.
//
// getReceiptTxIds deliberately stays in dataAdapter.js (its paged loop is
// pinned there by the pagedGuards source scan) — it shares the degrade flag
// through the accessors below.
import { supabase } from '../supabaseClient.js';
import { isMissingTableError } from './shared.js';

let hasReceipts = true;

export function receiptsInstalled() {
  return hasReceipts;
}

export function markReceiptsMissing() {
  hasReceipts = false;
}

// The storage path needs the household id, which the client doesn't otherwise
// hold (RLS defaults fill it on table inserts). current_household_id() is a
// plain public-schema function, so PostgREST exposes it as an rpc. Cached —
// the household can't change within a session.
let cachedHouseholdId = null;
async function getHouseholdId() {
  if (cachedHouseholdId) return cachedHouseholdId;
  const { data, error } = await supabase.rpc('current_household_id');
  if (error) throw error;
  if (!data) throw new Error('No household for this user');
  cachedHouseholdId = data;
  return data;
}

export async function getReceipts(transactionId) {
  if (!hasReceipts) return { receipts: [] };
  const { data, error } = await supabase
    .from('receipts')
    .select('id, transaction_id, storage_path, mime, created_at')
    .eq('transaction_id', transactionId)
    .order('created_at', { ascending: true });
  if (error) {
    if (isMissingTableError(error)) {
      hasReceipts = false;
      return { receipts: [] };
    }
    throw error;
  }
  return { receipts: data };
}

// blob: the ALREADY-COMPRESSED image (src/receiptImage.js) — this function
// does no resizing. Upload the object first, then insert the index row; a
// failure between the two orphans a blob (accepted, ~200 KB) rather than
// creating a row pointing at nothing.
export async function addReceipt(transactionId, blob, mime = 'image/jpeg') {
  const householdId = await getHouseholdId();
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  const path = `${householdId}/${transactionId}/${crypto.randomUUID()}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from('receipts')
    .upload(path, blob, { contentType: mime, upsert: false });
  if (upErr) throw upErr;
  const { data, error } = await supabase
    .from('receipts')
    .insert({ transaction_id: transactionId, storage_path: path, mime })
    .select('id, transaction_id, storage_path, mime, created_at')
    .single();
  if (error) {
    // Roll the object back so a failed insert doesn't strand a blob the index
    // will never find. Best-effort — if this remove also fails, the orphan is
    // the accepted outcome.
    await supabase.storage.from('receipts').remove([path]).catch(() => {});
    throw error;
  }
  return data;
}

// Object first, then row: the row is the index, so deleting it last means a
// half-completed delete leaves a still-listed receipt whose image 404s only
// until retried, never an invisible orphan.
export async function deleteReceipt(receipt) {
  const { error: rmErr } = await supabase.storage
    .from('receipts')
    .remove([receipt.storage_path]);
  if (rmErr) throw rmErr;
  const { error } = await supabase.from('receipts').delete().eq('id', receipt.id);
  if (error) throw error;
}

// Mint a fresh signed URL per render — 1 hour outlives any open sheet, and
// nothing caches it (the service worker passes cross-origin through).
export async function getReceiptUrl(storagePath) {
  const { data, error } = await supabase.storage
    .from('receipts')
    .createSignedUrl(storagePath, 3600);
  if (error) throw error;
  return data.signedUrl;
}
