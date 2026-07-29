import { supabase } from './supabaseClient.js';
import { isTransferCategory, applyAccountRules, UNCATEGORIZED } from './categoryMap.js';
import { merchantKey, matchLearnedRule } from './txClassify.js';
import { markInternalTransfers, cashIncome, cashSpending } from './cashFlow.js';
import { walkEnvelopes, monthKey, planMove } from './envelopes.js';

// Re-export the pure cash-flow model (src/cashFlow.js) so existing importers
// and the CSV-import dry-run harness keep working.
export { markInternalTransfers, cashIncome, cashSpending } from './cashFlow.js';

// Same deal for the pure envelope model (src/envelopes.js) — Dashboard and any
// harness import the helpers from one place.
export { targetNeed, readyToAssign, monthKey, shiftMonthKey } from './envelopes.js';

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

// User override wins over the classifier's answer.
function effectiveCategory(t) {
  return t.user_category || t.mapped_category || UNCATEGORIZED;
}

// Some banks send masked descriptors ("****** *********"). Treat those as
// empty so the UI falls through to something readable.
function looksMasked(s) {
  return !!s && /^[\s*·.xX_-]+$/.test(s);
}

// The bank's own name for the row, with no user override applied — the
// counterpart to mapped_category, and what "reset name" falls back to.
function bankName(t) {
  const merchant = looksMasked(t.merchant_name) ? '' : t.merchant_name;
  const desc = looksMasked(t.description) ? '' : t.description;
  return merchant || desc || 'Card transaction';
}

function displayName(t) {
  return t.user_description || bankName(t);
}

const ACCOUNT_COLUMNS =
  'id, institution_id, plaid_account_id, name, official_name, nickname, color, mask, type, subtype, current_balance, available_balance, last_balance_at, hidden, institutions(name, display_name)';

// `columns` / `markTransfers` exist for the envelope walk, which can span
// years: it needs only the spending predicate's inputs, and never reads
// `_internal`, so it skips both the wide column list and the O(V·E) transfer
// matching. Every other caller gets the full rows and the matching as before.
async function getTransactionsBetween(start, end, { columns = TX_COLUMNS, markTransfers = true } = {}) {
  // RLS scopes every query to the signed-in household automatically.
  // The inner join on accounts drops transactions belonging to hidden
  // accounts from every dashboard view (spending, lists, trends).
  const rows = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('transactions')
      .select(`${columns}, accounts!inner(hidden, type, subtype)`)
      .eq('accounts.hidden', false)
      .gte('date', start)
      .lte('date', end)
      .order('date', { ascending: false })
      // Tiebreaker: date alone is not a stable sort, so without it a page
      // boundary landing inside a run of same-dated rows can drop or repeat
      // one. Reachable now that the envelope walk can span years.
      .order('id', { ascending: false })
      .range(from, from + page - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < page) break;
  }
  // Credit-card refunds become "Return" — not income, not spending.
  for (const t of rows) {
    t.mapped_category = applyAccountRules(t.mapped_category, t.amount, t.accounts?.type);
  }
  if (markTransfers) markInternalTransfers(rows);
  return rows;
}

// The subset of TX_COLUMNS that isSpend() + effectiveCategory() actually read
// (plus `id`, which the pagination tiebreaker orders by). isLoanAccount reads
// accounts.type, which the inner join already selects.
const SPEND_TX_COLUMNS = 'id, date, amount, mapped_category, user_category, excluded';

function getMonthTransactions(year, month) {
  const { start, end } = monthBounds(year, month);
  return getTransactionsBetween(start, end);
}

// A debit on a LOAN account is a loan payment, not a purchase — and the cash
// that paid it already counts when it leaves checking, so counting it here
// double-counts the mortgage. Plaid never surfaced this (its loan accounts
// carry sparse/no transactions), but SimpleFIN ships the servicer's real
// transaction list. Note this guards `loan` ONLY: credit-card *purchases* are
// exactly what purchase-based spending is supposed to measure.
function isLoanAccount(t) {
  return t.accounts?.type === 'loan';
}

