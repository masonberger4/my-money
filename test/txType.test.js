// The 4-type transaction model (src/txType.js + the derivers in
// src/spending.js): the display-type derivation matrix, the selector's
// sign-gating policy, and — the load-bearing one — the AGREEMENT property
// test, which is what makes "every surface reads one verdict" a red test
// instead of a hope: for every row of a random overridden ledger, the type a
// screen would RENDER (tx_type) must match what the totals DO with the row
// (isSpend / cashIncome).
//
// Also the sync-omit pin for the new column: user_type is user-owned, so the
// feed writers must never name it (the noPlaid/assistantModels source-scan
// precedent).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TX_TYPES,
  TX_TYPE_LABELS,
  deriveTxType,
  effectiveTxType,
  allowedUserTypes,
} from '../src/txType.js';
import { isSpend, toTxShape } from '../src/spending.js';
import { markInternalTransfers, cashIncome } from '../src/cashFlow.js';
import { TRANSFER_CATEGORY } from '../src/categoryMap.js';
import { makeAccounts, makeTx, randomLedger, lcg } from './helpers/ledger.js';

const A = makeAccounts();

// --- the derivation matrix ----------------------------------------------------

test('derivation matrix: the four structural cases + loan', () => {
  // Unpaired positive on a non-loan account = spending.
  assert.equal(deriveTxType(makeTx(A.checking, 'd1', '2026-07-05', 50, 'SAFEWAY 1467')), 'spending');
  // Unpaired positive with card-payment wording = card payment (the veto).
  assert.equal(deriveTxType(makeTx(A.checking, 'd2', '2026-07-05', 400, 'CAPITAL ONE AUTOPAY PYMT')), 'card_payment');
  // The user-category veto derives card payment the same way.
  assert.equal(
    deriveTxType(makeTx(A.checking, 'd3', '2026-07-05', 60, 'SAFEWAY 1467', { user_category: TRANSFER_CATEGORY })),
    'card_payment'
  );
  // Any negative displays Inflow — a depository negative is income…
  assert.equal(deriveTxType(makeTx(A.checking, 'd4', '2026-07-05', -2500, 'PAYROLL DIRECT DEP')), 'inflow');
  // …and a credit negative is Return: never income, but it DISPLAYS as Inflow.
  assert.equal(deriveTxType(makeTx(A.card1, 'd5', '2026-07-05', -25, 'SOME STORE REFUND')), 'inflow');
  // Loan-account rows are the display-only fifth value.
  assert.equal(deriveTxType(makeTx(A.mortgage, 'd6', '2026-07-05', 500, 'SUSPENSE POSTING')), 'loan');
});

test('paired rows: transfer, except a credit-account or payment-worded leg displays card payment', () => {
  // A checking↔savings transfer pair: both legs display Transfer.
  const o1 = makeTx(A.checking, 'p1', '2026-07-10', 300, 'ONLINE BANKING TRANSFER TO SAVINGS');
  const i1 = makeTx(A.savings, 'p2', '2026-07-10', -300, 'ONLINE BANKING TRANSFER FROM CHECKING');
  markInternalTransfers([o1, i1]);
  assert.equal(o1._internal, true, 'fixture: the pair washes');
  assert.equal(deriveTxType(o1), 'transfer');
  assert.equal(deriveTxType(i1), 'transfer');
  // A checking→card payment pair: the checking leg is payment-worded and the
  // card leg sits on a credit account — BOTH display Card payment, not
  // Transfer (the YNAB vocabulary this exists to adopt).
  const o2 = makeTx(A.checking, 'p3', '2026-07-15', 400, 'CAPITAL ONE AUTOPAY PYMT');
  const i2 = makeTx(A.card1, 'p4', '2026-07-16', -400, 'PAYMENT RECEIVED THANK YOU');
  markInternalTransfers([o2, i2]);
  assert.equal(o2._internal, true, 'fixture: the payment pair washes');
  assert.equal(deriveTxType(o2), 'card_payment');
  assert.equal(deriveTxType(i2), 'card_payment');
});

// --- effectiveTxType ----------------------------------------------------------

test('effective type = user_type ?? structural; garbage stored values fall back; loan ignores the override', () => {
  const t = makeTx(A.checking, 'e1', '2026-07-05', 50, 'SAFEWAY 1467');
  assert.equal(effectiveTxType(t), 'spending');
  assert.equal(effectiveTxType({ ...t, user_type: 'transfer' }), 'transfer');
  assert.equal(effectiveTxType({ ...t, user_type: 'garbage' }), 'spending', 'unknown value = automatic');
  // An account retyped to loan after an override was written must not
  // resurrect the override.
  const loan = makeTx(A.mortgage, 'e2', '2026-07-05', 50, 'SUSPENSE POSTING', { user_type: 'spending' });
  assert.equal(effectiveTxType(loan), 'loan');
  assert.ok(!isSpend(loan), 'and the row still never counts');
});

