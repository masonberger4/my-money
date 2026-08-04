import { supabase } from './supabaseClient.js';
import { applyAccountRules } from './categoryMap.js';
import { merchantKey, classifyDescription } from './txClassify.js';
import { applyRuleToHistory, isRangeExhaustedError } from './ruleHistory.js';
import { markInternalTransfers, cashIncome, cashSpending } from './cashFlow.js';
import { walkEnvelopes, monthKey, planMove, planAutoFill } from './envelopes.js';
import { matchExpected, rollForwardDate, isDuplicateExpected, isDuplicateRollForward } from './expectedTx.js';
import { isBudgetableCategory } from './categoryMap.js';
import { isSpend, sumSpending, spendingGroups, biggestMovers, toTxShape, aggregateEnvelopeSpending } from './spending.js';
import { createRangeMemo } from './monthMemo.js';
import { setSyncCompletionHook } from './sync.js';
import { amountOrClause, searchIsActive } from './searchFilters.js';
import { parseIgnoreList, toggleIgnoreKey, CANDIDATE_WINDOW_MONTHS } from './recurring.js';
import { parseSavedChats, addSavedChat, removeSavedChat } from './savedChats.js';
import { aggregateCoverage } from './coverage.js';
import { netWorthSeries, clampSeries } from './netWorth.js';
import { getSetting, setSetting, getSettings, deleteSetting } from './db.js';
import { makeSerializedUpdater } from './serializedUpdater.js';

// Re-export the pure cash-flow model (src/cashFlow.js) so existing importers
// and the CSV-import dry-run harness keep working.
export { markInternalTransfers, cashIncome, cashSpending } from './cashFlow.js';

// Same deal for the pure envelope model (src/envelopes.js) — Dashboard and any
// harness import the helpers from one place.
export { targetNeed, readyToAssign, envelopePace, monthKey, shiftMonthKey, effectiveTarget } from './envelopes.js';

// Same for the pure expected-transaction model (src/expectedTx.js) — the I/O
// lives below; Dashboard imports the display helpers from one place.
export {
  expectedByCategory,
  projectFutureCycles,
  expectedStatus,
  isMissedExpected,
  seedFromRecurring,
} from './expectedTx.js';

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
    return pagedRows((from, to) =>
      supabase
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
        .range(from, to)
    );
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
// Cleared by invalidateEnvelopeSpending(), the same invalidation that drops
// spendCache — fired on write / sync / import / Refresh, NOT on plain month
// navigation, which reuses warm entries (Mason, 2026-08-04). Reuse is safe
// because callers never see the memo's rows: they get per-row shallow COPIES —
// pipelines below mutate rows (top-level fields only), and shared rows would
// leak getCashFlow's `_internal` marks into the purchase-based model.
const rangeMemo = createRangeMemo((start, end) => fetchRawBetween(start, end));

// The ONE paged-loop discipline (exported for tests). Every whole-table /
// whole-range read pages in 1000-row windows, and a result set that is an
// exact multiple of the page size makes the next request start past the end —
// PostgREST answers that with 416/PGRST103, not an empty page. Treat it as
// end-of-data (isRangeExhaustedError), never a failure: an unguarded throw on
// an exact N×1000 window errors the whole dashboard (the memo evicts on
// rejection, so it recurs on every reload) and blocks CSV/PDF import.
export async function pagedRows(fetchPage, page = 1000) {
  const rows = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await fetchPage(from, from + page - 1);
    if (error) {
      if (isRangeExhaustedError(error)) break;
      throw error;
    }
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < page) break;
  }
  return rows;
}

// `columns` exists for the envelope walk, which can span years: it needs only
// the spending predicate's inputs, so it skips the wide column list (and the
// range memo — its aggregation is memoised separately as spendCache).
// EVERY caller gets markInternalTransfers: under the unified linked-boundary
// model isSpend() reads `_internal`, so the pairing is part of establishing
// the row shape, not a Trends-only step. It stays cheap because matching runs
// per equal-amount bucket (near-linear) with binary-searched date windows.
async function getTransactionsBetween(start, end, { columns } = {}) {
  const rows = columns
    ? await fetchRawBetween(start, end, columns)
    : await rangeMemo.getCopy(start, end);
  // Credit-card refunds become "Return" — not income, not spending.
  for (const t of rows) {
    t.mapped_category = applyAccountRules(t.mapped_category, t.amount, t.accounts?.type);
  }
  markInternalTransfers(rows);
  return rows;
}

// The subset of TX_COLUMNS that isSpend() + effectiveCategory() +
// markInternalTransfers actually read (plus `id`, which the pagination
// tiebreaker orders by). account_id feeds the pairing (different-account
// rule); description/merchant_name feed the card-payment veto. isLoanAccount
// reads accounts.type, which the inner join already selects.
const SPEND_TX_COLUMNS =
  'id, account_id, date, amount, description, merchant_name, mapped_category, user_category, excluded';

