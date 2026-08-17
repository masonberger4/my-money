// Tests for the pure cash-flow model (src/cashFlow.js).
//
// CLAUDE.md records that markInternalTransfers' pairing was "verified maximum
// against brute force" — this file makes that verification runnable: random
// small instances are washed through markInternalTransfers (maxMatchTransfers
// is not exported; the public entry point exercises it) and the number of
// washed pairs is compared against an exhaustive brute-force maximum matching.
import test from 'node:test';
import assert from 'node:assert/strict';
import { markInternalTransfers, cashSpending, cashIncome, isIncome } from '../src/cashFlow.js';

const WINDOW = 4; // must mirror INTERNAL_MATCH_WINDOW_DAYS (not exported)

const iso = dayOffset => new Date(Date.UTC(2026, 2, 1 + dayOffset)).toISOString().slice(0, 10);
const day = isoStr => {
  const [y, m, d] = isoStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};

const CHK = { type: 'depository', subtype: 'checking' };
const SAV = { type: 'depository', subtype: 'savings' };
const CC = { type: 'credit', subtype: 'credit card' };

let seq = 0;
function out(amount, dayOffset, account_id = 'acc-chk', accounts = CHK) {
  return { plaid_tx_id: `o${seq++}`, account_id, accounts, date: iso(dayOffset), amount, raw_category: 'TRANSFER_OUT' };
}
function inn(amount, dayOffset, account_id = 'acc-sav', accounts = SAV) {
  return { plaid_tx_id: `i${seq++}`, account_id, accounts, date: iso(dayOffset), amount: -amount, raw_category: 'TRANSFER_IN' };
}

// --- markInternalTransfers semantics ----------------------------------------

test('equal-amount depository OUT/IN pair on different accounts within the window washes both legs', () => {
  const o = out(500, 0);
  const i = inn(500, 3);
  markInternalTransfers([o, i]);
  assert.equal(o._internal, true);
  assert.equal(i._internal, true);
});

test('REGRESSION (b, model decision 2026-08-03): a depository→credit pair IS washed — a card payment is internal', () => {
  // Inverted from the old two-model design, where the checking leg had to stay
  // countable as the cash-flow proxy for card purchases. Under the unified
  // linked-boundary model the purchases themselves count and the payment is
  // never spending, so the pair washes.
  const o = out(500, 0); // checking leg of a card payment
  const i = inn(500, 1, 'acc-cc', CC); // credit-card side
  markInternalTransfers([o, i]);
  assert.equal(o._internal, true);
  assert.equal(i._internal, true);
});

test('REGRESSION (a, the F1 case): a cross-bank depository ACH pair with NO transfer wording washes', () => {
  // The $23k/quarter double count: SimpleFIN stamps raw_category only on
  // intra-bank transfers, so cross-bank legs arrived blank and the old
  // raw_category gate never paired them. Detection is structural now.
  const o = { plaid_tx_id: 'f1o', account_id: 'acc-discover', accounts: CHK, date: iso(0), amount: 6000, raw_category: '', description: 'ACH Withdrawal Boeing Employees Credit Union' };
  const i = { plaid_tx_id: 'f1i', account_id: 'acc-becu', accounts: CHK, date: iso(2), amount: -6000, raw_category: '', description: 'External Deposit - Discover (CONA) DC FINOUT' };
  markInternalTransfers([o, i]);
  assert.equal(o._internal, true);
  assert.equal(i._internal, true);
  assert.equal(cashIncome([o, i]), 0, 'the in-leg is not income');
});

test('a LOAN account never participates in pairing — the depository leg of a loan payment stays unpaired', () => {
  const o = out(1800, 0); // checking leg of a mortgage payment
  const i = { plaid_tx_id: 'ln1', account_id: 'acc-loan', accounts: { type: 'loan', subtype: null }, date: iso(1), amount: -1800, raw_category: '' };
  markInternalTransfers([o, i]);
  assert.ok(!o._internal);
  assert.ok(!i._internal);
});

test('legs outside the window, or on the same account, do not pair', () => {
  const farOut = out(75, 0);
  const farIn = inn(75, WINDOW + 1);
  const sameOut = out(30, 10, 'acc-chk');
  const sameIn = inn(30, 10, 'acc-chk', CHK);
  markInternalTransfers([farOut, farIn, sameOut, sameIn]);
  for (const t of [farOut, farIn, sameOut, sameIn]) assert.ok(!t._internal);
});

