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
  txTypeLabel,
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
  // A DEPOSITORY negative is income, and displays Inflow.
  assert.equal(deriveTxType(makeTx(A.checking, 'd4', '2026-07-05', -2500, 'PAYROLL DIRECT DEP')), 'inflow');
  // A CREDIT negative splits (2026-08-17, refund netting — this case used to
  // derive 'inflow' for both halves, back when every credit negative was a
  // 'Return' that counted in nothing). A refund NETS, so it must derive
  // 'spending' or the rendered type would contradict the total it moves…
  const refund = makeTx(A.card1, 'd5', '2026-07-05', -25, 'SOME STORE REFUND');
  assert.equal(deriveTxType(refund), 'spending');
  assert.equal(isSpend(refund), true, 'and it really does count');
  // …while it LABELS as Refund, so nothing prints "Spending" on money coming
  // back. Display-only, like 'loan' — TX_TYPES stays four values.
  assert.equal(txTypeLabel(deriveTxType(refund), refund.amount), 'Refund');
  assert.equal(txTypeLabel('spending', 50), 'Spending');
  // A payment RECEIVED on the card is the other half, and the card-side veto
  // is what separates them — note it carries no issuer name, which is exactly
  // why isCardPaymentDescriptor cannot do this job.
  const payment = makeTx(A.card1, 'd5b', '2026-07-05', -2148.33, 'PAYMENT THANK YOU');
  assert.equal(deriveTxType(payment), 'card_payment');
  assert.equal(isSpend(payment), false, 'a payment never nets');
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

test('allowedUserTypes mirrors the model: no inert option is ever offered', () => {
  const out = makeTx(A.checking, 'a1', '2026-07-05', 50, 'SAFEWAY 1467');
  const inn = makeTx(A.checking, 'a2', '2026-07-05', -50, 'REFUND');
  assert.deepEqual(allowedUserTypes(out), ['spending', 'transfer', 'card_payment']);
  // Money-in rows are offered 'spending' too since 2026-08-17b (Mason): on a
  // DEPOSITORY row it is the only way a debit-card refund can ever net,
  // because nothing structural separates one from a paycheck. It is no longer
  // inert, so withholding it would hide a real verdict rather than protect one.
  assert.deepEqual(allowedUserTypes(inn), ['spending', 'inflow', 'transfer', 'card_payment']);
  assert.equal(isSpend({ ...inn, user_type: 'spending' }), true, "…and it really nets");
  assert.equal(isSpend(inn), false, 'while the default for a depository inflow is still income');
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
      // THE invariant, restated for refund netting (2026-08-17): a rendered
      // Spending row counts as spending, full stop. It used to read
      // `isSpend(t) === (t.amount > 0)` — correct only while spending was
      // money-out by definition. Now a credit-card refund is a Spending row
      // with a NEGATIVE amount (labelled "Refund"), so tying the guarantee to
      // the sign would forbid the very thing Mason asked for while still
      // sounding like an agreement check.
      if (ty === 'spending') {
        assert.ok(isSpend(t), `seed ${seed}: a rendered Spending row counts as spending`);
      } else {
        assert.ok(!isSpend(t), `seed ${seed}: a non-Spending row never counts as spending (${ty})`);
      }
      // …and the direction stays legible, which is what keeps the relaxed
      // assertion above from hiding a paycheck being subtracted from spending.
      // A counted money-IN row is EITHER a card refund (automatic, credit only)
      // OR a row a human explicitly typed 'spending' — the debit-refund verdict
      // (2026-08-17b). It is never both counted and income, and it never
      // renders the word "Spending".
      if (ty === 'spending' && t.amount < 0) {
        assert.ok(t.accounts?.type === 'credit' || t.user_type === 'spending',
          `seed ${seed}: a money-in row counts only as a card refund or by explicit verdict`);
        assert.ok(!incomeRows.has(t), `seed ${seed}: a netting refund is never also income`);
        assert.equal(txTypeLabel(ty, t.amount), 'Refund', `seed ${seed}: it renders as Refund`);
      }
      // The paycheck guard, stated positively: with NO override, a depository
      // inflow is income and never spending, whatever its wording.
      if (t.accounts?.type === 'depository' && t.amount < 0 && !t.user_type && !t._internal) {
        assert.ok(!isSpend(t), `seed ${seed}: an un-overridden depository inflow is never spending`);
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

test('the sheet never trusts a never-paired row shape (openTx + the _unpairedShape gate)', () => {
  // The verified 2026-08-16 sweep finding: rows from the account sheet and
  // search results never run markInternalTransfers, so deriveTxType calls a
  // genuinely-washed transfer leg 'spending'. Display-only until the sheet
  // WRITES from tx_type — then "confirming" Transfer on such a row stores a
  // real override (the null-equals-automatic comparison keys on the
  // mis-derived auto_tx_type), drops the leg from the pairing pool,
  // un-washes its partner, and counts the transfer as income. The fix has
  // two halves, both pinned here by source scan (the teachQueue precedent):
  // every row-open goes through openTx (which resolves against the paired
  // month list and tags the rest _unpairedShape), and the type UI withholds
  // itself for _unpairedShape rows.
  const dash = readFileSync(new URL('../src/components/Dashboard.jsx', import.meta.url), 'utf8');
  assert.ok(dash.includes('const openTx=t=>{'), 'openTx helper exists');
  assert.ok(/transactions\?\.transactions\?\.find\(x=>x\.id===t\.id\)/.test(dash),
    'openTx resolves against the paired month list');
  assert.ok(dash.includes('_unpairedShape:true'), 'unresolved rows are tagged');
  assert.ok(dash.includes('selTx._unpairedShape?null:'), 'the sheet withholds the type UI for unpaired shapes');
  const opens = (dash.match(/openTx\(t\)/g) || []).length;
  assert.ok(opens >= 5, `every row-open site routes through openTx (found ${opens}, expected >= 5)`);
  assert.ok(!/className="tx" onClick=\{\(\)=>setSelTx\(t\)\}/.test(dash),
    'no list row bypasses openTx straight into setSelTx');
});

test('no feed writer names user_type (user-owned — it must survive re-pulls)', () => {
  const sync = readFileSync(new URL('../api/sync.js', import.meta.url), 'utf8');
  assert.ok(!sync.includes('user_type'), 'api/sync.js must not write user_type');
  const csv = readFileSync(new URL('../src/csvImport.js', import.meta.url), 'utf8');
  assert.ok(!csv.includes('user_type'), 'csvImport.js must not write user_type');
});
