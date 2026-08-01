// Byte-determinism tests for the assistant's context builder. CLAUDE.md
// requires byte-stable output per DB state (prompt caching stops hitting
// otherwise); formatSpendingContext is the pure formatter buildSpendingContext
// now delegates to after its two queries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSpendingContext } from '../api/_lib/spendingContext.js';

const ACCOUNTS = [
  { id: 'a-chk', name: 'Everyday Checking', nickname: null, mask: '1234', type: 'depository', subtype: 'checking', current_balance: 2500.5, hidden: false, institutions: { name: 'Synth CU' } },
  { id: 'a-card', name: 'Venture Card', nickname: 'Our Card', mask: '7885', type: 'credit', subtype: 'credit card', current_balance: 5127.97, hidden: false, institutions: { name: 'Capital Synth' } },
  { id: 'a-loan', name: 'Home Loan', nickname: null, mask: '', type: 'loan', subtype: 'loan', current_balance: 231550.12, hidden: false, institutions: { name: 'Synth Servicing' } },
  { id: 'a-hid', name: 'Hidden Card', nickname: null, mask: '9999', type: 'credit', subtype: 'credit card', current_balance: 42, hidden: true, institutions: { name: 'Capital Synth' } },
];

const TXS = [
  { account_id: 'a-chk', date: '2026-07-08', amount: 85.5, merchant_name: '', description: 'SAFEWAY 1467', mapped_category: 'Groceries', user_category: null, user_description: null, excluded: false },
  { account_id: 'a-chk', date: '2026-07-12', amount: 40, merchant_name: '', description: 'EXCLUDED ROW MARKER', mapped_category: 'Groceries', user_category: null, user_description: null, excluded: true },
  { account_id: 'a-card', date: '2026-07-19', amount: -35, merchant_name: '', description: 'RIVER GEAR REFUND', mapped_category: 'Uncategorized', user_category: null, user_description: null, excluded: false },
  { account_id: 'a-card', date: '2026-07-05', amount: 220, merchant_name: 'CAPITAL ONE TRAVEL', description: 'CAPITAL ONE TRAVEL PORTLAND', mapped_category: 'Travel and vacation', user_category: null, user_description: 'Portland trip', excluded: false },
  { account_id: 'a-chk', date: '2026-07-18', amount: 60, merchant_name: '', description: 'MYSTERY VENDOR LLC', mapped_category: 'Uncategorized', user_category: 'Dining out', user_description: null, excluded: false },
  { account_id: 'a-loan', date: '2026-07-15', amount: 800, merchant_name: '', description: 'ESCROW DISBURSEMENT', mapped_category: 'Uncategorized', user_category: null, user_description: null, excluded: false },
];

const clone = v => JSON.parse(JSON.stringify(v));

test('two runs over the same rows produce byte-identical text, without mutating the inputs', () => {
  const accounts = clone(ACCOUNTS);
  const txs = clone(TXS);
  const first = formatSpendingContext(accounts, txs);
  const second = formatSpendingContext(clone(ACCOUNTS), clone(TXS));
  assert.equal(typeof first, 'string');
  assert.equal(first, second, 'byte-identical or prompt caching stops hitting');
  assert.deepEqual(accounts, ACCOUNTS, 'accounts not mutated');
  assert.deepEqual(txs, TXS, 'transactions not mutated');
  // …and a third run on the SAME (already-used) arrays is still identical.
  assert.equal(formatSpendingContext(accounts, txs), first);
});

test('excluded rows and loan-account rows are skipped everywhere', () => {
  const text = formatSpendingContext(clone(ACCOUNTS), clone(TXS));
  assert.ok(!text.includes('EXCLUDED ROW MARKER'), 'excluded rows never reach the assistant');
  assert.ok(!text.includes('ESCROW DISBURSEMENT'), 'loan postings are not purchases');
  // The loan ACCOUNT still lists — only its transactions are dropped.
  assert.ok(text.includes('Home Loan'));
});

test('user edits win: user_category in the sums and list, user_description as the name', () => {
  const text = formatSpendingContext(clone(ACCOUNTS), clone(TXS));
  assert.ok(text.includes('- 2026-07 Dining out: $60.00'), 'override category drives the monthly sum');
  assert.ok(text.includes('| Dining out |'), 'and the transaction line');
  assert.ok(text.includes('Portland trip'), 'user_description is the shown name');
});

test('debt balances match displayBalance — the fourth display site', () => {
  const text = formatSpendingContext(clone(ACCOUNTS), clone(TXS));
  assert.ok(text.includes('balance $-5127.97'), 'card shown as owed (negative)');
  assert.ok(text.includes('balance $-231550.12'), 'loan shown as owed');
  assert.ok(text.includes('balance $2500.50'), 'deposit positive');
});

test('hidden accounts appear nowhere', () => {
  const text = formatSpendingContext(clone(ACCOUNTS), clone(TXS));
  assert.ok(!text.includes('Hidden Card'));
  assert.ok(!text.includes('9999'));
});

test('credit-card negatives read as Return and never enter the spending sums', () => {
  const text = formatSpendingContext(clone(ACCOUNTS), clone(TXS));
  assert.ok(text.includes('| Return |'), 'the refund lists as Return');
  assert.ok(!text.includes('2026-07 Return'), 'no Return line in monthly spending (money in)');
});

