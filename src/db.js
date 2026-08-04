import { supabase } from './supabaseClient.js';

// Household-scoped key/value settings (dashboard colors, names, custom
// categories). Same getSetting/setSetting API the app used with Dexie,
// now backed by the Supabase settings table so preferences follow the
// household across devices.

export async function getSetting(key) {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) throw error;
  return data ? data.value : null;
}

export async function setSetting(key, value) {
  const { error } = await supabase
    .from('settings')
    .upsert({ key, value }, { onConflict: 'household_id,key' });
  if (error) throw error;
}

// Multi-key read in one round trip (getBudgetIncome reads a default + a
// per-month override together). Returns { key: value } for the rows that
// exist; absent keys are simply absent.
export async function getSettings(keys) {
  const { data, error } = await supabase
    .from('settings')
    .select('key, value')
    .in('key', keys);
  if (error) throw error;
  const byKey = {};
  for (const row of data || []) byKey[row.key] = row.value;
  return byKey;
}

// Delete path (setBudgetIncome clears overrides by removing the row — an
// upserted empty string would read differently from "no row").
export async function deleteSetting(key) {
  const { error } = await supabase.from('settings').delete().eq('key', key);
  if (error) throw error;
}