// The purchase-based spending test. getSpending(), sumSpending() and the
// envelope walk all go through this one predicate so a category's "Spent"
// can never disagree with the bar rendered next to it. Positive = money out;
// user edits win; transfers/card payments, credit-card returns and loan
// account postings never count.
function isSpend(t) {
  if (t.excluded || isLoanAccount(t)) return false;
  if (t.amount <= 0) return false;
  return !isTransferCategory(effectiveCategory(t));
}

function sumSpending(txs) {
  let total = 0;
  for (const t of txs) {
    if (isSpend(t)) total += t.amount;
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
    if (!isSpend(t)) continue;
    const cat = effectiveCategory(t);
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
    auto_category: t.mapped_category || UNCATEGORIZED,
    // The un-overridden name, so an optimistic rename (or its reset) can
    // recompute `merchant_name` locally the same way displayName() does.
    // Without it the collapse into `merchant_name` is lossy and a list that is
    // never refetched — search results, the account sheet — keeps the old name.
    auto_description: bankName(t),
    user_category: t.user_category || null,
    user_description: t.user_description || null,
    excluded: !!t.excluded,
    // Whether this row is one of the dollars a category bar / envelope Spent is
    // made of. It rides along rather than being re-derived in the UI so a
    // category drill-in's own total can never disagree with the number that was
    // tapped to open it — same reason getEnvelopeSpending aggregates on
    // isSpend() instead of its own copy of the rule. Every caller of toTxShape
    // selects accounts.type, which isLoanAccount() needs.
    counted: isSpend(t),
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

// --- Learned merchant rules --------------------------------------------------
// The household's own merchant→category memory (see the category_rules
// migration). Read as a plain object so it can be handed straight to
// guessCategory/classifyDescription. Tolerates the table not existing yet:
// previews share the production database, so this has to work before the
// migration is pasted.
let hasCategoryRules = true;

export async function getCategoryRules() {
  if (!hasCategoryRules) return {};
  const { data, error } = await supabase.from('category_rules').select('merchant_key, category');
  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') {
      hasCategoryRules = false;
      return {};
    }
    throw error;
  }
  const rules = {};
  for (const r of data || []) rules[r.merchant_key] = r.category;
  return rules;
}

// Teach a merchant. household_id fills in from its column default — never send
// it from the client (same pattern as setBudget/setSetting).
export async function setCategoryRule(descriptor, category) {
  const key = merchantKey(descriptor);
  if (!key) throw new Error('Cannot learn a rule from an empty description');
  const { error } = await supabase
    .from('category_rules')
    .upsert({ merchant_key: key, category, updated_at: new Date().toISOString() },
            { onConflict: 'household_id,merchant_key' });
  if (error) throw error;
  return key;
}

export async function deleteCategoryRule(merchantKeyValue) {
  const { error } = await supabase.from('category_rules').delete().eq('merchant_key', merchantKeyValue);
  if (error) throw error;
}

// Apply a freshly-taught rule to history. Writes `mapped_category` only, so a
// per-transaction `user_category` override always still wins — this changes
// what the classifier *would* have said, not what the user decided.
//
// dryRun counts the matches without writing, so the confirm can say how many
// past transactions it is about to touch.
export async function applyCategoryRuleToHistory(descriptor, category, { dryRun = false } = {}) {
  const key = merchantKey(descriptor);
  if (!key) return 0;

  // The match is on the NORMALIZED descriptor, which SQL can't reproduce, so
  // candidates are narrowed server-side with ilike on the first token and the
  // exact rule applied here.
  const firstToken = key.split(' ')[0];
  const pat = `%${firstToken.replace(/([\\%_])/g, '\\$1')}%`;

  const matches = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('transactions')
      .select('id, description, merchant_name, mapped_category')
      .or(`description.ilike.${pat},merchant_name.ilike.${pat}`)
      .range(from, from + page - 1);
    if (error) throw error;
    for (const t of data) {
      // Classify on the same string the write path uses.
      const descriptors = [t.merchant_name, t.description].filter(Boolean);
      const hit = descriptors.some(d => matchLearnedRule(d, { [key]: category }));
      if (hit && t.mapped_category !== category) matches.push(t.id);
    }
    if (data.length < page) break;
  }
  if (dryRun || matches.length === 0) return matches.length;

  const batch = 200;
  for (let i = 0; i < matches.length; i += batch) {
    const { error } = await supabase
      .from('transactions')
      .update({ mapped_category: category })
      .in('id', matches.slice(i, i + batch));
    if (error) throw error;
  }
  return matches.length;
}

