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

test('monthly sums are emitted in sorted-key order (order-independent above the transaction list)', () => {
  // The transaction list itself follows input order (the query orders it);
  // everything above it — accounts and the monthly category sums — must not
  // depend on row order at all.
  const head = t => t.slice(0, t.indexOf('## Transactions'));
  const a = formatSpendingContext(clone(ACCOUNTS), clone(TXS));
  const b = formatSpendingContext(clone(ACCOUNTS), clone(TXS).reverse());
  assert.equal(head(a), head(b));
});
