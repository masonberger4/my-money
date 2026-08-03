import { supabase } from './supabaseClient.js';
import { applyAccountRules } from './categoryMap.js';
import { merchantKey, classifyDescription } from './txClassify.js';
import { applyRuleToHistory, isRangeExhaustedError } from './ruleHistory.js';
import { markInternalTransfers, cashIncome, cashSpending } from './cashFlow.js';
import { walkEnvelopes, monthKey, planMove } from './envelopes.js';
import { isSpend, sumSpending, spendingGroups, biggestMovers, toTxShape, aggregateEnvelopeSpending } from './spending.js';
import { createRangeMemo } from './monthMemo.js';
import { parseIgnoreList } from './recurring.js';
import { aggregateCoverage } from './coverage.js';

// Re-export the pure cash-flow model (src/cashFlow.js) so existing importers
// and the CSV-import dry-run harness keep working.
export { markInternalTransfers, cashIncome, cashSpending } from './cashFlow.js';

// Same deal for the pure envelope model (src/envelopes.js) — Dashboard and any
// harness import the helpers from one place.
export { targetNeed, readyToAssign, envelopePace, monthKey, shiftMonthKey } from './envelopes.js';

// The purchase-based spending model lives pure in src/spending.js (isSpend,
// sumSpending, the Categories bucketing, toTxShape, the envelope fold) — same
// extraction shape as cashFlow.js. Re-exported so harnesses and tests import
// the helpers from one place.
export {
  isSpend,
  sumSpending,
  spendingGroups,
  biggestMovers,
  toTxShape,
  patchTxShape,
  effectiveCategory,
  aggregateEnvelopeSpending,
} from './spending.js';

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

// The rental-tax columns (20260730000001) ride along on every transaction read
// so the detail sheet can show and edit them from ANY list — transactions tab,
// search results, the account sheet. Dropped (with the flag, below) until the
// migration is pasted, exactly like transactions.source.
const TX_TAX_COLUMNS = ', entity_id, is_capital, placed_in_service, useful_life_years';

const ACCOUNT_COLUMNS =
  'id, institution_id, plaid_account_id, name, official_name, nickname, color, mask, type, subtype, current_balance, available_balance, last_balance_at, hidden, institutions(name, display_name)';

// The RAW range fetch: pagination + the entity-column fallback, NO
// per-model pipeline (applyAccountRules / markInternalTransfers) — those
// mutate rows in place, so they run in getTransactionsBetween on each
// caller's own copies, never on rows the memo below might share.
async function fetchRawBetween(start, end, columns) {
  // RLS scopes every query to the signed-in household automatically.
  // The inner join on accounts drops transactions belonging to hidden
  // accounts from every dashboard view (spending, lists, trends).
  // An explicit `columns` (the envelope walk's narrow list) skips the tax
  // columns; the default wide read carries them, degrading pre-migration.
  const fetchAll = async withEntity => {
    const cols = columns ?? (withEntity ? TX_COLUMNS + TX_TAX_COLUMNS : TX_COLUMNS);
    const join = `accounts!inner(hidden, type, subtype${withEntity ? ', entity_id' : ''})`;
    const rows = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      const { data, error } = await supabase
        .from('transactions')
        .select(`${cols}, ${join}`)
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
    return rows;
  };
  try {
    return await fetchAll(!columns && transactionsHaveEntity);
  } catch (error) {
    if (!columns && transactionsHaveEntity && isMissingColumnError(error, 'entity_id')) {
      transactionsHaveEntity = false;
      return await fetchAll(false);
    }
    throw error;
  }
}

// Per-reload memo of the wide-column raw fetch (see src/monthMemo.js):
// reloadData fires getSpending / getTransactions / getOverview / getCashFlow
// in parallel and their ranges overlap — the memo dedupes in-flight requests
// per range and serves contained ranges by slicing, so each reload fetches the
// cash-flow window once instead of refetching the current month per caller.
// Cleared by invalidateEnvelopeSpending(), the same reload-time invalidation
// that drops spendCache. Callers always receive per-row shallow COPIES — the
// pipelines below mutate rows (top-level fields only), and shared rows would
// leak getCashFlow's `_internal` marks into the purchase-based model.
const rangeMemo = createRangeMemo((start, end) => fetchRawBetween(start, end));