// The recurring candidate fetch (~40 months — the app's largest query) needs
// only what detectRecurring reads off the toTxShape rows: the spending
// predicate's inputs plus user_description, which displayName() folds into
// merchant_name (a renamed subscription must keep grouping under its display
// name). Everything else toTxShape emits (plaid_tx_id, tax columns, pending)
// defaults harmlessly and detection never reads it. Exported for the test
// that pins this list against recurring.js's actual reads.
export const RECURRING_TX_COLUMNS = SPEND_TX_COLUMNS + ', user_description';

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
// through the pure biggestMovers (src/spending.js — isSpend lineage, the ONE
// linked-boundary model). Each month's rows arrive already marked:
// getTransactionsBetween runs markInternalTransfers per fetch, because
// isSpend() reads `_internal` — the pairing is part of the row shape, not an
// optional step. Both months ride the same per-reload range memo the other
// reads share, so inside a reload the current month is served from the fetch
// getSpending already started (and the previous month by slicing the
// cash-flow window when it overlaps). Honest limit: the pairing sees one
// month's window at a time, so a transfer pair straddling the month boundary
// is unpaired on both sides and each leg COUNTS — the same verdict the one
// model gives any pair that crosses a boundary it can't see across (an
// unlinked or hidden account), here triggered by the window edge instead of
// the account set.
export async function getBiggestMovers({ year, month }) {
  const prev = shiftMonth(year, month, -1);
  const cb = monthBounds(year, month);
  const pb = monthBounds(prev.year, prev.month);
  const [currRows, prevRows] = await Promise.all([
    getTransactionsBetween(cb.start, cb.end),
    getTransactionsBetween(pb.start, pb.end),
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
  // Writes are THE invalidation moment now that month navigation reuses the
  // caches (Mason, 2026-08-04): drop the memoised ranges AND the envelope
  // spend sums here — reloadData no longer invalidates, so a site that only
  // cleared the range memo would leave spendCache serving pre-edit sums.
  invalidateEnvelopeSpending();
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

// type/subtype are editable — SimpleFIN sends neither, so the type is guessed
// at first insert and user-owned thereafter (the sync writes it on INSERT
// only); manual accounts get theirs once at creation. See ACCOUNT_TYPES.
export const ACCOUNT_TYPES = ['depository', 'credit', 'loan'];
export const ACCOUNT_SUBTYPES = ['checking', 'savings'];

export async function updateAccount(id, fields) {
  const allowed = {};
  // current_balance is deliberately NOT in this whitelist: a fed balance is
  // never hand-edited (the sync restates it). A MANUAL account's balance IS
  // typed by hand — that path is updateManualBalance below, which requires the
  // account row so it can prove is_manual before writing.
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
  // classify — drop the memoised ranges AND the envelope spend sums (isSpend
  // reads the account type; hidden gates the query). reloadData no longer
  // invalidates, so this write is the invalidation moment.
  invalidateEnvelopeSpending();
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
  // Paged: PostgREST caps unranged reads at 1000 rows and truncation here
  // would drop the NEWEST snapshots (ascending order) — the exact rows the
  // headline/sparkline endpoints read. Ordinal tiebreak on account_id keeps
  // pages deterministic; PGRST103 on an exact page multiple = cleanly done
  // (the same end-of-range contract as ruleHistory).
  const page = 1000;
  const rows = [];
  for (let from = 0; ; from += page) {
    let q = supabase
      .from('balance_snapshots')
      .select('account_id, captured_on, balance')
      .in('account_id', accountIds)
      .order('captured_on', { ascending: true })
      .order('account_id', { ascending: true })
      .range(from, from + page - 1);
    if (sinceDate) q = q.gte('captured_on', sinceDate);
    const { data, error } = await q;
    if (error) {
      if (isRangeExhaustedError(error)) break;
      if (isMissingTableError(error)) {
        hasBalanceSnapshots = false;
        return [];
      }
      throw error;
    }
    rows.push(...(data || []));
    if (!data || data.length < page) break;
  }
  return rows;
}

// Net worth over time: assets minus debts off balance_snapshots, one point
// per snapshot date, oldest first — [{ date, total }], total already SIGNED
// (each account through displayBalance inside the fold; render it directly,
// never through displayBalance again). Hidden accounts are EXCLUDED (Mason
// 2026-08-03, the query-level rule) — filtered here so the pure fold never
// sees them or their snapshots. Degrades like getBalanceSnapshots: [] when
// the snapshots table isn't installed yet (previews share the prod DB), and
// [] on no accounts. `hidden` is an original accounts column, so there is no
// missing-column arm to check here.
//
// sinceDate is a DISPLAY window, never a fetch window: snapshots are written
// on balance CHANGE only, so an account that hasn't moved inside the window
// has zero rows there and a windowed fetch would silently drop its entire
// balance from every point — headline included (a manual loan typed once ages
// out of a 365-day window after a year, with no error and no visual tell).
// So the fold always runs over FULL history and clampSeries trims the points
// afterwards, keeping the boundary-crossing carry.
export async function getNetWorthSeries(sinceDate) {
  const { data, error } = await supabase.from('accounts').select('id, type, hidden');
  if (error) throw error;
  const accounts = (data || []).filter(a => !a.hidden);
  const snaps = await getBalanceSnapshots(accounts.map(a => a.id), null);
  return clampSeries(netWorthSeries(snaps, accounts), sinceDate);
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
    if (isMissingTableError(error)) {
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
  // A real apply rewrites other rows' mapped_category — a write, so it is an
  // invalidation moment (spend sums shift when categories move between
  // spending and the transfer bucket's veto).
  if (!dryRun) invalidateEnvelopeSpending();
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
  // Missing table (shared predicate) OR the budgets columns the migration
  // adds (42703, undefined_column) — this is the one place a column error is
  // deliberately part of a schema-missing verdict; everywhere else the
  // table/column tests stay separate (the api/sync.js rule).
  return !!error && (isMissingTableError(error) || error.code === '42703');
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
// budget_months.target_override lands with migration 20260804000001. Previews
// share the prod database, so the read must work before Mason pastes it — but
// the fallback needs a check STRICTER than isMissingColumnError: the Budget
// tab's gate (isEnvelopeSchemaMissing) treats ANY 42703 as "envelopes not
// installed", so a bare 42703 caused by this one new column escaping from
// here would shut the whole tab off. Only an error that NAMES target_override
// triggers the retry; everything else still escapes to the gate untouched.
let budgetMonthsHaveOverride = true;

function isMissingOverrideColumnError(error) {
  if (!error) return false;
  if (error.code !== '42703' && error.code !== 'PGRST204') return false;
  const blob = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`.toLowerCase();
  return blob.includes('target_override');
}

async function getAssignmentsThrough(monthStart, { client = supabase } = {}) {
  const rows = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const attempt = withOverride =>
      client
        .from('budget_months')
        .select(withOverride ? 'category, month, assigned, target_override' : 'category, month, assigned')
        .lte('month', monthStart)
        .order('month', { ascending: true })
        .order('category', { ascending: true })
        .range(from, from + page - 1);
    let { data, error } = await attempt(budgetMonthsHaveOverride);
    if (error && budgetMonthsHaveOverride && isMissingOverrideColumnError(error)) {
      budgetMonthsHaveOverride = false;
      ({ data, error } = await attempt(false));
    }
    // A row count that is an exact multiple of `page` makes the next request
    // start past the end, which PostgREST answers with a 416/PGRST103 rather
    // than an empty page — treat that as end-of-data, not a failure (same fix
    // as the ruleHistory candidate scan and the spendingContext paginators).
    if (error) {
      if (isRangeExhaustedError(error)) break;
      throw error;
    }
    // walkEnvelopes reads `targetOverride` off the assignment rows (viewed
    // month only; past overrides never reach the output — the walk enforces
    // that, not this read).
    for (const r of data) {
      rows.push({
        category: r.category,
        month: r.month,
        assigned: r.assigned,
        targetOverride: r.target_override ?? null,
      });
    }
    if (data.length < page) break;
  }
  return rows;
}
export { getAssignmentsThrough }; // exported for test/envelopeIO.test.js only

// Household income for a month, for Ready to Assign. Hand-entered: the feed
// still cannot be trusted for take-home pay (SimpleFIN only syncs what is
// linked and unhidden, and a missed paycheck would silently read as less to
// budget). `budget:income` is the recurring default; `budget:income:YYYY-MM`
// overrides one month. Both live in `settings`, so this needs no migration.
const INCOME_KEY = 'budget:income';

export async function getBudgetIncome({ year, month }) {
  const monthKeyStr = `${INCOME_KEY}:${monthKey(year, month)}`;
  const byKey = await getSettings([INCOME_KEY, monthKeyStr]);
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
  if (n == null) await deleteSetting(key);
  else await setSetting(key, String(n));
  if (scope === 'default') await deleteSetting(monthKeyStr);
}

// Per-envelope pace-warning opt-in. Stored as ONE settings row keyed
// 'env:pace' whose value is a JSON map { category: true } — the dash:colors /
// dash:cats pattern (a name-keyed JSON blob), chosen because adding a real
// budgets column would need a migration and this is a pure display preference.
// Default OFF for every category (absent key ⇒ {}), so a fixed bill that spends
// 100% on day 1 never false-alarms; opting in is a deliberate per-envelope act.
const ENV_PACE_KEY = 'env:pace';

export async function getEnvPace() {
  const value = await getSetting(ENV_PACE_KEY);
  if (value == null || String(value).trim() === '') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function setEnvPace(map) {
  const clean = {};
  for (const [k, v] of Object.entries(map || {})) if (v) clean[k] = true;
  await setSetting(ENV_PACE_KEY, JSON.stringify(clean));
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
  return parseIgnoreList(await getSetting(REC_IGNORE_KEY));
}

export async function setRecIgnore(keys) {
  const seen = new Set();
  const clean = [];
  for (const k of keys || []) {
    if (typeof k !== 'string' || !k || seen.has(k)) continue;
    seen.add(k);
    clean.push(k);
  }
  await setSetting(REC_IGNORE_KEY, JSON.stringify(clean));
}

// Toggle ONE key with a read-merge-write: re-read the stored row at toggle
// time and change only the toggled key (pure toggleIgnoreKey). Rebuilding the
// whole array from component state let a failed mount-time read (recIgnore=[]
// after a network blip) wipe every previously ignored charge for BOTH phones
// on the first ✕ tap — and made the ordinary two-phone race last-array-wins.
// A failed READ aborts before any write. Returns the merged list so the
// caller can adopt keys the other phone added since mount.
//
// SAME-DEVICE toggles are serialized through a promise chain: two quick ✕
// taps otherwise interleave (read A, read B, write [A], write [B]) and the
// last write silently drops the first key — then the caller's
// .then(setRecIgnore) reverts it on screen too. Chaining makes B's read see
// A's committed write. The chain swallows rejections so one failed toggle
// never dams the queue; callers still receive the real rejection. The
// two-PHONE race stays the accepted single-key last-write-wins.
//
// The chain mechanics (serialization, failed-read-aborts, swallowed
// rejections that never dam the queue) live in the shared
// makeSerializedUpdater (src/serializedUpdater.js, tested) — this binds it.
const runRecIgnoreUpdate = makeSerializedUpdater(getRecIgnore, setRecIgnore);
export function updateRecIgnore(key, ignored) {
  return runRecIgnoreUpdate(current => toggleIgnoreKey(current, key, ignored));
}

// Saved Ask-tab chats — HOUSEHOLD data (settings table, NOT device storage:
// a chat saved on the laptop should be openable on the phone). ONE row keyed
// 'asst:chats' holding a JSON array of {id,title,savedAt,msgs}; all parsing/
// trimming/eviction decisions are pure in src/savedChats.js. The WRITE is a
// read-merge-write serialized through a promise chain — the exact
// updateRecIgnore discipline: two quick saves must not interleave (read A,
// read B, write [A], write [B]) and drop one, and a failed mount-time read
// must never let a rebuilt-from-state array wipe the other phone's saves.
// A failed READ aborts before any write; the chain swallows rejections so one
// failed save never dams the queue, while callers still get the rejection.
const ASST_CHATS_KEY = 'asst:chats';

export async function getSavedChats() {
  return parseSavedChats(await getSetting(ASST_CHATS_KEY));
}

async function setSavedChats(list) {
  await setSetting(ASST_CHATS_KEY, JSON.stringify(list));
}

const updateSavedChats = makeSerializedUpdater(getSavedChats, setSavedChats);

// Both return the merged stored list so the caller can adopt entries the
// other phone added since its last read.
export function saveChatToApp(chat) {
  return updateSavedChats(current => addSavedChat(current, chat));
}

export function deleteSavedChat(id) {
  return updateSavedChats(current => removeSavedChat(current, id));
}

// Per-(category, month) spend sums for the walk's range, memoised. The walk's
// range grows by a month every month and is re-read after every envelope edit,
// but an envelope edit CANNOT change a transaction — so assigning, moving money
// or toggling rollover reuses this instead of re-downloading the household's
// whole budgeting history. Month navigation REUSES this cache (Mason,
// 2026-08-04) — invalidateEnvelopeSpending() runs only at the four moments
// transactions can actually have moved: a client write (every adapter write
// path that touches transactions/accounts calls it), a completed sync (the
// setSyncCompletionHook registration below), a CSV/PDF import, and the
// dashboard's explicit Refresh (which syncs, so the hook covers it).
let spendCache = null;
// Generation counter: a fetch that was already in flight when the cache was
// invalidated must not write its (pre-invalidation) result back in — network
// reordering would otherwise re-poison the cache with pre-edit sums right
// after a recategorisation or a learned-rule history rewrite.
let spendGen = 0;

export function invalidateEnvelopeSpending() {
  spendCache = null;
  spendGen++;
  // The raw range memo lives and dies by the same moments — one invalidation
  // covers both, so a write site can never clear one and strand the other.
  rangeMemo.clear();
}

// A completed sync may have upserted rows server-side — it is one of the four
// invalidation moments. Registered as a callback so sync.js stays importable
// without the adapter (test/sync.test.js drives it standalone).
setSyncCompletionHook(invalidateEnvelopeSpending);

async function getEnvelopeSpending(start, end) {
  const cacheKey = `${start}|${end}`;
  if (spendCache && spendCache.key === cacheKey) return spendCache.spending;

  const gen = spendGen;
  // Narrow columns, but the FULL pipeline: the unified isSpend() reads
  // `_internal`, so the envelope fold needs the pairing too (it used to skip
  // it for perf; per-amount bucketing keeps it near-linear).
  const txs = await getTransactionsBetween(start, end, { columns: SPEND_TX_COLUMNS });

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
// assignment entirely (which is what keeps "no row = assigned 0" true) —
// UNLESS the row carries a per-month target_override: the zero-row-equivalence
// rule applies to ASSIGNED only, so a row with a non-null override is a REAL
// row and is set to assigned 0 instead of deleted (deleting it would silently
// discard the override). Negative is allowed — that's moving money back out
// of an envelope. `client` is injectable for tests (the addManualTransaction
// pattern).
export async function setAssigned(category, { year, month }, amount, { client = supabase } = {}) {
  const raw = amount == null ? '' : String(amount).trim();
  const n = raw === '' ? 0 : Number(raw);
  // A typo ("1-2") must not silently wipe an assignment — only an empty value
  // clears one. Anything unparseable is ignored.
  if (!Number.isFinite(n)) return;
  const monthStart = `${year}-${pad2(month)}-01`;
  if (n === 0) {
    const del = () => client.from('budget_months').delete().eq('category', category).eq('month', monthStart);
    if (!budgetMonthsHaveOverride) {
      // Pre-migration: the old unconditional delete (no override can exist).
      const { error } = await del();
      if (error) throw error;
      return;
    }
    const { error } = await del().is('target_override', null);
    if (error) {
      // 42703 NAMING target_override = the column isn't there yet — fall back
      // to the old behaviour rather than break clearing an assignment on a
      // preview. Anything else (incl. a bare 42703) escapes untouched.
      if (isMissingOverrideColumnError(error)) {
        budgetMonthsHaveOverride = false;
        const { error: delErr } = await del();
        if (delErr) throw delErr;
        return;
      }
      throw error;
    }
    // A row the delete skipped (non-null override) still needs its assignment
    // cleared. No row matches ⇒ no-op.
    const { error: updErr } = await client
      .from('budget_months')
      .update({ assigned: 0, updated_at: new Date().toISOString() })
      .eq('category', category)
      .eq('month', monthStart);
    if (updErr) throw updErr;
    return;
  }
  const { error } = await client
    .from('budget_months')
    .upsert(
      { category, month: monthStart, assigned: n, updated_at: new Date().toISOString() },
      { onConflict: 'household_id,category,month' }
    );
  if (error) throw error;
}

// Per-month funding-target override (budget_months.target_override). Non-null
// upserts the override — sent-columns-only, so an existing row's `assigned`
// survives, and a fresh row gets the column default assigned 0, which does
// NOT open an envelope (the walk's catStart rule). An override of 0 is a real
// value ("ask nothing this month"), distinct from clearing. Clearing (null or
// blank) null-UPDATEs the row, then deletes it only when it carries nothing
// else (assigned = 0 AND target_override IS NULL) — the setBudget shape.
export async function setTargetOverride(category, { year, month }, amount, { client = supabase } = {}) {
  const monthStart = `${year}-${pad2(month)}-01`;
  const raw = amount == null ? '' : String(amount).trim();
  if (raw === '') {
    const { error } = await client
      .from('budget_months')
      .update({ target_override: null, updated_at: new Date().toISOString() })
      .eq('category', category)
      .eq('month', monthStart);
    if (error) {
      // Pre-migration there is no override to clear — a no-op, not a failure.
      if (isMissingOverrideColumnError(error)) {
        budgetMonthsHaveOverride = false;
        return;
      }
      throw error;
    }
    const { error: delErr } = await client
      .from('budget_months')
      .delete()
      .eq('category', category)
      .eq('month', monthStart)
      .eq('assigned', 0)
      .is('target_override', null);
    if (delErr) throw delErr;
    return;
  }
  const n = Number(raw);
  // Targets are plain positive dollars (0 allowed — "ask nothing").
  if (!Number.isFinite(n) || n < 0) return;
  const { error } = await client
    .from('budget_months')
    .upsert(
      { category, month: monthStart, target_override: n, updated_at: new Date().toISOString() },
      { onConflict: 'household_id,category,month' }
    );
  if (error) throw error;
}

// Auto-fill: copy the previous month's assignments into the viewed month
// ("Fill from July"). The plan itself is pure (planAutoFill in envelopes.js):
// merge semantics — existing non-zero assignments in the viewed month are
// skipped, zero sums are never written, an existing 0 row counts as absent.
// The write is ONE bulk upsert of the plan's rows, sent-columns-only
// (category, month, assigned, updated_at — NEVER target_override), so filling
// onto a 0 row that carries an override leaves the override intact. Reads
// never select target_override here for the same pre-migration reason as
// getAssignmentsThrough. Returns the plan so the UI can confirm/summarize.
export async function autoFillMonth({ year, month }, { client = supabase } = {}) {
  const monthStart = `${year}-${pad2(month)}-01`;
  const prev = shiftMonth(year, month, -1);
  const prevStart = `${prev.year}-${pad2(prev.month)}-01`;
  const [srcRes, existRes] = await Promise.all([
    client.from('budget_months').select('category, assigned').eq('month', prevStart),
    client.from('budget_months').select('category, assigned').eq('month', monthStart),
  ]);
  if (srcRes.error) throw srcRes.error;
  if (existRes.error) throw existRes.error;

  const plan = planAutoFill({
    source: srcRes.data || [],
    existing: existRes.data || [],
    isBudgetable: isBudgetableCategory,
  });
  if (!plan.rows.length) return plan;

  const updatedAt = new Date().toISOString();
  const { error } = await client.from('budget_months').upsert(
    plan.rows.map(r => ({
      category: r.category,
      month: monthStart,
      assigned: r.assigned,
      updated_at: updatedAt,
    })),
    { onConflict: 'household_id,category,month' }
  );
  if (error) throw error;
  return plan;
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
// The window is CANDIDATE_WINDOW_MONTHS (~40 — was 6, then 25 on the faulty
// "two full year-gaps" arithmetic, which kept an annual item detectable only
// in its renewal month: the ≥3-charge floor needs the LAST three renewals in
// range, and the newest of those can be nearly a year old — the constant's
// comment in src/recurring.js carries the numbers, and the year-round sweep
// in test/recurring.test.js pins them). detectRecurring's recency-sliced
// gates + staleness cutoff are what keep a window this wide honest.
// Detection itself never reads `_internal` — transfers are excluded by
// CATEGORY inside detectRecurring — but the rows arrive marked anyway: under
// the unified model getTransactionsBetween ALWAYS runs the pairing (cheap —
// per-equal-amount buckets), and toTxShape's `counted` reads the marks.
export async function getRecurringCandidates({ months = CANDIDATE_WINDOW_MONTHS } = {}) {
  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;
  const oldest = shiftMonth(curY, curM, -(months - 1));
  const { start } = monthBounds(oldest.year, oldest.month);
  const { end } = monthBounds(curY, curM);
  // Narrow columns (RECURRING_TX_COLUMNS — the envelope-walk precedent):
  // ~40 months of the wide TX_COLUMNS + tax columns was the app's heaviest
  // read for a consumer that only groups by name/amount/date. Passing
  // `columns` bypasses the range memo, which is fine — recurring is
  // lazy-cached in Dashboard state, so this runs once per invalidation.
  const rows = await getTransactionsBetween(start, end, { columns: RECURRING_TX_COLUMNS });
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

// filters is the normalized object from buildSearchFilters (src/searchFilters.js)
// or null. Amount/date go SERVER-side so limit/offset paginate the FILTERED
// set — a client-side filter over an unfiltered 200 would silently hide
// matches past the cap. offset > 0 is the "Load more" page: ordered paging
// (date desc, id desc as the total-order tiebreak) via .range, with the
// exact-page-multiple 416 answered as "no more rows" (isRangeExhaustedError),
// per the ruleHistory convention.
export async function searchTransactions(query, { limit = 200, offset = 0, filters = null } = {}) {
  const q = (query || '').trim();
  // Filter-only search: non-null filters activate a search with no (or a
  // too-short) text query — the ilike .or() is simply skipped and the
  // amount/date conjuncts stand alone. searchIsActive is the shared gate.
  if (!searchIsActive(q, filters)) return { transactions: [], hasMore: false };
  const textOr = q.length >= 2
    ? (() => {
        const pat = ilikePattern(q);
        return [
          `description.ilike.${pat}`,
          `merchant_name.ilike.${pat}`,
          `user_description.ilike.${pat}`,
        ].join(',');
      })()
    : null;
  // Chained .or() calls AND together in PostgREST — the text match and the
  // absolute-amount match are independent conjuncts.
  const amtOr = filters ? amountOrClause(filters.amountMin, filters.amountMax) : null;
  const attempt = withEntity => {
    let b = supabase
      .from('transactions')
      .select(`${withEntity ? TX_COLUMNS + TX_TAX_COLUMNS : TX_COLUMNS}, accounts!inner(hidden, type, subtype)`)
      .eq('accounts.hidden', false);
    if (textOr) b = b.or(textOr);
    if (amtOr) b = b.or(amtOr);
    if (filters?.dateFrom) b = b.gte('date', filters.dateFrom);
    if (filters?.dateTo) b = b.lte('date', filters.dateTo);
    return b
      .order('date', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit);
  };
  let { data, error } = await attempt(transactionsHaveEntity);
  if (error && transactionsHaveEntity && isMissingColumnError(error, 'entity_id')) {
    transactionsHaveEntity = false;
    ({ data, error } = await attempt(false));
  }
  if (error) {
    if (isRangeExhaustedError(error)) return { transactions: [], hasMore: false };
    throw error;
  }

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
// Creates real transactions on a manual account so history no feed reaches
// becomes visible. All writes go through the
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

// A missing COLUMN, and it must be THIS column: the name has to appear in the
// error text (PostgREST/Postgres always name it) before the code counts.
// Matching on PGRST204/42703 alone would let a DIFFERENT missing column flip a
// feature's degrade flag — reading, say, an entity_id problem as "debt tracker
// not installed" for the whole session, the exact missing-table/missing-column
// conflation the CLAUDE.md gotcha forbids. Mirrors the test-pinned twin in
// api/sync.js. Exported for tests only.
export function isMissingColumnError(error, col) {
  if (!error) return false;
  const blob = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`.toLowerCase();
  if (!blob.includes(String(col).toLowerCase())) return false;
  if (error.code === 'PGRST204' || error.code === '42703') return true;
  return blob.includes('column');
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

// Create one manual account. kind is 'checking' | 'savings' | 'credit' | 'loan'.
// checking/savings are depository (and drive the Trends checking-vs-savings
// split); 'credit' is a credit-card account, for a card whose statements are
// only available as CSV/PDF — its purchases count as spending by category and
// applyAccountRules turns its negatives into "Return" (never income), exactly
// like a SimpleFIN-fed card. 'loan' is a hand-tracked debt (a private loan, a
// servicer no feed reaches): its balance is typed by hand and its own ledger
// rows never count as spending (isLoanAccount — the counted leg is the
// depository payment). Returns the inserted account row.

// Pure row builder, exported for tests. `balance` is the hand-typed amount
// OWED for a credit/loan kind — stored POSITIVE (the app-wide debt
// convention; displayBalance flips at render). Ignored for depository kinds
// (nothing sets a manual depository balance today). Negative balances are
// rejected rather than abs()'d — a minus sign here means the user is thinking
// in display convention, and silently flipping it would hide that.
export const MANUAL_ACCOUNT_KINDS = ['checking', 'savings', 'credit', 'loan'];
export function buildManualAccountRow({ name, subtype = 'checking', balance } = {}) {
  const kind = MANUAL_ACCOUNT_KINDS.includes(subtype) ? subtype : 'checking';
  const row = {
    name: (name || 'Imported account').trim(),
    type: kind === 'credit' ? 'credit' : kind === 'loan' ? 'loan' : 'depository',
    subtype: kind === 'credit' ? 'credit card' : kind,
  };
  if (kind === 'credit' || kind === 'loan') {
    const bal = Number(balance);
    if (balance != null && balance !== '' && Number.isFinite(bal)) {
      if (bal < 0)
        throw new Error('Enter the balance as a positive amount owed');
      row.current_balance = Number(bal.toFixed(2));
    }
  }
  return row;
}

export async function createManualAccount({ name, subtype = 'checking', balance } = {}) {
  const institutionId = await findOrCreateManualInstitution();
  const plaidAccountId = MANUAL_ACCOUNT_PREFIX + makeUuid();
  const base = {
    institution_id: institutionId,
    plaid_account_id: plaidAccountId,
    ...buildManualAccountRow({ name, subtype, balance }),
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
  // First sight of a hand-typed debt balance counts as a move (same rule as
  // the sync) — seed its history so the sparkline/net-worth start truthfully.
  if (data && data.current_balance != null) {
    await appendClientSnapshot(data.id, Number(data.current_balance));
  }
  return data;
}

// --- Manual debt balance ------------------------------------------------------
// The pure decision for a hand-typed balance edit: only a MANUAL account's
// balance may be typed (a fed balance is restated by every pull — hand-editing
// it would just be overwritten, so the distinction is enforced, not advisory).
// Returns { balance, snapshot } — balance rounded to cents in the STORED
// convention (debts positive = owed), snapshot true when the value actually
// moved (mirrors api/sync.js's only-on-change rule; the per-day upsert dedups
// same-day edits anyway). Exported for tests.
export function manualBalanceUpdate(account, balance) {
  if (!account || isSimpleFinAccount(account) || !isManualAccount(account))
    throw new Error('Only a manual account balance can be edited by hand');
  const bal = Number(balance);
  if (!Number.isFinite(bal)) throw new Error('Balance must be a number');
  if ((account.type === 'credit' || account.type === 'loan') && bal < 0)
    throw new Error('Enter the balance as a positive amount owed');
  const rounded = Number(bal.toFixed(2));
  return { balance: rounded, snapshot: Number(account.current_balance) !== rounded };
}

// Best-effort client-side balance_snapshots append. Unlike api/sync.js (which
// runs as SERVICE_ROLE and must set household_id explicitly), this is an
// authenticated client write, so household_id is OMITTED and the column
// default current_household_id() fills it — the normal RLS path. A missing
// table (previews share the prod DB) switches it off quietly; any other
// failure is logged, never thrown — history is auxiliary, the balance itself
// already landed on `accounts`.
async function appendClientSnapshot(accountId, balance) {
  if (!hasBalanceSnapshots) return;
  const { error } = await supabase.from('balance_snapshots').upsert(
    { account_id: accountId, captured_on: new Date().toISOString().slice(0, 10), balance },
    { onConflict: 'account_id,captured_on' },
  );
  if (error) {
    if (isMissingTableError(error)) hasBalanceSnapshots = false;
    else console.warn('balance snapshot append failed', error.message || error);
  }
}

// Write a hand-typed balance onto a MANUAL account (the Debt tab's balance
// editor) and append today's history row. Takes the account ROW, not just an
// id — manualBalanceUpdate needs it to prove the account is manual.
export async function updateManualBalance(account, balance) {
  const { balance: bal, snapshot } = manualBalanceUpdate(account, balance);
  const { error } = await supabase
    .from('accounts')
    .update({ current_balance: bal })
    .eq('id', account.id);
  if (error) throw error;
  if (snapshot) await appendClientSnapshot(account.id, bal);
  return bal;
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
  let selectCols = transactionsHaveSource ? 'plaid_tx_id, source' : 'plaid_tx_id';
  const rows = await pagedRows(async (from, to) => {
    let { data, error } = await supabase
      .from('transactions')
      .select(selectCols)
      .eq('account_id', accountId)
      .range(from, to);
    if (error && selectCols !== 'plaid_tx_id' && isMissingColumnError(error, 'source')) {
      transactionsHaveSource = false;
      selectCols = 'plaid_tx_id';
      ({ data, error } = await supabase
        .from('transactions')
        .select(selectCols)
        .eq('account_id', accountId)
        .range(from, to));
    }
    return { data, error };
  });
  for (const r of rows) {
    ids.add(r.plaid_tx_id);
    if (r.source) sources.add(r.source);
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
// isn't compared against years of feed history.
export async function getAccountTransactionsInRange(accountId, start, end) {
  if (!accountId || !start || !end) return [];
  const rows = await pagedRows((from, to) =>
    supabase
      .from('transactions')
      .select('plaid_tx_id, date, amount, description, merchant_name, mapped_category, user_category, pending')
      .eq('account_id', accountId)
      .gte('date', start)
      .lte('date', end)
      .order('date', { ascending: true })
      .range(from, to)
  );
  return rows.map(r => ({ ...r, amount: Number(r.amount) }));
}

// Idempotent upsert of built CSV rows onto a manual account. onConflict
// (account_id, plaid_tx_id) means a re-import of overlapping rows updates in
// place instead of duplicating; user-owned columns (user_category, excluded,
// user_description) are omitted from the payload so those edits survive the
// re-import, exactly like the SimpleFIN sync's upserts. Returns the number of
// rows written.
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
  invalidateEnvelopeSpending(); // new rows exist — every memoised read is stale
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
  invalidateEnvelopeSpending(); // a new row exists — every memoised read is stale
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

// Sign out the shared household session on this device. A passthrough so
// Dashboard never imports supabaseClient.js directly — the gitignored mock
// harness aliases dataAdapter/sync/db/apiClient by full-match regex, and a
// direct supabaseClient import would escape the mocks and break harness
// rendering. App.jsx's onAuthStateChange sees the session end and renders the
// Login screen, so callers don't navigate — they just await this.
// scope:'local' is LOAD-BEARING: supabase-js v2 defaults to scope 'global',
// which revokes EVERY refresh token for the user server-side — and this app
// runs ONE shared Auth user for the whole household, so the default would
// silently drop the other person's phone to the Login screen within the
// access-token hour. 'local' ends only this device's session, which is what
// the confirm dialog promises.
export async function signOut() {
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) throw error;
}

// --- Expected/scheduled transactions (migration 20260804000002) --------------
// DISPLAY-ONLY by contract (the envelopePace rule): nothing here ever writes
// budgets/budget_months or touches the walk, `available`, or any spending
// total — a matched expectation just points at the real transaction row. The
// decisions live pure in src/expectedTx.js; this is the I/O. All reads return
// null pre-migration (the getReceiptTxIds pattern: null ≠ "no expectations",
// it means "the feature isn't installed — hide every surface"), and the
// missing-TABLE check is deliberately separate from any missing-column check
// (the api/sync.js gotcha). No adapter-side cache: the Dashboard holds the
// lazy list behind an EPOCH counter (never a null sentinel) and re-reads after
// each write commits; these writes touch no transaction/budget rows, so the
// range memo and envelope-spending cache stay valid.

let hasExpectedTx = true;

const EXPECTED_COLUMNS =
  'id, recurring_key, description, category, account_id, amount, due_date, cadence, status, matched_tx_id, created_at';

// How far back the auto-match read reaches for real transactions. Covers the
// worst pending case: staleDays 60 overdue + the annual 30-day match window.
const EXPECTED_MATCH_LOOKBACK_DAYS = 95;

function addDaysISO(iso, days) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function localTodayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

// Insert the NEXT cycle's pending row after a match/dismiss. Dup-gated so two
// devices matching the same cycle can't double the Upcoming card: on
// recurring_key when the row has one (isDuplicateExpected), and on
// description+cadence+amount within the cadence tolerance when it doesn't
// (isDuplicateRollForward — hand-typed rows have recurring_key null, and a
// roll-forward twin is always machine-minted, never a real second bill).
// 'once' rows never roll (rollForwardDate returns null). Returns the inserted
// row or null.
async function rollForwardExpected(client, row) {
  const due_date = rollForwardDate(row.due_date, row.cadence);
  if (!due_date) return null;
  const fields = {
    recurring_key: row.recurring_key ?? null,
    description: row.description,
    category: row.category,
    account_id: row.account_id ?? null,
    amount: row.amount,
    due_date,
    cadence: row.cadence,
  };
  if (fields.recurring_key != null) {
    const { data, error } = await client
      .from('expected_transactions')
      .select(EXPECTED_COLUMNS)
      .eq('status', 'pending')
      .eq('recurring_key', fields.recurring_key);
    if (error) throw error;
    if (isDuplicateExpected(fields, data || [])) return null;
  } else {
    const { data, error } = await client
      .from('expected_transactions')
      .select(EXPECTED_COLUMNS)
      .eq('status', 'pending')
      .is('recurring_key', null)
      .eq('description', fields.description)
      .eq('cadence', fields.cadence);
    if (error) throw error;
    if (isDuplicateRollForward(fields, data || [])) return null;
  }
  const { data, error } = await client
    .from('expected_transactions')
    .insert(fields)
    .select(EXPECTED_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

// The main read: every pending row plus this month's matched ones, with the
// auto-match pass run and PERSISTED first (status='matched' + matched_tx_id,
// then the roll-forward pending row for the next cycle). Matching is the pure
// matchExpected (greedy nearest-date, deterministic); the transaction window
// rides getTransactionsBetween, so it shares the reload's range memo and the
// full pipeline (hidden accounts excluded, marks applied — irrelevant here,
// but one read path is one read path). `today` is injectable for tests.
export async function getExpectedTransactions(
  { today } = {},
  { client = supabase, fetchTxs = getTransactionsBetween } = {}
) {
  if (!hasExpectedTx) return null;
  const day = today || localTodayISO();
  const { start: monthStart, end: monthEnd } = monthBounds(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7))
  );

  const pendRes = await client
    .from('expected_transactions')
    .select(EXPECTED_COLUMNS)
    .eq('status', 'pending')
    .order('due_date', { ascending: true });
  if (pendRes.error) {
    if (isMissingTableError(pendRes.error)) {
      hasExpectedTx = false;
      return null;
    }
    throw pendRes.error;
  }
  const matchedRes = await client
    .from('expected_transactions')
    .select(EXPECTED_COLUMNS)
    .eq('status', 'matched')
    .gte('due_date', monthStart)
    .lte('due_date', monthEnd)
    .order('due_date', { ascending: true });
  if (matchedRes.error) throw matchedRes.error;

  let pending = pendRes.data || [];
  const matched = matchedRes.data || [];

  if (pending.length) {
    // Fetch real rows around the pending due dates (never past today — a
    // match needs a posted transaction).
    let earliest = pending[0].due_date;
    for (const r of pending) if (r.due_date < earliest) earliest = r.due_date;
    // Cover every pending due date's window (earliest−31 covers the widest,
    // annual's 30), clamped to the lookback floor. ISO strings compare as
    // dates, so the LATER of the two is the clamp.
    const floor = addDaysISO(day, -EXPECTED_MATCH_LOOKBACK_DAYS);
    const wanted = addDaysISO(earliest, -31);
    const fetchStart = wanted > floor ? wanted : floor;
    if (fetchStart <= day) {
      const txs = await fetchTxs(fetchStart, day);
      // Ids already claimed by a matched expectation can't match again.
      const claimed = new Set(matched.map(r => r.matched_tx_id).filter(Boolean));
      const txRows = (txs || [])
        .filter(t => !claimed.has(t.id))
        .map(t => ({
          id: t.id,
          transaction_date: t.date,
          amount: Number(t.amount),
          account_id: t.account_id,
          merchant_name: t.merchant_name,
          description: t.user_description || t.description,
        }));
      const matches = matchExpected(pending, txRows);
      if (matches.length) {
        const byId = new Map(pending.map(r => [r.id, r]));
        const updatedAt = new Date().toISOString();
        for (const m of matches) {
          const row = byId.get(m.expectationId);
          if (!row) continue;
          const { error } = await client
            .from('expected_transactions')
            .update({ status: 'matched', matched_tx_id: m.txId, updated_at: updatedAt })
            .eq('id', m.expectationId);
          if (error) throw error;
          row.status = 'matched';
          row.matched_tx_id = m.txId;
        }
        // Roll each freshly matched row forward, then re-split the lists.
        const stillPending = pending.filter(r => r.status === 'pending');
        for (const m of matches) {
          const row = byId.get(m.expectationId);
          if (!row) continue;
          const next = await rollForwardExpected(client, row);
          if (next) stillPending.push(next);
          if (row.due_date >= monthStart && row.due_date <= monthEnd) matched.push(row);
        }
        pending = stillPending;
      }
    }
  }

  const bySort = (a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0);
  pending.sort(bySort);
  matched.sort(bySort);
  return { pending, matched };
}

// Adds an expectation (seeded from a recurring item via seedFromRecurring, or
// hand-typed). Dup-gated: the same recurring_key with an existing PENDING row
// due within ± the cadence's tolerance is the same cycle — return it instead
// of inserting a twin (hand-typed rows, recurring_key null, never gate).
// Returns { row, duplicate } — or null pre-migration.
export async function addExpected(fields, { client = supabase } = {}) {
  if (!hasExpectedTx) return null;
  if (fields?.recurring_key != null) {
    const { data, error } = await client
      .from('expected_transactions')
      .select(EXPECTED_COLUMNS)
      .eq('status', 'pending')
      .eq('recurring_key', fields.recurring_key);
    if (error) {
      if (isMissingTableError(error)) {
        hasExpectedTx = false;
        return null;
      }
      throw error;
    }
    if (isDuplicateExpected(fields, data || [])) return { row: null, duplicate: true };
  }
  const insert = {
    recurring_key: fields.recurring_key ?? null,
    description: fields.description,
    category: fields.category,
    account_id: fields.account_id ?? null,
    amount: fields.amount,
    due_date: fields.due_date,
    cadence: fields.cadence || 'once',
  };
  const { data, error } = await client
    .from('expected_transactions')
    .insert(insert)
    .select(EXPECTED_COLUMNS)
    .single();
  if (error) {
    if (isMissingTableError(error)) {
      hasExpectedTx = false;
      return null;
    }
    throw error;
  }
  return { row: data, duplicate: false };
}

// Dismiss one cycle ("not this time"). Rolls the next cycle forward unless
// { stop: true } — stopping is the user saying the bill itself is gone.
// NEVER called automatically: a stale unmatched expectation renders "missed?"
// and waits for a human (the unmatched bill is the alarm).
export async function dismissExpected(id, { stop = false } = {}, { client = supabase } = {}) {
  const { data: row, error: readErr } = await client
    .from('expected_transactions')
    .select(EXPECTED_COLUMNS)
    .eq('id', id)
    .single();
  if (readErr) throw readErr;
  const { error } = await client
    .from('expected_transactions')
    .update({ status: 'dismissed', updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
  if (stop) return { next: null };
  const next = await rollForwardExpected(client, row);
  return { next };
}

// The "Mark paid" picker: the user points an expectation at a real
// transaction the auto-match missed. Rolls forward like an auto-match.
export async function matchExpectedManually(id, txId, { client = supabase } = {}) {
  const { data: row, error: readErr } = await client
    .from('expected_transactions')
    .select(EXPECTED_COLUMNS)
    .eq('id', id)
    .single();
  if (readErr) throw readErr;
  const { error } = await client
    .from('expected_transactions')
    .update({ status: 'matched', matched_tx_id: txId, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
  const next = await rollForwardExpected(client, row);
  return { next };
}
