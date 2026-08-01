// Totals stress suite for the purchase-based spending model (src/spending.js,
// extracted from dataAdapter.js) against a synthetic multi-account household
// (test/helpers/ledger.js) covering every transaction type the app handles.
//
// The two spending models — purchase-based here, joint-budget cash-flow in
// src/cashFlow.js — legitimately disagree. Scenario 8 asserts each against its
// OWN constants; nothing here asserts they match.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isSpend,
  sumSpending,
  spendingGroups,
  toTxShape,
  effectiveCategory,
  aggregateEnvelopeSpending,
} from '../src/spending.js';
import { markInternalTransfers, cashIncome, cashSpending } from '../src/cashFlow.js';
import { TRANSFER_CATEGORY, RETURN_CATEGORY, UNCATEGORIZED } from '../src/categoryMap.js';
import { standardLedger, randomLedger, makeAccounts, makeTx, EXPECTED, lcg } from './helpers/ledger.js';

const CENT = 0.01;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < CENT, `${msg ?? ''} (${a} vs ${b})`);

const byLabel = groups => Object.fromEntries(groups.map(g => [g.label, g]));

// --- Scenario 1: groups, sum and hand-computed total agree -------------------

test('group amounts sum exactly to sumSpending and to the hand-computed total', () => {
  const visible = standardLedger().visibleRows();
  const groups = spendingGroups(visible);
  const groupSum = groups.reduce((s, g) => s + g.amount, 0);
  near(groupSum, sumSpending(visible), 'groups vs sumSpending');
  near(groupSum, EXPECTED.spendTotal, 'groups vs hand-computed');

  const got = byLabel(groups);
  assert.deepEqual(Object.keys(got).sort(), Object.keys(EXPECTED.groups).sort());
  for (const [label, exp] of Object.entries(EXPECTED.groups)) {
    near(got[label].amount, exp.amount, label);
    assert.equal(got[label].transaction_count, exp.count, `${label} count`);
  }
  // Largest-first ordering and percent_of_total.
  for (let i = 1; i < groups.length; i++) assert.ok(groups[i - 1].amount >= groups[i].amount);
  near(groups.reduce((s, g) => s + g.percent_of_total, 0), 100, 'percents sum to 100');
});

// --- Scenario 2: the loan-account guard --------------------------------------

test('a loan account contributes NOTHING to purchase-based spending', () => {
  const visible = standardLedger().visibleRows();
  const noLoan = visible.filter(t => t.accounts.type !== 'loan');
  assert.ok(noLoan.length < visible.length, 'fixture sanity: loan rows exist and one is a positive debit');
  assert.deepEqual(spendingGroups(visible), spendingGroups(noLoan));
  assert.equal(sumSpending(visible), sumSpending(noLoan));
});

// --- Scenario 3: the counted contract (CategorySheet) ------------------------

test('the sum of counted:true rows in a category equals that category’s group amount', () => {
  const visible = standardLedger().visibleRows();
  const groups = byLabel(spendingGroups(visible));
  const shaped = visible.map(toTxShape);
  for (const [label, g] of Object.entries(groups)) {
    const listSum = shaped
      .filter(s => s.counted && s.category === label)
      .reduce((s, x) => s + x.amount, 0);
    near(listSum, g.amount, `counted-list sum for ${label}`);
  }
  // …and no counted row falls outside the groups.
  const countedSum = shaped.filter(s => s.counted).reduce((s, x) => s + x.amount, 0);
  near(countedSum, EXPECTED.spendTotal, 'all counted rows are in some group');
});

// --- Scenario 4: the shared-predicate guarantee (envelope fold) --------------

test('aggregateEnvelopeSpending equals getSpending’s buckets over the same rows', () => {
  const visible = standardLedger().visibleRows();
  const groups = byLabel(spendingGroups(visible));
  const spending = aggregateEnvelopeSpending(visible).filter(s => s.month === EXPECTED.month);
  assert.deepEqual(
    spending.map(s => s.category).sort(),
    Object.keys(groups).sort()
  );
  for (const s of spending) {
    // Within a cent: the walk rounds per month while bucket sums do not.
    near(s.spent, groups[s.category].amount, `envelope Spent for ${s.category}`);
  }
});

