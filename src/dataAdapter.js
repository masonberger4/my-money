import { supabase } from './supabaseClient.js';
import { applyAccountRules } from './categoryMap.js';
import { merchantKey, classifyDescription } from './txClassify.js';
import { applyRuleToHistory, isRangeExhaustedError } from './ruleHistory.js';
import { markInternalTransfers, cashIncome, cashSpending } from './cashFlow.js';
import { walkEnvelopes, monthKey } from './envelopes.js';
import { matchExpected, rollForwardDate, isDuplicateExpected, isDuplicateRollForward } from './expectedTx.js';
import { isSpend, sumSpending, spendingGroups, biggestMovers, toTxShape, aggregateEnvelopeSpending } from './spending.js';
import { createRangeMemo } from './monthMemo.js';
import { setSyncCompletionHook } from './sync.js';
import { amountOrClause, searchIsActive } from './searchFilters.js';
import { CANDIDATE_WINDOW_MONTHS, parseIgnoreList } from './recurring.js';
import { getSettings } from './db.js';
import { aggregateCoverage, feedCoverageGaps, FEED_REACH_DAYS } from './coverage.js';
import { netWorthSeries, clampSeries } from './netWorth.js';
import {
  pad2,
  monthBounds,
  monthLabel,
  shiftMonth,
  isMissingTableError,
  isMissingColumnError,
} from './adapters/shared.js';
import {
  hasOverrideColumn,
  markOverrideColumnMissing,
  isMissingOverrideColumnError,
  ENV_PACE_KEY,
  parseEnvPace,
} from './adapters/envelopeIO.js';
import { REC_IGNORE_KEY } from './adapters/settingsIO.js';
import { receiptsInstalled, markReceiptsMissing } from './adapters/receiptIO.js';

// --- The façade contract (mock-harness boundary) ------------------------------
// dataAdapter.js is the ONE import surface for all adapter I/O: the gitignored
// harness aliases it (with sync/db/apiClient) by full-match regex, and
// Dashboard imports only through those four modules. The cohesive clusters
// below live in src/adapters/*.js — INTERNAL modules that only this file may
// import — and are re-exported here byte-compatibly (the spending.js /
// ruleHistory.js / monthMemo.js extraction precedent, applied to the I/O).
export { isMissingColumnError } from './adapters/shared.js';
export {
  getBudgets,
  setBudget,
  isEnvelopeSchemaMissing,
  getBudgetIncome,
  setBudgetIncome,
  getEnvPace,
  setEnvPace,
  setAssigned,
  setTargetOverride,
  autoFillMonth,
  setCategoryRollover,
  setTargetKind,
  moveMoney,
  fundTargets,
} from './adapters/envelopeIO.js';
export {
  getRecIgnore,
  setRecIgnore,
  updateRecIgnore,
  getSavedChats,
  saveChatToApp,
  deleteSavedChat,
  addRegistryEntry,
  updateRegistryParent,
  removeRegistryEntry,
  updateCategoryColor,
  updateCategoryAlias,
} from './adapters/settingsIO.js';
export {
  getEntities,
  createEntity,
  updateEntity,
  getMileage,
  addMileage,
  deleteMileage,
} from './adapters/taxIO.js';
export {
  getReceipts,
  addReceipt,
  deleteReceipt,
  getReceiptUrl,
} from './adapters/receiptIO.js';

// ONE .in() read for the Dashboard mount effect, replacing seven single-key
// settings queries. Honest sizing: the seven ran in parallel over one
// connection, so the win is request count and radio jitter, not a full RTT.
// `keys` are the Dashboard-owned raw rows, returned untouched in `values`
// (absent ⇒ null, matching getSetting); the two ADAPTER-owned rows ride along
// PARSED — their parse rules live beside their writers (envelopeIO /
// recurring.js), never inline in a component.
export async function getStartupSettings(keys) {
  const byKey = await getSettings([...keys, ENV_PACE_KEY, REC_IGNORE_KEY]);
  const values = {};
  for (const k of keys) values[k] = byKey[k] ?? null;
  return {
    values,
    envPace: parseEnvPace(byKey[ENV_PACE_KEY]),
    recIgnore: parseIgnoreList(byKey[REC_IGNORE_KEY]),
  };
}

// Re-export the pure cash-flow model (src/cashFlow.js) so existing importers
// and the CSV-import dry-run harness keep working.
export { markInternalTransfers, cashIncome, cashSpending } from './cashFlow.js';

