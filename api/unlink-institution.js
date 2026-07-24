import { getPlaidClient } from './_lib/plaid.js';
import { getServiceClient, requireUser } from './_lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const user = await requireUser(req, res);
  if (!user) return;

  const { institution_id } = req.body || {};
  if (!institution_id) {
    return res.status(400).json({ error: 'institution_id required' });
  }

  try {
    const supabase = getServiceClient();
    let inst;
    let instErr;
    ({ data: inst, error: instErr } = await supabase
      .from('institutions')
      .select('id, name, plaid_credential_key, household_id, simplefin_org_id')
      .eq('id', institution_id)
      .eq('household_id', user.householdId)
      .maybeSingle());
    // Tolerate a deploy that lands before the SimpleFIN migration.
    if (instErr && (instErr.code === 'PGRST204' || instErr.code === '42703')) {
      ({ data: inst, error: instErr } = await supabase
        .from('institutions')
        .select('id, name, plaid_credential_key, household_id')
        .eq('id', institution_id)
        .eq('household_id', user.householdId)
        .maybeSingle());
    }
    if (instErr) throw instErr;
    if (!inst) {
      return res.status(404).json({ error: 'Institution not found' });
    }

    // SimpleFIN institutions can't be unlinked by deleting the row. One access
    // URL covers EVERY bank linked at the Bridge, so the very next pull would
    // find this org again and recreate it. Instead: drop its accounts (which
    // cascades their transactions) and keep the institution as a disabled
    // tombstone — api/sync.js skips disabled institutions, so the org stays out
    // of the app until the user reconnects it. To stop the bank feeding
    // SimpleFIN at all, they remove it at SimpleFIN Bridge.
    if (inst.simplefin_org_id) {
      const { error: acctErr } = await supabase
        .from('accounts')
        .delete()
        .eq('institution_id', inst.id);
      if (acctErr) throw acctErr;

      const { error: disableErr } = await supabase
        .from('institutions')
        .update({ status: 'disabled', last_error: null, sync_state: {} })
        .eq('id', inst.id);
      if (disableErr) throw disableErr;

      return res.status(200).json({ ok: true, plaid_removed: false, disabled: true });
    }

    const { data: token } = await supabase
      .from('plaid_tokens')
      .select('access_token')
      .eq('institution_id', inst.id)
      .maybeSingle();

    // Remove the Item on Plaid's side first — this frees the free-tier slot
    // and stops the bank connection. If Plaid already considers it gone
    // (expired, previously removed), proceed with local deletion anyway.
    let plaidRemoved = false;
    if (token?.access_token) {
      try {
        const plaid = getPlaidClient(inst.plaid_credential_key);
        await plaid.itemRemove({ access_token: token.access_token });
        plaidRemoved = true;
      } catch (err) {
        console.warn(
          'itemRemove failed (continuing with local delete)',
          err?.response?.data?.error_code || err.message
        );
      }
    }

    // Cascades: accounts, transactions, plaid_tokens.
    const { error: delErr } = await supabase
      .from('institutions')
      .delete()
      .eq('id', inst.id);
    if (delErr) throw delErr;

    return res.status(200).json({ ok: true, plaid_removed: plaidRemoved });
  } catch (err) {
    console.error('unlink-institution error', err?.response?.data || err);
    return res
      .status(500)
      .json({ error: err?.response?.data || err.message || 'Unknown error' });
  }
}
