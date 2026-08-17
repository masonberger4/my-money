// Mock dataAdapter for the CI render check. Imports are RELATIVE on purpose:
// absolute paths work on one machine and fail on every CI runner — which is
// exactly how this file failed its own first CI run.
import { toTxShape, spendingGroups, biggestMovers } from '../../../src/spending.js';
import { markInternalTransfers, cashIncome } from '../../../src/cashFlow.js';
import { setRegistryParent } from '../../../src/categoryTree.js';
// The aliased settings store — the registry updaters below read-merge-write
// the same rows Dashboard's mount reads hit, so the adopt-merged-value path
// renders honestly.
import { getSetting, setSetting } from './db.js';
export { targetNeed, readyToAssign, envelopePace, monthKey, effectiveTarget, resolveBudgetIncome } from '../../../src/envelopes.js';
import { walkEnvelopes } from '../../../src/envelopes.js';
import { normalizeMerchant } from '../../../src/recurring.js';
export const ACCOUNT_TYPES = ['depository', 'credit', 'loan'];
export const ACCOUNT_SUBTYPES = ['checking', 'savings'];

const ACCTS = [
  { id: 'a1', institution_id: 'i1', plaid_account_id: 'sfin:1', name: 'Joint Checking', official_name: null, nickname: null, color: null, mask: '1234', type: 'depository', subtype: 'checking', current_balance: 4821.55, available_balance: 4821.55, last_balance_at: '2026-08-02T12:00:00Z', hidden: false, created_at: '2026-05-02T09:00:00Z', entity_id: null, institutions: { name: 'BECU', display_name: 'BECU' } },
  { id: 'a2', institution_id: 'i1', plaid_account_id: 'sfin:2', name: 'Joint Savings', official_name: null, nickname: null, color: null, mask: '5678', type: 'depository', subtype: 'savings', current_balance: 15230.10, available_balance: 15230.10, last_balance_at: '2026-08-02T12:00:00Z', hidden: false, created_at: '2026-05-02T09:00:00Z', entity_id: null, institutions: { name: 'BECU', display_name: 'BECU' } },
  { id: 'a3', institution_id: 'i2', plaid_account_id: 'sfin:3', name: 'Venture X', official_name: null, nickname: null, color: null, mask: '9012', type: 'credit', subtype: 'credit card', current_balance: 2148.33, available_balance: 12851.67, last_balance_at: '2026-08-02T12:00:00Z', hidden: false, created_at: '2026-05-02T09:00:00Z', entity_id: null, institutions: { name: 'Capital One', display_name: 'Capital One' } },
  { id: 'a4', institution_id: 'i2', plaid_account_id: 'sfin:4', name: 'Quicksilver', official_name: null, nickname: null, color: null, mask: '3456', type: 'credit', subtype: 'credit card', current_balance: 512.09, available_balance: 4487.91, last_balance_at: '2026-08-02T12:00:00Z', hidden: false, created_at: '2026-05-02T09:00:00Z', entity_id: null, institutions: { name: 'Capital One', display_name: 'Capital One' } },
  { id: 'am1', institution_id: 'im', plaid_account_id: 'manual:am1', name: 'Old Checking', official_name: null, nickname: null, color: null, mask: '2644', type: 'depository', subtype: 'checking', current_balance: 310.22, available_balance: 310.22, last_balance_at: '2026-06-30T12:00:00Z', hidden: false, created_at: '2026-06-30T12:00:00Z', entity_id: null, is_manual: true, institutions: { name: 'Imported', display_name: 'Imported' } },
];
const acctType = id => ACCTS.find(a => a.id === id)?.type || 'depository';

// Session B harness knobs (query-string driven, so one server serves all shots)
const Q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
if (Q.has('hiddenCard')) { const a = ACCTS.find(x => x.id === 'a3'); if (a) a.hidden = true; }
// ?removedImport — the "Imported" institution soft-hidden (its accounts hidden
// with a restore record on file), the one state the Accounts tab's Restore
// strip renders in.
const REMOVED_IMPORT = Q.has('removedImport');
if (REMOVED_IMPORT) { const a = ACCTS.find(x => x.id === 'am1'); if (a) a.hidden = true; }


