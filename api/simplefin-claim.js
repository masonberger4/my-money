import { getServiceClient, requireUser } from './_lib/supabase.js';
import { decodeSetupToken, claimAccessUrl, fetchAccountSet } from './_lib/simplefin.js';

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
    const decoded = decodeSetupToken(setup_token);
    const accessUrl =
      decoded.kind === 'access' ? decoded.url : await claimAccessUrl(decoded.url);

    // Prove the credentials work before storing them — balances-only keeps it
    // to a cheap call. A bad access URL saved here would fail silently on every
    // later sync with nothing pointing back at this moment.
    const probe = await fetchAccountSet(accessUrl, { balancesOnly: true });
    const accountCount = Array.isArray(probe?.accounts) ? probe.accounts.length : 0;

    const supabase = getServiceClient();
    // household_id has no column default here: this runs as service_role, where
    // auth.uid() is NULL and current_household_id() would resolve to NULL.
    const { error } = await supabase
      .from('simplefin_access')
      .upsert(
        {
          household_id: user.householdId,
          access_url: accessUrl,
          // Force the first pull to reach back for full history rather than
          // inheriting a watermark from a previous connection.
          last_pulled_at: null,
          last_error: null,
        },
        { onConflict: 'household_id,access_url' }
      );
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

    return res.status(200).json({ ok: true, accounts: accountCount });
  } catch (err) {
    if (err?.name === 'SimpleFinError') {
      console.warn('simplefin-claim rejected:', err.code, err.message);
      return res.status(400).json({ error: err.code, message: err.message });
    }
    console.error('simplefin-claim error', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
