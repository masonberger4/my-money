import { getPlaidClient } from './_lib/plaid.js';
import { getServiceClient, requireUser } from './_lib/supabase.js';
import {
  fetchAccountSet,
  normalizeAccountSet,
  inferAccountType,
  normalizeBalance,
  sanitizeFeedMessage,
  SFIN_PREFIX,
  FIRST_PULL_DAYS,
  OVERLAP_DAYS,
  MIN_PULL_MINUTES,
  INCLUDE_PENDING,
} from './_lib/simplefin.js';
import { mapPlaidCategory } from '../src/categoryMap.js';
import { classifyDescription } from '../src/txClassify.js';

// depository + credit fund the spending/cash-flow views; loan lets linked
// debts (mortgage, student/personal loans) sync their balances for the debt
// tracker. Loan accounts carry sparse/no transaction rows — under Plaid their
// real data (APR, minimum payment, due date) comes from the Liabilities
// product; under SimpleFIN it is hand-entered.
const ALLOWED_TYPES = new Set(['depository', 'credit', 'loan']);

const DAY_MS = 86_400_000;

// transactions.source landed with the CSV-import migration; tolerate its
// absence the way the importer does. Module scope so a warm invocation only
// has to learn it once.
let txHaveSource = true;

// PostgREST/Postgres codes for "that column/table isn't there". Previews share
// the production database, so every write has to survive the window between a
// branch deploying and Mason pasting its migration.
function isMissingSchemaError(error, name) {
  if (!error) return false;
  const blob = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`.toLowerCase();
  // The name must appear: PostgREST names the missing column/table in the
  // message, and matching on the code alone would let a DIFFERENT missing
  // column be mistaken for the optional one and silently dropped.
  if (!blob.includes(String(name).toLowerCase())) return false;
  if (['PGRST204', 'PGRST205', '42703', '42P01'].includes(error.code)) return true;
  return /column|table|schema cache/.test(blob);
}

// =============================================================================
// Plaid
// =============================================================================

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

// =============================================================================
// SimpleFIN
//
// Where Plaid gives one access token per institution and a per-institution
// cursor, SimpleFIN gives ONE access URL covering every bank the user linked at
// the Bridge, fetched in a single GET with no cursor and no pagination. So this
// pass is per-access-URL, not per-institution: pull once, then fan the response
// out into institutions (per SimpleFIN org), accounts and transactions.
// =============================================================================

// Read the household's stored access URLs. Returns null — not an error — when
// the SimpleFIN migration hasn't been pasted yet.
async function loadAccessRows(supabase, householdId) {
  const { data, error } = await supabase
    .from('simplefin_access')
    .select('id, access_url, last_pulled_at, last_attempt_at')
    .eq('household_id', householdId);
  if (error) {
    if (isMissingSchemaError(error, 'simplefin_access')) return null;
    throw error;
  }
  return data || [];
}

// Find-or-create one institution row per SimpleFIN org. Returns a Map of
// orgKey → { id, disabled }. A disabled institution is one the user removed
// from the app (see api/unlink-institution.js): its org stays on the feed
// because the access URL is shared, so the row is kept as a tombstone and its
// accounts are never recreated.
async function resolveOrgInstitutions(supabase, householdId, orgs) {
  const { data: existing, error } = await supabase
    .from('institutions')
    .select('id, simplefin_org_id, status')
    .eq('household_id', householdId)
    .not('simplefin_org_id', 'is', null);
  if (error) throw error;

  const byKey = new Map();
  for (const inst of existing || []) {
    byKey.set(inst.simplefin_org_id, { id: inst.id, disabled: inst.status === 'disabled' });
  }

  const missing = orgs.filter(o => !byKey.has(o.key));
  if (missing.length) {
    const { data: inserted, error: insErr } = await supabase
      .from('institutions')
      .insert(
        missing.map(o => ({
          household_id: householdId,
          name: o.label,
          simplefin_org_id: o.key,
          status: 'active',
        }))
      )
      .select('id, simplefin_org_id');
    if (insErr) throw insErr;
    for (const inst of inserted || []) {
      byKey.set(inst.simplefin_org_id, { id: inst.id, disabled: false });
    }
  }
  return byKey;
}

async function pullOneAccessUrl(supabase, householdId, accessRow, { force }) {
  const now = new Date();
  const lastPulled = accessRow.last_pulled_at ? new Date(accessRow.last_pulled_at) : null;
  // Throttle on the last ATTEMPT, not the last success — otherwise a broken
  // connection would be retried on every dashboard load forever.
  const lastAttempt = accessRow.last_attempt_at ? new Date(accessRow.last_attempt_at) : null;

  if (!force && lastAttempt && now.getTime() - lastAttempt.getTime() < MIN_PULL_MINUTES * 60_000) {
    return {
      institution: 'SimpleFIN',
      skipped: 'throttled',
      last_pulled_at: lastPulled ? lastPulled.toISOString() : null,
    };
  }

  // Incremental: re-request an overlap window because a bank can amend or
  // late-post a transaction inside a date we already pulled. Re-seeing a row is
  // free — the upsert lands on the same (account_id, plaid_tx_id).
  const floor = now.getTime() - FIRST_PULL_DAYS * DAY_MS;
  const startDate = new Date(
    lastPulled ? Math.max(lastPulled.getTime() - OVERLAP_DAYS * DAY_MS, floor) : floor
  );

  // Stamped before the request, so a timeout or a crashed invocation still
  // counts as an attempt and the throttle holds.
  const { error: attemptErr } = await supabase
    .from('simplefin_access')
    .update({ last_attempt_at: now.toISOString() })
    .eq('id', accessRow.id);
  if (attemptErr) throw attemptErr;

  const json = await fetchAccountSet(accessRow.access_url, {
    startDate,
    pending: INCLUDE_PENDING,
  });
  const { errors, accounts, skipped } = normalizeAccountSet(json);

  if (skipped) {
    console.warn('[sync:simplefin] skipped %d unusable account object(s)', skipped);
  }
  // SimpleFIN reports a broken bank connection as a free-text string in the
  // response body rather than an HTTP error, and keeps returning the accounts
  // it *can* reach. Nothing back at all plus an error means the pull failed.
  if (errors.length && accounts.length === 0) {
    throw new Error(`SimpleFIN reported: ${errors.join('; ')}`);
  }

  // ---- institutions, one per org -------------------------------------------
  const orgs = [];
  const seenOrg = new Set();
  for (const acct of accounts) {
    const key = acct.org.key || 'unknown';
    if (seenOrg.has(key)) continue;
    seenOrg.add(key);
    orgs.push({ key, label: acct.org.label });
  }
  const instByOrg = await resolveOrgInstitutions(supabase, householdId, orgs);

  // ---- accounts -------------------------------------------------------------
  const { data: existingRows, error: acctErr } = await supabase
    .from('accounts')
    .select('id, plaid_account_id, institution_id, type, subtype, current_balance')
    .eq('household_id', householdId)
    .like('plaid_account_id', `${SFIN_PREFIX}%`);
  if (acctErr) throw acctErr;
  const existingByExternal = new Map((existingRows || []).map(a => [a.plaid_account_id, a]));

  const toInsert = [];
  const toUpdate = [];
  const usable = [];
  let ignoredTypes = 0;

  // A response that listed the same account twice would build the same
  // transaction rows twice, and Postgres rejects an upsert whose payload hits
  // one row twice ("ON CONFLICT DO UPDATE command cannot affect row a second
  // time") — which would fail the entire sync, not just the duplicate.
  const seenAccount = new Set();

  for (const acct of accounts) {
    const inst = instByOrg.get(acct.org.key || 'unknown');
    if (!inst || inst.disabled) continue;

    const externalId = SFIN_PREFIX + acct.externalId;
    if (seenAccount.has(externalId)) continue;
    seenAccount.add(externalId);
    const existing = existingByExternal.get(externalId);

    // The account's type is INSERT-ONLY. SimpleFIN sends no type at all, so it
    // is guessed from the name once; after that it is user-owned (the Accounts
    // tab can correct it) and the feed must never clobber the correction —
    // the same rule that protects nickname/color/hidden.
    const guessed = existing ? null : inferAccountType(acct.name, acct.org);
    const type = existing ? existing.type : guessed.type;
    const subtype = existing ? existing.subtype : guessed.subtype;

    if (!ALLOWED_TYPES.has(type)) {
      ignoredTypes++;
      continue;
    }

    const balance = normalizeBalance(type, acct.balance);
    if ((type === 'credit' || type === 'loan') && acct.balance != null) {
      // The debt-balance sign convention is the one thing the protocol doesn't
      // pin down (see normalizeBalance). Log both so a real card can settle it.
      console.log(
        '[sync:simplefin] debt balance %s: feed=%s stored=%s (verify the sign)',
        acct.name,
        acct.balance,
        balance
      );
    }

    usable.push({ acct, externalId });

    // available-balance is omitted when it equals the balance, so fall back
    // rather than nulling it out.
    const available = acct.availableBalance ?? balance;

    if (existing) {
      toUpdate.push({
        id: existing.id,
        patch: {
          name: acct.name,
          currency: acct.currency,
          // A degraded connection can return the account with a blank balance.
          // parseMoney maps that to null (deliberately — absent must not read
          // as zero), but writing the null over a known balance would show the
          // account as $0.00 in every view. Keep the last known good instead.
          ...(balance == null ? {} : { current_balance: balance }),
          ...(available == null ? {} : { available_balance: available }),
          ...(balance == null
            ? {}
            : { last_balance_at: acct.balanceDate || now.toISOString() }),
          // Re-home the account if its org now resolves to a different
          // institution — e.g. the Bridge flipped protocol version and the org
          // id moved. Without this the account would be stranded under the old
          // institution while a new empty one sat beside it.
          ...(existing.institution_id !== inst.id ? { institution_id: inst.id } : {}),
        },
      });
    } else {
      toInsert.push({
        household_id: householdId,
        institution_id: inst.id,
        plaid_account_id: externalId,
        name: acct.name,
        official_name: '',
        type,
        subtype,
        // SimpleFIN sends no mask, and the name often already ends in the last
        // four digits — leaving it empty avoids "Checking 1234 ··1234" labels.
        mask: '',
        current_balance: balance,
        available_balance: available,
        currency: acct.currency,
        last_balance_at: acct.balanceDate || now.toISOString(),
        // Hidden on arrival, on purpose. While SimpleFIN runs ALONGSIDE Plaid,
        // a bank connected to both would otherwise land its transactions twice
        // and silently double every total in the dashboard. Hidden accounts are
        // fully browsable in the Accounts tab but excluded from spending,
        // trends and totals, so the two feeds can be compared before switching
        // over. Unhiding is a deliberate, one-tap act — and `hidden` is
        // user-owned, so no later sync re-hides it.
        hidden: true,
      });
    }
  }

  if (toInsert.length) {
    const { error } = await supabase
      .from('accounts')
      .upsert(toInsert, {
        onConflict: 'institution_id,plaid_account_id',
        ignoreDuplicates: true,
      });
    if (error) throw error;
  }
  for (const { id, patch } of toUpdate) {
    // One statement per account (there are only ever a handful) rather than a
    // bulk upsert: a bulk upsert would have to restate type/subtype/hidden in
    // every row, which is exactly what must not be overwritten.
    const { error } = await supabase.from('accounts').update(patch).eq('id', id);
    if (error) throw error;
  }

  // ---- transactions ---------------------------------------------------------
  const { data: idRows, error: idErr } = await supabase
    .from('accounts')
    .select('id, plaid_account_id')
    .eq('household_id', householdId)
    .like('plaid_account_id', `${SFIN_PREFIX}%`);
  if (idErr) throw idErr;
  const uuidByExternal = new Map((idRows || []).map(a => [a.plaid_account_id, a.id]));

  const txRows = [];
  // Same duplicate hazard as accounts, one level down: a repeated transaction
  // id inside one account would make the upsert touch a row twice and abort.
  const seenTx = new Set();
  const collect = normalizedAccounts => {
    for (const acct of normalizedAccounts) {
      const accountUuid = uuidByExternal.get(SFIN_PREFIX + acct.externalId);
      if (!accountUuid) continue;
      for (const tx of acct.transactions) {
        const dedupKey = `${accountUuid}|${tx.externalId}`;
        if (seenTx.has(dedupKey)) continue;
        seenTx.add(dedupKey);
        // SimpleFIN ships no category, so it is derived from the descriptor at
        // write time — the same keyword table the CSV importer uses. `payee` is
        // the cleaner merchant string when the server sends one; memo is left
        // out because freeform text ("transfer for rent") would mislabel bills.
        const descriptor =
          tx.payee && tx.payee !== tx.description
            ? `${tx.payee} ${tx.description}`
            : tx.description;
        const { raw_category, mapped_category } = classifyDescription(descriptor, tx.amount);
        txRows.push({
          household_id: householdId,
          account_id: accountUuid,
          plaid_tx_id: SFIN_PREFIX + tx.externalId,
          date: tx.date,
          amount: tx.amount,
          merchant_name: tx.payee || '',
          description: tx.description,
          raw_category,
          mapped_category,
          pending: tx.pending,
          pulled_at: now.toISOString(),
        });
      }
    }
  };
  collect(usable.map(u => u.acct));

  // Backfill accounts we're seeing for the first time. One access URL covers
  // every bank linked at the Bridge, so a bank added there later just shows up
  // in a later pull — and that pull's start-date came from the shared
  // watermark, which would cap the newcomer at the 30-day overlap. Re-request
  // full history, scoped to only the new accounts (`account` is a repeatable
  // param) so this costs one extra call the first time a bank appears.
  const backfillIds = toInsert
    .map(r => String(r.plaid_account_id).slice(SFIN_PREFIX.length))
    .filter(Boolean);
  if (backfillIds.length && lastPulled) {
    try {
      const history = await fetchAccountSet(accessRow.access_url, {
        startDate: new Date(floor),
        pending: INCLUDE_PENDING,
        accountIds: backfillIds,
      });
      const before = txRows.length;
      collect(normalizeAccountSet(history).accounts);
      console.log(
        '[sync:simplefin] backfilled %d row(s) of history for %d new account(s)',
        txRows.length - before,
        backfillIds.length
      );
    } catch (err) {
      // Not fatal: the accounts and their recent transactions are already
      // written, and the next pull can be forced to try the backfill again.
      console.warn('[sync:simplefin] history backfill failed', err?.message || err);
    }
  }

  let written = 0;
  const batch = 500;
  for (let i = 0; i < txRows.length; i += batch) {
    const slice = txRows.slice(i, i + batch);
    const attempt = withSource =>
      supabase
        .from('transactions')
        .upsert(
          withSource ? slice.map(r => ({ ...r, source: 'simplefin' })) : slice,
          { onConflict: 'account_id,plaid_tx_id' }
        );

    let { error } = await attempt(txHaveSource);
    if (error && txHaveSource && isMissingSchemaError(error, 'source')) {
      txHaveSource = false;
      ({ error } = await attempt(false));
    }
    if (error) throw error;
    written += slice.length;
  }

  // ---- bookkeeping ----------------------------------------------------------
  const instIds = [...new Set(usable.map(u => instByOrg.get(u.acct.org.key || 'unknown')?.id))].filter(
    Boolean
  );
  if (instIds.length) {
    const { error } = await supabase
      .from('institutions')
      .update({
        last_successful_pull_at: now.toISOString(),
        status: 'active',
        last_error: null,
      })
      .in('id', instIds);
    if (error) throw error;
  }

  // Advance the data watermark ONLY on a completely clean pull. A partial
  // failure comes back as HTTP 200 with the reachable banks plus an error
  // string for the broken one — moving the watermark then would leave the
  // broken bank's outage window behind forever once it exceeded the 30-day
  // overlap. Leaving it put means the next pull re-requests from where the
  // last good one ended; startDate is floored at FIRST_PULL_DAYS so a bank the
  // user never fixes can't grow the window without bound.
  const clean = errors.length === 0;
  const { error: accessErr } = await supabase
    .from('simplefin_access')
    .update({
      ...(clean ? { last_pulled_at: now.toISOString() } : {}),
      last_error: clean ? null : errors.join('; ').slice(0, 1000),
    })
    .eq('id', accessRow.id);
  if (accessErr) throw accessErr;

  return {
    institution: 'SimpleFIN',
    institutions: instIds.length,
    accounts: usable.length,
    accounts_created: toInsert.length,
    ignored_accounts: ignoredTypes,
    transactions: written,
    ...(errors.length ? { warnings: errors } : {}),
  };
}

async function syncSimpleFin(supabase, householdId, { force }) {
  const accessRows = await loadAccessRows(supabase, householdId);
  if (accessRows === null || accessRows.length === 0) return [];

  const results = [];
  for (const row of accessRows) {
    try {
      results.push(await pullOneAccessUrl(supabase, householdId, row, { force }));
    } catch (err) {
      const message = err?.message || 'Unknown error';
      console.error('[sync:simplefin] pull failed', err);
      // Record the failure but leave last_pulled_at alone: advancing the
      // watermark on a failed pull would skip past transactions we never read.
      // Sanitized because last_error is rendered in the connect modal and a
      // database error can quote feed-supplied text (an account name, say).
      await supabase
        .from('simplefin_access')
        .update({ last_error: sanitizeFeedMessage(message) })
        .eq('id', row.id);
      results.push({
        institution: 'SimpleFIN',
        error: message,
        needs_reauth: err?.code === 'auth_failed',
      });
    }
  }
  return results;
}

// =============================================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const user = await requireUser(req, res);
  if (!user) return;

  const force = !!(req.body || {}).force;

  try {
    const supabase = getServiceClient();

    // simplefin_org_id is the feed discriminator; select it defensively so a
    // deploy that lands before its migration still syncs Plaid normally.
    let institutions;
    let instErr;
    ({ data: institutions, error: instErr } = await supabase
      .from('institutions')
      .select('id, name, plaid_credential_key, sync_state, status, simplefin_org_id')
      .eq('household_id', user.householdId)
      .neq('status', 'disabled'));
    if (instErr && isMissingSchemaError(instErr, 'simplefin_org_id')) {
      ({ data: institutions, error: instErr } = await supabase
        .from('institutions')
        .select('id, name, plaid_credential_key, sync_state, status')
        .eq('household_id', user.householdId)
        .neq('status', 'disabled'));
    }
    if (instErr) throw instErr;

    // Plaid-fed institutions only. A SimpleFIN-fed one has no plaid_tokens row,
    // so without this it would report a bogus "no access token" every sync.
    const plaidInstitutions = institutions.filter(i => !i.simplefin_org_id);

    // Guard the empty list: a household that has moved entirely to SimpleFIN
    // has no Plaid institutions left to look tokens up for.
    const tokenByInst = new Map();
    if (plaidInstitutions.length) {
      const { data: tokens, error: tokenErr } = await supabase
        .from('plaid_tokens')
        .select('institution_id, access_token')
        .in('institution_id', plaidInstitutions.map(i => i.id));
      if (tokenErr) throw tokenErr;
      for (const t of tokens || []) tokenByInst.set(t.institution_id, t.access_token);
    }

    const results = [];
    for (const inst of plaidInstitutions) {
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

    // A SimpleFIN failure must never take the Plaid results down with it.
    try {
      results.push(...(await syncSimpleFin(supabase, user.householdId, { force })));
    } catch (err) {
      console.error('[sync:simplefin] pass failed', err);
      results.push({ institution: 'SimpleFIN', error: err?.message || 'Unknown error' });
    }

    return res.status(200).json({ results });
  } catch (err) {
    console.error('sync error', err?.response?.data || err);
    return res
      .status(500)
      .json({ error: err?.response?.data || err.message || 'Unknown error' });
  }
}