// Same deal for the pure envelope model (src/envelopes.js) — Dashboard and any
// harness import the helpers from one place.
export { targetNeed, readyToAssign, envelopePace, monthKey, shiftMonthKey, effectiveTarget, resolveBudgetIncome } from './envelopes.js';

// Same for the pure expected-transaction model (src/expectedTx.js) — the I/O
// lives below; Dashboard imports the display helpers from one place.
export {
  expectedByCategory,
  projectFutureCycles,
  expectedStatus,
  isMissedExpected,
  seedFromRecurring,
} from './expectedTx.js';

// THE spending model lives pure in src/spending.js (isSpend,
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

const TX_COLUMNS =
  'id, plaid_tx_id, account_id, date, amount, merchant_name, description, mapped_category, raw_category, user_category, user_description, excluded, pending';

// The rental-tax columns (20260730000001) ride along on every transaction read
// so the detail sheet can show and edit them from ANY list — transactions tab,
// search results, the account sheet. Dropped (with the flag, below) until the
// migration is pasted, exactly like transactions.source.
const TX_TAX_COLUMNS = ', entity_id, is_capital, placed_in_service, useful_life_years';

const ACCOUNT_COLUMNS =
  // created_at has been on `accounts` since the init migration (it is the day
  // the account's FIRST pull ran), and getFeedCoverageGaps reads it to tell a
  // feed-reach gap from an account that is simply new.
  'id, institution_id, plaid_account_id, name, official_name, nickname, color, mask, type, subtype, current_balance, available_balance, last_balance_at, hidden, created_at, institutions(name, display_name)';

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
// range memo — its aggregation is memoised separately in the range-keyed
// spendCache).
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
// The `amount` column arrives with migration 20260805000002, which is pasted
// AFTER the deploy (it drops a PK). Previews share the production database, so
// every read here has to work before it lands: a missing COLUMN falls back to
// selecting without it, which is a different failure from a missing TABLE and
// is tested separately (the CLAUDE.md conflation gotcha).
let rulesHaveAmount = true;

// Shape: { merchantKey: [{ amount, category }, ...] } — one entry per stored
// rule row, `amount: null` being the any-amount rule. txClassify's
// matchLearnedRule reads this array shape directly (and still reads the older
// bare-string shape, so nothing had to change in lockstep).
// `opts.client` is a test seam only (the envelopeIO recording-fake pattern);
// production callers pass nothing.
export async function getCategoryRules({ client = supabase } = {}) {
  if (!hasCategoryRules) return {};
  const read = cols => client.from('category_rules').select(cols);
  let { data, error } = await read(
    rulesHaveAmount ? 'merchant_key, category, amount' : 'merchant_key, category'
  );
  if (error && rulesHaveAmount && isMissingColumnError(error, 'amount')) {
    rulesHaveAmount = false;
    ({ data, error } = await read('merchant_key, category'));
  }
  if (error) {
    if (isMissingTableError(error)) {
      hasCategoryRules = false;
      return {};
    }
    throw error;
  }
  const rules = {};
  for (const r of data || []) {
    // PostgREST hands numerics back as strings often enough that coercing here
    // is the only place it needs handling — the matcher compares numbers.
    const amount = r.amount == null || r.amount === '' ? null : Number(r.amount);
    (rules[r.merchant_key] ||= []).push({
      amount: Number.isFinite(amount) ? amount : null,
      category: r.category,
    });
  }
  return rules;
}

// Teach a merchant. household_id fills in from its column default — never send
// it from the client (same pattern as setBudget/setSetting).
//
// `amount` (optional, app convention: positive = money out) scopes the rule to
// transactions of exactly that amount; null/undefined is the any-amount rule.
//
// WHY THIS IS NO LONGER AN UPSERT: uniqueness is now carried by two PARTIAL
// unique indexes (`... where amount is null` / `... where amount is not null`,
// migration 20260805000002), and ON CONFLICT cannot infer a partial index —
// PostgREST would answer "no unique or exclusion constraint matching the ON
// CONFLICT specification". So the write deletes the exact
// (merchant_key, amount) slot and inserts. Teaching a merchant is a rare,
// deliberate user action, not a hot path, so two round trips are fine — and
// the delete is slot-scoped, so it can never take out the sibling rule for the
// same merchant at a different amount.
export async function setCategoryRule(descriptor, category, amount = null, { client = supabase } = {}) {
  const key = merchantKey(descriptor);
  if (!key) throw new Error('Cannot learn a rule from an empty description');
  const amt = amount == null || amount === '' ? null : Number(amount);
  const scoped = amt != null && Number.isFinite(amt);

  const clearSlot = async () => {
    const del = client.from('category_rules').delete().eq('merchant_key', key);
    if (!rulesHaveAmount) return del; // pre-migration: one rule per merchant
    return scoped ? del.eq('amount', amt) : del.is('amount', null);
  };
  let { error: delErr } = await clearSlot();
  // Pre-migration there is no amount column: degrade to the old
  // one-rule-per-merchant behaviour rather than failing the teach outright.
  if (delErr && rulesHaveAmount && isMissingColumnError(delErr, 'amount')) {
    rulesHaveAmount = false;
    ({ error: delErr } = await clearSlot());
  }
  if (delErr) throw delErr;

  const row = { merchant_key: key, category, updated_at: new Date().toISOString() };
  if (scoped && rulesHaveAmount) row.amount = amt;
  const { error } = await client.from('category_rules').insert(row);
  if (error) throw error;
  return key;
}

