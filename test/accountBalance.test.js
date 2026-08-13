// Tests for src/accountBalance.js — the stored-positive → displayed-negative
// rule for debt balances. Four display sites depend on it (three in
// Dashboard.jsx plus the assistant context); this is the shared primitive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDebtAccount, displayBalance, balanceAsOf, BALANCE_STALE_DAYS } from '../src/accountBalance.js';

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

// --- balanceAsOf: how old the number on screen is ---------------------------
// accounts.last_balance_at was written by every sync and rendered nowhere, so
// a manual balance typed in June looked exactly like one pulled this morning.
test('balanceAsOf returns the date and whole days of age', () => {
  const now = new Date('2026-08-13T12:00:00Z');
  const got = balanceAsOf({ last_balance_at: '2026-08-01T12:00:00Z' }, now);
  assert.equal(got.staleDays, 12);
  assert.equal(got.date.toISOString().slice(0, 10), '2026-08-01');
  // Same day = 0, not null: "as of today" is a fact, it just doesn't render.
  assert.equal(balanceAsOf({ last_balance_at: '2026-08-13T09:00:00Z' }, now).staleDays, 0);
});

test('balanceAsOf says nothing rather than guessing', () => {
  const now = new Date('2026-08-13T12:00:00Z');
  // Pre-stamp manual rows carry null — honest absence, the getReceiptTxIds
  // pattern. Nothing renders until the first re-typed balance stamps it.
  assert.equal(balanceAsOf({ last_balance_at: null }, now), null);
  assert.equal(balanceAsOf({}, now), null);
  assert.equal(balanceAsOf(null, now), null);
  assert.equal(balanceAsOf({ last_balance_at: 'not a date' }, now), null);
});

test('balanceAsOf floors at 0 — clock skew never reads as a future balance', () => {
  const now = new Date('2026-08-13T12:00:00Z');
  assert.equal(balanceAsOf({ last_balance_at: '2026-08-20T12:00:00Z' }, now).staleDays, 0);
});

test('BALANCE_STALE_DAYS is the documented threshold', () => {
  // Pinned as documentation (the recurring.js precedent): the accounts list
  // shows an age only past this, and it is chosen against SimpleFIN's ~daily
  // refresh — two weeks quiet is well outside normal.
  assert.equal(BALANCE_STALE_DAYS, 14);
});