test('straddle case: maximum matching washes all four legs where greedy nearest-partner strands a pair', () => {
  // From the maxMatchTransfers comment: outs on the 4th and 9th, ins on the 1st
  // and 6th. Greedy gives the day-4 out the nearer day-6 in (2 days), leaving
  // the day-9 out only the day-1 in, 8 days away — one real transfer stays
  // counted. The maximum matching pairs 4↔1 and 9↔6 (both 3 days).
  const o1 = out(200, 3); // the 4th
  const o2 = out(200, 8); // the 9th
  const i1 = inn(200, 0); // the 1st
  const i2 = inn(200, 5); // the 6th
  markInternalTransfers([i1, o1, i2, o2]);
  for (const t of [o1, o2, i1, i2]) assert.equal(t._internal, true);
});

// --- maxMatchTransfers ≡ brute-force maximum matching -----------------------

// Tiny seeded LCG so failures are reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// Exhaustive maximum matching over the same eligibility rules the real code
// applies: equal amount, different account, |date gap| ≤ window, neither
// leg on a loan account (loans never pair — model decision 2026-08-03), and
// neither leg carrying a user_type override (an explicit verdict never
// pairs — the 4-type override, 2026-08-15).
// Fine at n ≤ 8.
function bruteMax(outs, ins) {
  const eligible = t => t.accounts?.type !== 'loan' && !t.user_type;
  const adj = outs.map(o =>
    ins
      .map((r, j) => j)
      .filter(j => {
        const r = ins[j];
        if (!eligible(o) || !eligible(r)) return false;
        if (o.amount.toFixed(2) !== (-r.amount).toFixed(2)) return false;
        if (r.account_id === o.account_id) return false;
        return Math.abs(day(r.date) - day(o.date)) <= WINDOW;
      })
  );
  const usedIn = new Array(ins.length).fill(false);
  const rec = i => {
    if (i === outs.length) return 0;
    let best = rec(i + 1); // leave this out unmatched
    for (const j of adj[i]) {
      if (usedIn[j]) continue;
      usedIn[j] = true;
      best = Math.max(best, 1 + rec(i + 1));
      usedIn[j] = false;
    }
    return best;
  };
  return rec(0);
}

test('REGRESSION (g): random MIXED-account-type instances — washed-pair count equals brute-force maximum matching', () => {
  const rand = lcg(20260726);
  const randInt = n => Math.floor(rand() * n);
  const amounts = [5, 5, 12.5, 80];
  // Mixed types on purpose: depository, credit and loan accounts all appear,
  // pinning that pairing spans every type combination EXCEPT loan.
  const LOAN = { type: 'loan', subtype: null };
  const accountPool = [
    ['acc-a', CHK],
    ['acc-b', SAV],
    ['acc-c', CC],
    ['acc-d', LOAN],
  ];
  for (let trial = 0; trial < 200; trial++) {
    seq = 0;
    const outs = [];
    const ins = [];
    const nOuts = randInt(9);
    const nIns = randInt(9);
    // ~1 row in 6 carries a user_type override, so the parity check also
    // covers the pool gate: an overridden leg must neither pair nor stop its
    // would-be partner from pairing with someone else.
    const OVERRIDES = ['spending', 'inflow', 'transfer', 'card_payment'];
    const maybeType = t => {
      if (randInt(6) === 0) t.user_type = OVERRIDES[randInt(OVERRIDES.length)];
      return t;
    };
    for (let i = 0; i < nOuts; i++) {
      const [id, acct] = accountPool[randInt(accountPool.length)];
      outs.push(maybeType(out(amounts[randInt(amounts.length)], randInt(13), id, acct)));
    }
    for (let j = 0; j < nIns; j++) {
      const [id, acct] = accountPool[randInt(accountPool.length)];
      ins.push(maybeType(inn(amounts[randInt(amounts.length)], randInt(13), id, acct)));
    }
    const rows = [...outs, ...ins];
    for (let k = rows.length - 1; k > 0; k--) {
      const j = randInt(k + 1);
      [rows[k], rows[j]] = [rows[j], rows[k]];
    }
    markInternalTransfers(rows);
    const matchedOuts = outs.filter(t => t._internal).length;
    const matchedIns = ins.filter(t => t._internal).length;
    assert.equal(matchedOuts, matchedIns, `trial ${trial}: unbalanced washing`);
    assert.equal(matchedOuts, bruteMax(outs, ins), `trial ${trial}: not a maximum matching`);
  }
});

// --- cashSpending / cashIncome ----------------------------------------------