let seq = 0;
function raw(date, amount, desc, cat, acct = 'a1', extra = {}) {
  seq++;
  return {
    id: 't' + seq, plaid_tx_id: 'sfin:t' + seq, account_id: acct,
    date, amount, description: desc, mapped_category: cat,
    user_category: null, user_description: null, excluded: false, user_type: null,
    raw_category: extra.raw_category || null, entity_id: null,
    is_capital: false, placed_in_service: null, useful_life_years: null,
    accounts: { type: acctType(acct), subtype: ACCTS.find(a => a.id === acct)?.subtype },
  };
}

const AUG = [
  raw('2026-08-02', 84.12, 'SAFEWAY #1234 SEATTLE WA', 'Groceries', 'a3'),
  raw('2026-08-02', 12.45, 'STARBUCKS 8892', 'Coffee and snacks', 'a3'),
  raw('2026-08-01', 156.90, 'COSTCO WHSE #0117', 'Groceries', 'a3'),
  raw('2026-08-01', 62.30, 'SHELL OIL 5551', 'Vehicle expenses', 'a3'),
  raw('2026-08-01', 45.00, 'MYSTERY VENDOR LLC', null, 'a3'),
  raw('2026-08-02', 89.99, 'MYSTERY VENDOR LLC', null, 'a3'),
  raw('2026-08-03', 15.50, 'MYSTERY VENDOR LLC', null, 'a1'),
  raw('2026-08-02', 34.20, 'ACME POS 4412', null, 'a3'),
  raw('2026-08-01', 34.20, 'ACME POS 9981', null, 'a3'),
  raw('2026-08-03', 210.00, 'NEIGHBORHOOD HVAC CO', null, 'a1'),
  raw('2026-08-02', 68.44, 'DINNER HOUSE GRILL', 'Dining out', 'a3'),
  raw('2026-08-01', 129.00, 'CITY UTILITIES', 'Utilities', 'a1'),
  raw('2026-08-01', -2400.00, 'TRANSFER FROM PERSONAL', 'Transfers and card payments', 'a1', { raw_category: 'TRANSFER_IN' }),
  raw('2026-08-02', 950.00, 'CAPITAL ONE CARD PAYMENT', 'Transfers and card payments', 'a1'),
  // Refund netting (2026-08-17): the harness had ZERO credit-account negatives,
  // so every surface this change touches — a negative category bar, the
  // breakdown card's "Less returns" line, the sheet's Refund label — rendered
  // untested. These two are the pair that matters: a REFUND (nets against
  // Groceries, taking it below the Safeway charge) and a PAYMENT RECEIVED on
  // the same card, which must NOT net and which no issuer name appears in.
  raw('2026-08-04', -30.00, 'SAFEWAY #1234 SEATTLE WA', 'Groceries', 'a3'),
  raw('2026-08-05', -600.00, 'PAYMENT THANK YOU', null, 'a3'),
];
const JUL = [
  raw('2026-07-28', 92.10, 'SAFEWAY #1234 SEATTLE WA', 'Groceries', 'a3'),
  raw('2026-07-20', 401.22, 'HOME DEPOT 2210', 'Home maintenance and improvement', 'a3'),
  raw('2026-07-15', 58.00, 'DINNER HOUSE GRILL', 'Dining out', 'a3'),
  raw('2026-07-10', 129.00, 'CITY UTILITIES', 'Utilities', 'a1'),
  raw('2026-07-05', 44.90, 'MYSTERY VENDOR LLC', null, 'a3'),
  raw('2026-07-03', -2400.00, 'TRANSFER FROM PERSONAL', 'Transfers and card payments', 'a1', { raw_category: 'TRANSFER_IN' }),
];
// --- POST-WIPE MODE (?postwipe) --------------------------------------------
// What Mason actually sees the morning after migration 20260805000001 runs:
// every stored category is Uncategorized (the three MECHANISM labels survive —
// they are written by the guards that outlived the keyword table), budgets /
// budget_months / category_rules are archived and deleted, and the `dash:cats`
// registry is empty. Nothing has been taught yet.
const POSTWIPE = Q.has('postwipe');
const MECHANISM = new Set(['Transfers and card payments', 'Return', 'Uncategorized']);

