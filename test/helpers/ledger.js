// Synthetic household ledger for test/spending.test.js (and the Phase 5
// harness cross-check). All data is invented.
//
// The point of this helper is to hand rows to the pure spending suite THE WAY
// THE APP'S QUERIES AND WRITE PATH DELIVER THEM — several behaviors the
// scenarios exercise are produced by the fetch/write layers, not by isSpend:
//
//   • rows carry the post-join shape (t.accounts = { hidden, type, subtype });
//   • mapped_category is derived the way the write path does it — through
//     classifyDescription (with accountType), then the read layer's
//     applyAccountRules (credit negatives → 'Return');
//   • hidden-account exclusion happens at the QUERY level, so tests compute
//     ALL totals over visibleRows() — the ledger's stand-in for
//     `.eq('accounts.hidden', false)`. The hidden account exists to pin that
//     the fixture models the query contract; hidden exclusion is never
//     asserted through isSpend.
import { classifyDescription } from '../../src/txClassify.js';
import { applyAccountRules } from '../../src/categoryMap.js';

export function makeAccounts() {
  return {
    checking: { id: 'acc-chk', type: 'depository', subtype: 'checking', hidden: false },
    savings: { id: 'acc-sav', type: 'depository', subtype: 'savings', hidden: false },
    card1: { id: 'acc-card1', type: 'credit', subtype: 'credit card', hidden: false },
    card2: { id: 'acc-card2', type: 'credit', subtype: 'credit card', hidden: false },
    mortgage: { id: 'acc-loan', type: 'loan', subtype: null, hidden: false },
    manual: { id: 'acc-manual', type: 'depository', subtype: 'checking', hidden: false, is_manual: true },
    hiddenCard: { id: 'acc-hidden', type: 'credit', subtype: 'credit card', hidden: true },
  };
}

// One transaction, built the way the app's layers would deliver it.
// overrides: user_category, user_description, excluded, entity_id, rules
// (learned rules for the write-time classifier), raw_category/mapped_category
// (to force a stored value), id/plaid_tx_id.
export function makeTx(account, id, date, amount, description, overrides = {}) {
  const { rules = null, ...fields } = overrides;
  // Write path: both feeds derive the category pair at write time.
  const { raw_category, mapped_category } = classifyDescription(description, amount, account.type, rules);
  const t = {
    id,
    plaid_tx_id: `led:${id}`,
    account_id: account.id,
    date,
    amount,
    merchant_name: '',
    description,
    mapped_category,
    raw_category,
    user_category: null,
    user_description: null,
    excluded: false,
    pending: false,
    entity_id: null,
    is_capital: false,
    placed_in_service: null,
    useful_life_years: null,
    // The post-join shape the queries deliver.
    accounts: {
      hidden: account.hidden,
      type: account.type,
      subtype: account.subtype,
      entity_id: account.entity_id ?? null,
    },
    ...fields,
  };
  // Read layer: getTransactionsBetween applies the account rules on the way
  // out (credit negatives → 'Return').
  t.mapped_category = applyAccountRules(t.mapped_category, t.amount, t.accounts?.type);
  return t;
}

// The standard scenario ledger: every transaction type the app handles, all
// in 2026-07, with hand-computable totals (EXPECTED below).
export function standardLedger() {
  const A = makeAccounts();
  const rows = [
    // Joint checking
    makeTx(A.checking, 'chk1', '2026-07-06', 120.0, 'PUGET SOUND ENERGY BILL PAY'), // Utilities
    makeTx(A.checking, 'chk2', '2026-07-08', 85.5, 'SAFEWAY 1467 EVERETT WA'), // Groceries
    makeTx(A.checking, 'chk3', '2026-07-01', -2500.0, 'PAYROLL DIRECT DEP'), // income
    makeTx(A.checking, 'chk4', '2026-07-15', 400.0, 'CAPITAL ONE AUTOPAY PYMT'), // card payment leg
    makeTx(A.checking, 'chk5', '2026-07-10', 300.0, 'ONLINE BANKING TRANSFER TO SAVINGS'), // transfer out leg
    makeTx(A.checking, 'chk6', '2026-07-12', 40.0, 'SAFEWAY 1467 EVERETT WA', { excluded: true }),
    makeTx(A.checking, 'chk7', '2026-07-18', 60.0, 'MYSTERY VENDOR LLC', { user_category: 'Dining out' }),
    makeTx(A.checking, 'chk8', '2026-07-20', 55.0, 'NORTH WALL CLIMBING', { user_category: 'Climbing Gym' }), // custom category
    makeTx(A.checking, 'chk9', '2026-07-21', 33.0, 'TOTALLY UNKNOWN VENDOR 9'), // Uncategorized
    makeTx(A.checking, 'chk10', '2026-07-22', 75.0, 'ACE HARDWARE STORE 12', { entity_id: 'ent-rental' }), // entity-tagged
    // Joint savings
    makeTx(A.savings, 'sav1', '2026-07-12', -300.0, 'ONLINE BANKING TRANSFER FROM CHECKING'), // transfer in leg
    makeTx(A.savings, 'sav2', '2026-07-31', -1.25, 'INTEREST PAID'), // income
    // Credit card 1
    makeTx(A.card1, 'c1a', '2026-07-05', 220.0, 'CAPITAL ONE TRAVEL PORTLAND'), // purchase, NOT a card payment
    makeTx(A.card1, 'c1b', '2026-07-16', -400.0, 'CAPITAL ONE MOBILE PYMT AUTOPAY'), // payment received
    makeTx(A.card1, 'c1c', '2026-07-19', -35.0, 'RIVER GEAR RETURNS'), // refund → Return
    // Credit card 2
    makeTx(A.card2, 'c2a', '2026-07-09', 85.0, 'DISCOVER TIRE AND AUTO CENTER'), // purchase, NOT a card payment
    makeTx(A.card2, 'c2b', '2026-07-11', 6.5, 'ACME COFFEE 0042'),
    // Mortgage (loan) — the servicer's real posting list
    makeTx(A.mortgage, 'loan1', '2026-07-01', -2412.6, 'PAYMENT RECEIVED THANK YOU'),
    makeTx(A.mortgage, 'loan2', '2026-07-15', 800.0, 'ESCROW DISBURSEMENT COUNTY TAX'),
    // Manual "Imported" account
    makeTx(A.manual, 'man1', '2026-07-25', 24.0, 'FARMERS MARKET STALL 12'), // Groceries
    // Hidden account — must appear in NO total (query-level exclusion)
    makeTx(A.hiddenCard, 'hid1', '2026-07-13', 99.0, 'ACME COFFEE 0042'),
  ];
  return {
    accounts: A,
    rows,
    // The query contract: every read the totals are built from already
    // receives only unhidden rows (`.eq('accounts.hidden', false)`).
    visibleRows: () => rows.filter(t => !t.accounts.hidden),
  };
}