test('unified model: cashSpending counts ALL unpaired non-loan outflows (incl. savings + card purchases); cashIncome counts unpaired depository inflows', () => {
  // Model change 2026-08-03: cashSpending delegates to the shared sumSpending.
  // Savings outflows and credit purchases now count (they used to be excluded
  // by the checking-only rule); _internal and excluded rows still skip both,
  // and loan rows never count.
  const rows = [
    { accounts: CHK, amount: 50 }, // checking outflow → spending
    { accounts: { type: 'depository', subtype: null }, amount: 10 }, // lenient subtype → spending
    { accounts: SAV, amount: 200 }, // savings outflow → spending now (unpaired = crossed the boundary)
    { accounts: CC, amount: 30 }, // credit PURCHASE → spending now (one model)
    { accounts: { type: 'loan', subtype: null }, amount: 500 }, // loan ledger row → never spending
    { accounts: CHK, amount: -1000 }, // checking inflow → income
    { accounts: SAV, amount: -250 }, // savings inflow → income
    { accounts: CC, amount: -25, description: 'REI CO-OP' }, // credit REFUND → nets against spending (2026-08-17), never income
    { accounts: CHK, amount: 75, _internal: true }, // washed transfer legs skip both
    { accounts: SAV, amount: -75, _internal: true },
    { accounts: CHK, amount: 40, excluded: true }, // user-excluded skips both
    { accounts: CHK, amount: -40, excluded: true },
  ];
  // 290 of money out, MINUS the 25 refund — refund netting (Mason,
  // 2026-08-17): money back on a card subtracts from the category it carries.
  // Income is untouched at 1250: a credit negative was never income and still
  // isn't, so exactly one number moved.
  assert.equal(cashSpending(rows), 265);
  assert.equal(cashIncome(rows), 1250);
});

test('a card PAYMENT received never nets, paired or not — the two independent guards', () => {
  // The disaster case refund netting had to be built around: money in on a
  // card is either a refund (nets) or a payment the household sent (must not).
  // A four-figure payment subtracting itself from a category would be silent
  // and would also manufacture that much phantom envelope Available.
  const paired = [out(2148.33, 0), { ...inn(2148.33, 1, 'acc-card1', CC), description: 'PAYMENT THANK YOU' }];
  markInternalTransfers(paired);
  assert.ok(paired[1]._internal, 'guard 1: the linked payment washes structurally');
  assert.equal(cashSpending(paired), 0);

  // Guard 2 — the card side stands alone when the paying account is unlinked,
  // which is exactly where the pairing cannot help. These are Mason's real
  // statement wordings, and NONE of them carries an issuer name, which is why
  // isCardPaymentDescriptor misses every one (see isCardPaymentReceived).
  for (const d of ['PAYMENT THANK YOU', 'PAYMENT RECEIVED', 'ELECTRONIC PAYMENT',
                   'AUTOPAY PAYMENT THANK YOU', 'CASHBACK BONUS REDEMPTION', 'BALANCE TRANSFER']) {
    const row = { accounts: CC, amount: -2148.33, description: d };
    assert.equal(cashSpending([row]), 0, `unpaired "${d}" must not net`);
  }
  // …while a genuine refund on the same card does net.
  assert.equal(cashSpending([{ accounts: CC, amount: -35, description: 'RIVER GEAR RETURNS' }]), -35);
});

// --- the 4-type override (transactions.user_type, 2026-08-15) ----------------

test('an overridden leg leaves the pairing pool and its former partner re-derives structurally', () => {
  // The false-wash fix: an accidental equal-amount coincidence washed a
  // paycheck against an unrelated outflow. Marking the outflow 'spending'
  // pulls it from the pool; the paycheck is unpaired again and counts as
  // income with NO second edit.
  const o = out(2200, 0);
  const i = inn(2200, 2); // the paycheck leg
  markInternalTransfers([o, i]);
  assert.equal(o._internal, true, 'fixture: the coincidence pairs before the override');
  const o2 = { ...out(2200, 0), user_type: 'spending' };
  const i2 = inn(2200, 2);
  markInternalTransfers([o2, i2]);
  assert.ok(!o2._internal, 'an explicit verdict never pairs');
  assert.ok(!i2._internal, 'the former partner is unpaired again');
  assert.equal(cashIncome([o2, i2]), 2200, 'the paycheck counts as income again');
  assert.equal(cashSpending([o2, i2]), 2200, 'the overridden outflow counts as spending');
});

test("user_type 'transfer' lands a row in neither total, paired or not", () => {
  // A missed wash (legs 6 days apart — outside the window): mark both legs.
  const o = { ...out(300, 0), user_type: 'transfer' };
  const i = { ...inn(300, WINDOW + 2), user_type: 'transfer' };
  markInternalTransfers([o, i]);
  assert.ok(!o._internal && !i._internal, 'overridden rows never pair');
  assert.equal(cashSpending([o, i]), 0);
  assert.equal(cashIncome([o, i]), 0);
});