// Untaught money that lands OUTSIDE every spending total — the population the
// teach-queue's second group exists for. A paycheck (unpaired depository
// inflow) and a structural self-transfer pair (equal amount, two accounts,
// wording the surviving guards do NOT catch, so it stays Uncategorized and is
// washed by markInternalTransfers, not by its label).
const WIPE_EXTRA = POSTWIPE ? [
  raw('2026-08-01', -2200.00, 'ACH DEPOSIT PAYROLL POME HOLISTIC PE', null, 'a1'),
  raw('2026-08-02', 600.00, 'ZELLE TO BECU SAVINGS', null, 'a1'),
  raw('2026-08-02', -600.00, 'ZELLE FROM CHECKING MASON B', null, 'a2'),
] : [];

const ALL = [...AUG, ...JUL, ...WIPE_EXTRA];

if (POSTWIPE) {
  for (const t of ALL) {
    if (!MECHANISM.has(t.mapped_category)) t.mapped_category = 'Uncategorized';
    t.user_category = null;
  }
  // The real adapter pairs inside getTransactionsBetween, so `counted` is
  // stamped from a MARKED row set. Marking here (once, over the whole fixture —
  // every pair in it is same-month, so range-scoped pairing gives the same
  // answer) keeps the harness's `counted` equal to production's.
  markInternalTransfers(ALL);
}

const inMonth = (y, m) => ALL.filter(t => t.date.startsWith(`${y}-${String(m).padStart(2, '0')}`));