export async function deleteCategoryRule(merchantKeyValue, amount = null, { client = supabase } = {}) {
  const amt = amount == null || amount === '' ? null : Number(amount);
  const scoped = amt != null && Number.isFinite(amt);
  const q = client.from('category_rules').delete().eq('merchant_key', merchantKeyValue);
  // Slot-scoped like setCategoryRule: deleting the $1,800 Zelle rule must
  // leave the any-amount Zelle rule alone, and vice versa.
  const { error } = await (!rulesHaveAmount ? q : scoped ? q.eq('amount', amt) : q.is('amount', null));
  if (error) throw error;
  // Deleting a rule changes ZERO existing transactions — mapped_category is
  // computed at WRITE time and nothing recomputes it at read time. So this is
  // not a spending-total invalidation; it only changes what FUTURE imports
  // will say. The Taught-rules confirm states this in as many words.
}

// The Taught-rules screen's read. Deliberately NOT getCategoryRules(): that
// one returns the `{key: category}` map the hot write path wants
// (api/sync.js, CsvImport, addManualTransaction) and its `{}` on a missing
// table is load-bearing there. This one returns ROWS with their metadata, and
// **null — not [] — when the table is missing**, so the caller can tell "the
// feature isn't installed" from "nothing taught yet" (the getReceiptTxIds
// sentinel; the entry link keys on it and doesn't render at all pre-migration).
export async function listCategoryRules({ client = supabase } = {}) {
  if (!hasCategoryRules) return null;
  const rows = [];
  const page = 500;
  for (let from = 0; ; from += page) {
    const { data, error } = await client
      .from('category_rules')
      .select(rulesHaveAmount
        ? 'merchant_key, category, amount, source, updated_at'
        : 'merchant_key, category, source, updated_at')
      // Ordered paging: an unordered result set can drop or repeat rows across
      // the boundary (the Session A guard class).
      .order('merchant_key', { ascending: true })
      .range(from, from + page - 1);
    if (error) {
      // 416 on an exact-page-multiple result set is end-of-data, not failure.
      if (isRangeExhaustedError(error)) break;
      // Pre-migration the amount column isn't there yet: retry this same page
      // without it. Checked BEFORE the missing-table test and name-checked, so
      // a column problem can never read as "the feature isn't installed".
      if (rulesHaveAmount && isMissingColumnError(error, 'amount')) {
        rulesHaveAmount = false;
        from -= page; // redo this page with the narrower select
        continue;
      }
      if (isMissingTableError(error)) {
        hasCategoryRules = false;
        return null;
      }
      throw error;
    }
    rows.push(...(data || []).map(r => ({
      ...r,
      amount: r.amount == null || r.amount === '' ? null : Number(r.amount),
    })));
    if (!data || data.length < page) break;
  }
  return rows;
}