// Budgets: one monthly dollar limit per category. No row = no budget.
// RLS scopes reads to the household; household_id fills in server-side via
// its column default (same as settings) — never send it from the client.
// `budgets` maps category → MONTHLY target only. A by-date sinking fund's
// amount is a multi-month TOTAL — handing it to the Categories tab as if it
// were monthly would inflate the Targets strip and every bar denominator by
// the un-prorated balance (a "$6,000 by June" fund is not a $6,000/month
// budget). By-date targets come back separately in `byDate`.
export async function getBudgets() {
  let { data, error } = await supabase
    .from('budgets')
    .select('category, monthly_limit, target_kind, target_date');
  // Pre-envelope-migration schema has no target_kind/target_date (42703);
  // every row is a plain monthly target there.
  if (error && error.code === '42703') {
    ({ data, error } = await supabase.from('budgets').select('category, monthly_limit'));
  }
  if (error) throw error;
  const budgets = {};
  const byDate = {};
  for (const row of data) {
    // A null limit is a category keeping rollover/target settings without a
    // target amount (post-envelope migration) — reads as "no target".
    if (row.monthly_limit == null) continue;
    if (row.target_kind === 'by_date') {
      byDate[row.category] = { target: Number(row.monthly_limit), date: row.target_date || null };
    } else {
      budgets[row.category] = Number(row.monthly_limit);
    }
  }
  return { budgets, byDate };
}

// Sets the category's funding target. Clearing it null-UPDATES the row rather
// than deleting it, so a category keeps its rollover / target_date settings;
// getBudgets() skips null limits, so it still reads as "no target". An UPDATE,
// not an upsert: clearing a target on a category that never had a budgets row
// must stay a no-op — an upserted null row would list that category on the
// Budget tab every month forever, with no UI that ever deletes it.
export async function setBudget(category, limit) {
  const n = limit == null || limit === '' ? NaN : Number(limit);
  const monthly_limit = Number.isFinite(n) && n > 0 ? n : null;
  const { error } =
    monthly_limit === null
      ? await supabase.from('budgets').update({ monthly_limit }).eq('category', category)
      : await supabase
          .from('budgets')
          .upsert({ category, monthly_limit }, { onConflict: 'household_id,category' });
  if (!error) return;
  // `monthly_limit` is NOT NULL until the envelope migration relaxes it, and
  // previews share the PROD database — so on a preview whose migration hasn't
  // been pasted yet, clearing a target would fail where it used to work. Fall
  // back to the old behaviour (drop the row) rather than break it. 23502 is
  // not_null_violation.
  if (monthly_limit === null && error.code === '23502') {
    const { error: delErr } = await supabase.from('budgets').delete().eq('category', category);
    if (delErr) throw delErr;
    return;
  }
  throw error;
}

// True for the errors that mean the envelope schema has not been installed —
// a missing table (PGRST205 from PostgREST's schema cache, 42P01 from
// Postgres) or the budgets columns the migration adds (42703). The dashboard
// uses this to tell "migration not pasted yet" apart from a transient network
// failure: only the former should show the not-set-up notice. Same pattern as
// getCategoryRules above.
export function isEnvelopeSchemaMissing(error) {
  return (
    !!error &&
    (error.code === 'PGRST205' || error.code === '42P01' || error.code === '42703')
  );
}

// --- Envelope budgeting (YNAB rules 1–3) -------------------------------------
// Two tables back this:
//   budgets       — per category: the funding TARGET (monthly_limit, with
//                   target_kind/target_date) and the rollover flag.
//   budget_months — per (category, month): `assigned`, the dollars actually
//                   given to that category that month.
//
//   available(cat, m) = assigned(cat, m) + carry(cat, m-1) - spent(cat, m)
//
// carry is the previous month's available for a rolling category and 0 for a
// non-rolling one. A month with no budget_months row contributes assigned 0 —
// never the target — so a category cannot accrue a phantom balance out of
// months nobody actually budgeted. Every assignment comes from an explicit
// user action, which keeps the number on screen equal to the number the walk
// rolls forward.
//
// The walk itself lives in src/envelopes.js (pure, zero imports, covered by
// test/envelopes.test.js). Everything below is I/O: read the rows, aggregate
// spending through the shared isSpend() predicate, hand it to walkEnvelopes().