export async function getOverview() {
  const visible = ACCTS.filter(a => !a.hidden);
  const ordered = [...visible.filter(a => a.type === 'credit'), ...visible.filter(a => a.type === 'depository')];
  return {
    accounts: ordered.map(a => ({
      id: a.id, balance: { current: a.current_balance }, name: a.name, mask: a.mask, type: a.type,
      // Additive fields the Overview tile reads: available credit (never
      // through displayBalance) and the as-of stamp.
      available: a.available_balance ?? null,
      plaid_account_id: a.plaid_account_id,
      last_balance_at: a.last_balance_at ?? null,
    })),
    // Last month in full, and last month sliced at today's day-of-month — the
    // honest comparison for a month still in progress.
    last_month: { spending: { amount: 1125.22 }, spending_to_date: { amount: 611.40 } },
  };
}
export async function getSpending({ year, month }) {
  return { groups: spendingGroups(inMonth(year, month)) };
}
export async function getBiggestMovers({ year, month }) {
  const py = month === 1 ? year - 1 : year;
  const pm = month === 1 ? 12 : month - 1;
  return { movers: biggestMovers(inMonth(year, month), inMonth(py, pm)) };
}
export async function getTransactions({ year, month }) {
  const txs = inMonth(year, month).slice().sort((a, b) => a.date === b.date ? b.amount - a.amount : (a.date < b.date ? 1 : -1));
  return { transactions: txs.map(toTxShape) };
}
// Each period carries the ROWS behind its income figure — the real
// getCashFlow filters them with the same isIncome() pass it folds the amount
// from, and the Reflect hub's income drill-in lists them. Derived the same way
// here (cashIncome over the same rows) rather than hardcoded beside them, so
// the harness's sheet total equals its bars exactly as production's does; the
// two paychecks still sum to the 4200/4500 the bars drew before.
const CASHFLOW_PERIODS = ['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'].map((label, i) => {
  const mm = String(3 + i).padStart(2, '0');
  const rows = [
    raw(`2026-${mm}-15`, -2100, 'ACH DEPOSIT PAYROLL POME HOLISTIC PE', null, 'a1'),
    raw(`2026-${mm}-01`, -(2100 + (i % 2) * 300), 'DIRECT DEP EMPLOYER INC', null, 'a1'),
  ];
  return {
    label, start: `2026-${mm}-01`,
    spending: { amount: 1800 + i * 120 },
    income: { amount: cashIncome(rows), transactions: rows.map(toTxShape) },
  };
});
export async function getCashFlow() {
  return { periods: CASHFLOW_PERIODS, averages: { spending: { amount: 2100 } } };
}
export async function getAccounts() { return { accounts: ACCTS.map(a => ({ ...a })) }; }
export async function updateAccount() {}
export async function getAccountTransactions() { return { transactions: AUG.map(toTxShape) }; }
export async function getAccountTransactionsInRange() { return []; }
export async function updateTransaction() {}
// The wipe deletes every `budgets` row (they were keyed to categories that no
// longer exist anywhere in the code).
export async function getBudgets() {
  if (POSTWIPE) return { budgets: {}, byDate: {} };
  return { budgets: { Groceries: 500, 'Dining out': 200 }, byDate: {} };
}
export async function setBudget() {}
// --- Recurring fixtures: weekly + monthly + annual cadences, plus two
// monthly items whose keys sit on the household ignore list. Dates chosen so
// nothing is overdue/stale against today = 2026-08-03.
const REC = [];
function recSeries(desc, amount, dates, cat = 'Entertainment and subscriptions', acct = 'a3') {
  for (const d of dates) REC.push(raw(d, amount, desc, cat, acct));
}
// Weekly ($63.99/wk → tops the monthly-equivalent sort)
recSeries('BLUE APRON', 63.99, ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03'], 'Groceries');
// Monthly
recSeries('NETFLIX.COM', 15.49, ['2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15', '2026-07-15']);
recSeries('SPOTIFY USA', 11.99, ['2026-03-02', '2026-04-02', '2026-05-02', '2026-06-02', '2026-07-02', '2026-08-02']);
// Annual
recSeries('AMAZON PRIME MEMBERSHIP', 139.00, ['2023-09-14', '2024-09-13', '2025-09-14'], 'Shopping and gear');
recSeries('COSTCO ANNUAL MEMBERSHIP', 65.00, ['2023-11-30', '2024-11-29', '2025-11-30'], 'Shopping and gear');
// Ignored (keys on the household ignore list below)
recSeries('PLANET FITNESS', 24.99, ['2026-03-17', '2026-04-17', '2026-05-17', '2026-06-17', '2026-07-17'], 'Health and fitness', 'a1');
recSeries('HULU', 17.99, ['2026-02-28', '2026-03-28', '2026-04-28', '2026-05-28', '2026-06-28', '2026-07-28']);

export async function getRecurringCandidates() { return { transactions: REC.map(toTxShape) }; }

// Household recurring ignore list ('rec:ignore' settings row in prod).
let recIgnoreList = [normalizeMerchant('PLANET FITNESS'), normalizeMerchant('HULU')];
export async function getRecIgnore() { return [...recIgnoreList]; }
export async function setRecIgnore(keys) { recIgnoreList = [...keys]; }
export async function updateRecIgnore(key, ignored) {
  recIgnoreList = recIgnoreList.filter(k => k !== key);
  if (ignored) recIgnoreList.push(key);
  return [...recIgnoreList];
}
// --- Cross-month search corpus: >1 server page so Load more renders, with
// amounts/dates spread so the amount/date filters visibly narrow the set.
const SEARCH_CORPUS = (() => {
  const rows = [];
  for (let i = 0; i < 230; i++) {
    const y = i < 40 ? 2026 : 2026 - Math.floor((i - 40) / 96); // recent first-ish
    const m = ((230 - i) % 12) + 1;
    const d = (i % 27) + 1;
    const date = `${2026 - Math.floor(i / 96)}-${String(((i % 12) + 1)).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const amount = i % 9 === 0 ? -(20 + (i % 60)) : (4.5 + (i % 13) * 7.35);
    rows.push(raw(date, Math.round(amount * 100) / 100, `STARBUCKS STORE #${1000 + i} SEATTLE WA`, 'Coffee and snacks', i % 3 ? 'a3' : 'a1'));
  }
  rows.sort((a, b) => (a.date === b.date ? (a.id < b.id ? 1 : -1) : (a.date < b.date ? 1 : -1)));
  return rows;
})();
export async function searchTransactions(query, { limit = 200, offset = 0, filters = null } = {}) {
  const q = (query || '').trim().toLowerCase();
  // Filter-only search (Session B): active filters run with no text query,
  // matching the real adapter's searchIsActive gate (skip the ilike).
  if (q.length < 2 && !filters) return { transactions: [], hasMore: false };
  let rows = q.length >= 2 ? SEARCH_CORPUS.filter(t => t.description.toLowerCase().includes(q)) : SEARCH_CORPUS.slice();
  if (filters) {
    const { amountMin, amountMax, dateFrom, dateTo } = filters;
    rows = rows.filter(t => {
      const a = Math.abs(t.amount);
      if (amountMin != null && a < amountMin) return false;
      if (amountMax != null && a > amountMax) return false;
      if (dateFrom && t.date < dateFrom) return false;
      if (dateTo && t.date > dateTo) return false;
      return true;
    });
  }
  const page = rows.slice(offset, offset + limit);
  return { transactions: page.map(toTxShape), hasMore: rows.length > offset + limit };
}

// --- Saved Ask-tab chats (household 'asst:chats' row in prod) ---------------
let SAVED_CHATS = [
  {
    id: 'sc1', title: 'Why was July dining so high? — Jul 30', savedAt: '2026-07-30T18:04:00.000Z',
    msgs: [
      { role: 'user', content: 'Why was July dining so high?' },
      { role: 'assistant', content: 'July dining came to $486, about $210 above your three-month average. Two drivers: three Dinner House Grill visits totaling $174, and a one-off $95 charge at Harbor Oyster Bar on Jul 18.' },
      { role: 'user', content: 'Is that a recurring place?' },
      { role: 'assistant', content: 'No — Harbor Oyster Bar appears only once in your history. Dinner House Grill shows up roughly monthly.' },
    ],
  },
  {
    id: 'sc2', title: 'How much buffer do we have this month? — Jul 22', savedAt: '2026-07-22T15:41:00.000Z',
    msgs: [
      { role: 'user', content: 'How much buffer do we have this month?' },
      { role: 'assistant', content: 'After expected bills (~$2,340 remaining) and your typical spending pace, checking + savings leave roughly $1,850 of buffer through Jul 31.' },
    ],
  },
];
export async function getSavedChats() { return SAVED_CHATS.map(c => ({ ...c, msgs: c.msgs.map(m => ({ ...m })) })); }
export async function saveChatToApp(chat) {
  SAVED_CHATS = [chat, ...SAVED_CHATS.filter(c => c.id !== chat.id)].slice(0, 10);
  return getSavedChats();
}
export async function deleteSavedChat(id) {
  SAVED_CHATS = SAVED_CHATS.filter(c => c.id !== id);
  return getSavedChats();
}
// --- Category-registry rows (dash:cats / dash:colors / dash:names) ----------
// Read-merge-write against the settings store, resolving with the merged
// value — the real adapter's contract (src/adapters/settingsIO.js).
async function mergeSettingRow(key, empty, merge) {
  let cur = empty;
  const raw = await getSetting(key);
  if (raw) { try { cur = JSON.parse(raw); } catch { /* corrupt row reads empty */ } }
  const next = merge(cur);
  await setSetting(key, JSON.stringify(next));
  return next;
}
export const addRegistryEntry = entry => mergeSettingRow('dash:cats', [], cur =>
  cur.some(c => (c?.name || '').trim() === (entry?.name || '').trim()) ? cur : [...cur, entry]);
export const updateRegistryParent = (name, parent) =>
  mergeSettingRow('dash:cats', [], cur => setRegistryParent(cur, name, parent));
export const removeRegistryEntry = id =>
  mergeSettingRow('dash:cats', [], cur => cur.filter(c => c?.id !== id));
export const updateCategoryColor = (cat, color) =>
  mergeSettingRow('dash:colors', {}, cur => ({ ...cur, [cat]: color }));
export const updateCategoryAlias = (cat, alias) =>
  mergeSettingRow('dash:names', {}, cur => ({ ...cur, [cat]: alias }));
export const FEED_GAP_SCAN_CAP = 25;
export function isManualAccount(a) { return !!a?.is_manual; }
export function isSimpleFinAccount(a) { return String(a?.plaid_account_id || '').startsWith('sfin:'); }
export async function setCategoryRule() {}
// Returns a COUNT — the real adapter returns matches.length (a number the
// learn-confirm renders as "updates N past transactions"). The first version
// of this mock returned an object, so the render gate exercised a state the
// real app can never produce.
export async function applyCategoryRuleToHistory() { return 0; }
export async function getCategoryRules() { return []; }

// --- taught-rules screen (RulesSheet) ---------------------------------------
let RULES = [
  { merchant_key: 'SAFEWAY SEATTLE WA', category: 'Groceries', source: 'user', updated_at: '2026-08-02T18:04:00Z' },
  { merchant_key: 'STARBUCKS', category: 'Coffee and snacks', source: 'user', updated_at: '2026-08-01T09:12:00Z' },
  { merchant_key: 'DINNER HOUSE GRILL', category: 'Dining out', source: 'user', updated_at: '2026-07-28T20:41:00Z' },
  { merchant_key: 'SHELL OIL', category: 'Vehicle expenses', source: 'user', updated_at: '2026-07-22T07:55:00Z' },
  { merchant_key: 'NEIGHBORHOOD HVAC CO', category: 'Home maintenance and improvement', source: 'import', updated_at: '2026-07-19T16:30:00Z' },
  { merchant_key: 'PUGET SOUND ENERGY', category: 'Utilities', source: 'user', updated_at: '2026-06-30T11:02:00Z' },
  // Amount-scoped rule (amount non-null): RulesSheet keys rows on the
  // (merchant_key, amount) PAIR and renders the amount as part of the rule's
  // identity — without one in the fixture that whole path never renders in
  // the gate.
  { merchant_key: 'ZELLE TRANSFER', category: 'Rent', amount: 1800, source: 'user', updated_at: '2026-08-06T08:00:00Z' },
  { merchant_key: 'ZELLE TRANSFER', category: 'Gifts', amount: null, source: 'user', updated_at: '2026-08-06T08:01:00Z' },
];
export async function listCategoryRules() {
  await new Promise(r => setTimeout(r, 120));
  // `category_rules` is archived and emptied by the wipe: the table EXISTS
  // (so the sentinel stays [] and never null) but nothing has been taught yet.
  if (POSTWIPE) return [];
  return RULES.map(r => ({ ...r }));
}
export async function countCategoryRuleMatches(key) {
  await new Promise(r => setTimeout(r, 700));
  if (key === 'SHELL OIL') throw new Error('network request failed');
  const counts = { 'SAFEWAY SEATTLE WA': 34, 'STARBUCKS': 112, 'DINNER HOUSE GRILL': 9,
    'NEIGHBORHOOD HVAC CO': 1, 'PUGET SOUND ENERGY': 26 };
  return counts[key] ?? 0;
}
export async function deleteCategoryRule(key) {
  await new Promise(r => setTimeout(r, 150));
  RULES = RULES.filter(r => r.merchant_key !== key);
}
export async function getEnvelopes({ year, month }) {
  // `budget_months` is emptied too — no assignments, no targets, no carry.
  if (POSTWIPE) {
    const spending = ALL.filter(t => t.mapped_category)
      .map(t => ({ category: t.mapped_category, month: t.date.slice(0, 7) + '-01', spent: t.amount }));
    return walkEnvelopes({ assignments: [], spending, settings: [], year, month });
  }
  const assignments = [
    { category: 'Groceries', month: '2026-07-01', assigned: 500 },
    { category: 'Groceries', month: '2026-08-01', assigned: 500, targetOverride: 350 },
    { category: 'Dining out', month: '2026-08-01', assigned: 200 },
    // July-only envelopes so "Fill from July" has assignments to copy.
    { category: 'Utilities', month: '2026-07-01', assigned: 130 },
    { category: 'Vehicle expenses', month: '2026-07-01', assigned: 220 },
  ];
  const spending = ALL.filter(t => t.mapped_category && t.mapped_category !== 'Transfers and card payments')
    .map(t => ({ category: t.mapped_category, month: t.date.slice(0, 7) + '-01', spent: t.amount }));
  const settings = [
    { category: 'Groceries', target: 500, targetKind: 'monthly', targetDate: null, rollover: true },
    { category: 'Dining out', target: 200, targetKind: 'monthly', targetDate: null, rollover: false },
  ];
  return walkEnvelopes({ assignments, spending, settings, year, month });
}
export async function setAssigned() {}
export async function setCategoryRollover() {}
export async function setTargetKind() {}
export async function fundTargets() {}
export async function moveMoney() {}
// The real adapter's shape ({income, isDefault, monthlyDefault}), so the
// Budget header renders the typed figure instead of "＋ set income".
export async function getBudgetIncome() { return { income: 6200, isDefault: true, monthlyDefault: 6200 }; }
export async function setBudgetIncome() {}
// The hybrid income rule's measured half. The render gate views the current
// month, so the resolver picks manual and this value is never painted — it
// exists so the read resolves without error.
export async function getActualIncome() { return { amount: 5400, coverageStart: '2026-01-09' }; }
export function invalidateEnvelopeSpending() {}
export function isEnvelopeSchemaMissing() { return false; }
export async function getEnvPace() { return false; }
export async function setEnvPace() {}
// Startup batch (the façade shape: raw Dashboard-owned rows in `values`, the
// two adapter-owned rows parsed).
export async function getStartupSettings(keys) {
  const values = {};
  for (const k of keys || []) values[k] = await getSetting(k);
  return { values, envPace: await getEnvPace(), recIgnore: await getRecIgnore() };
}
// --- Tax tab (post-wipe) ----------------------------------------------------
// A rental property whose whole year is now Uncategorized: the Schedule E
// picker below it can offer nothing (isBudgetableCategory filters the
// mechanism labels out), so every dollar sits in the VISIBLE amber "not on any
// line yet" bucket, and unmapped money IN still defaults to rents.
const ENTITIES = POSTWIPE
  ? [{ id: 'e1', name: 'Cedar St duplex', kind: 'rental', created_at: '2025-03-01T00:00:00Z', archived_at: null }]
  : [];
const taxRow = (date, amount, desc, extra = {}) => ({
  ...toTxShape(raw(date, amount, desc, POSTWIPE ? 'Uncategorized' : null, 'a1')),
  effective_entity_id: 'e1',
  entity_id: 'e1',
  ...extra,
});
const TAX_ROWS = POSTWIPE ? [
  taxRow('2026-01-05', -2400.00, 'RENT DEPOSIT UNIT A'),
  taxRow('2026-02-04', -2400.00, 'RENT DEPOSIT UNIT A'),
  taxRow('2026-03-05', -2400.00, 'RENT DEPOSIT UNIT A'),
  taxRow('2026-04-03', -1650.00, 'RENT DEPOSIT UNIT B'),
  taxRow('2026-01-15', 1875.40, 'NEWREZ SHELLPOINT MORTGAGE'),
  taxRow('2026-02-15', 1875.40, 'NEWREZ SHELLPOINT MORTGAGE'),
  taxRow('2026-03-15', 1875.40, 'NEWREZ SHELLPOINT MORTGAGE'),
  taxRow('2026-02-08', 318.44, 'HOME DEPOT 2210'),
  taxRow('2026-03-22', 460.00, 'RAINIER PLUMBING LLC'),
  taxRow('2026-01-28', 142.10, 'STATE FARM INSURANCE'),
  taxRow('2026-02-28', 96.75, 'CITY UTILITIES'),
  taxRow('2026-04-18', 8400.00, 'ROOFLINE CONTRACTORS INC',
    { is_capital: true, placed_in_service: '2026-04-20', useful_life_years: 27 }),
] : [];

export async function getEntities() { return { entities: ENTITIES.map(e => ({ ...e })) }; }
export async function createEntity() { return { id: 'e1' }; }
export async function updateEntity() {}
export async function getTaxYearTransactions(year) {
  if (!POSTWIPE) return { transactions: [] };
  return { transactions: TAX_ROWS.filter(t => t.transaction_date.startsWith(String(year))).map(t => ({ ...t })) };
}
export async function getMileage() { return []; }
export async function addMileage() {}
export async function deleteMileage() {}
export async function getReceiptTxIds() { return null; }
export async function getReceipts() { return []; }
export async function addReceipt() {}
export async function deleteReceipt() {}
export async function getReceiptUrl() { return ''; }
const MANUAL_DEBT = {
  id: 'am9', institution_id: 'im', plaid_account_id: 'manual:am9', name: 'Family loan',
  official_name: null, nickname: null, color: null, mask: null, type: 'loan', subtype: 'loan',
  current_balance: 6500, available_balance: null, last_balance_at: '2026-08-02T12:00:00Z',
  hidden: false, entity_id: null, is_manual: true,
  institutions: { name: 'Imported', display_name: 'Imported' },
  apr: null, minimum_payment: 250, credit_limit: null, statement_balance: null,
  next_payment_due_date: '2026-08-15', interest_rate: 4.5, original_balance: 9000,
};
export async function getDebts() {
  const debts = ACCTS.filter(a => a.type === 'credit').map(a => ({
    ...a,
    apr: 24.99, minimum_payment: a.id === 'a3' ? 80 : 40, credit_limit: a.id === 'a3' ? 15000 : 5000,
    statement_balance: null, next_payment_due_date: '2026-08-20', interest_rate: null, original_balance: null,
  })).concat([{ ...MANUAL_DEBT }]);
  for (const d of debts) d.debtRate = d.apr ?? d.interest_rate ?? null;
  return {
    debts,
    totalDebt: debts.reduce((s, a) => s + (Number(a.current_balance) || 0), 0),
    totalMinimums: debts.reduce((s, a) => s + (Number(a.minimum_payment) || 0), 0),
    hasDebtColumns: true,
  };
}
export async function getBalanceSnapshots(accountIds = []) {
  const days = ['2026-07-28', '2026-07-30', '2026-08-01', '2026-08-02', '2026-08-03'];
  const base = { a3: 2400, a4: 560, am9: 6900 };
  const rows = [];
  for (const id of accountIds) {
    if (!(id in base)) continue;
    days.forEach((d, i) => rows.push({ account_id: id, captured_on: d, balance: base[id] - i * (base[id] * 0.012) }));
  }
  return rows;
}
export async function getNetWorthSeries() {
  return [
    { date: '2026-07-28', total: 10480.5 },
    { date: '2026-07-30', total: 10630.2 },
    { date: '2026-08-01', total: 10820.75 },
    { date: '2026-08-02', total: 10891.23 },
    { date: '2026-08-03', total: 11042.61 },
  ];
}
export async function updateManualBalance() {}
export async function addManualTransaction() {}
export async function createManualAccount() { return { id: 'am1' }; }
export async function getFeedCoverageStart() { return null; }
export async function getDataCoverage() { return { accounts: [], months: [] }; }
// The removed-imported marker. Null = nothing removed, which is the harness's
// steady state — the Restore strip is an exception surface and the render gate
// asserts the ORDINARY Accounts tab. (Flip to an id array to eyeball it.)
export async function getRestoreRecord() { return REMOVED_IMPORT ? ['am1'] : null; }
// Feed-reach shortfall. Realistic default: this household linked SimpleFIN on
// 2026-05-02 and the first pull reached ~88 days back, so the two BECU accounts
// start at the wall and have no older history, while the two Capital One cards
// carry pre-link statement imports and are therefore NOT flagged.
export async function getFeedCoverageGaps() {
  return {
    gaps: [
      { account_id: 'a1', served_from: '2026-02-04' },
      { account_id: 'a2', served_from: '2026-02-06' },
    ],
    reachDays: 88,
    truncated: false,
  };
}
export async function signOut() {}
export async function findOrCreateManualInstitution() { return { id: 'im' }; }

// --- Session 6: auto-fill, target overrides, expected transactions ---------
export async function autoFillMonth() { return { rows: [], total: 0, skipped: [] }; }
export async function setTargetOverride() {}
const EXPECTED = {
  pending: [
    // Upcoming this month
    { id: 'x1', recurring_key: null, description: 'GREENLEAF PROPERTIES RENT', category: 'Utilities', account_id: 'a1', amount: 1850, due_date: '2026-08-05', cadence: 'monthly', status: 'pending', matched_tx_id: null, created_at: '2026-08-01' },
    // Overdue + missed? (once, >14 days past due) — renders Mark paid
    { id: 'x2', recurring_key: null, description: 'WATER & SEWER DISTRICT', category: 'Utilities', account_id: 'a1', amount: 88.40, due_date: '2026-07-12', cadence: 'once', status: 'pending', matched_tx_id: null, created_at: '2026-07-01' },
    // Pending for a recurring item (Spotify) — drives "expected ✓" on the
    // Recurring row; due next month so it stays off the August card.
    { id: 'x3', recurring_key: normalizeMerchant('SPOTIFY USA'), description: 'SPOTIFY USA', category: 'Entertainment and subscriptions', account_id: 'a3', amount: 11.99, due_date: '2026-09-02', cadence: 'monthly', status: 'pending', matched_tx_id: null, created_at: '2026-08-02' },
  ],
  matched: [
    { id: 'x4', recurring_key: null, description: 'CITY UTILITIES', category: 'Utilities', account_id: 'a1', amount: 129.00, due_date: '2026-08-01', cadence: 'monthly', status: 'matched', matched_tx_id: 't12', created_at: '2026-07-15' },
  ],
};
export async function getExpectedTransactions() {
  if (Q.has('emptyExpected')) return { pending: [], matched: [] };
  return { pending: EXPECTED.pending.map(r => ({ ...r })), matched: EXPECTED.matched.map(r => ({ ...r })) };
}
export async function addExpected(fields) { return { row: { id: 'xn', status: 'pending', ...fields }, duplicate: false }; }
export async function dismissExpected() {}
export async function matchExpectedManually() {}
export async function getExistingTxIds() { return new Set(); }
export async function importCsvTransactions() { return { inserted: 0 }; }