// "How many transactions does this rule match at all?" — the on-demand count
// behind each rule row. NOT the dry run: applyRuleToHistory's dryRun counts
// only rows it would still CHANGE, so a working rule reads 0. countAll drops
// that clause and never writes.
//
// Throws on failure like its sibling — the caller renders a failed count
// differently from a real 0 (the count === null distinction).
export async function countCategoryRuleMatches(descriptor, category, amount = null) {
  return applyRuleToHistory({
    descriptor,
    category,
    amount,
    countAll: true,
    fetchPage: (pat, from, to) =>
      supabase
        .from('transactions')
        .select('id, description, merchant_name, mapped_category, amount')
        .or(`description.ilike.${pat},merchant_name.ilike.${pat}`)
        .order('id', { ascending: true })
        .range(from, to),
    updateBatch: () => {
      throw new Error('countCategoryRuleMatches must never write');
    },
  });
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
export async function applyCategoryRuleToHistory(descriptor, category, { dryRun = false, amount = null } = {}) {
  const result = await applyRuleToHistory({
    descriptor,
    category,
    amount,
    dryRun,
    fetchPage: (pat, from, to) =>
      supabase
        .from('transactions')
        // `amount` is selected because an amount-scoped rule is re-matched
        // against the ROW's amount — without the column it would match nothing.
        .select('id, description, merchant_name, mapped_category, amount')
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
// test/envelopes.test.js). The envelope WRITES (setAssigned, setTargetOverride,
// autoFillMonth, moveMoney, fundTargets, …) live in src/adapters/envelopeIO.js
// (internal; re-exported above). What stays HERE is the part coupled to the
// transaction pipeline and its caches: getAssignmentsThrough (sharing the
// target_override degrade flag through envelopeIO's accessors), the spend-sum
// cache + invalidateEnvelopeSpending, and getEnvelopes.

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
    let { data, error } = await attempt(hasOverrideColumn());
    if (error && hasOverrideColumn() && isMissingOverrideColumnError(error)) {
      markOverrideColumnMissing();
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

// Per-(category, month) spend sums for the walk's range, memoised per EXACT
// range in a small bounded Map. The walk's `end` moves with the viewed month,
// so a single slot here made every month tap refetch the household's ENTIRE
// budgeting history — range-keying is what makes month navigation actually
// reuse the cache (Mason's 2026-08-04 ruling): envelope edits re-read the
// same range (an envelope edit CANNOT change a transaction), and returning to
// a month finds its whole-window sums still warm. Exact-key reuse ONLY —
// never slice a narrower month out of a wider entry: markInternalTransfers
// pairs over the whole window on purpose, so a subset's rows can pair
// differently than the same rows fetched alone. invalidateEnvelopeSpending()
// clears it at the four moments transactions can actually have moved: a
// client write (every adapter write path that touches transactions/accounts
// calls it), a completed sync (the setSyncCompletionHook registration below),
// a CSV/PDF import, and the dashboard's explicit Refresh (which syncs, so the
// hook covers it).
const SPEND_CACHE_MAX = 12; // ranges — a year of month taps between invalidations
const spendCache = new Map(); // `${start}|${end}` → per-(category, month) sums
// Generation counter: a fetch that was already in flight when the cache was
// invalidated must not write its (pre-invalidation) result back in — network
// reordering would otherwise re-poison the cache with pre-edit sums right
// after a recategorisation or a learned-rule history rewrite.
let spendGen = 0;

export function invalidateEnvelopeSpending() {
  spendCache.clear();
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
  if (spendCache.has(cacheKey)) return spendCache.get(cacheKey);

  const gen = spendGen;
  // Narrow columns, but the FULL pipeline: the unified isSpend() reads
  // `_internal`, so the envelope fold needs the pairing too (it used to skip
  // it for perf; per-amount bucketing keeps it near-linear).
  const txs = await getTransactionsBetween(start, end, { columns: SPEND_TX_COLUMNS });

  // Aggregate on the same predicate the Categories bars use, so an envelope's
  // Spent can never disagree with the bar rendered beside it — the fold itself
  // is pure in src/spending.js.
  const spending = aggregateEnvelopeSpending(txs);
  if (gen === spendGen) {
    spendCache.set(cacheKey, spending);
    // Bounded FIFO (Map iterates in insertion order) — plain month taps
    // insert one entry each; recency tracking isn't worth the machinery.
    if (spendCache.size > SPEND_CACHE_MAX) spendCache.delete(spendCache.keys().next().value);
  }
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

// Actual income for one month, for the Budget tab's hybrid income rule
// (resolveBudgetIncome in src/envelopes.js — a COMPLETED month reads this
// instead of the typed figure). The measurement is the shared cashIncome model
// over the month's marked rows, so it rides the same range memo the other
// month reads share. Pairing window is the CALENDAR MONTH (getMonthTransactions
// lineage — the Overview/Categories precedent), so it can differ from Trends'
// income for the same month only on a transfer pair straddling the window edge
// (getCashFlow pairs across its whole 6-month fetch, which washes MORE) — the
// same documented honest edge as biggestMovers and the assistant context.
// coverageStart is the household's earliest visible DEPOSITORY row (income
// only reads depository inflows): the resolver derives nothing for months the
// ledger doesn't reach, because missing history would read as $0 income.
export async function getActualIncome({ year, month }) {
  const [rows, coverage] = await Promise.all([
    getMonthTransactions(year, month),
    supabase
      .from('transactions')
      .select('date, accounts!inner(hidden, type)')
      .eq('accounts.hidden', false)
      .eq('accounts.type', 'depository')
      .order('date', { ascending: true })
      .limit(1),
  ]);
  if (coverage.error) throw coverage.error;
  return { amount: cashIncome(rows), coverageStart: coverage.data?.[0]?.date || null };
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
// classifyDescription — transfer/card-payment guards → learned rule (from
// `rules`) → Uncategorized (there is no keyword table any more) — with `accountType` passed so a card purchase is never read as
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
// The entity/mileage I/O lives in src/adapters/taxIO.js (internal;
// re-exported above). These two flags stay HERE: they gate the entity COLUMN
// fallbacks on the transaction/account reads in this file (fetchRawBetween,
// getAccounts, getAccountTransactions, searchTransactions), not the taxIO
// tables.

let accountsHaveEntity = true;
let transactionsHaveEntity = true;

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

// --- Receipts (photo attachments; migration 20260731000001) ------------------
// The receipt I/O (upload/list/delete/signed URLs + the design notes) lives in
// src/adapters/receiptIO.js (internal; re-exported above). getReceiptTxIds
// stays HERE (its paged loop belongs to this file's pagedGuards-scanned
// discipline) and shares the degrade flag through receiptIO's accessors.

// The Tax tab's "which transactions have a receipt?" read: the whole table's
// transaction_ids as a Set. The table is one row per photo a human took —
// paginated anyway so a decade of receipts can't silently truncate.
// Returns null (not an empty Set) when the migration isn't installed, so the
// Tax tab can tell "no receipts yet" from "the feature doesn't exist" and
// skip the no-receipt nag instead of flagging every capital expense.
export async function getReceiptTxIds() {
  if (!receiptsInstalled()) return null;
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
        markReceiptsMissing();
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

// Troubleshooting aid, ruled KEEP by Mason 2026-08-13 (see src/coverage.js) —
// per-account transaction coverage for the Accounts tab's "Data coverage" panel. Pages the WHOLE
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

// Feed-reach shortfall, per account (Accounts tab). SimpleFIN serves at most
// ~90 days per request, so a first pull reaches back FEED_REACH_DAYS and no
// further — history older than that was NEVER FETCHED and nothing downstream
// will ever fetch it (statement import is the only path). api/sync.js reports
// the same fact as `coverage_shortfall` in its response, but that value is
// transient AND absent on every steady-state pull, so a client listening to
// sync responses would see it once and never again: the absence-has-no-alarm
// shape this codebase keeps getting bitten by. Derived from the LEDGER instead
// — which needs no migration, survives a reload, and self-clears the moment a
// backfill row lands (see feedCoverageGaps).
//
// One indexed `limit 1` per fed account, capped, and takes the already-loaded
// accounts so it costs no extra account read. Returns
//   { gaps: [{ account_id, served_from }], reachDays, truncated }
// and NEVER throws: any failure resolves to zero gaps, because a wrong warning
// here is worse than a missing one.
// Exported because the Accounts tab RENDERS this number in its truncation
// notice — a hardcoded copy there is exactly the drifting-constant hazard the
// FEED_REACH_DAYS one-copy rule exists for.
export const FEED_GAP_SCAN_CAP = 25;

export async function getFeedCoverageGaps(accounts) {
  const empty = { gaps: [], reachDays: FEED_REACH_DAYS, truncated: false };
  try {
    const fed = (accounts || []).filter(a => a && !a.hidden && isSimpleFinAccount(a));
    const scan = fed.slice(0, FEED_GAP_SCAN_CAP);
    const rows = await Promise.all(
      scan.map(async a => {
        const { data, error } = await supabase
          .from('transactions')
          .select('date')
          .eq('account_id', a.id)
          .order('date', { ascending: true })
          .limit(1);
        if (error) throw error;
        return { account_id: a.id, created_at: a.created_at, first: data?.[0]?.date || null };
      })
    );
    return {
      gaps: feedCoverageGaps(rows),
      reachDays: FEED_REACH_DAYS,
      truncated: fed.length > scan.length,
    };
  } catch {
    return empty;
  }
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
