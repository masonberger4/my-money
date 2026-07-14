import { runServerSync } from './plaidClient.js';

// The sync itself runs server-side (api/sync.js): the server holds the Plaid
// access tokens and writes accounts/transactions straight to Supabase. This
// wrapper just triggers it and keeps the single-flight behavior the UI relies on.

let syncInFlight = null;

export function runSync() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    try {
      const { results } = await runServerSync();
      const failures = (results || []).filter(r => r.error);
      for (const f of failures) {
        console.warn('[sync] institution failed:', f.institution, f.error);
      }
      return { results, failures };
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}
