import { db } from './db.js';
import { syncTransactions, getBalances } from './plaidClient.js';
import { mapPlaidCategory } from './categoryMap.js';

const ALLOWED_TYPES = new Set(['depository', 'credit']);

function mapPlaidAccount(account, institutionId) {
  return {
    plaidAccountId: account.account_id,
    institutionId,
    name: account.name || '',
    officialName: account.official_name || '',
    type: account.type || '',
    subtype: account.subtype || '',
    currentBalance: account.balances?.current ?? null,
    availableBalance: account.balances?.available ?? null,
    mask: account.mask || '',
    lastUpdated: new Date().toISOString(),
  };
}

function mapPlaidTransaction(tx) {
  const primary = tx.personal_finance_category?.primary || '';
  const detailed = tx.personal_finance_category?.detailed || '';
  return {
    plaidTxId: tx.transaction_id,
    accountId: tx.account_id,
    date: tx.date,
    amount: tx.amount,
    merchantName: tx.merchant_name || '',
    name: tx.name || '',
    plaidCategory: detailed || primary,
    mappedCategory: mapPlaidCategory(primary, detailed),
    pending: !!tx.pending,
  };
}

async function syncOneInstitution(inst) {
  let cursor = inst.cursor || null;
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
    const resp = await syncTransactions(inst.accessToken, cursor);
    added = added.concat(resp.added || []);
    modified = modified.concat(resp.modified || []);
    removed = removed.concat(resp.removed || []);
    if (resp.accounts) accounts = resp.accounts;
    cursor = resp.next_cursor || cursor;
    hasMore = !!resp.has_more;
  }

  await db.transaction('rw', db.transactions, db.accounts, db.institutions, async () => {
    if (accounts.length) {
      const accountRows = accounts
        .filter(a => ALLOWED_TYPES.has(a.type))
        .map(a => mapPlaidAccount(a, inst.id));
      if (accountRows.length) await db.accounts.bulkPut(accountRows);
    }
    const toPut = [...added, ...modified].map(mapPlaidTransaction);
    if (toPut.length) await db.transactions.bulkPut(toPut);
    const toRemove = removed.map(r => r.transaction_id).filter(Boolean);
    if (toRemove.length) await db.transactions.bulkDelete(toRemove);
    await db.institutions.update(inst.id, {
      cursor,
      lastSync: new Date().toISOString(),
    });
  });

  return { added: added.length, modified: modified.length, removed: removed.length };
}

async function refreshBalances(inst) {
  try {
    const { accounts } = await getBalances(inst.accessToken);
    const rows = (accounts || [])
      .filter(a => ALLOWED_TYPES.has(a.type))
      .map(a => mapPlaidAccount(a, inst.id));
    if (rows.length) await db.accounts.bulkPut(rows);
  } catch (err) {
    console.warn('[sync] balance refresh failed for institution', inst.id, err);
  }
}

let syncInFlight = null;

export function runSync() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    try {
      const institutions = await db.institutions.toArray();
      for (const inst of institutions) {
        try {
          await syncOneInstitution(inst);
        } catch (err) {
          console.error('[sync] transactions sync failed for institution', inst.id, err);
          // TODO: handle ITEM_LOGIN_REQUIRED / update-mode re-auth
        }
        await refreshBalances(inst);
      }
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}