test("cashIncome: any non-'inflow' override vetoes income; 'inflow' on credit stays non-income (Return)", () => {
  const rows = [
    { accounts: CHK, amount: -500, user_type: 'transfer' }, // vetoed
    { accounts: CHK, amount: -400, user_type: 'card_payment' }, // vetoed
    { accounts: CHK, amount: -300, user_type: 'inflow' }, // counts
    { accounts: CHK, amount: -200 }, // structural income, still counts
    { accounts: CC, amount: -100, user_type: 'inflow' }, // credit: NEVER income
  ];
  assert.equal(cashIncome(rows), 500);
});

test("the sign guard on money-OUT is unchanged; 'spending' on money-IN now nets (the refund verdict)", () => {
  // 'inflow' on a money-out row stays inert in both directions — it is not
  // income (money out never is) and isSpend returns false for a non-'spending'
  // override, so the row leaves both totals rather than corrupting one.
  const out80 = { accounts: CHK, amount: 80, user_type: 'inflow' };
  assert.equal(cashIncome([out80]), 0, "money-out 'inflow' never counts as income");
  assert.equal(cashSpending([out80]), 0);

  // REVERSED 2026-08-17b (Mason): 'spending' on a DEPOSITORY money-in row used
  // to be inert, guarded on the reasoning that honoring it "would ADD a
  // negative to sumSpending". Netting is now the point — it is how a
  // debit-card refund is filed, and the only way, since nothing structural
  // tells one from a paycheck. It leaves income by the same act.
  const debitRefund = { accounts: CHK, amount: -90, user_type: 'spending' };
  assert.equal(cashSpending([debitRefund]), -90, 'the refund nets');
  assert.equal(cashIncome([debitRefund]), 0, 'and is not income');
  // The default is untouched: an un-overridden depository inflow is income and
  // never spending. This is the line that protects every paycheck.
  const paycheck = { accounts: CHK, amount: -2200, description: 'PAYROLL DIRECT DEP' };
  assert.equal(cashIncome([paycheck]), 2200);
  assert.equal(cashSpending([paycheck]), 0);
});

// --- isIncome: the ONE income predicate --------------------------------------
// Extracted from cashIncome's fold (2026-08-16) so the Reflect hub's income
// drill-in can LIST the rows behind the number instead of re-deriving the rule
// in the UI. The pin that matters is the DELEGATION: whatever the fold counts,
// the predicate admits, and vice versa — the two can never answer differently,
// which is what makes the drill-in's total the chart's number by construction
// (the isSpend/sumSpending contract, and toTxShape's `counted`, on the income
// side).

test('isIncome is exactly what cashIncome sums — same rows, same answer', () => {
  const rows = [
    { accounts: CHK, amount: -1000 }, // checking inflow → income
    { accounts: SAV, amount: -250 }, // savings inflow → income
    { accounts: { type: 'depository', subtype: null }, amount: -15 }, // lenient subtype
    { accounts: CC, amount: -25 }, // credit refund → nets against spending, never income
    { accounts: { type: 'loan', subtype: null }, amount: -500 }, // loan row → never income
    { accounts: CHK, amount: 50 }, // money out → not income
    { accounts: CHK, amount: 0 }, // a zero row is neither
    { accounts: CHK, amount: -75, _internal: true }, // washed transfer leg
    { accounts: CHK, amount: -40, excluded: true }, // hand-excluded
    { accounts: CHK, amount: -500, user_type: 'transfer' }, // override vetoes
    { accounts: CHK, amount: -300, user_type: 'inflow' }, // override forces
    { accounts: CC, amount: -100, user_type: 'inflow' }, // credit stays out
    { amount: -60 }, // no accounts join at all → not depository, not income
  ];
  const admitted = rows.filter(isIncome);
  assert.deepEqual(
    admitted.map(r => r.amount),
    [-1000, -250, -15, -300],
    'exactly the four unpaired, un-vetoed depository inflows'
  );
  // The delegation invariant, stated both ways.
  assert.equal(cashIncome(rows), 1565);
  assert.equal(
    admitted.reduce((s, r) => s + Math.abs(r.amount), 0),
    cashIncome(rows),
    'summing the admitted rows reproduces the fold — a drill-in listing them cannot disagree with the bar'
  );
  assert.equal(cashIncome(rows.filter(r => !isIncome(r))), 0, 'nothing the predicate rejects contributes');
});

test('isIncome over a real pairing: the washed leg drops out, the paycheck stays', () => {
  // The structural half, end to end — pairing first, predicate after, which is
  // the order every consumer runs (getTransactionsBetween marks, then folds).
  const transferOut = out(300, 0);
  const transferIn = inn(300, 1); // pairs with the above → both _internal
  const paycheck = inn(2200, 2); // no partner → income
  const rows = [transferOut, transferIn, paycheck];
  markInternalTransfers(rows);
  assert.deepEqual(rows.filter(isIncome), [paycheck]);
  assert.equal(cashIncome(rows), 2200);
});