// --- Scenario 5: Return counts in NEITHER spending nor income ----------------

test('Return rows count in neither spending nor income', () => {
  const led = standardLedger();
  const visible = led.visibleRows();
  // Fixture non-vacuity: the credit-card refund actually derived 'Return'
  // through the read layer's applyAccountRules.
  const refund = visible.find(t => t.id === 'c1c');
  assert.equal(refund.mapped_category, RETURN_CATEGORY);

  assert.equal(byLabel(spendingGroups(visible))[RETURN_CATEGORY], undefined, 'no Return spending bucket');
  // Not income either: cash income is identical with the Return rows removed.
  const noReturns = visible.filter(t => effectiveCategory(t) !== RETURN_CATEGORY);
  assert.equal(cashIncome(visible), cashIncome(noReturns));
});

// --- Scenario 6: transfer/card-payment guards through the aggregation --------

test('transfers/card payments never count as spending — and issuer-named PURCHASES are not eaten by the guard', () => {
  const visible = standardLedger().visibleRows();
  const groups = byLabel(spendingGroups(visible));
  assert.equal(groups[TRANSFER_CATEGORY], undefined, 'no transfer bucket');

  const shaped = Object.fromEntries(visible.map(t => [t.id, toTxShape(t)]));
  // The two real purchases whose descriptors carry an issuer name: counted,
  // in their true categories (the txClassify guards, seen through totals).
  assert.equal(shaped.c1a.counted, true);
  assert.equal(shaped.c1a.category, 'Travel and vacation');
  assert.equal(shaped.c2a.counted, true);
  assert.equal(shaped.c2a.category, 'Vehicle expenses');
  // The actual card-payment leg from checking is NOT counted.
  assert.equal(shaped.chk4.counted, false);
  assert.equal(shaped.chk4.category, TRANSFER_CATEGORY);
});

// --- Scenario 7: exclude toggle + recategorization ---------------------------

test('toggling excluded moves the total by exactly that row’s amount', () => {
  const led = standardLedger();
  const before = sumSpending(led.visibleRows());
  const row = led.rows.find(t => t.id === 'chk2');
  row.excluded = true;
  near(sumSpending(led.visibleRows()), before - 85.5, 'excluding chk2');
  row.excluded = false;
  near(sumSpending(led.visibleRows()), before, 'un-excluding restores');
});

test('a user_category change moves money between buckets and conserves the grand total', () => {
  const led = standardLedger();
  const row = led.rows.find(t => t.id === 'chk2'); // Groceries 85.50
  row.user_category = 'Dining out';
  const groups = byLabel(spendingGroups(led.visibleRows()));
  near(groups.Groceries.amount, EXPECTED.groups.Groceries.amount - 85.5, 'Groceries loses the row');
  near(groups['Dining out'].amount, EXPECTED.groups['Dining out'].amount + 85.5, 'Dining out gains it');
  near(
    spendingGroups(led.visibleRows()).reduce((s, g) => s + g.amount, 0),
    EXPECTED.spendTotal,
    'grand total conserved'
  );
});

// --- Scenario 8: the cash-flow model, against its OWN constants --------------

test('cash-flow constants: the checking↔savings pair washes; the card payment is cash spending but not purchase spending', () => {
  const visible = standardLedger().visibleRows();
  markInternalTransfers(visible);
  assert.equal(visible.find(t => t.id === 'chk5')._internal, true, 'transfer out leg washed');
  assert.equal(visible.find(t => t.id === 'sav1')._internal, true, 'transfer in leg washed');
  near(cashIncome(visible), EXPECTED.cash.income, 'cash income');
  near(cashSpending(visible), EXPECTED.cash.spending, 'cash spending');
  // The card payment (chk4, $400) IS inside cash spending but NOT in purchase
  // spending — the two models legitimately disagree; assert each against its
  // own number, never against each other.
  near(EXPECTED.cash.spending - sumSpending(visible), 852.5 - 764.0, 'models differ by design');
});

