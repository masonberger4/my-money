import { getServiceClient, requireUser } from './_lib/supabase.js';
import { decodeSetupToken, claimAccessUrl, fetchAccountSet, sanitizeFeedMessage } from './_lib/simplefin.js';

function isMissingColumn(error, name) {
  const blob = `${error?.message || ''} ${error?.details || ''}`.toLowerCase();
  return blob.includes(String(name).toLowerCase()) &&
    (error?.code === 'PGRST204' || error?.code === '42703' || /column/.test(blob));
}

// Exchange a SimpleFIN setup token for a durable access URL and store it.
//
// This is SimpleFIN's answer to Plaid's create-link-token + exchange-token
// pair, and it is much smaller: the user links their banks on SimpleFIN
// Bridge's own hosted page, copies the setup token it prints, and pastes it
// here. There is no client-side SDK and no public token round trip.
//
// The claimed access URL embeds HTTP Basic bank credentials, so it is written
// with the service-role client into simplefin_access, a table with RLS on and
// ZERO policies. It is never returned to the browser — not even truncated.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const user = await requireUser(req, res);
  if (!user) return;

  const { setup_token } = req.body || {};
  if (!setup_token || typeof setup_token !== 'string') {
    return res.status(400).json({ error: 'setup_token required' });
  }

  try {
    // Users paste all three of these, so accept all three: a setup token, the
    // claim URL it decodes to, or an access URL they already hold.
    // Async since the host check gained DNS resolution (a public-looking name
    // with a private A record is rejected here, before anything is stored).
    const decoded = await decodeSetupToken(setup_token);
    const accessUrl =
      decoded.kind === 'access' ? decoded.url : await claimAccessUrl(decoded.url);

    // STORE FIRST, probe second. A claim URL is single-use: once claimAccessUrl
    // succeeds, this access URL is the only one that token will ever produce.
    // Verifying before persisting would mean a flaky first GET — Bridge still
    // mid-refresh, a timeout — throws the URL away for good and forces the user
    // back to Bridge for a fresh token. So persist, then probe, and report a
    // probe failure as a warning on a connection that exists.
    const supabase = getServiceClient();
    // household_id has no column default here: this runs as service_role, where
    // auth.uid() is NULL and current_household_id() would resolve to NULL.
    //
    // Reset the clocks: the first pull should reach back for full history
    // rather than inheriting a watermark from a previous connection, and it
    // must not be throttled by an old attempt. last_attempt_at was added to the
    // migration after it was first published, so tolerate its absence.
    const base = {
      household_id: user.householdId,
      access_url: accessUrl,
      last_pulled_at: null,
      last_error: null,
    };
    const save = row =>
      supabase.from('simplefin_access').upsert(row, { onConflict: 'household_id,access_url' });

    let { error } = await save({ ...base, last_attempt_at: null });
    if (error && isMissingColumn(error, 'last_attempt_at')) {
      ({ error } = await save(base));
    }
    if (error) {
      if (error.code === 'PGRST205' || error.code === '42P01') {
        return res.status(503).json({
          error: 'migration_pending',
          message:
            'The SimpleFIN tables are not in the database yet. Run the ' +
            'supabase/migrations/20260724000001_simplefin.sql migration, then try again.',
        });
      }
      throw error;
    }

    // Cheap confidence check (balances-only, no transactions) so the UI can say
    // how many accounts the feed can see. Never fatal — the connection is
    // already saved and api/sync.js will retry on its own schedule.
    let accountCount = null;
    let warning = null;
    try {
      const probe = await fetchAccountSet(accessUrl, { balancesOnly: true });
      accountCount = Array.isArray(probe?.accounts) ? probe.accounts.length : 0;
    } catch (probeErr) {
      // probeErr.message can embed remote body bytes (http_error/bad_response
      // include a slice of whatever the server sent) — sanitize even the log.
      console.warn(
        'simplefin-claim stored, first read failed:',
        probeErr?.code,
        sanitizeFeedMessage(probeErr?.message)
      );
      warning = sanitizeFeedMessage(probeErr?.message) || 'Connected, but the first read from SimpleFIN failed.';
    }

    return res.status(200).json({ ok: true, accounts: accountCount, ...(warning ? { warning } : {}) });
  } catch (err) {
    if (err?.name === 'SimpleFinError') {
      console.warn('simplefin-claim rejected:', err.code, sanitizeFeedMessage(err.message));
      return res.status(400).json({ error: err.code, message: sanitizeFeedMessage(err.message) });
    }
    // Full error stays in the server log; the client gets a generic string +
    // stable code (raw err.message can carry schema/PostgREST details — the
    // SimpleFinError branch above already sanitizes the feed-facing path).
    console.error('simplefin-claim error', err);
    return res.status(500).json({ error: 'claim_failed', message: 'Connecting failed — try again.' });
  }
}