// `columns` / `markTransfers` exist for the envelope walk, which can span
// years: it needs only the spending predicate's inputs, and never reads
// `_internal`, so it skips both the wide column list and the O(V·E) transfer
// matching (and the range memo — its aggregation is memoised separately as
// spendCache). Every other caller gets the full rows and the matching as
// before, each applied to its own copies.
async function getTransactionsBetween(start, end, { columns, markTransfers = true } = {}) {
  const rows = columns
    ? await fetchRawBetween(start, end, columns)
    : await rangeMemo.getCopy(start, end);
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

export async function getOverview() {
  const { data: accounts, error } = await supabase
    .from('accounts')
    .select('id, name, mask, type, current_balance')
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
      // Additive: the Overview card tile keys its remembered selection on it.
      id: a.id,
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
  return { groups: spendingGroups(txs) };
}

// The Trends "Biggest movers" read: the viewed month vs the month before it,
// through the pure biggestMovers (src/spending.js — isSpend lineage, purchase
// model ONLY). markTransfers is deliberately OFF: the purchase model never
// reads `_internal`, so the O(V·E) matching would be pure waste here — and
// skipping it keeps the cash-flow model out of this number entirely. Both
// months ride the same per-reload range memo the other reads share, so inside
// a reload the current month is served from the fetch getSpending already
// started (and the previous month from the cash-flow window when it overlaps).
export async function getBiggestMovers({ year, month }) {
  const prev = shiftMonth(year, month, -1);
  const cb = monthBounds(year, month);
  const pb = monthBounds(prev.year, prev.month);
  const [currRows, prevRows] = await Promise.all([
    getTransactionsBetween(cb.start, cb.end, { markTransfers: false }),
    getTransactionsBetween(pb.start, pb.end, { markTransfers: false }),
  ]);
  return { movers: biggestMovers(currRows, prevRows) };
}

// fields: { user_category } (null reverts to the automatic category),
// { user_description } (null reverts to the bank's name), and/or { excluded }.
// The rental-tax fields ride the same allowlist: { entity_id } (null reverts
// to the account's default entity), { is_capital }, { placed_in_service },
// { useful_life_years }. All user-owned — sync never writes any of them.
export async function updateTransaction(id, fields) {
  const allowed = {};
  if ('user_category' in fields) allowed.user_category = fields.user_category;
  if ('user_description' in fields) allowed.user_description = fields.user_description;
  if ('excluded' in fields) allowed.excluded = fields.excluded;
  if ('entity_id' in fields) allowed.entity_id = fields.entity_id;
  if ('is_capital' in fields) allowed.is_capital = fields.is_capital;
  if ('placed_in_service' in fields) allowed.placed_in_service = fields.placed_in_service;
  if ('useful_life_years' in fields) allowed.useful_life_years = fields.useful_life_years;
  const { error } = await supabase.from('transactions').update(allowed).eq('id', id);
  if (error) throw error;
  // Not every reader reloads through reloadData (which clears the memo):
  // saveTx only bumps taxEpoch, and the Tax refetch must not be served the
  // pre-edit rows out of a warm memo.
  rangeMemo.clear();
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
  // entity_id lands with the rental-tax migration; previews share the prod DB,
  // so this read must survive the column not existing yet (same trap as
  // is_manual). Rows without the column read as entity-less, which is right.
  const attempt = withEntity =>
    supabase
      .from('accounts')
      .select(withEntity ? `${ACCOUNT_COLUMNS}, entity_id` : ACCOUNT_COLUMNS)
      .order('type', { ascending: true })
      .order('name', { ascending: true });
  let { data, error } = await attempt(accountsHaveEntity);
  if (error && accountsHaveEntity && isMissingColumnError(error, 'entity_id')) {
    accountsHaveEntity = false;
    ({ data, error } = await attempt(false));
  }
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
  // Account-level rental default: every transaction on this account belongs to
  // the entity unless the row overrides it (null = no default).
  if ('entity_id' in fields) allowed.entity_id = fields.entity_id;
  // Debt-tracker liability fields — hand-entered in the Debt view, user-owned
  // (never written by the sync). The view only renders their editors when
  // getDebts reports the columns exist, so pre-migration these never arrive.
  for (const k of ['apr', 'minimum_payment', 'credit_limit', 'statement_balance', 'next_payment_due_date', 'interest_rate', 'original_balance'])
    if (k in fields) allowed[k] = fields[k];
  const { error } = await supabase.from('accounts').update(allowed).eq('id', id);
  if (error) throw error;
  // hidden/type edits change which rows the raw fetch returns / how they
  // classify — drop any memoised ranges rather than trust every caller to
  // reload through invalidateEnvelopeSpending.
  rangeMemo.clear();
}

// --- Debt tracker ------------------------------------------------------------
// The liability columns land with the debt-tracker migration (additive on
// accounts; hand-entered under SimpleFIN, never written by the sync). Previews
// share the prod DB, so this read must survive them not existing yet — same
// trap as is_manual/entity_id. Rows read as field-less (nulls) until then.
let accountsHaveDebtColumns = true;
const DEBT_COLUMNS =
  'apr, minimum_payment, credit_limit, statement_balance, next_payment_due_date, interest_rate, original_balance';

// Debt accounts for the Debt view. Return shape:
//   { debts: [{ ...account row (ACCOUNT_COLUMNS), apr, minimum_payment,
//               credit_limit, statement_balance, next_payment_due_date,
//               interest_rate, original_balance,   // null pre-migration
//               debtRate }],                       // apr ?? interest_rate, PERCENT (e.g. 22.9)
//     totalDebt,          // sum of current_balance, STORED convention (positive = owed)
//     totalMinimums }     // sum of minimum_payment over rows that have one
// Hidden accounts are excluded (their balances must not move the totals).
// Balances stay in the stored positive convention — the view renders them
// through displayBalance like every other balance.
export async function getDebts() {
  const attempt = withDebt =>
    supabase
      .from('accounts')
      .select(withDebt ? `${ACCOUNT_COLUMNS}, ${DEBT_COLUMNS}` : ACCOUNT_COLUMNS)
      .in('type', ['credit', 'loan'])
      .order('current_balance', { ascending: false });
  let { data, error } = await attempt(accountsHaveDebtColumns);
  if (error && accountsHaveDebtColumns && isMissingColumnError(error, 'apr')) {
    accountsHaveDebtColumns = false;
    ({ data, error } = await attempt(false));
  }
  if (error) throw error;
  const debts = (data || [])
    .filter(a => !a.hidden)
    .map(a => ({
      ...a,
      apr: a.apr ?? null,
      minimum_payment: a.minimum_payment ?? null,
      credit_limit: a.credit_limit ?? null,
      statement_balance: a.statement_balance ?? null,
      next_payment_due_date: a.next_payment_due_date ?? null,
      interest_rate: a.interest_rate ?? null,
      original_balance: a.original_balance ?? null,
      // One normalized rate for payoff math — stored as PERCENT; divide by 100
      // for monthly amortization (src/debtPayoff.js does).
      debtRate: a.apr ?? a.interest_rate ?? null,
    }));
  const totalDebt = debts.reduce((s, a) => s + (Number(a.current_balance) || 0), 0);
  const totalMinimums = debts.reduce((s, a) => s + (Number(a.minimum_payment) || 0), 0);
  // hasDebtColumns tells the Debt view whether the liability columns exist yet
  // (false pre-migration → it hides the APR/min editors instead of offering
  // edits that can't be written).
  return { debts, totalDebt, totalMinimums, hasDebtColumns: accountsHaveDebtColumns };
}

// Balance history for the debt-over-time chart. Returns an ARRAY of
//   { account_id, captured_on, balance }   // balance mirrors the STORED
// convention (debts positive = owed), oldest first — the chart flips at render
// via displayBalance. Returns [] when the balance_snapshots table hasn't been
// installed yet (previews share the prod DB), never throws for that.
let hasBalanceSnapshots = true;
export async function getBalanceSnapshots(accountIds, sinceDate) {
  if (!hasBalanceSnapshots || !accountIds || accountIds.length === 0) return [];
  let q = supabase
    .from('balance_snapshots')
    .select('account_id, captured_on, balance')
    .in('account_id', accountIds)
    .order('captured_on', { ascending: true });
  if (sinceDate) q = q.gte('captured_on', sinceDate);
  const { data, error } = await q;
  if (error) {
    // Missing table: PGRST205 (PostgREST schema cache) or 42P01 (Postgres) —
    // same pair as isEnvelopeSchemaMissing.
    if (error.code === 'PGRST205' || error.code === '42P01') {
      hasBalanceSnapshots = false;
      return [];
    }
    throw error;
  }
  return data || [];
}

// All transactions for one account, newest first, capped so a huge history
// can't lock up the phone. Returns { transactions, hasMore }.
export async function getAccountTransactions(accountId, { limit = 500 } = {}) {
  const attempt = withEntity =>
    supabase
      .from('transactions')
      .select(`${withEntity ? TX_COLUMNS + TX_TAX_COLUMNS : TX_COLUMNS}, accounts(type)`)
      .eq('account_id', accountId)
      .order('date', { ascending: false })
      .limit(limit + 1);
  let { data, error } = await attempt(transactionsHaveEntity);
  if (error && transactionsHaveEntity && isMissingColumnError(error, 'entity_id')) {
    transactionsHaveEntity = false;
    ({ data, error } = await attempt(false));
  }
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
//
// NOTE for callers: this ALWAYS throws on a real failure and never returns 0 to
// mean "it didn't work". 0 genuinely means nothing matched — and because the
// transaction being edited matches its own rule (its descriptor is where the
// key came from) and only ever has `user_category` rewritten, 0 is impossible
// unless the merchant truly appears nowhere else under a different
// mapped_category. Swallowing the throw into a 0 makes a broken preview look
// exactly like "nothing to update", which is how this failed silently.
//
// The whole loop — narrowing, PGRST103 paging contract, re-matching, dryRun —
// lives in src/ruleHistory.js (pure, tested with fakes); this wrapper only
// binds the real client.
export async function applyCategoryRuleToHistory(descriptor, category, { dryRun = false } = {}) {
  const result = await applyRuleToHistory({
    descriptor,
    category,
    dryRun,
    fetchPage: (pat, from, to) =>
      supabase
        .from('transactions')
        .select('id, description, merchant_name, mapped_category')
        .or(`description.ilike.${pat},merchant_name.ilike.${pat}`)
        // Same tiebreaker reasoning as getTransactionsBetween: paging an
        // unordered result set can drop or repeat rows across the boundary,
        // and a dropped row here is a transaction the rule silently fails to
        // fix.
        .order('id', { ascending: true })
        .range(from, to),
    updateBatch: (ids, cat) =>
      supabase.from('transactions').update({ mapped_category: cat }).in('id', ids),
  });
  // A real apply rewrites other rows' mapped_category; the recurring/tax
  // refetches it triggers don't pass through invalidateEnvelopeSpending.
  if (!dryRun) rangeMemo.clear();
  return result;
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
    // A row count that is an exact multiple of `page` makes the next request
    // start past the end, which PostgREST answers with a 416/PGRST103 rather
    // than an empty page — treat that as end-of-data, not a failure (same fix
    // as the ruleHistory candidate scan and the spendingContext paginators).
    if (error) {
      if (isRangeExhaustedError(error)) break;
      throw error;
    }
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

// Per-envelope pace-warning opt-in. Stored as ONE settings row keyed
// 'env:pace' whose value is a JSON map { category: true } — the dash:colors /
// dash:cats pattern (a name-keyed JSON blob), chosen because adding a real
// budgets column would need a migration and this is a pure display preference.
// Default OFF for every category (absent key ⇒ {}), so a fixed bill that spends
// 100% on day 1 never false-alarms; opting in is a deliberate per-envelope act.
const ENV_PACE_KEY = 'env:pace';

export async function getEnvPace() {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', ENV_PACE_KEY)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.value == null || String(data.value).trim() === '') return {};
  try {
    const parsed = JSON.parse(data.value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function setEnvPace(map) {
  const clean = {};
  for (const [k, v] of Object.entries(map || {})) if (v) clean[k] = true;
  const { error } = await supabase
    .from('settings')
    .upsert({ key: ENV_PACE_KEY, value: JSON.stringify(clean) }, { onConflict: 'household_id,key' });
  if (error) throw error;
}

// Recurring-charge ignore list — a HOUSEHOLD pref (settings table, NOT
// localStorage: muting a subscription should mute it on both phones — Mason's
// recorded ruling). ONE row keyed 'rec:ignore' holding a JSON array of the
// recurring items' group keys (detectRecurring's `key`); parsing is the pure
// parseIgnoreList in src/recurring.js. Display-only: detection stays
// unfiltered and the Recurring tab filters at render, so toggling never
// refetches (and never touches the lazy cache's null-means-refetch sentinel).
const REC_IGNORE_KEY = 'rec:ignore';

export async function getRecIgnore() {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', REC_IGNORE_KEY)
    .maybeSingle();
  if (error) throw error;
  return parseIgnoreList(data?.value ?? null);
}

export async function setRecIgnore(keys) {
  const seen = new Set();
  const clean = [];
  for (const k of keys || []) {
    if (typeof k !== 'string' || !k || seen.has(k)) continue;
    seen.add(k);
    clean.push(k);
  }
  const { error } = await supabase
    .from('settings')
    .upsert({ key: REC_IGNORE_KEY, value: JSON.stringify(clean) }, { onConflict: 'household_id,key' });
  if (error) throw error;
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
  // The raw range memo lives and dies by the same moment: reloadData calls
  // this before its parallel fetches, so each reload starts from an empty memo
  // and shares within itself only.
  rangeMemo.clear();
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
  // Spent can never disagree with the bar rendered beside it — the fold itself
  // is pure in src/spending.js.
  const spending = aggregateEnvelopeSpending(txs);
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
// The window reaches ~2 years (was 6 months) so the ANNUAL cadence has the
// >= 3 charges detection requires — two full year-gaps. Detection never reads
// `_internal`, so the O(V·E) transfer matching is skipped over this long
// range — the envelope-walk precedent (transfers are excluded by CATEGORY in
// detectRecurring, not by the pairing marks).
export async function getRecurringCandidates({ months = 25 } = {}) {
  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;
  const oldest = shiftMonth(curY, curM, -(months - 1));
  const { start } = monthBounds(oldest.year, oldest.month);
  const { end } = monthBounds(curY, curM);
  const rows = await getTransactionsBetween(start, end, { markTransfers: false });
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
  const attempt = withEntity =>
    supabase
      .from('transactions')
      .select(`${withEntity ? TX_COLUMNS + TX_TAX_COLUMNS : TX_COLUMNS}, accounts!inner(hidden, type, subtype)`)
      .eq('accounts.hidden', false)
      .or(ors.join(','))
      .order('date', { ascending: false })
      .limit(limit + 1);
  let { data, error } = await attempt(transactionsHaveEntity);
  if (error && transactionsHaveEntity && isMissingColumnError(error, 'entity_id')) {
    transactionsHaveEntity = false;
    ({ data, error } = await attempt(false));
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
  rangeMemo.clear(); // new rows exist — memoised ranges are stale
  return written;
}

// --- Manual transaction quick-add -------------------------------------------
// Record a single cash/manual transaction by hand — the one spending path CSV/PDF
// import can't reach (a coffee paid in cash never hits a feed). Writes ONE real
// row onto a manual "Imported" account, running the SAME write-time
// categorization the CSV importer and the SimpleFIN sync use.

// The pure row builder: id + sign + write-time category, no I/O. Exported so a
// test can assert the id/prefix/source, the sign storage and the category
// precedence without a live client.
//
// Sign: `amount` is ALREADY in the app convention (positive = money out), same
// as the rows importCsvTransactions stores — NO flip here. The form collects a
// positive figure the user thinks of as "spent", which already IS positive=out;
// a user recording money in passes a negative amount (the caller's job), exactly
// like every stored row. The helper never reinterprets the sign.
//
// Category: derived at WRITE time via the shared precedence in
// classifyDescription — learned rule (from `rules`) → keyword table →
// Uncategorized — with `accountType` passed so a card purchase is never read as
// a card payment. `user_category` is set ONLY when the user explicitly picked
// one in the form; at read time it still wins over mapped_category.
export function buildManualTxRow({ date, amount, description, category } = {}, { rules, accountType } = {}) {
  if (!date) throw new Error('addManualTransaction requires a date');
  const amt = Number(amount);
  if (!Number.isFinite(amt)) throw new Error('addManualTransaction requires a numeric amount');
  const desc = (description || '').trim();
  const { raw_category, mapped_category } = classifyDescription(desc, amt, accountType, rules);
  const row = {
    // The adapter-agnostic external-id space plaid_tx_id carries (sfin:/csv:/
    // manual:). crypto.randomUUID via makeUuid — the app's existing uuid path,
    // no new dependency, and never the csvImport content hash (that is for
    // idempotent re-import; a hand-typed row has no file to re-import).
    plaid_tx_id: MANUAL_ACCOUNT_PREFIX + makeUuid(),
    date,
    // Stored already-signed, positive = money out (see the sign note above).
    amount: Number(amt.toFixed(2)),
    merchant_name: '',
    description: desc,
    raw_category,
    mapped_category,
    pending: false,
  };
  // Only an explicit user pick becomes a user_category override.
  if (category) row.user_category = category;
  return row;
}

// Insert a manual transaction and return it shaped like getTransactions rows so
// the caller can optimistically patch its lists (saveTx Gotcha: a new row only
// appears via that patch or a reloadData). household_id is NOT set — the client
// insert resolves it from the column default current_household_id() (auth.uid()
// is present); setting it explicitly is the service-role trap, the opposite
// case. Deps are injectable for tests (default: the module client + rules read).
export async function addManualTransaction(
  { accountId, date, amount, description, category } = {},
  { client = supabase, getRules = getCategoryRules } = {},
) {
  if (!accountId) throw new Error('addManualTransaction requires an account id');

  // Gate: the target must be a manual account. A manual: id on a SimpleFIN-fed
  // account would collide with the feed's own id space — the same overlap rule
  // that keeps csv: history off a live feed. Reject it.
  const { data: acct, error: acctErr } = await client
    .from('accounts')
    .select('id, plaid_account_id, is_manual, type, subtype')
    .eq('id', accountId)
    .single();
  if (acctErr) throw acctErr;
  if (!acct) throw new Error('Account not found');
  if (isSimpleFinAccount(acct) || !isManualAccount(acct))
    throw new Error('Manual transactions can only be added to a manual account');

  const rules = await getRules();
  const row = buildManualTxRow({ date, amount, description, category }, { rules, accountType: acct.type });
  const insert = { ...row, account_id: accountId };

  const attempt = async withSource => {
    const payload = withSource ? { ...insert, source: 'manual' } : insert;
    return client
      .from('transactions')
      .insert(payload)
      .select(`${TX_COLUMNS}, accounts!inner(hidden, type, subtype)`)
      .single();
  };

  let { data, error } = await attempt(transactionsHaveSource);
  if (error && transactionsHaveSource && isMissingColumnError(error, 'source')) {
    transactionsHaveSource = false;
    ({ data, error } = await attempt(false));
  }
  if (error) throw error;

  // Credit-card refunds become "Return" — same pipeline step every read runs.
  data.mapped_category = applyAccountRules(data.mapped_category, data.amount, data.accounts?.type);
  rangeMemo.clear(); // a new row exists — memoised ranges are stale
  return toTxShape(data);
}

// --- Rental entities + tax lens ---------------------------------------------
// The rental-tax migration (20260730000001) adds all of this at once, so one
// table-level flag covers the reads that need it. Like category_rules, every
// read degrades to "feature not installed" when the migration hasn't been
// pasted yet (previews share the prod database).

let hasEntities = true;
let hasMileage = true;
let accountsHaveEntity = true;
let transactionsHaveEntity = true;

function isMissingTableError(error) {
  return error && (error.code === 'PGRST205' || error.code === '42P01');
}

// Rental properties (kind='rental'; the schema also allows 'business' for a
// future side-business, but nothing in the UI creates one yet). Archived
// entities are returned too: a year-end report must still resolve an entity
// archived mid-year — callers filter on archived_at for pickers.
export async function getEntities() {
  if (!hasEntities) return { entities: [] };
  const { data, error } = await supabase
    .from('entities')
    .select('id, name, kind, created_at, archived_at')
    .order('created_at', { ascending: true });
  if (error) {
    if (isMissingTableError(error)) {
      hasEntities = false;
      return { entities: [] };
    }
    throw error;
  }
  return { entities: data };
}

export async function createEntity(name, kind = 'rental') {
  const { data, error } = await supabase
    .from('entities')
    .insert({ name, kind })
    .select('id, name, kind, created_at, archived_at')
    .single();
  if (error) throw error;
  return data;
}

// fields: { name } and/or { archived_at } (an ISO timestamp archives, null
// restores). Archive rather than delete — transactions reference the row.
export async function updateEntity(id, fields) {
  const allowed = {};
  if ('name' in fields) allowed.name = fields.name;
  if ('archived_at' in fields) allowed.archived_at = fields.archived_at;
  const { error } = await supabase.from('entities').update(allowed).eq('id', id);
  if (error) throw error;
}

// Every transaction of one calendar year, shaped like toTxShape (which now
// carries the tax fields), plus the EFFECTIVE entity resolved (tx.entity_id ??
// the account's default). Hidden accounts are excluded like every other
// dashboard read — a hidden SimpleFIN account's type is an unconfirmed guess,
// and unhiding is the act that confirms it; assign entities after that. Feeds
// both the Schedule E report (entity rows) and the personal-deduction report
// (the rest), so it returns everything and lets src/taxReport.js split.
export async function getTaxYearTransactions(year) {
  const rows = await getTransactionsBetween(`${year}-01-01`, `${year}-12-31`);
  return {
    transactions: rows.map(t => ({
      ...toTxShape(t),
      // toTxShape's entity_id is the row's OWN value (so the detail sheet can
      // tell an explicit assignment from an inherited one); this is the value
      // the report filters on.
      effective_entity_id: t.entity_id ?? t.accounts?.entity_id ?? null,
    })),
  };
}

// --- Mileage log (hand-entered; valued by src/taxReport.js) ------------------

export async function getMileage(year) {
  if (!hasMileage) return { mileage: [] };
  const { data, error } = await supabase
    .from('mileage_log')
    .select('id, entity_id, on_date, miles, purpose')
    .gte('on_date', `${year}-01-01`)
    .lte('on_date', `${year}-12-31`)
    .order('on_date', { ascending: false })
    .limit(2000);
  if (error) {
    if (isMissingTableError(error)) {
      hasMileage = false;
      return { mileage: [] };
    }
    throw error;
  }
  return { mileage: data };
}

export async function addMileage({ on_date, miles, purpose, entity_id }) {
  const { data, error } = await supabase
    .from('mileage_log')
    .insert({ on_date, miles, purpose: purpose || null, entity_id: entity_id || null })
    .select('id, entity_id, on_date, miles, purpose')
    .single();
  if (error) throw error;
  return data;
}

export async function deleteMileage(id) {
  const { error } = await supabase.from('mileage_log').delete().eq('id', id);
  if (error) throw error;
}

// --- Receipts (photo attachments; migration 20260731000001) ------------------
// Images live in the PRIVATE 'receipts' Storage bucket; the receipts table is
// the index the app trusts (never storage.list()). Paths are
// <household_id>/<transaction_id>/<uuid>.<ext> — the first segment is what the
// storage policy scopes on. Display always goes through short-lived signed
// URLs minted per render; a signed URL is never stored. USER-OWNED like
// user_category: sync and the importers never touch any of this, so
// attachments survive re-pulls. Degrades to "not installed" pre-migration
// like the rental-tax reads.

let hasReceipts = true;

// The storage path needs the household id, which the client doesn't otherwise
// hold (RLS defaults fill it on table inserts). current_household_id() is a
// plain public-schema function, so PostgREST exposes it as an rpc. Cached —
// the household can't change within a session.
let cachedHouseholdId = null;
async function getHouseholdId() {
  if (cachedHouseholdId) return cachedHouseholdId;
  const { data, error } = await supabase.rpc('current_household_id');
  if (error) throw error;
  if (!data) throw new Error('No household for this user');
  cachedHouseholdId = data;
  return data;
}

export async function getReceipts(transactionId) {
  if (!hasReceipts) return { receipts: [] };
  const { data, error } = await supabase
    .from('receipts')
    .select('id, transaction_id, storage_path, mime, created_at')
    .eq('transaction_id', transactionId)
    .order('created_at', { ascending: true });
  if (error) {
    if (isMissingTableError(error)) {
      hasReceipts = false;
      return { receipts: [] };
    }
    throw error;
  }
  return { receipts: data };
}

// The Tax tab's "which transactions have a receipt?" read: the whole table's
// transaction_ids as a Set. The table is one row per photo a human took —
// paginated anyway so a decade of receipts can't silently truncate.
// Returns null (not an empty Set) when the migration isn't installed, so the
// Tax tab can tell "no receipts yet" from "the feature doesn't exist" and
// skip the no-receipt nag instead of flagging every capital expense.
export async function getReceiptTxIds() {
  if (!hasReceipts) return null;
  const ids = new Set();
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('receipts')
      .select('transaction_id')
      .order('id', { ascending: true })
      .range(from, from + page - 1);
    if (error) {
      if (isMissingTableError(error)) {
        hasReceipts = false;
        return null;
      }
      // End-of-range on an exact-multiple-of-1000 result set is end-of-data,
      // not a failure (the learned-rule candidate scan's bug — and here a
      // throw is worse: Dashboard folds it into null, the "not installed"
      // sentinel, silently switching the no-receipt nag off).
      if (isRangeExhaustedError(error)) break;
      throw error;
    }
    for (const r of data) ids.add(r.transaction_id);
    if (data.length < page) break;
  }
  return ids;
}

// blob: the ALREADY-COMPRESSED image (src/receiptImage.js) — this function
// does no resizing. Upload the object first, then insert the index row; a
// failure between the two orphans a blob (accepted, ~200 KB) rather than
// creating a row pointing at nothing.
export async function addReceipt(transactionId, blob, mime = 'image/jpeg') {
  const householdId = await getHouseholdId();
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  const path = `${householdId}/${transactionId}/${crypto.randomUUID()}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from('receipts')
    .upload(path, blob, { contentType: mime, upsert: false });
  if (upErr) throw upErr;
  const { data, error } = await supabase
    .from('receipts')
    .insert({ transaction_id: transactionId, storage_path: path, mime })
    .select('id, transaction_id, storage_path, mime, created_at')
    .single();
  if (error) {
    // Roll the object back so a failed insert doesn't strand a blob the index
    // will never find. Best-effort — if this remove also fails, the orphan is
    // the accepted outcome.
    await supabase.storage.from('receipts').remove([path]).catch(() => {});
    throw error;
  }
  return data;
}

// Object first, then row: the row is the index, so deleting it last means a
// half-completed delete leaves a still-listed receipt whose image 404s only
// until retried, never an invisible orphan.
export async function deleteReceipt(receipt) {
  const { error: rmErr } = await supabase.storage
    .from('receipts')
    .remove([receipt.storage_path]);
  if (rmErr) throw rmErr;
  const { error } = await supabase.from('receipts').delete().eq('id', receipt.id);
  if (error) throw error;
}

// Mint a fresh signed URL per render — 1 hour outlives any open sheet, and
// nothing caches it (the service worker passes cross-origin through).
export async function getReceiptUrl(storagePath) {
  const { data, error } = await supabase.storage
    .from('receipts')
    .createSignedUrl(storagePath, 3600);
  if (error) throw error;
  return data.signedUrl;
}

// TEMPORARY TROUBLESHOOTING AID (see src/coverage.js) — per-account transaction
// coverage for the Accounts tab's "Data coverage" panel. Pages the WHOLE
// transactions table (account_id/date/source only), so callers should fetch
// lazily — Dashboard loads it only when the panel is first expanded.
// Return shape (stable): { [account_id]: { first: 'YYYY-MM-DD'|null,
//   last: 'YYYY-MM-DD'|null, count: n, sources: { simplefin|csv|pdf|manual|unknown: n } } }
export async function getDataCoverage() {
  const rows = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('transactions')
      .select('account_id, date, source')
      .order('id', { ascending: true })
      .range(from, from + page - 1);
    // A row count that is an exact multiple of `page` makes the next request
    // start past the end, which PostgREST answers with a 416/PGRST103 rather
    // than an empty page — treat that as end-of-data, not a failure (same fix
    // as the ruleHistory candidate scan and the spendingContext paginators).
    if (error) {
      if (isRangeExhaustedError(error)) break;
      throw error;
    }
    rows.push(...data);
    if (data.length < page) break;
  }
  return aggregateCoverage(rows);
}
