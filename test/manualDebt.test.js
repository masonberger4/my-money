import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildManualAccountRow,
  manualBalanceUpdate,
  MANUAL_ACCOUNT_KINDS,
} from '../src/dataAdapter.js';

// --- buildManualAccountRow: the pure manual-account row builder ---------------

test('kind → type/subtype mapping covers all four kinds', () => {
  assert.deepEqual(MANUAL_ACCOUNT_KINDS, ['checking', 'savings', 'credit', 'loan']);
  const m = k => buildManualAccountRow({ name: 'X', subtype: k });
  assert.deepEqual({ type: m('checking').type, subtype: m('checking').subtype }, { type: 'depository', subtype: 'checking' });
  assert.deepEqual({ type: m('savings').type, subtype: m('savings').subtype }, { type: 'depository', subtype: 'savings' });
  assert.deepEqual({ type: m('credit').type, subtype: m('credit').subtype }, { type: 'credit', subtype: 'credit card' });
  assert.deepEqual({ type: m('loan').type, subtype: m('loan').subtype }, { type: 'loan', subtype: 'loan' });
});

test('unknown kind falls back to checking (pre-existing default)', () => {
  const r = buildManualAccountRow({ name: 'X', subtype: 'yacht' });
  assert.equal(r.type, 'depository');
  assert.equal(r.subtype, 'checking');
});

test('name defaults and trims', () => {
  assert.equal(buildManualAccountRow({}).name, 'Imported account');
  assert.equal(buildManualAccountRow({ name: '  Loan from Dad  ' }).name, 'Loan from Dad');
});

test('hand-typed balance lands STORED-POSITIVE on credit/loan, rounded to cents', () => {
  // Stored convention: debts positive = owed; displayBalance flips at render.
  assert.equal(buildManualAccountRow({ subtype: 'loan', balance: 1234.567 }).current_balance, 1234.57);
  assert.equal(buildManualAccountRow({ subtype: 'credit', balance: 500 }).current_balance, 500);
});

test('a negative balance is REJECTED, never abs()d — the minus means display convention', () => {
  assert.throws(() => buildManualAccountRow({ subtype: 'loan', balance: -100 }), /positive/);
});

test('balance is ignored for depository kinds and when absent/blank', () => {
  assert.ok(!('current_balance' in buildManualAccountRow({ subtype: 'checking', balance: 100 })));
  assert.ok(!('current_balance' in buildManualAccountRow({ subtype: 'loan' })));
  assert.ok(!('current_balance' in buildManualAccountRow({ subtype: 'loan', balance: '' })));
  assert.ok(!('current_balance' in buildManualAccountRow({ subtype: 'loan', balance: 'nope' })));
});

// --- manualBalanceUpdate: the hand-typed balance-edit gate --------------------

const manualLoan = { id: 'a1', plaid_account_id: 'manual:xyz', is_manual: true, type: 'loan', current_balance: 900 };

test('fed and non-manual accounts are refused — a fed balance is never hand-edited', () => {
  assert.throws(() => manualBalanceUpdate({ plaid_account_id: 'sfin:123', type: 'credit' }, 100), /manual/i);
  assert.throws(() => manualBalanceUpdate({ plaid_account_id: 'other', type: 'credit' }, 100), /manual/i);
  assert.throws(() => manualBalanceUpdate(null, 100), /manual/i);
});

test('robust to is_manual column missing: the manual: prefix alone qualifies', () => {
  const r = manualBalanceUpdate({ plaid_account_id: 'manual:abc', type: 'loan', current_balance: 5 }, 10);
  assert.equal(r.balance, 10);
});

test('non-numeric and negative debt balances are rejected', () => {
  assert.throws(() => manualBalanceUpdate(manualLoan, 'nope'), /number/i);
  assert.throws(() => manualBalanceUpdate(manualLoan, NaN), /number/i);
  assert.throws(() => manualBalanceUpdate(manualLoan, -50), /positive/);
});

test('rounds to cents and reports snapshot only when the value MOVED (sync parity)', () => {
  // Moved → snapshot true.
  assert.deepEqual(manualBalanceUpdate(manualLoan, 850.006), { balance: 850.01, snapshot: true });
  // Unchanged → no history row (mirrors api/sync.js only-on-change).
  assert.deepEqual(manualBalanceUpdate(manualLoan, 900), { balance: 900, snapshot: false });
  // Unchanged after rounding still counts as unchanged.
  assert.deepEqual(manualBalanceUpdate(manualLoan, 900.0004), { balance: 900, snapshot: false });
});

test('zero is a legal payoff balance', () => {
  assert.deepEqual(manualBalanceUpdate(manualLoan, 0), { balance: 0, snapshot: true });
});
