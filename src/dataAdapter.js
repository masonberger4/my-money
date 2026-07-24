import { supabase } from './supabaseClient.js';
import { isTransferCategory, applyAccountRules } from './categoryMap.js';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function monthBounds(year, month) {
  const start = `${year}-${pad2(month)}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${pad2(month)}-${pad2(lastDay)}`;
  return { start, end };
}

function monthLabel(year, month) {
  return new Date(year, month - 1, 1).toLocaleString('default', {
    month: 'long',
    year: 'numeric',
  });
}

function shiftMonth(year, month, delta) {
  const d = new Date(year, month - 1 + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

const TX_COLUMNS =
  'id, plaid_tx_id, account_id, date, amount, merchant_name, description, mapped_category, raw_category, user_category, user_description, excluded, pending';

// User override wins over the Plaid-derived category.
function effectiveCategory(t) {
  return t.user_category || t.mapped_category || 'Shopping and gear';
}

// Some banks send masked descriptors ("****** *********"). Treat those as
// empty so the UI falls through to something readable.
function looksMasked(s) {
  return !!s && /^[\s*·.xX_-]+$/.test(s);
}

function displayName(t) {
  if (t.user_description) return t.user_description;
  const merchant = looksMasked(t.merchant_name) ? '' : t.merchant_name;
  const desc = looksMasked(t.description) ? '' : t.description;
  return merchant || desc || 'Card transaction';
}

const ACCOUNT_COLUMNS =
  'id, institution_id, plaid_account_id, name, official_name, nickname, color, mask, type, subtype, current_balance, available_balance, last_balance_at, hidden, institutions(name, display_name)';

async function getTransactionsBetween(start, end) {
  // RLS scopes every query to the signed-in household automatically.
  // The inner join on accounts drops transactions belonging to hidden
  // accounts from every dashboard view (spending, lists, trends).
  const rows = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('transactions')
      .select(`${TX_COLUMNS}, accounts!inner(hidden, type, subtype)`)
      .eq('accounts.hidden', false)
      .gte('date', start)
      .lte('date', end)
      .order('date', { ascending: false })
      .range(from, from + page - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < page) break;
  }
  // Credit-card refunds become "Return" — not income, not spending.
  for (const t of rows) {
    t.mapped_category = applyAccountRules(t.mapped_category, t.amount, t.accounts?.type);
  }
  markInternalTransfers(rows);
  return rows;
}

// Mark both legs of a transfer between the household's own deposit accounts
// (BECU checking ↔ savings) as `_internal` so cash-flow totals skip them.
// A Plaid TRANSFER_OUT on one depository account pairs with a TRANSFER_IN on a
// *different* depository account of the same amount within a few days (legs
// often post on different days). Restricting to TRANSFER_IN/OUT legs and to
// depository↔depository leaves real income (an unmatched deposit that merely
// arrives tagged TRANSFER_IN) and credit-card payments (checking → credit,
// which IS cash leaving checking) counted.
const INTERNAL_MATCH_WINDOW_DAYS = 4;

function dayNumber(iso) {
  const [y, m, d] = (iso || '').split('-').map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1) / 86400000;
}

// Exported so the CSV-import dry-run harness can verify washing against the
// real logic (a personal↔joint transfer pair cancels across CSV + Plaid legs).
export function markInternalTransfers(rows) {
  const outs = [];
  const insByAmount = new Map();
  for (const t of rows) {
    if (t.excluded || t.accounts?.type !== 'depository') continue;
    const raw = (t.raw_category || '').toUpperCase();
    if (t.amount > 0 && raw.startsWith('TRANSFER_OUT')) {
      outs.push(t);
    } else if (t.amount < 0 && raw.startsWith('TRANSFER_IN')) {
      const key = (-t.amount).toFixed(2);
      if (!insByAmount.has(key)) insByAmount.set(key, []);
      insByAmount.get(key).push(t);
    }
  }
  outs.sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const out of outs) {
    const candidates = insByAmount.get(out.amount.toFixed(2));
    if (!candidates) continue;
    let best = null;
    let bestGap = Infinity;
    for (const cand of candidates) {
      if (cand._internal || cand.account_id === out.account_id) continue;
      const gap = Math.abs(dayNumber(cand.date) - dayNumber(out.date));
      if (gap <= INTERNAL_MATCH_WINDOW_DAYS && gap < bestGap) {
        best = cand;
        bestGap = gap;
      }
    }
    if (best) {
      best._internal = true;
      out._internal = true;
    }
  }
}

function getMonthTransactions(year, month) {
  const { start, end } = monthBounds(year, month);
  return getTransactionsBetween(start, end);
}

