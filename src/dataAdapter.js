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
  'id, institution_id, name, official_name, nickname, color, mask, type, subtype, current_balance, available_balance, last_balance_at, hidden, institutions(name, display_name)';

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

function markInternalTransfers(rows) {
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

// --- Trends cash flow (checking-account view) --------------------------------
// The Trends "income vs spending" chart measures cash moving through the
// household's checking account(s): income = money arriving in checking,
// spending = money leaving checking. Internal transfers to/from the household's
// own savings are washed out (markInternalTransfers) so moving money to savings
// isn't "spending" and moving it back isn't "income". Credit-card *purchases*
// are not counted here — the card *payment* that leaves checking is (that's the
// cash actually spent). This is deliberately different from the Categories tab
// / Overview headline (sumSpending above), which break spending down by what
// was purchased so per-category budgets work.
function isCheckingAccount(t) {
  // Depository and not the savings pot. Lenient on subtype so a null/oddly
  // typed primary account still counts; only "savings" is treated as separate.
  return t.accounts?.type === 'depository' && t.accounts?.subtype !== 'savings';
}

function cashSpending(txs) {
  let total = 0;
  for (const t of txs) {
    if (t.excluded || t._internal) continue;
    if (isCheckingAccount(t) && t.amount > 0) total += t.amount;
  }
  return total;
}

function cashIncome(txs) {
  let total = 0;
  for (const t of txs) {
    if (t.excluded || t._internal) continue;
    if (isCheckingAccount(t) && t.amount < 0) total += Math.abs(t.amount);
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

export async function updateAccount(id, fields) {
  const allowed = {};
  if ('nickname' in fields) allowed.nickname = fields.nickname;
  if ('color' in fields) allowed.color = fields.color;
  if ('hidden' in fields) allowed.hidden = fields.hidden;
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