// Every assignment up to and including the viewed month. Paginated rather
// than date-clamped: dropping old rows would drop real dollars out of a
// rollover balance. Ordered by (month, category), which is unique per
// household, so page boundaries are stable.
async function getAssignmentsThrough(monthStart) {
  const rows = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('budget_months')
      .select('category, month, assigned')
      .lte('month', monthStart)
      .order('month', { ascending: true })
      .order('category', { ascending: true })
      .range(from, from + page - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < page) break;
  }
  return rows;
}

// Household income for a month, for Ready to Assign. Hand-entered: the feed
// still cannot be trusted for take-home pay (SimpleFIN only syncs what is
// linked and unhidden, and a missed paycheck would silently read as less to
// budget). `budget:income` is the recurring default; `budget:income:YYYY-MM`
// overrides one month. Both live in `settings`, so this needs no migration.
const INCOME_KEY = 'budget:income';

export async function getBudgetIncome({ year, month }) {
  const monthKeyStr = `${INCOME_KEY}:${monthKey(year, month)}`;
  const { data, error } = await supabase
    .from('settings')
    .select('key, value')
    .in('key', [INCOME_KEY, monthKeyStr]);
  if (error) throw error;
  const byKey = {};
  for (const row of data || []) byKey[row.key] = row.value;
  // settings.value is a TEXT column (see migration 2) — everything stored there
  // is a string, so read it back as one. An empty string is not a zero.
  const read = v => {
    if (v == null || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const override = read(byKey[monthKeyStr]);
  const fallback = read(byKey[INCOME_KEY]);
  return {
    income: override != null ? override : fallback,
    isDefault: override == null && fallback != null,
    monthlyDefault: fallback,
  };
}

// `scope: 'month'` sets just this month; `scope: 'default'` sets the recurring
// amount AND clears this month's override so the new default is what shows.
export async function setBudgetIncome({ year, month }, amount, { scope = 'month' } = {}) {
  const raw = amount == null ? '' : String(amount).trim();
  const n = raw === '' ? null : Number(raw);
  if (raw !== '' && !Number.isFinite(n)) return;
  const monthKeyStr = `${INCOME_KEY}:${monthKey(year, month)}`;
  const key = scope === 'default' ? INCOME_KEY : monthKeyStr;
  if (n == null) {
    const { error } = await supabase.from('settings').delete().eq('key', key);
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from('settings')
      .upsert({ key, value: String(n) }, { onConflict: 'household_id,key' });
    if (error) throw error;
  }
  if (scope === 'default') {
    const { error } = await supabase.from('settings').delete().eq('key', monthKeyStr);
    if (error) throw error;
  }
}

// Per-(category, month) spend sums for the walk's range, memoised. The walk's
// range grows by a month every month and is re-read after every envelope edit,
// but an envelope edit CANNOT change a transaction — so assigning, moving money
// or toggling rollover reuses this instead of re-downloading the household's
// whole budgeting history. invalidateEnvelopeSpending() is called by the
// dashboard's own reload, which is the only moment transactions can have moved
// (a sync, a CSV/PDF import, a recategorisation, a learned rule applied).
let spendCache = null;
// Generation counter: a fetch that was already in flight when the cache was
// invalidated must not write its (pre-invalidation) result back in — network
// reordering would otherwise re-poison the cache with pre-edit sums right
// after a recategorisation or a learned-rule history rewrite.
let spendGen = 0;

export function invalidateEnvelopeSpending() {
  spendCache = null;
  spendGen++;
}

async function getEnvelopeSpending(start, end) {
  const cacheKey = `${start}|${end}`;
  if (spendCache && spendCache.key === cacheKey) return spendCache.spending;

  const gen = spendGen;
  const txs = await getTransactionsBetween(start, end, {
    columns: SPEND_TX_COLUMNS,
    markTransfers: false,
  });

  // Aggregate on the same predicate the Categories bars use, so an envelope's
  // Spent can never disagree with the bar rendered beside it. Keyed 'YYYY-MM' +
  // category, sliced at a fixed offset rather than split on a separator —
  // category labels contain spaces ("Coffee and snacks").
  const byKey = new Map();
  for (const t of txs) {
    if (!isSpend(t)) continue;
    const key = `${(t.date || '').slice(0, 7)}${effectiveCategory(t)}`;
    byKey.set(key, (byKey.get(key) || 0) + t.amount);
  }
  const spending = [];
  for (const [key, amount] of byKey) {
    spending.push({ category: key.slice(7), month: key.slice(0, 7), spent: amount });
  }
  if (gen === spendGen) spendCache = { key: cacheKey, spending };
  return spending;
}

export async function getEnvelopes({ year, month }) {
  const targetKey = monthKey(year, month);

  const [assignmentRows, settingsRes] = await Promise.all([
    getAssignmentsThrough(`${targetKey}-01`),
    supabase.from('budgets').select('category, monthly_limit, rollover, target_kind, target_date'),
  ]);
  if (settingsRes.error) throw settingsRes.error;

  // Only fetch transactions back to the earliest month anyone actually assigned
  // in — the walk cannot use anything older, and this is the query that grows
  // with the household's budgeting history.
  let earliestKey = targetKey;
  for (const row of assignmentRows) {
    const key = String(row.month).slice(0, 7);
    if ((Number(row.assigned) || 0) !== 0 && key < earliestKey) earliestKey = key;
  }
  const [startYear, startMonth] = earliestKey.split('-').map(Number);
  const { start } = monthBounds(startYear, startMonth);
  const { end } = monthBounds(year, month);
  const spending = await getEnvelopeSpending(start, end);

  const settings = settingsRes.data.map(row => ({
    category: row.category,
    target: row.monthly_limit,
    targetKind: row.target_kind,
    targetDate: row.target_date,
    rollover: row.rollover,
  }));

  return walkEnvelopes({ assignments: assignmentRows, spending, settings, year, month });
}

// Assigns dollars to a category for one month. Blank or zero removes the
// assignment entirely (which is what keeps "no row = assigned 0" true).
// Negative is allowed — that's moving money back out of an envelope.
export async function setAssigned(category, { year, month }, amount) {
  const raw = amount == null ? '' : String(amount).trim();
  const n = raw === '' ? 0 : Number(raw);
  // A typo ("1-2") must not silently wipe an assignment — only an empty value
  // clears one. Anything unparseable is ignored.
  if (!Number.isFinite(n)) return;
  const monthStart = `${year}-${pad2(month)}-01`;
  if (n === 0) {
    const { error } = await supabase
      .from('budget_months')
      .delete()
      .eq('category', category)
      .eq('month', monthStart);
    if (error) throw error;
    return;
  }
  const { error } = await supabase
    .from('budget_months')
    .upsert(
      { category, month: monthStart, assigned: n, updated_at: new Date().toISOString() },
      { onConflict: 'household_id,category,month' }
    );
  if (error) throw error;
}

// Rule 3: whether this category's leftover (or overspend) carries forward.
// Each budgets writer sends only the columns it owns — a PostgREST upsert's
// ON CONFLICT DO UPDATE touches only those, so setting a rollover flag never
// clobbers monthly_limit or target_kind, and vice versa (verified against a
// local Postgres stub).
//
// Asymmetric on purpose: rollover=false (non-default) may create a row, but
// rollover=true first deletes a row that carries nothing else and otherwise
// UPDATEs — walkEnvelopes lists every budgets row in every month and no UI
// deletes one, so an idle ⟳ experiment on a never-budgeted category must not
// pin it to the Budget tab forever.
export async function setCategoryRollover(category, rollover) {
  if (rollover) {
    const { error: delErr } = await supabase
      .from('budgets')
      .delete()
      .eq('category', category)
      .is('monthly_limit', null)
      .is('target_date', null);
    if (delErr && delErr.code !== '42703') throw delErr;
    const { error } = await supabase
      .from('budgets')
      .update({ rollover: true })
      .eq('category', category);
    if (error && error.code !== '42703') throw error;
    return;
  }
  const { error } = await supabase
    .from('budgets')
    .upsert({ category, rollover: false }, { onConflict: 'household_id,category' });
  if (error) throw error;
}

// Rule 2: 'monthly' funds the target every month; 'by_date' is a sinking fund
// that should reach the target by `date`.
export async function setTargetKind(category, kind, date = null) {
  const target_kind = kind === 'by_date' ? 'by_date' : 'monthly';
  const { error } = await supabase.from('budgets').upsert(
    { category, target_kind, target_date: target_kind === 'by_date' ? date : null },
    { onConflict: 'household_id,category' }
  );
  if (error) throw error;
}

// Rule 3's actual mechanic: cover an overspent category from one with room.
// Both legs go in ONE upsert so a failure can never leave money duplicated or
// destroyed. A leg that lands on exactly zero is written as a 0 row rather than
// deleted — the walk treats a 0 assignment as "no envelope opened here", so the
// two are equivalent and atomicity is worth more than tidiness.
export async function moveMoney({ from, to, amount }, { year, month }) {
  const monthStart = `${year}-${pad2(month)}-01`;
  const { data, error: readErr } = await supabase
    .from('budget_months')
    .select('category, assigned')
    .eq('month', monthStart)
    .in('category', [from, to]);
  if (readErr) throw readErr;
  const current = {};
  for (const row of data || []) current[row.category] = Number(row.assigned) || 0;

  const legs = planMove({ from, to, amount, assignedByCategory: current });
  if (!legs) return;

  const updatedAt = new Date().toISOString();
  const { error } = await supabase.from('budget_months').upsert(
    legs.map(l => ({ ...l, month: monthStart, updated_at: updatedAt })),
    { onConflict: 'household_id,category,month' }
  );
  if (error) throw error;
}

// Bulk-assign for "Fund targets". items: [{ category, amount }]. Amounts are
// the *new* assigned totals for the month, not deltas. A total of exactly ZERO
// is still written: it can be the funding step that lifts a negative
// assignment back to zero, and a 0 row is defined as equivalent to no row —
// filtering it out would leave the negative in place and the category's
// "needs" chip asking forever.
export async function fundTargets(items, { year, month }) {
  const monthStart = `${year}-${pad2(month)}-01`;
  const updatedAt = new Date().toISOString();
  const rows = items
    .filter(i => Number.isFinite(Number(i.amount)))
    .map(i => ({
      category: i.category,
      month: monthStart,
      assigned: Number(i.amount),
      updated_at: updatedAt,
    }));
  if (!rows.length) return;
  const { error } = await supabase
    .from('budget_months')
    .upsert(rows, { onConflict: 'household_id,category,month' });
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

// Cross-month search over description/merchant/user_description via ilike.

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

  const ors = [
    `description.ilike.${pat}`,
    `merchant_name.ilike.${pat}`,
    `user_description.ilike.${pat}`,
  ];
  const { data, error } = await supabase
    .from('transactions')
    .select(`${TX_COLUMNS}, accounts!inner(hidden, type, subtype)`)
    .eq('accounts.hidden', false)
    .or(ors.join(','))
    .order('date', { ascending: false })
    .limit(limit + 1);
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
// these rows: the manual institution is status='disabled' and has no SimpleFIN
  // org id,
// so it's skipped entirely.

const MANUAL_INSTITUTION_NAME = 'Imported';
const MANUAL_ACCOUNT_PREFIX = 'manual:';
// Mirrors SFIN_PREFIX in api/_lib/simplefin.js — that module is server-only
// (it handles bank credentials), so the browser gets its own copy of the one
// string it needs. It prefixes BOTH ids the feed writes: accounts.plaid_account_id
// and transactions.plaid_tx_id — hence the un-suffixed name.
const SIMPLEFIN_PREFIX = 'sfin:';

// A SimpleFIN-fed account. Matters to the UI for two reasons: its type was
// GUESSED from the account name (SimpleFIN sends none) so it must be
// correctable by hand, and it arrives hidden — the type guess is exactly what
// unhiding confirms, and getting it wrong moves the spending totals.
export function isSimpleFinAccount(a) {
  return String(a?.plaid_account_id || '').startsWith(SIMPLEFIN_PREFIX);
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

// Create one manual account. kind is 'checking' | 'savings' | 'credit'.
// checking/savings are depository (and drive the Trends checking-vs-savings
// split); 'credit' is a credit-card account, for a card whose statements are
// only available as CSV/PDF — its purchases count as spending by category and
// applyAccountRules turns its negatives into "Return" (never income), exactly
// like a Plaid-linked card. Returns the inserted account row.
export async function createManualAccount({ name, subtype = 'checking' }) {
  const institutionId = await findOrCreateManualInstitution();
  const plaidAccountId = MANUAL_ACCOUNT_PREFIX + makeUuid();
  const isCredit = subtype === 'credit';
  const base = {
    institution_id: institutionId,
    plaid_account_id: plaidAccountId,
    name: (name || 'Imported account').trim(),
    type: isCredit ? 'credit' : 'depository',
    subtype: isCredit ? 'credit card' : subtype === 'savings' ? 'savings' : 'checking',
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
// a prior import already inserted, plus which sources those rows came from.
// The dedup id hashes the description, and a bank's CSV and PDF word the same
// transaction differently — so feeding one account from both formats
// double-inserts. The caller warns when the sources would be mixed.
// Returns { ids: Set, sources: Set }. Empty for a brand-new account.
export async function getExistingTxIds(accountId) {
  const ids = new Set();
  const sources = new Set();
  if (!accountId) return { ids, sources };
  const page = 1000;
  let selectCols = transactionsHaveSource ? 'plaid_tx_id, source' : 'plaid_tx_id';
  for (let from = 0; ; from += page) {
    let { data, error } = await supabase
      .from('transactions')
      .select(selectCols)
      .eq('account_id', accountId)
      .range(from, from + page - 1);
    if (error && selectCols !== 'plaid_tx_id' && isMissingColumnError(error, 'source')) {
      transactionsHaveSource = false;
      selectCols = 'plaid_tx_id';
      ({ data, error } = await supabase
        .from('transactions')
        .select(selectCols)
        .eq('account_id', accountId)
        .range(from, from + page - 1));
    }
    if (error) throw error;
    for (const r of data) {
      ids.add(r.plaid_tx_id);
      if (r.source) sources.add(r.source);
    }
    if (data.length < page) break;
  }
  return { ids, sources };
}

// Where the SimpleFIN feed's own coverage starts for an account: the date of
// the earliest transaction the FEED delivered. CSV history imported on or after this date would be a second
// copy of transactions the feed already supplies: `csv:` and `sfin:` dedup ids
// live in different namespaces and cannot see each other, so nothing downstream
// would catch the duplication. Returns null when the FEED has no rows yet.
//
// The `sfin:` filter is load-bearing, not a tidy-up. Without it the query
// returns the earliest row of ANY origin, so the first successful backfill moves
// the boundary back onto the `csv:` rows it just inserted — and every later
// statement is then 100% "overlap", importing nothing, with no error to explain
// why. That silently breaks rebuilding history one statement at a time, which is
// the whole point of the feature.
//
// Filtering on `plaid_tx_id` rather than `source` is deliberate too: the id
// prefix is written unconditionally, whereas `source` degrades to the legacy
// `'plaid'` default whenever the column is absent (see `txHaveSource` in
// api/sync.js and `transactionsHaveSource` here).
export async function getFeedCoverageStart(accountId) {
  if (!accountId) return null;
  const { data, error } = await supabase
    .from('transactions')
    .select('date')
    .eq('account_id', accountId)
    .like('plaid_tx_id', `${SIMPLEFIN_PREFIX}%`)
    .order('date', { ascending: true })
    .limit(1);
  if (error) throw error;
  return data?.[0]?.date || null;
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
export async function importCsvTransactions(accountId, rows, source = 'csv') {
  if (!accountId) throw new Error('importCsvTransactions requires an account id');
  if (!rows || rows.length === 0) return 0;

  const batchSize = 500;
  let written = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize).map(r => ({ ...r, account_id: accountId }));

    const attempt = async withSource => {
      const payload = withSource ? slice.map(r => ({ ...r, source })) : slice;
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
