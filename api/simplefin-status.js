import { getServiceClient, requireUser } from './_lib/supabase.js';
import { MIN_PULL_MINUTES } from './_lib/simplefin.js';

// Whether this household has SimpleFIN connected, and how the last pull went.
//
// The client can't read any of this itself: simplefin_access has zero RLS
// policies (it holds bank credentials). So this route reports *about* the
// stored access URL without ever revealing it — no URL, no host, no username.
//
// GET  → { connected, connections, last_pulled_at, last_error, institutions,
//          accounts, hidden_accounts, removed[], min_pull_minutes }
// POST { restore_institution_id } → undo a "Remove bank": clears the disabled
//          tombstone so the next pull recreates its accounts.
// DELETE → forget the stored access URL (stops all SimpleFIN syncing; leaves
//          already-imported accounts and transactions in place).
export default async function handler(req, res) {
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const user = await requireUser(req, res);
  if (!user) return;

  // The only GET route in api/ — and a cached "not connected" right after
  // connecting would be baffling. (public/sw.js already passes /api/* through.)
  res.setHeader('Cache-Control', 'no-store');

  try {
    const supabase = getServiceClient();

    // Removing a SimpleFIN bank only disables it (one access URL covers every
    // bank, so deleting the row would let the next pull recreate it). Without
    // this route that tombstone would be permanent — the bank could never be
    // brought back from inside the app.
    if (req.method === 'POST') {
      const { restore_institution_id } = req.body || {};
      if (!restore_institution_id) {
        return res.status(400).json({ error: 'restore_institution_id required' });
      }
      const { data, error } = await supabase
        .from('institutions')
        .update({ status: 'active', last_error: null })
        .eq('id', restore_institution_id)
        .eq('household_id', user.householdId)
        .not('simplefin_org_id', 'is', null)
        .select('id, name');
      if (error) throw error;
      if (!data?.length) {
        return res.status(404).json({ error: 'No such SimpleFIN bank in this household' });
      }
      return res.status(200).json({ ok: true, restored: data[0].name });
    }

    if (req.method === 'DELETE') {
      const { error } = await supabase
        .from('simplefin_access')
        .delete()
        .eq('household_id', user.householdId);
      if (error && !isMissingTable(error)) throw error;
      return res.status(200).json({ ok: true, connected: false });
    }

    const { data: access, error: accessErr } = await supabase
      .from('simplefin_access')
      .select('id, last_pulled_at, last_error')
      .eq('household_id', user.householdId)
      .order('created_at', { ascending: true });
    if (accessErr) {
      // Migration not pasted yet — report "not connected" rather than 500ing
      // the Accounts tab.
      if (isMissingTable(accessErr)) {
        return res.status(200).json({ connected: false, migration_pending: true });
      }
      throw accessErr;
    }

    const rows = access || [];
    const latest = rows.reduce(
      (acc, r) => (!acc || (r.last_pulled_at || '') > (acc.last_pulled_at || '') ? r : acc),
      null
    );

    // Account counts come from the institutions the SimpleFIN pull created, so
    // the UI can say "3 accounts, all hidden — unhide when you've compared them
    // against Plaid" without a second round trip.
    const { data: institutions, error: instErr } = await supabase
      .from('institutions')
      .select('id, name, status')
      .eq('household_id', user.householdId)
      .not('simplefin_org_id', 'is', null);
    if (instErr && !isMissingColumn(instErr)) throw instErr;

    const active = (institutions || []).filter(i => i.status !== 'disabled');
    const removed = (institutions || [])
      .filter(i => i.status === 'disabled')
      .map(i => ({ id: i.id, name: i.name }));
    let accounts = 0;
    let hidden = 0;
    if (active.length) {
      const { data: acctRows, error: acctErr } = await supabase
        .from('accounts')
        .select('id, hidden')
        .in('institution_id', active.map(i => i.id));
      if (acctErr) throw acctErr;
      accounts = (acctRows || []).length;
      hidden = (acctRows || []).filter(a => a.hidden).length;
    }

    return res.status(200).json({
      connected: rows.length > 0,
      connections: rows.length,
      last_pulled_at: latest?.last_pulled_at || null,
      last_error: latest?.last_error || null,
      institutions: active.length,
      accounts,
      hidden_accounts: hidden,
      removed,
      min_pull_minutes: MIN_PULL_MINUTES,
    });
  } catch (err) {
    console.error('simplefin-status error', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}

function isMissingTable(error) {
  return error?.code === 'PGRST205' || error?.code === '42P01';
}

function isMissingColumn(error) {
  return error?.code === 'PGRST204' || error?.code === '42703';
}
