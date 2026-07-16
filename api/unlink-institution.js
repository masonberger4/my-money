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
    const { data: inst, error: instErr } = await supabase
      .from('institutions')
      .select('id, name, plaid_credential_key, household_id')
      .eq('id', institution_id)
      .eq('household_id', user.householdId)
      .maybeSingle();
    if (instErr) throw instErr;
    if (!inst) {
      return res.status(404).json({ error: 'Institution not found' });
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
