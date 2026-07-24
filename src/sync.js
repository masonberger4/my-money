import { runServerSync } from './plaidClient.js';

// The sync itself runs server-side (api/sync.js): the server holds the Plaid
// access tokens and the SimpleFIN access URL, and writes accounts/transactions
// straight to Supabase. This wrapper just triggers it and keeps the
// single-flight behavior the UI relies on.

let syncInFlight = null;

async function execute(force) {
  const { results } = await runServerSync({ force });
  const failures = (results || []).filter(r => r.error);
  for (const f of failures) {
    console.warn('[sync] institution failed:', f.institution, f.error);
  }
  return { results, failures };
}

// opts.force bypasses the server-side SimpleFIN pull throttle (a pull is
// normally skipped if one ran in the last hour — SimpleFIN only refreshes bank
// data about once a day). Forced syncs also skip the single-flight dedupe:
// they're deliberate user actions like "I just connected a bank", and folding
// one into an already-running background sync would silently drop the force.
export function runSync({ force = false } = {}) {
  if (force) return execute(true);
  if (syncInFlight) return syncInFlight;
  syncInFlight = execute(false).finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}