test('a second, savings→checking pair reduces income only — savings outflows were never spending', () => {
  const led = standardLedger();
  led.rows.push(
    makeTx(led.accounts.savings, 'sav3', '2026-07-24', 150.0, 'ONLINE BANKING TRANSFER TO CHECKING'),
    makeTx(led.accounts.checking, 'chk11', '2026-07-26', -150.0, 'ONLINE BANKING TRANSFER FROM SAVINGS')
  );
  const visible = led.visibleRows();
  // Unwashed, the extra pair would inflate income by its in-leg (and the
  // still-unwashed chk5/sav1 pair shows up in both).
  near(cashIncome(visible), EXPECTED.cash.income + 300 + 150, 'pre-wash income');
  near(cashSpending(visible), EXPECTED.cash.spending + 300, 'pre-wash spending: the savings out-leg never appears');

  markInternalTransfers(visible);
  assert.equal(visible.find(t => t.id === 'sav3')._internal, true);
  assert.equal(visible.find(t => t.id === 'chk11')._internal, true);
  near(cashIncome(visible), EXPECTED.cash.income, 'washing removed the in-leg from income');
  near(cashSpending(visible), EXPECTED.cash.spending, 'spending never contained the savings out-leg');
});

// --- Scenario 9: Uncategorized is counted and visible ------------------------

test('Uncategorized rows count as spending and appear as a visible bucket', () => {
  const groups = byLabel(spendingGroups(standardLedger().visibleRows()));
  assert.ok(groups[UNCATEGORIZED], 'the unknown is visible');
  near(groups[UNCATEGORIZED].amount, 33.0);
});

// --- Scenario 10: entities are a lens, not an exclusion ----------------------

test('an entity-tagged rental expense still counts in every household total', () => {
  const visible = standardLedger().visibleRows();
  const rentalRow = visible.find(t => t.id === 'chk10');
  assert.equal(rentalRow.entity_id, 'ent-rental', 'fixture sanity');
  assert.equal(isSpend(rentalRow), true);
  near(byLabel(spendingGroups(visible))['Home maintenance and improvement'].amount, 75.0);
  // …and in the cash-flow model too (checking outflow).
  const washed = [...visible];
  markInternalTransfers(washed);
  const without = washed.filter(t => t.id !== 'chk10');
  near(cashSpending(washed) - cashSpending(without), 75.0, 'cash spending includes the rental row');
});

// --- Scenario 11: the accounts-join contract ---------------------------------

test('a row with accounts.type loan yields counted:false and contributes to no bucket', () => {
  const A = makeAccounts();
  const row = makeTx(A.mortgage, 'x1', '2026-07-02', 50.0, 'SAFEWAY 1467 EVERETT WA');
  assert.equal(row.mapped_category, 'Groceries', 'the category is not what excludes it');
  assert.equal(toTxShape(row).counted, false);
  assert.deepEqual(spendingGroups([row]), []);
});

test('REGRESSION: a row MISSING the accounts join is treated as non-loan (counted when it otherwise qualifies)', () => {
  // The silent failure behind dataAdapter's "Every caller of toTxShape selects
  // accounts.type" comment: without the join, isLoanAccount cannot see the
  // type and the row counts. This pins the failure MODE so a read that stops
  // selecting the join shows up as a totals change in review, not silently.
  const A = makeAccounts();
  const row = makeTx(A.mortgage, 'x2', '2026-07-02', 50.0, 'SAFEWAY 1467 EVERETT WA');
  delete row.accounts;
  assert.equal(toTxShape(row).counted, true);
  near(sumSpending([row]), 50.0);
});

