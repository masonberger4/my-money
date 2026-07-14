import { getPlaidClient } from './_lib/plaid.js';
import { getServiceClient, requireUser } from './_lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const user = await requireUser(req, res);
  if (!user) return;

  const { public_token, credential_key, institution_name } = req.body || {};
  if (!public_token || !credential_key) {
    return res
      .status(400)
      .json({ error: 'public_token and credential_key required' });
  }

  try {
    const plaid = getPlaidClient(credential_key);
    const response = await plaid.itemPublicTokenExchange({ public_token });
    const accessToken = response.data.access_token;
    const itemId = response.data.item_id;

    const supabase = getServiceClient();
    const { data: institution, error: instErr } = await supabase
      .from('institutions')
      .insert({
        household_id: user.householdId,
        name: institution_name || 'Bank',
        plaid_credential_key: credential_key,
        plaid_item_id: itemId,
      })
      .select('id')
      .single();
    if (instErr) throw instErr;

    const { error: tokenErr } = await supabase
      .from('plaid_tokens')
      .insert({ institution_id: institution.id, access_token: accessToken });
    if (tokenErr) {
      // Don't leave an institution row without a token — it could never sync.
      await supabase.from('institutions').delete().eq('id', institution.id);
      throw tokenErr;
    }

    return res.status(200).json({ institution_id: institution.id });
  } catch (err) {
    console.error('exchange-token error', err?.response?.data || err);
    return res
      .status(500)
      .json({ error: err?.response?.data || err.message || 'Unknown error' });
  }
}
