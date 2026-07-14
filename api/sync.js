import { getPlaidClient } from './_lib/plaid.js';
import { getServiceClient, requireUser } from './_lib/supabase.js';
import { mapPlaidCategory } from '../src/categoryMap.js';

const ALLOWED_TYPES = new Set(['depository', 'credit']);

function mapAccountRow(account, institutionId, householdId) {
  return {
    household_id: householdId,
    institution_id: institutionId,
    plaid_account_id: account.account_id,
    name: account.name || '',
    official_name: account.official_name || '',
    type: account.type || 'other',
    subtype: account.subtype || '',
    mask: account.mask || '',
    current_balance: account.balances?.current ?? null,
    available_balance: account.balances?.available ?? null,
    currency: account.balances?.iso_currency_code || 'USD',
    last_balance_at: new Date().toISOString(),
  };
}

function mapTransactionRow(tx, accountUuid, householdId) {
  const primary = tx.personal_finance_category?.primary || '';
  const detailed = tx.personal_finance_category?.detailed || '';
  return {
    household_id: householdId,
    account_id: accountUuid,
    plaid_tx_id: tx.transaction_id,
    date: tx.date,
    amount: tx.amount,
    merchant_name: tx.merchant_name || '',
    description: tx.name || '',
    raw_category: detailed || primary,
    mapped_category: mapPlaidCategory(primary, detailed),
    pending: !!tx.pending,
    pulled_at: new Date().toISOString(),
  };
}

async function syncOneInstitution(supabase, inst, accessToken, householdId) {
  const plaid = getPlaidClient(inst.plaid_credential_key);

  let cursor = inst.sync_state?.cursor || null;
  let added = [];
  let modified = [];
  let removed = [];
  let accounts = [];
  let hasMore = true;
  let safety = 0;

  while (hasMore) {
    if (safety++ > 50) {
      console.warn('[sync] pagination safety break for institution', inst.id);
      break;
    }
    const request = { access_token: accessToken };
    if (cursor) request.cursor = cursor;
    const resp = (await plaid.transactionsSync(request)).data;
    added = added.concat(resp.added || []);
    modified = modified.concat(resp.modified || []);
    removed = removed.concat(resp.removed || []);
    if (resp.accounts) accounts = resp.accounts;
    cursor = resp.next_cursor || cursor;
    hasMore = !!resp.has_more;
  }

  const accountRows = accounts
    .filter(a => ALLOWED_TYPES.has(a.type))
    .map(a => mapAccountRow(a, inst.id, householdId));
  if (accountRows.length) {
    const { error } = await supabase
      .from('accounts')
      .upsert(accountRows, { onConflict: 'institution_id,plaid_account_id' });
    if (error) throw error;
  }

  // Transactions reference accounts by our UUID, not Plaid's account_id.
  const { data: accountList, error: mapErr } = await supabase
    .from('accounts')
    .select('id, plaid_account_id')
    .eq('institution_id', inst.id);
  if (mapErr) throw mapErr;
  const accountUuids = new Map(accountList.map(a => [a.plaid_account_id, a.id]));

  const txRows = [...added, ...modified]
    .filter(tx => accountUuids.has(tx.account_id))
    .map(tx => mapTransactionRow(tx, accountUuids.get(tx.account_id), householdId));
  if (txRows.length) {
    const { error } = await supabase
      .from('transactions')
      .upsert(txRows, { onConflict: 'account_id,plaid_tx_id' });
    if (error) throw error;
  }

  const removedIds = removed.map(r => r.transaction_id).filter(Boolean);
  if (removedIds.length) {
    const { error } = await supabase
      .from('transactions')
      .delete()
      .in('plaid_tx_id', removedIds)
      .in('account_id', [...accountUuids.values()]);
    if (error) throw error;
  }

  const { error: instErr } = await supabase
    .from('institutions')
    .update({
      sync_state: { cursor },
      last_successful_pull_at: new Date().toISOString(),
      status: 'active',
      last_error: null,
    })
    .eq('id', inst.id);
  if (instErr) throw instErr;

  return { added: added.length, modified: modified.length, removed: removedIds.length };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const supabase = getServiceClient();
    const { data: institutions, error: instErr } = await supabase
      .from('institutions')
      .select('id, name, plaid_credential_key, sync_state, status')
      .eq('household_id', user.householdId)
      .neq('status', 'disabled');
    if (instErr) throw instErr;

    const { data: tokens, error: tokenErr } = await supabase
      .from('plaid_tokens')
      .select('institution_id, access_token')
      .in('institution_id', institutions.map(i => i.id));
    if (tokenErr) throw tokenErr;
    const tokenByInst = new Map(tokens.map(t => [t.institution_id, t.access_token]));

    const results = [];
    for (const inst of institutions) {
      const accessToken = tokenByInst.get(inst.id);
      if (!accessToken) {
        results.push({ institution: inst.name, error: 'no access token' });
        continue;
      }
      try {
        const counts = await syncOneInstitution(supabase, inst, accessToken, user.householdId);
        results.push({ institution: inst.name, ...counts });
      } catch (err) {
        const plaidCode = err?.response?.data?.error_code;
        const needsReauth = plaidCode === 'ITEM_LOGIN_REQUIRED';
        console.error('[sync] failed for institution', inst.id, plaidCode || err);
        await supabase
          .from('institutions')
          .update({
            status: needsReauth ? 'needs_reauth' : 'error',
            last_error: plaidCode || err.message || 'Unknown error',
          })
          .eq('id', inst.id);
        results.push({
          institution: inst.name,
          error: plaidCode || err.message || 'Unknown error',
          needs_reauth: needsReauth,
        });
      }
    }

    return res.status(200).json({ results });
  } catch (err) {
    console.error('sync error', err?.response?.data || err);
    return res
      .status(500)
      .json({ error: err?.response?.data || err.message || 'Unknown error' });
  }
}