function sumSpending(txs) {
  let total = 0;
  for (const t of txs) {
    if (t.excluded) continue;
    if (t.amount > 0 && !isTransferCategory(effectiveCategory(t))) total += t.amount;
  }
  return total;
}

// --- Trends cash flow (joint-budget view) ------------------------------------
// The Trends "income vs spending" chart measures cash moving through the
// household's *joint* accounts, treated as one budget:
//   income   = money arriving in the joint checking OR savings accounts
//   spending = money leaving the joint checking account (expenses are paid from
//              checking; money leaving savings is never an expense)
// Transfers between the joint checking and joint savings wash out
// (markInternalTransfers), so moving money to savings isn't "spending" and
// moving it back isn't "income". Money the household moves in from its own
// *personal* accounts (not connected to Plaid) has no matching leg to wash
// against, so it counts as income — deliberate: with only the joint accounts
// synced, funding the joint budget from a personal account is the closest thing
// to measurable income (real paychecks land in the un-connected personal
// accounts). Credit-card *purchases* are not counted here — the card *payment*
// that leaves checking is (that's the cash actually spent). This is deliberately
// different from the Categories tab / Overview headline (sumSpending above),
// which break spending down by what was purchased so per-category budgets work.
function isHouseholdDepository(t) {
  // Any connected depository account (checking or savings) — the joint budget.
  return t.accounts?.type === 'depository';
}

function isCheckingAccount(t) {
  // Depository and not the savings pot. Lenient on subtype so a null/oddly
  // typed primary account still counts; only "savings" is treated as separate.
  return t.accounts?.type === 'depository' && t.accounts?.subtype !== 'savings';
}

// Expenses are paid from checking only; savings outflows are not spending.
// Exported for the CSV-import dry-run harness (see markInternalTransfers).
export function cashSpending(txs) {
  let total = 0;
  for (const t of txs) {
    if (t.excluded || t._internal) continue;
    if (isCheckingAccount(t) && t.amount > 0) total += t.amount;
  }
  return total;
}

// Income is money into either joint account (checking or savings). Savings is
// included so income that arrives via savings — money moved in from a personal
// account — is not missed.
// Exported for the CSV-import dry-run harness (see markInternalTransfers).
export function cashIncome(txs) {
  let total = 0;
  for (const t of txs) {
    if (t.excluded || t._internal) continue;
    if (isHouseholdDepository(t) && t.amount < 0) total += Math.abs(t.amount);
  }
  return total;
}

export async function getOverview() {
  const { data: accounts, error } = await supabase
    .from('accounts')
    .select('name, mask, type, current_balance')
    .eq('hidden', false);
  if (error) throw error;

  const credit = accounts.filter(a => a.type === 'credit');
  const depository = accounts.filter(a => a.type === 'depository');
  const ordered = [...credit, ...depository];

  const now = new Date();
  const last = shiftMonth(now.getFullYear(), now.getMonth() + 1, -1);
  const lastTxs = await getMonthTransactions(last.year, last.month);

  return {
    accounts: ordered.map(a => ({
      balance: { current: a.current_balance ?? 0 },
      name: a.name,
      mask: a.mask,
      type: a.type,
    })),
    last_month: {
      spending: { amount: sumSpending(lastTxs) },
    },
  };
}

