// SimpleFIN wire normalization — CLAUDE.md calls account-type inference "the
// fragile part", and none of this had coverage (test/simplefin.test.js covers
// the classifier/clamp only).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inferAccountType,
  normalizeTransaction,
  normalizeBalance,
  parseMoney,
  epochToIsoDate,
  normalizeAccount,
} from '../api/_lib/simplefin.js';

const secs = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d, 12) / 1000);

// --- inferAccountType --------------------------------------------------------

test('card PRODUCT names with no card-ish word resolve credit (the Venture X shape)', () => {
  for (const name of ['Venture X', 'Quicksilver', 'Freedom Unlimited', 'Sapphire Reserve']) {
    const r = inferAccountType(name, { name: 'Big National Bank' }, null);
    assert.equal(r.type, 'credit', name);
    assert.equal(r.subtype, 'credit card');
  }
});

test('REGRESSION: deposit rules run FIRST — "Platinum Savings" / "Preferred Checking" stay deposits', () => {
  // "platinum" and "preferred" both sit in the card product-name list; the
  // deposit words must claim these accounts before the card rules see them.
  // A reorder silently turns a savings account into a card — and with it,
  // every outflow's spending treatment.
  const savings = inferAccountType('Platinum Savings', { name: 'Big National Bank' }, null);
  assert.deepEqual([savings.type, savings.subtype], ['depository', 'savings']);
  const checking = inferAccountType('Preferred Checking', { name: 'Big National Bank' }, null);
  assert.deepEqual([checking.type, checking.subtype], ['depository', 'checking']);
});

test('a card-only issuer in the org name resolves credit when the name says nothing', () => {
  const r = inferAccountType('MyStore Account', { name: 'Synchrony Bank' }, null);
  assert.equal(r.type, 'credit');
  // …but a full-service bank's name proves nothing: unrecognisable + no
  // balance signal falls through to the uncertain checking default.
  const r2 = inferAccountType('MyStore Account', { name: 'Chase' }, null);
  assert.equal(r2.type, 'depository');
});

test('negative-balance fallback: an unrecognisable account with a negative balance is a card, flagged uncertain', () => {
  const r = inferAccountType('Acct 4471', { name: 'Some CU' }, -523.12);
  assert.equal(r.type, 'credit');
  assert.equal(r.uncertain, true, 'the sync logs uncertain guesses for eyeballing');
});

test('nothing matched → depository/checking, flagged uncertain (visible, so a wrong guess is noticed)', () => {
  const r = inferAccountType('Acct 4471', { name: 'Some CU' }, 100.0);
  assert.deepEqual([r.type, r.subtype], ['depository', 'checking']);
  assert.equal(r.uncertain, true);
  assert.equal(r.inferred, true);
});

test('loans and investments claim themselves ahead of everything', () => {
  assert.equal(inferAccountType('Home Loan 30yr', {}, null).type, 'loan');
  assert.equal(inferAccountType('Roth IRA', {}, null).type, 'investment');
});

// --- normalizeTransaction ----------------------------------------------------

test('string amounts parse (zero-padded included) and the sign flips to positive = money out', () => {
  // SimpleFIN: negative = money OUT of the account; this app: positive = out.
  const t = normalizeTransaction({ id: 'tx1', amount: '-05.50', posted: secs(2026, 7, 15) });
  assert.equal(t.amount, 5.5);
  assert.equal(t.date, '2026-07-15');
  // Money IN (SimpleFIN positive) lands negative.
  const dep = normalizeTransaction({ id: 'tx2', amount: '1200.00', posted: secs(2026, 7, 1) });
  assert.equal(dep.amount, -1200);
});

test('REGRESSION: posted 0 is a pending sentinel — falls through to transacted_at, never 1970', () => {
  const t = normalizeTransaction({
    id: 'tx3',
    amount: '-12.00',
    posted: 0,
    transacted_at: secs(2026, 7, 20),
    pending: true,
  });
  assert.equal(t.date, '2026-07-20');
  assert.equal(t.pending, true);
  // Both missing/zero → the row is unusable, not a 1970 transaction.
  assert.equal(normalizeTransaction({ id: 'tx4', amount: '-12.00', posted: 0 }), null);
});