test('source scan: the three reads that feed toTxShape select the accounts type', () => {
  // Scoped deliberately: getExistingTxIds, getFeedCoverageStart,
  // getAccountTransactionsInRange and the rule-history candidate scan
  // legitimately select no accounts join — do not widen this to every
  // .from('transactions') call.
  const src = readFileSync(new URL('../src/dataAdapter.js', import.meta.url), 'utf8');
  const innerJoins = src.match(/accounts!inner\(hidden, type, subtype/g) || [];
  assert.ok(
    innerJoins.length >= 2,
    'getTransactionsBetween and searchTransactions must join accounts(hidden, type, …)'
  );
  assert.ok(src.includes('accounts(type)'), 'getAccountTransactions must select accounts(type)');
});

// --- Property tests (seeded PRNG over random ledgers) ------------------------

function shuffle(arr, rand) {
  const a = [...arr];
  for (let k = a.length - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1));
    [a[k], a[j]] = [a[j], a[k]];
  }
  return a;
}

test('property: shuffling input order preserves the bucket SET (keyed by label, sums within a cent)', () => {
  for (const seed of [11, 12, 13]) {
    const rows = randomLedger(seed).visibleRows();
    const base = byLabel(spendingGroups(rows));
    const perm = byLabel(spendingGroups(shuffle(rows, lcg(seed * 7 + 1))));
    assert.deepEqual(Object.keys(perm).sort(), Object.keys(base).sort(), `seed ${seed}: label sets`);
    for (const label of Object.keys(base)) {
      near(perm[label].amount, base[label].amount, `seed ${seed}: ${label}`);
      assert.equal(perm[label].transaction_count, base[label].transaction_count);
    }
  }
});

test('property: splitting a counted row into two same-category halves preserves every bucket total', () => {
  const rand = lcg(20260714);
  for (const seed of [21, 22]) {
    const rows = randomLedger(seed).visibleRows();
    const base = byLabel(spendingGroups(rows));
    const counted = rows.filter(t => isSpend(t) && t.amount >= 0.02);
    const mutated = [...rows];
    for (let k = 0; k < 20 && counted.length; k++) {
      const t = counted[Math.floor(rand() * counted.length)];
      const idx = mutated.indexOf(t);
      if (idx < 0) continue; // already split in an earlier iteration
      const a1 = Math.max(0.01, Math.min(t.amount - 0.01, Math.round(t.amount * rand() * 100) / 100));
      const a2 = Math.round((t.amount - a1) * 100) / 100;
      mutated.splice(idx, 1, { ...t, id: `${t.id}:a`, amount: a1 }, { ...t, id: `${t.id}:b`, amount: a2 });
    }
    const split = byLabel(spendingGroups(mutated));
    assert.deepEqual(Object.keys(split).sort(), Object.keys(base).sort());
    for (const label of Object.keys(base)) near(split[label].amount, base[label].amount, `seed ${seed}: ${label}`);
  }
});

test('property: toggling excluded moves the total by exactly the row’s prior contribution', () => {
  const rand = lcg(20260715);
  for (const seed of [31, 32]) {
    const rows = randomLedger(seed).visibleRows();
    for (let k = 0; k < 30; k++) {
      const t = rows[Math.floor(rand() * rows.length)];
      const before = sumSpending(rows);
      const contributionBefore = isSpend(t) ? t.amount : 0;
      t.excluded = !t.excluded;
      const contributionAfter = isSpend(t) ? t.amount : 0;
      near(sumSpending(rows) - before, contributionAfter - contributionBefore, `seed ${seed} trial ${k}`);
    }
  }
});

test('property: retyping a row’s account to loan removes exactly its prior contribution', () => {
  const rand = lcg(20260716);
  for (const seed of [41, 42]) {
    const rows = randomLedger(seed).visibleRows();
    for (let k = 0; k < 30; k++) {
      const t = rows[Math.floor(rand() * rows.length)];
      const before = sumSpending(rows);
      const prior = isSpend(t) ? t.amount : 0;
      const savedType = t.accounts.type;
      t.accounts.type = 'loan';
      near(before - sumSpending(rows), prior, `seed ${seed} trial ${k}`);
      t.accounts.type = savedType;
    }
  }
});
