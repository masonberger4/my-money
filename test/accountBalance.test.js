// Tests for src/accountBalance.js — the stored-positive → displayed-negative
// rule for debt balances. Four display sites depend on it (three in
// Dashboard.jsx plus the assistant context); this is the shared primitive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDebtAccount, displayBalance } from '../src/accountBalance.js';

test('isDebtAccount: credit and loan only', () => {
  assert.equal(isDebtAccount('credit'), true);
  assert.equal(isDebtAccount('loan'), true);
  assert.equal(isDebtAccount('depository'), false);
  assert.equal(isDebtAccount('investment'), false);
  assert.equal(isDebtAccount(null), false);
  assert.equal(isDebtAccount(undefined), false);
});

test('displayBalance negates stored-positive debts and passes deposits through', () => {
  assert.equal(displayBalance(5127.97, 'credit'), -5127.97);
  assert.equal(displayBalance(231550.12, 'loan'), -231550.12);
  assert.equal(displayBalance(2500.5, 'depository'), 2500.5);
  assert.equal(displayBalance(2500.5, null), 2500.5, 'unknown type passes through');
});

test('REGRESSION: zero and null balances render as 0 — never -0', () => {
  // Caught writing this suite: negating a stored 0 produced -0. The shipped
  // formatters happened to mask it (fmtX tests `v < 0`; toFixed prints
  // "0.00"), but any future site formatting the raw value with
  // toLocaleString would show a paid-off card as "-$0.00".
  assert.equal(displayBalance(0, 'credit'), 0);
  assert.ok(Object.is(displayBalance(0, 'credit'), 0), 'no -0 leaking into formatting');
  assert.equal(displayBalance(null, 'credit'), 0);
  assert.equal(displayBalance(undefined, 'depository'), 0);
  assert.equal(displayBalance('garbage', 'credit'), 0, 'non-numeric reads as 0, not NaN');
});

test('the overpaid-card caveat is a DECISION, not a bug: stored positive ⇒ still displayed as owed', () => {
  // SimpleFIN reports an overpaid card POSITIVE; normalizeBalance leaves it
  // positive (indistinguishable from owed), so display shows it as owed.
  // Approximate by decision — rare and small. If this test ever needs to
  // change, that is a product decision for Mason, not a refactor.
  assert.equal(displayBalance(12.34, 'credit'), -12.34);
});