test('missing id or amount → null (never a half-row)', () => {
  assert.equal(normalizeTransaction({ amount: '-5.00', posted: secs(2026, 7, 1) }), null);
  assert.equal(normalizeTransaction({ id: '  ', amount: '-5.00', posted: secs(2026, 7, 1) }), null);
  assert.equal(normalizeTransaction({ id: 'x', posted: secs(2026, 7, 1) }), null);
  assert.equal(normalizeTransaction({ id: 'x', amount: 'garbage', posted: secs(2026, 7, 1) }), null);
});

test('description falls back payee → memo → "Transaction"', () => {
  const base = { id: 'x', amount: '-5.00', posted: secs(2026, 7, 1) };
  assert.equal(normalizeTransaction({ ...base, description: 'RIVER GROCERY' }).description, 'RIVER GROCERY');
  assert.equal(normalizeTransaction({ ...base, payee: 'RIVER GROCERY' }).description, 'RIVER GROCERY');
  assert.equal(normalizeTransaction({ ...base, memo: 'note' }).description, 'note');
  assert.equal(normalizeTransaction(base).description, 'Transaction');
});

// --- normalizeBalance --------------------------------------------------------

test('debt balances: SimpleFIN negative-when-owed flips to the stored positive convention', () => {
  // Settled against a live Capital One card (2026-07): the feed sent -5127.97
  // for a card with $5,127.97 outstanding.
  assert.equal(normalizeBalance('credit', -5127.97), 5127.97);
  assert.equal(normalizeBalance('loan', -231550.12), 231550.12);
});

test('deposit balances pass through, including a genuine overdraft', () => {
  assert.equal(normalizeBalance('depository', 2500.5), 2500.5);
  assert.equal(normalizeBalance('depository', -50), -50);
});

test('the overpaid-card case stays positive BY DECISION (shown as owed; rare and small)', () => {
  assert.equal(normalizeBalance('credit', 12.34), 12.34);
});

test('a missing balance stays null — absent must never read as zero', () => {
  assert.equal(normalizeBalance('credit', null), null);
  assert.equal(normalizeBalance('depository', null), null);
});

// --- the small parsers -------------------------------------------------------

test('parseMoney (wire strings): zero-padded, formatted, blank and junk', () => {
  assert.equal(parseMoney('-05.50'), -5.5);
  assert.equal(parseMoney('1,234.56'), 1234.56);
  assert.equal(parseMoney('$10.00'), 10);
  assert.equal(parseMoney(''), null, 'blank is null, never 0');
  assert.equal(parseMoney(null), null);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney(42.5), 42.5, 'a real JSON number passes through');
});

test('epochToIsoDate: valid seconds → UTC date; 0 and negatives → null', () => {
  assert.equal(epochToIsoDate(secs(2026, 7, 15)), '2026-07-15');
  assert.equal(epochToIsoDate(0), null);
  assert.equal(epochToIsoDate(-100), null);
  assert.equal(epochToIsoDate('nope'), null);
});

// --- normalizeAccount (the string-amount path end to end) --------------------

test('normalizeAccount parses balances as strings and drops unusable transactions', () => {
  const a = normalizeAccount(
    {
      id: 'acc9',
      name: 'Everyday Checking',
      balance: '-05.50',
      'available-balance': '10.00',
      'balance-date': secs(2026, 7, 15),
      org: { name: 'Some CU', domain: 'somecu.example' },
      transactions: [
        { id: 't1', amount: '-4.50', posted: secs(2026, 7, 10) },
        { id: '', amount: '-4.50', posted: secs(2026, 7, 10) }, // dropped
      ],
    },
    null
  );
  assert.equal(a.balance, -5.5);
  assert.equal(a.availableBalance, 10);
  assert.equal(a.transactions.length, 1);
  assert.equal(a.org.label, 'Some CU');
});