test('every storable type has a label; loan has the display-only fifth', () => {
  for (const ty of TX_TYPES) assert.ok(TX_TYPE_LABELS[ty], `label for ${ty}`);
  assert.ok(TX_TYPE_LABELS.loan);
  assert.equal(TX_TYPES.length, 4, 'exactly four storable types');
  assert.ok(!TX_TYPES.includes('loan'), "'loan' is never storable");
});

// --- allowedUserTypes (the selector policy) ------------------------------------

test('allowedUserTypes mirrors the sign guards: no inert option is ever offered', () => {
  const out = makeTx(A.checking, 'a1', '2026-07-05', 50, 'SAFEWAY 1467');
  const inn = makeTx(A.checking, 'a2', '2026-07-05', -50, 'REFUND');
  assert.deepEqual(allowedUserTypes(out), ['spending', 'transfer', 'card_payment']);
  assert.deepEqual(allowedUserTypes(inn), ['inflow', 'transfer', 'card_payment']);
  assert.deepEqual(allowedUserTypes(makeTx(A.mortgage, 'a3', '2026-07-05', 50, 'X')), [], 'loan rows get no selector');
  // Policy honesty: every offered override actually changes/holds the row's
  // effective type — none is inert under the model.
  for (const t of [out, inn]) {
    for (const ty of allowedUserTypes(t)) {
      const withIt = { ...t, user_type: ty };
      assert.equal(effectiveTxType(withIt), ty, `${ty} takes effect on the ${t.amount > 0 ? 'out' : 'in'} row`);
    }
  }
});

// --- THE agreement property test ----------------------------------------------

test('AGREEMENT: over a random overridden ledger, tx_type and the totals never disagree', () => {
  for (const seed of [20260815, 424242, 7]) {
    const led = randomLedger(seed, { n: 300 });
    // Sprinkle overrides the way a household would: deterministically by the
    // same seeded LCG, ~1 row in 7, only values the selector would offer.
    const rand = lcg(seed ^ 0x5eed);
    const randInt = k => Math.floor(rand() * k);
    for (const t of led.rows) {
      if (randInt(7) !== 0) continue;
      const offered = allowedUserTypes(t);
      if (offered.length) t.user_type = offered[randInt(offered.length)];
    }
    const rows = led.visibleRows();
    markInternalTransfers(rows);

    // Per-row agreement: what a list renders (tx_type) vs what totals do.
    const incomeRows = new Set();
    for (const t of rows) {
      if (t.excluded || t._internal) continue;
      if (t.accounts?.type === 'depository' && t.amount < 0 && (!t.user_type || t.user_type === 'inflow')) {
        incomeRows.add(t);
      }
    }
    const income = cashIncome(rows);
    let incomeSum = 0;
    for (const t of incomeRows) incomeSum += Math.abs(t.amount);
    assert.ok(Math.abs(income - incomeSum) < 0.01, `seed ${seed}: income decomposition`);

    for (const t of rows) {
      const shaped = toTxShape(t);
      const ty = shaped.tx_type;
      assert.equal(ty, effectiveTxType(t), `seed ${seed}: shape carries the effective type`);
      if (t.excluded) continue; // excluded wins over everything — no type claim
      if (ty === 'spending') {
        assert.ok(isSpend(t) === (t.amount > 0), `seed ${seed}: a rendered Spending row counts iff money-out`);
      } else {
        assert.ok(!isSpend(t), `seed ${seed}: a non-Spending row never counts as spending (${ty})`);
      }
      if (ty === 'transfer' || ty === 'card_payment' || ty === 'loan') {
        assert.ok(!incomeRows.has(t), `seed ${seed}: a ${ty} row is never income`);
      }
      if (ty === 'inflow' && t.accounts?.type === 'depository' && !t._internal) {
        assert.ok(incomeRows.has(t), `seed ${seed}: a depository Inflow row IS income`);
      }
    }
  }
});

// --- sync-omit source pins ------------------------------------------------------

test('no feed writer names user_type (user-owned — it must survive re-pulls)', () => {
  const sync = readFileSync(new URL('../api/sync.js', import.meta.url), 'utf8');
  assert.ok(!sync.includes('user_type'), 'api/sync.js must not write user_type');
  const csv = readFileSync(new URL('../src/csvImport.js', import.meta.url), 'utf8');
  assert.ok(!csv.includes('user_type'), 'csvImport.js must not write user_type');
});
