import { getPlaidClient, pickCredential, MAX_ITEMS_PER_CREDENTIAL } from './_lib/plaid.js';
import { getServiceClient, requireUser } from './_lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const supabase = getServiceClient();
    const { data: institutions, error } = await supabase
      .from('institutions')
      .select('id, plaid_credential_key')
      .eq('household_id', user.householdId);
    if (error) throw error;

    // Only institutions that actually hold a Plaid Item consume a slot. The
    // manual "Imported" institution (CSV import) and SimpleFIN-fed ones carry
    // plaid_credential_key's 'main' default but have no plaid_tokens row, so
    // counting institutions outright would burn phantom capacity and
    // eventually report "all credentials full" while Plaid still has room.
    let hasItem = new Set();
    if (institutions.length) {
      const { data: tokens, error: tokenErr } = await supabase
        .from('plaid_tokens')
        .select('institution_id')
        .in('institution_id', institutions.map(i => i.id));
      if (tokenErr) throw tokenErr;
      hasItem = new Set((tokens || []).map(t => t.institution_id));
    }

    const usedCounts = {};
    for (const inst of institutions) {
      if (!hasItem.has(inst.id)) continue;
      usedCounts[inst.plaid_credential_key] =
        (usedCounts[inst.plaid_credential_key] || 0) + 1;
    }

    const picked = pickCredential(usedCounts);
    if (!picked) {
      return res.status(409).json({
        error: 'plaid_capacity',
        message:
          `All Plaid credentials are at capacity (${MAX_ITEMS_PER_CREDENTIAL} ` +
          'Items each). Create a new Plaid developer account and add its ' +
          'client_id/secret to the PLAID_CREDENTIALS env var, then redeploy.',
      });
    }

    const plaid = getPlaidClient(picked.key);
    const response = await plaid.linkTokenCreate({
      user: { client_user_id: user.userId },
      client_name: 'my-money',
      products: ['transactions'],
      transactions: { days_requested: 730 },
      country_codes: ['US'],
      language: 'en',
    });

    return res.status(200).json({
      link_token: response.data.link_token,
      credential_key: picked.key,
      credential_used: picked.used,
      credential_capacity: picked.capacity,
    });
  } catch (err) {
    console.error('create-link-token error', err?.response?.data || err);
    return res
      .status(500)
      .json({ error: err?.response?.data || err.message || 'Unknown error' });
  }
}
