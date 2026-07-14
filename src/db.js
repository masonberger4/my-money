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
