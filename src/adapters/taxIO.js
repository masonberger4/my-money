// Rental entities + mileage-log I/O (migration 20260730000001). Split out of
// dataAdapter.js (2026-08-04 code-health session); INTERNAL: only
// dataAdapter.js imports this module and re-exports its API.
//
// getTaxYearTransactions deliberately stays in dataAdapter.js — it rides
// getTransactionsBetween (the range memo + pipeline), which is façade-side.
// Like category_rules, every read here degrades to "feature not installed"
// when the migration hasn't been pasted yet (previews share the prod
// database); the flags only ever flip true→false.
import { supabase } from '../supabaseClient.js';
import { isMissingTableError } from './shared.js';

let hasEntities = true;
let hasMileage = true;

// Rental properties (kind='rental'; the schema also allows 'business' for a
// future side-business, but nothing in the UI creates one yet). Archived
// entities are returned too: a year-end report must still resolve an entity
// archived mid-year — callers filter on archived_at for pickers.
export async function getEntities() {
  if (!hasEntities) return { entities: [] };
  const { data, error } = await supabase
    .from('entities')
    .select('id, name, kind, created_at, archived_at')
    .order('created_at', { ascending: true });
  if (error) {
    if (isMissingTableError(error)) {
      hasEntities = false;
      return { entities: [] };
    }
    throw error;
  }
  return { entities: data };
}

export async function createEntity(name, kind = 'rental') {
  const { data, error } = await supabase
    .from('entities')
    .insert({ name, kind })
    .select('id, name, kind, created_at, archived_at')
    .single();
  if (error) throw error;
  return data;
}

// fields: { name } and/or { archived_at } (an ISO timestamp archives, null
// restores). Archive rather than delete — transactions reference the row.
export async function updateEntity(id, fields) {
  const allowed = {};
  if ('name' in fields) allowed.name = fields.name;
  if ('archived_at' in fields) allowed.archived_at = fields.archived_at;
  const { error } = await supabase.from('entities').update(allowed).eq('id', id);
  if (error) throw error;
}

// --- Mileage log (hand-entered; valued by src/taxReport.js) ------------------

export async function getMileage(year) {
  if (!hasMileage) return { mileage: [] };
  const { data, error } = await supabase
    .from('mileage_log')
    .select('id, entity_id, on_date, miles, purpose')
    .gte('on_date', `${year}-01-01`)
    .lte('on_date', `${year}-12-31`)
    .order('on_date', { ascending: false })
    .limit(2000);
  if (error) {
    if (isMissingTableError(error)) {
      hasMileage = false;
      return { mileage: [] };
    }
    throw error;
  }
  return { mileage: data };
}

export async function addMileage({ on_date, miles, purpose, entity_id }) {
  const { data, error } = await supabase
    .from('mileage_log')
    .insert({ on_date, miles, purpose: purpose || null, entity_id: entity_id || null })
    .select('id, entity_id, on_date, miles, purpose')
    .single();
  if (error) throw error;
  return data;
}

export async function deleteMileage(id) {
  const { error } = await supabase.from('mileage_log').delete().eq('id', id);
  if (error) throw error;
}