// Hand-computed constants for standardLedger()'s visible July rows.
export const EXPECTED = {
  month: '2026-07',
  spendTotal: 764.0,
  groups: {
    'Travel and vacation': { amount: 220.0, count: 1 },
    Utilities: { amount: 120.0, count: 1 },
    Groceries: { amount: 109.5, count: 2 }, // chk2 + man1
    'Vehicle expenses': { amount: 85.0, count: 1 },
    'Home maintenance and improvement': { amount: 75.0, count: 1 },
    'Dining out': { amount: 60.0, count: 1 },
    'Climbing Gym': { amount: 55.0, count: 1 },
    Uncategorized: { amount: 33.0, count: 1 },
    'Coffee and snacks': { amount: 6.5, count: 1 },
  },
  // Joint-budget cash flow (after markInternalTransfers washes chk5↔sav1):
  // income = chk3 2500 + sav2 1.25; spending = checking+manual outflows
  // 120 + 85.50 + 400 + 60 + 55 + 33 + 75 + 24 (chk5 washed, chk6 excluded).
  cash: { income: 2501.25, spending: 852.5 },
};

// Seeded LCG for the property tests (same pattern as test/cashFlow.test.js).
export function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// A random ledger for property tests: a few hundred rows across the account
// mix, descriptors from a pool that exercises every classifier branch,
// occasional overrides/exclusions. Deterministic for a given seed.
const DESC_POOL = [
  'SAFEWAY 1467 EVERETT WA',
  'ACME COFFEE 0042',
  'PUGET SOUND ENERGY BILL PAY',
  'CAPITAL ONE TRAVEL PORTLAND',
  'CAPITAL ONE AUTOPAY PYMT',
  'ONLINE BANKING TRANSFER TO SAVINGS',
  'TOTALLY UNKNOWN VENDOR 9',
  'ACE HARDWARE STORE 12',
  'DISCOVER TIRE AND AUTO CENTER',
  'FARMERS MARKET STALL 12',
];
const OVERRIDE_POOL = ['Dining out', 'Groceries', 'Climbing Gym'];

export function randomLedger(seed, { n = 300 } = {}) {
  const rand = lcg(seed);
  const randInt = k => Math.floor(rand() * k);
  const A = makeAccounts();
  const pool = [A.checking, A.savings, A.card1, A.card2, A.mortgage, A.manual, A.hiddenCard];
  const rows = [];
  for (let i = 0; i < n; i++) {
    const account = pool[randInt(pool.length)];
    const day = 1 + randInt(28);
    const date = `2026-07-${String(day).padStart(2, '0')}`;
    // Two-decimal amounts, mostly outflows, some inflows.
    const magnitude = Math.round((0.5 + rand() * 400) * 100) / 100;
    const amount = rand() < 0.25 ? -magnitude : magnitude;
    const overrides = {};
    if (rand() < 0.1) overrides.excluded = true;
    if (rand() < 0.15) overrides.user_category = OVERRIDE_POOL[randInt(OVERRIDE_POOL.length)];
    rows.push(makeTx(account, `r${i}`, date, amount, DESC_POOL[randInt(DESC_POOL.length)], overrides));
  }
  return {
    accounts: A,
    rows,
    visibleRows: () => rows.filter(t => !t.accounts.hidden),
  };
}