export async function getSpending({ year, month }) {
  const txs = await getMonthTransactions(year, month);
  const buckets = new Map();
  let total = 0;

  for (const t of txs) {
    if (t.excluded) continue;
    if (t.amount <= 0) continue;
    const cat = effectiveCategory(t);
    if (isTransferCategory(cat)) continue;
    if (!buckets.has(cat)) buckets.set(cat, { amount: 0, count: 0 });
    const b = buckets.get(cat);
    b.amount += t.amount;
    b.count += 1;
    total += t.amount;
  }

  const groups = Array.from(buckets.entries())
    .map(([label, b]) => ({
      label,
      amount: b.amount,
      transaction_count: b.count,
      percent_of_total: total ? (b.amount / total) * 100 : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  return { groups };
}

function toTxShape(t) {
  return {
    id: t.id,
    plaid_tx_id: t.plaid_tx_id,
    account_id: t.account_id,
    merchant_name: displayName(t),
    description: t.description,
    transaction_date: t.date,
    amount: t.amount,
    category: effectiveCategory(t),
    auto_category: t.mapped_category || 'Shopping and gear',
    user_category: t.user_category || null,
    user_description: t.user_description || null,
    excluded: !!t.excluded,
  };
}

// fields: { user_category } (null reverts to the automatic category),
// { user_description } (null reverts to the bank's name), and/or { excluded }.
export async function updateTransaction(id, fields) {
  const allowed = {};
  if ('user_category' in fields) allowed.user_category = fields.user_category;
  if ('user_description' in fields) allowed.user_description = fields.user_description;
  if ('excluded' in fields) allowed.excluded = fields.excluded;
  const { error } = await supabase.from('transactions').update(allowed).eq('id', id);
  if (error) throw error;
}

export async function getTransactions({ year, month }) {
  const txs = await getMonthTransactions(year, month);
  txs.sort((a, b) => {
    if (a.date === b.date) return b.amount - a.amount;
    return a.date < b.date ? 1 : -1;
  });
  return { transactions: txs.map(toTxShape) };
}

export async function getAccounts() {
  const { data, error } = await supabase
    .from('accounts')
    .select(ACCOUNT_COLUMNS)
    .order('type', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  return { accounts: data };
}

// type/subtype are editable for feeds that don't send one (SimpleFIN) — see
// ACCOUNT_TYPES. Never expose them for Plaid accounts: the Plaid sync upserts
// both columns, so an edit there would be silently reverted on the next sync.
export const ACCOUNT_TYPES = ['depository', 'credit', 'loan'];
export const ACCOUNT_SUBTYPES = ['checking', 'savings'];

export async function updateAccount(id, fields) {
  const allowed = {};
  if ('nickname' in fields) allowed.nickname = fields.nickname;
  if ('color' in fields) allowed.color = fields.color;
  if ('hidden' in fields) allowed.hidden = fields.hidden;
  if ('type' in fields && ACCOUNT_TYPES.includes(fields.type)) allowed.type = fields.type;
  if ('subtype' in fields) allowed.subtype = fields.subtype;
  const { error } = await supabase.from('accounts').update(allowed).eq('id', id);
  if (error) throw error;
}

// All transactions for one account, newest first, capped so a huge history
// can't lock up the phone. Returns { transactions, hasMore }.
export async function getAccountTransactions(accountId, { limit = 500 } = {}) {
  const { data, error } = await supabase
    .from('transactions')
    .select(`${TX_COLUMNS}, accounts(type)`)
    .eq('account_id', accountId)
    .order('date', { ascending: false })
    .limit(limit + 1);
  if (error) throw error;
  for (const t of data) {
    t.mapped_category = applyAccountRules(t.mapped_category, t.amount, t.accounts?.type);
  }
  const hasMore = data.length > limit;
  return {
    transactions: data.slice(0, limit).map(toTxShape),
    hasMore,
  };
}

// Budgets: one monthly dollar limit per category. No row = no budget.
// RLS scopes reads to the household; household_id fills in server-side via
// its column default (same as settings) — never send it from the client.
export async function getBudgets() {
  const { data, error } = await supabase.from('budgets').select('category, monthly_limit');
  if (error) throw error;
  const budgets = {};
  for (const row of data) budgets[row.category] = Number(row.monthly_limit);
  return { budgets };
}

export async function setBudget(category, limit) {
  const n = limit == null || limit === '' ? NaN : Number(limit);
  if (!Number.isFinite(n) || n <= 0) {
    const { error } = await supabase.from('budgets').delete().eq('category', category);
    if (error) throw error;
    return;
  }
  const { error } = await supabase
    .from('budgets')
    .upsert({ category, monthly_limit: n }, { onConflict: 'household_id,category' });
  if (error) throw error;
}

// Last N months of transactions (oldest full month through the current
// partial one) for client-side recurring detection (src/recurring.js).
// Goes through getTransactionsBetween so hidden-account filtering and
// account rules ("Return") apply. Detection itself stays out of the adapter.
export async function getRecurringCandidates({ months = 6 } = {}) {
  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;
  const oldest = shiftMonth(curY, curM, -(months - 1));
  const { start } = monthBounds(oldest.year, oldest.month);
  const { end } = monthBounds(curY, curM);
  const rows = await getTransactionsBetween(start, end);
  return { transactions: rows.map(toTxShape) };
}

// Cross-month search over description/merchant via ilike. The
// transaction-editing branch adds a user_description column; until its
// migration lands, querying that column errors, so we try with it once and
// fall back (and remember) if the database doesn't have it yet.
let searchHasUserDescription = true;

function ilikePattern(q) {
  // PostgREST's .or() parser treats commas/parens/quotes as syntax — strip
  // them rather than quote-juggle (household searches don't need them).
  // Escape the ilike wildcards so "100%" doesn't match everything.
  const cleaned = q.replace(/[,()"]/g, ' ');
  const escaped = cleaned.replace(/([\\%_])/g, '\\$1');
  return `%${escaped}%`;
}

export async function searchTransactions(query, { limit = 200 } = {}) {
  const q = (query || '').trim();
  if (q.length < 2) return { transactions: [], hasMore: false };
  const pat = ilikePattern(q);

  const run = withUserDesc => {
    const ors = [`description.ilike.${pat}`, `merchant_name.ilike.${pat}`];
    if (withUserDesc) ors.push(`user_description.ilike.${pat}`);
    return supabase
      .from('transactions')
      .select(`${TX_COLUMNS}, accounts!inner(hidden, type, subtype)`)
      .eq('accounts.hidden', false)
      .or(ors.join(','))
      .order('date', { ascending: false })
      .limit(limit + 1);
  };

  let { data, error } = await run(searchHasUserDescription);
  if (error && searchHasUserDescription) {
    // Column not there yet (pre-transaction-editing schema): retry without.
    searchHasUserDescription = false;
    ({ data, error } = await run(false));
  }
  if (error) throw error;

  for (const t of data) {
    t.mapped_category = applyAccountRules(t.mapped_category, t.amount, t.accounts?.type);
  }
  const hasMore = data.length > limit;
  return { transactions: data.slice(0, limit).map(toTxShape), hasMore };
}

export async function getCashFlow({ num_periods = 6 } = {}) {
  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;

  // One range query covering all periods, bucketed client-side.
  const oldest = shiftMonth(curY, curM, -(num_periods - 1));
  const { start: rangeStart } = monthBounds(oldest.year, oldest.month);
  const { end: rangeEnd } = monthBounds(curY, curM);
  const allTxs = await getTransactionsBetween(rangeStart, rangeEnd);

  const byMonth = new Map();
  for (const t of allTxs) {
    const ym = (t.date || '').slice(0, 7);
    if (!byMonth.has(ym)) byMonth.set(ym, []);
    byMonth.get(ym).push(t);
  }

  const periods = [];
  let spendSum = 0;
  let spendCount = 0;

  for (let i = num_periods - 1; i >= 0; i--) {
    const { year, month } = shiftMonth(curY, curM, -i);
    const txs = byMonth.get(`${year}-${pad2(month)}`) || [];
    const spending = cashSpending(txs);
    const income = cashIncome(txs);
    const { start } = monthBounds(year, month);
    periods.push({
      label: monthLabel(year, month),
      start,
      spending: { amount: spending },
      income: { amount: income },
    });
    spendSum += spending;
    spendCount += 1;
  }

  return {
    periods,
    averages: {
      spending: { amount: spendCount ? spendSum / spendCount : 0 },
    },
  };
}

// --- CSV import (standalone mode) --------------------------------------------
// Creates real transactions on a manual (non-Plaid) account so the un-synced
// personal-account income becomes visible. All writes go through the
// authenticated client: the *_all RLS policies allow it because household_id
// resolves from the column default current_household_id() (never sent from the
// client — same pattern as setBudget/setSetting). api/sync.js never touches
// these rows: the manual institution has no plaid_tokens and status='disabled',
// so it's skipped entirely.

const MANUAL_INSTITUTION_NAME = 'Imported';
const MANUAL_ACCOUNT_PREFIX = 'manual:';
// Mirrors SFIN_PREFIX in api/_lib/simplefin.js — that module is server-only
// (it handles bank credentials), so the browser gets its own copy of the one
// string it needs.
const SIMPLEFIN_ACCOUNT_PREFIX = 'sfin:';

// A SimpleFIN-fed account. Matters to the UI for two reasons: its type was
// GUESSED from the account name (SimpleFIN sends none) so it must be
// correctable by hand, and it arrives hidden until it's been compared against
// the Plaid copy of the same bank.
export function isSimpleFinAccount(a) {
  return String(a?.plaid_account_id || '').startsWith(SIMPLEFIN_ACCOUNT_PREFIX);
}

// The is_manual / source columns land with the CSV-import migration. Previews
// share the prod DB until Mason pastes it, so writes must work before it does:
// try with the column, and on a "column not found" error drop it and remember.
let accountsHaveIsManual = true;
let transactionsHaveSource = true;

function isMissingColumnError(error, col) {
  if (!error) return false;
  if (error.code === 'PGRST204' || error.code === '42703') return true;
  const blob = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`.toLowerCase();
  return blob.includes(col) && blob.includes('column');
}

function makeUuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Fallback (non-secure contexts / very old runtimes): not cryptographically
  // strong, only needs to be unique enough for a synthetic plaid_account_id.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
    const r = (Date.now() + Math.floor(Math.random() * 1e9)) % 16;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Whether an account row is a CSV-import (manual) account. Robust to the
// is_manual column not existing yet: the 'manual:' plaid_account_id prefix is
// set at write time and is always present.
export function isManualAccount(a) {
  return (
    a?.is_manual === true || String(a?.plaid_account_id || '').startsWith(MANUAL_ACCOUNT_PREFIX)
  );
}

// Find (or create) the single household-wide "Imported" institution that owns
// every manual account. status='disabled' keeps api/sync.js from ever
// processing it (it filters .neq('status','disabled')), so no bogus
// "no access token" result appears each sync.
export async function findOrCreateManualInstitution() {
  const { data: existing, error: selErr } = await supabase
    .from('institutions')
    .select('id, name, status')
    .eq('name', MANUAL_INSTITUTION_NAME)
    .limit(1)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing) return existing.id;

  // household_id omitted → column default current_household_id() fills it in.
  const { data, error } = await supabase
    .from('institutions')
    .insert({ name: MANUAL_INSTITUTION_NAME, status: 'disabled' })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

// Create one manual account. subtype is 'checking' or 'savings' (drives the
// Trends checking-vs-savings split). Returns the inserted account row.
export async function createManualAccount({ name, subtype = 'checking' }) {
  const institutionId = await findOrCreateManualInstitution();
  const plaidAccountId = MANUAL_ACCOUNT_PREFIX + makeUuid();
  const base = {
    institution_id: institutionId,
    plaid_account_id: plaidAccountId,
    name: (name || 'Imported account').trim(),
    type: 'depository',
    subtype: subtype === 'savings' ? 'savings' : 'checking',
  };

  const attempt = async withFlag => {
    const row = withFlag ? { ...base, is_manual: true } : base;
    return supabase.from('accounts').insert(row).select(ACCOUNT_COLUMNS).single();
  };

  let { data, error } = await attempt(accountsHaveIsManual);
  if (error && accountsHaveIsManual && isMissingColumnError(error, 'is_manual')) {
    accountsHaveIsManual = false;
    ({ data, error } = await attempt(false));
  }
  if (error) throw error;
  return data;
}

// plaid_tx_ids already stored for an account, so the preview can grey out rows
// a prior import already inserted. Empty for a brand-new account.
export async function getExistingTxIds(accountId) {
  const ids = new Set();
  if (!accountId) return ids;
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('transactions')
      .select('plaid_tx_id')
      .eq('account_id', accountId)
      .range(from, from + page - 1);
    if (error) throw error;
    for (const r of data) ids.add(r.plaid_tx_id);
    if (data.length < page) break;
  }
  return ids;
}

// Raw transactions on one account within a date range, for CSV reconciliation
// (comparison mode, Phase 2). Returns the columns reconcileCsv compares — not
// the shaped toTxShape form — scoped to the CSV's period so a one-month CSV
// isn't compared against years of Plaid history.
export async function getAccountTransactionsInRange(accountId, start, end) {
  const rows = [];
  if (!accountId || !start || !end) return rows;
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('transactions')
      .select('plaid_tx_id, date, amount, description, merchant_name, mapped_category, user_category, pending')
      .eq('account_id', accountId)
      .gte('date', start)
      .lte('date', end)
      .order('date', { ascending: true })
      .range(from, from + page - 1);
    if (error) throw error;
    for (const r of data) rows.push({ ...r, amount: Number(r.amount) });
    if (data.length < page) break;
  }
  return rows;
}

// Idempotent upsert of built CSV rows onto a manual account. onConflict
// (account_id, plaid_tx_id) means a re-import of overlapping rows updates in
// place instead of duplicating; user-owned columns (user_category, excluded,
// user_description) are omitted from the payload so those edits survive the
// re-import, exactly like Plaid syncs. Returns the number of rows written.
export async function importCsvTransactions(accountId, rows) {
  if (!accountId) throw new Error('importCsvTransactions requires an account id');
  if (!rows || rows.length === 0) return 0;

  const batchSize = 500;
  let written = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize).map(r => ({ ...r, account_id: accountId }));

    const attempt = async withSource => {
      const payload = withSource ? slice.map(r => ({ ...r, source: 'csv' })) : slice;
      return supabase
        .from('transactions')
        .upsert(payload, { onConflict: 'account_id,plaid_tx_id' });
    };

    let { error } = await attempt(transactionsHaveSource);
    if (error && transactionsHaveSource && isMissingColumnError(error, 'source')) {
      transactionsHaveSource = false;
      ({ error } = await attempt(false));
    }
    if (error) throw error;
    written += slice.length;
  }
  return written;
}
