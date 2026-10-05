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
import { isRangeExhaustedError } from '../ruleHistory.js';
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

// Paged, never `.limit(n)`: PostgREST clamps any single read at max-rows
// (1000), so the old 2000-row limit could only ever return 1000 drives — and
// silently drop the year's EARLIEST ones (newest first). id is the tiebreak
// that makes on_date's ties a total order across page boundaries.
// `opts.client` is a test seam only (the envelopeIO recording-fake pattern).
export async function getMileage(year, { client = supabase } = {}) {
  if (!hasMileage) return { mileage: [] };
  const mileage = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await client
      .from('mileage_log')
      .select('id, entity_id, on_date, miles, purpose')
      .gte('on_date', `${year}-01-01`)
      .lte('on_date', `${year}-12-31`)
      .order('on_date', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + page - 1);
    if (error) {
      if (isRangeExhaustedError(error)) break; // 416 = end-of-data (exact page multiple)
      if (isMissingTableError(error)) {
        hasMileage = false;
        return { mileage: [] };
      }
      throw error;
    }
    mileage.push(...(data || []));
    if (!data || data.length < page) break;
  }
  return { mileage };
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