// --- Recurring + envelope sections -----------------------------------------

// A ~monthly subscription: 4 charges ~30 days apart, similar amounts, with the
// last one hiked >5% over the median → priceCreep must flag.
const SUB_TXS = [
  { account_id: 'a-card', date: '2026-04-14', amount: 19.99, merchant_name: 'STREAMFLIX', description: 'STREAMFLIX 8841', mapped_category: 'Entertainment and rec', user_category: null, user_description: null, excluded: false },
  { account_id: 'a-card', date: '2026-05-14', amount: 19.99, merchant_name: 'STREAMFLIX', description: 'STREAMFLIX 9013', mapped_category: 'Entertainment and rec', user_category: null, user_description: null, excluded: false },
  { account_id: 'a-card', date: '2026-06-13', amount: 19.99, merchant_name: 'STREAMFLIX', description: 'STREAMFLIX 0027', mapped_category: 'Entertainment and rec', user_category: null, user_description: null, excluded: false },
  { account_id: 'a-card', date: '2026-07-14', amount: 21.99, merchant_name: 'STREAMFLIX', description: 'STREAMFLIX 1152', mapped_category: 'Entertainment and rec', user_category: null, user_description: null, excluded: false },
];

const BUDGET = {
  year: 2026,
  month: 7,
  assignments: [
    { category: 'Groceries', month: '2026-06-01', assigned: 100 },
    { category: 'Groceries', month: '2026-07-01', assigned: 200 },
  ],
  settings: [{ category: 'Groceries', target: 250, targetKind: 'monthly', targetDate: null, rollover: true }],
  // Raw tx rows, exactly the columns fetchBudgetInputs selects: June spends 40
  // (carry 100−40=60), July spends 85.50 → available 200+60−85.50 = 174.50.
  // The loan row and the excluded row must not count.
  spendTxs: [
    { account_id: 'a-chk', date: '2026-06-10', amount: 40, mapped_category: 'Groceries', user_category: null, excluded: false },
    { account_id: 'a-chk', date: '2026-07-08', amount: 85.5, mapped_category: 'Groceries', user_category: null, excluded: false },
    { account_id: 'a-chk', date: '2026-07-12', amount: 40, mapped_category: 'Groceries', user_category: null, excluded: true },
    { account_id: 'a-loan', date: '2026-07-15', amount: 800, mapped_category: 'Groceries', user_category: null, excluded: false },
  ],
};

test('byte-determinism holds with the recurring and envelope sections included', () => {
  const args = () => [clone(ACCOUNTS), clone(TXS).concat(clone(SUB_TXS)), { budget: clone(BUDGET) }];
  const first = formatSpendingContext(...args());
  const second = formatSpendingContext(...args());
  assert.equal(first, second, 'byte-identical or prompt caching stops hitting');
  assert.ok(first.includes('## Recurring charges'));
  assert.ok(first.includes('## Budget envelopes (2026-07)'));
});

test('recurring section renders the subscription, its creep flag, and the tx-derived clock', () => {
  const text = formatSpendingContext(clone(ACCOUNTS), clone(TXS).concat(clone(SUB_TXS)));
  assert.ok(text.includes('newest transaction (2026-07-19)'), 'clock is the max tx date, not wall clock');
  assert.ok(/- STREAMFLIX: ~\$19\.99\/mo \(Entertainment and rec, every ~3\d days, last 2026-07-14, next ~2026-08-1\d\)/.test(text));
  assert.ok(text.includes('price increased: was $19.99, now $21.99'));
  // One-off merchants never read as recurring.
  assert.ok(!text.includes('- SAFEWAY'));
});

test('recurring section says "None detected." rather than disappearing', () => {
  const text = formatSpendingContext(clone(ACCOUNTS), clone(TXS));
  assert.ok(text.includes('## Recurring charges'));
  assert.ok(text.includes('None detected.'));
});

test('envelope section walks assigned/carried/spent/available for the fixture month', () => {
  const text = formatSpendingContext(clone(ACCOUNTS), clone(TXS), { budget: clone(BUDGET) });
  assert.ok(
    text.includes('- Groceries: assigned $200.00, carried $60.00, spent $85.50, available $174.50, target $250.00/mo'),
    text
  );
  assert.ok(text.includes('Totals: assigned $200.00, carried $60.00, spent $85.50, available $174.50'));
});

test('missing envelope schema (budget: null / absent) omits the section cleanly', () => {
  const withNull = formatSpendingContext(clone(ACCOUNTS), clone(TXS), { budget: null });
  const absent = formatSpendingContext(clone(ACCOUNTS), clone(TXS));
  assert.ok(!withNull.includes('## Budget envelopes'));
  assert.equal(withNull, absent, 'null budget and no extras render identically');
});

test('monthly sums are emitted in sorted-key order (order-independent above the transaction list)', () => {
  // The transaction list itself follows input order (the query orders it);
  // everything above it — accounts and the monthly category sums — must not
  // depend on row order at all.
  const head = t => t.slice(0, t.indexOf('## Transactions'));
  const a = formatSpendingContext(clone(ACCOUNTS), clone(TXS));
  const b = formatSpendingContext(clone(ACCOUNTS), clone(TXS).reverse());
  assert.equal(head(a), head(b));
});
