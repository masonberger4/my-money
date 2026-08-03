// Totals stress suite for the purchase-based spending model (src/spending.js,
// extracted from dataAdapter.js) against a synthetic multi-account household
// (test/helpers/ledger.js) covering every transaction type the app handles.
//
// ONE unified linked-boundary model (Mason, 2026-08-03): structural transfer
// pairing (markInternalTransfers) is part of establishing the row shape, so
// totals tests wash the rows first — exactly what dataAdapter's
// getTransactionsBetween does for every caller. Scenario 8 pins that Trends
// spending and the Categories total are now THE SAME number by construction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isSpend,
  sumSpending,
  spendingGroups,
  biggestMovers,
  toTxShape,
  patchTxShape,
  effectiveCategory,
  aggregateEnvelopeSpending,
} from '../src/spending.js';
import { markInternalTransfers, cashIncome, cashSpending } from '../src/cashFlow.js';
import { TRANSFER_CATEGORY, RETURN_CATEGORY, UNCATEGORIZED } from '../src/categoryMap.js';
import { standardLedger, randomLedger, makeAccounts, makeTx, EXPECTED, lcg } from './helpers/ledger.js';

const CENT = 0.01;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < CENT, `${msg ?? ''} (${a} vs ${b})`);

const byLabel = groups => Object.fromEntries(groups.map(g => [g.label, g]));

// The adapter pipeline's stand-in: every read the totals are built from runs
// the structural pairing before aggregation (getTransactionsBetween).
const washed = rows => {
  markInternalTransfers(rows);
  return rows;
};

// --- Scenario 1: groups, sum and hand-computed total agree -------------------

test('group amounts sum exactly to sumSpending and to the hand-computed total', () => {
  const visible = washed(standardLedger().visibleRows());
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
  const visible = washed(standardLedger().visibleRows());
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

test('washed transfers/card payments never count as spending — and issuer-named PURCHASES are not eaten by the guard', () => {
  // Model change 2026-08-03: the transfer CATEGORY no longer excludes a row —
  // chk5 is out of the totals because its counter-leg sav1 pairs structurally,
  // and chk4 because of the card-payment veto. With both washed there is
  // still no transfer bucket over this fixture.
  const visible = washed(standardLedger().visibleRows());
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
  washed(led.visibleRows());
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

// --- Scenario 8: ONE model — Trends and Categories agree by construction -----
// (Model change 2026-08-03: the old two-model design is gone; these tests
// asserted the models "legitimately disagree" — they now assert the opposite.)

test('unified model: cashSpending IS sumSpending; income is unpaired depository inflows; both transfer pairs wash', () => {
  const visible = washed(standardLedger().visibleRows());
  assert.equal(visible.find(t => t.id === 'chk5')._internal, true, 'transfer out leg washed');
  assert.equal(visible.find(t => t.id === 'sav1')._internal, true, 'transfer in leg washed');
  // REGRESSION (model decision b): the depository→credit card-payment pair
  // washes too — the old depository↔depository gate is gone.
  assert.equal(visible.find(t => t.id === 'chk4')._internal, true, 'card-payment checking leg washed');
  assert.equal(visible.find(t => t.id === 'c1b')._internal, true, 'card-payment credit leg washed');
  near(cashIncome(visible), EXPECTED.cash.income, 'cash income');
  near(cashSpending(visible), EXPECTED.cash.spending, 'cash spending');
  near(cashSpending(visible), sumSpending(visible), 'Trends spending EQUALS the Categories total');
});

test('a savings→checking pair washes both legs — income and spending both unchanged', () => {
  const led = standardLedger();
  led.rows.push(
    makeTx(led.accounts.savings, 'sav3', '2026-07-24', 150.0, 'ONLINE BANKING TRANSFER TO CHECKING'),
    makeTx(led.accounts.checking, 'chk11', '2026-07-26', -150.0, 'ONLINE BANKING TRANSFER FROM SAVINGS')
  );
  const visible = washed(led.visibleRows());
  assert.equal(visible.find(t => t.id === 'sav3')._internal, true);
  assert.equal(visible.find(t => t.id === 'chk11')._internal, true);
  near(cashIncome(visible), EXPECTED.cash.income, 'washing removed the in-leg from income');
  near(cashSpending(visible), EXPECTED.cash.spending, 'washing removed the out-leg from spending');
});

// --- Named REGRESSIONs for the 2026-08-03 linked-boundary decisions ----------

test('REGRESSION (c): a depository payment to a linked LOAN account counts as spending — loans never pair', () => {
  // Mason's decision: mortgage/auto payments COUNT as spending even though the
  // loan is linked. The loan's own credit leg is in the row set, but loan
  // accounts never participate in pairing, so the checking leg stays unpaired.
  const led = standardLedger();
  led.rows.push(
    makeTx(led.accounts.checking, 'chk12', '2026-07-27', 1800.0, 'ACH Withdrawal NEWREZ-SHELLPOINT'),
    makeTx(led.accounts.mortgage, 'loan3', '2026-07-28', -1800.0, 'PAYMENT RECEIVED THANK YOU')
  );
  const visible = washed(led.visibleRows());
  const leg = visible.find(t => t.id === 'chk12');
  assert.ok(!leg._internal, 'the depository leg is NOT washed');
  assert.equal(isSpend(leg), true, 'the loan payment counts as spending');
  assert.equal(isSpend(visible.find(t => t.id === 'loan3')), false, 'the loan ledger row never counts');
  near(sumSpending(visible), EXPECTED.spendTotal + 1800, 'total includes the payment once');
});

test('REGRESSION (d): a transfer to a HIDDEN account counts as spending — hidden is outside the boundary', () => {
  // The hidden card's rows are excluded at the query level (visibleRows), so
  // the out-leg has no counter-leg to pair with and crosses the boundary.
  const led = standardLedger();
  led.rows.push(
    makeTx(led.accounts.checking, 'chk13', '2026-07-29', 250.0, 'ONLINE BANKING TRANSFER TO EXTERNAL'),
    makeTx(led.accounts.hiddenCard, 'hid2', '2026-07-29', -250.0, 'TRANSFER FROM CHECKING')
  );
  const visible = washed(led.visibleRows());
  const leg = visible.find(t => t.id === 'chk13');
  assert.ok(!leg._internal, 'no visible counter-leg — unpaired');
  assert.equal(isSpend(leg), true, 'the boundary-crossing transfer counts');
  near(sumSpending(visible), EXPECTED.spendTotal + 250, 'total includes it once');
});

test('REGRESSION (e): an unpaired card-payment-worded row is still excluded (the live BofA/WF descriptors)', () => {
  // Mason: card payments never count, even when the card is unlinked so
  // pairing cannot wash them. Exact descriptors from the live F2 finding.
  const led = standardLedger();
  led.rows.push(
    makeTx(led.accounts.checking, 'chk14', '2026-07-03', 510.19, 'External Withdrawal - BANK OF AMERICA - PAYMENT'),
    makeTx(led.accounts.checking, 'chk15', '2026-07-04', 412.86, 'External Withdrawal - WELLS FARGO CARD - CCPYMT')
  );
  const visible = washed(led.visibleRows());
  for (const id of ['chk14', 'chk15']) {
    const t = visible.find(x => x.id === id);
    assert.ok(!t._internal, `${id}: unpaired`);
    assert.equal(isSpend(t), false, `${id}: card payment never counts`);
  }
  near(sumSpending(visible), EXPECTED.spendTotal, 'totals unchanged');
});

test('an unpaired transfer-WORDED row DOES count — the category no longer excludes it', () => {
  // The narrowed exclusion: internal is decided by structure; only the
  // card-payment verdict vetoes an unpaired row. This is what fixes the F1
  // $23k double count's Trends side without hiding real boundary-crossing
  // money from the totals.
  const led = standardLedger();
  led.rows.push(
    makeTx(led.accounts.checking, 'chk16', '2026-07-30', 999.0, 'ONLINE BANKING TRANSFER TO SOMEWHERE ELSE')
  );
  const visible = washed(led.visibleRows());
  const t = visible.find(x => x.id === 'chk16');
  assert.equal(t.mapped_category, TRANSFER_CATEGORY, 'fixture sanity: classified as a transfer');
  assert.ok(!t._internal, 'no counter-leg');
  assert.equal(isSpend(t), true, 'it left the boundary — it counts');
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

// --- patchTxShape: the optimistic-patch recompute -----------------------------
// Dashboard's patchAllTxLists applies edits to already-shaped rows; the
// contract is that the result equals reshaping the raw row with the edit
// applied — for everything EXCEPT `counted`, which the shape can't recompute.

test('patchTxShape(shaped, edit) equals a full re-shape of the edited raw row — counted aside', () => {
  const raw = standardLedger().visibleRows().find(t => t.id === 'chk2'); // no user overrides
  const shaped = toTxShape(raw);
  const edits = [
    { user_category: 'Dining out' },          // recategorize
    { user_category: null },                   // reset to automatic
    { user_description: 'Corner market' },     // rename
    { user_description: null },                // reset name
    { excluded: true },                        // exclude toggle
    { entity_id: 'ent-rental' },               // rental tag
    { is_capital: true, useful_life_years: 5 },// multi-field edit
  ];
  for (const fields of edits) {
    const { counted: pc, ...patched } = patchTxShape(shaped, fields);
    const { counted: rc, ...reshaped } = toTxShape({ ...raw, ...fields });
    assert.deepEqual(patched, reshaped, JSON.stringify(fields));
  }
});

test('REGRESSION: patchTxShape leaves `counted` STALE — even when the edit would flip isSpend', () => {
  // Recategorizing into the transfer bucket WOULD flip isSpend, but the shape
  // no longer carries accounts.type, so the pre-edit value deliberately stays
  // (the saveTx Gotcha): its one reader renders from the refetched month list.
  const raw = standardLedger().visibleRows().find(t => t.id === 'chk2');
  const shaped = toTxShape(raw);
  assert.equal(shaped.counted, true, 'fixture sanity: chk2 is counted');
  assert.equal(patchTxShape(shaped, { user_category: TRANSFER_CATEGORY }).counted, true);
  assert.equal(toTxShape({ ...raw, user_category: TRANSFER_CATEGORY }).counted, false, 'a real re-shape WOULD flip it');
});

test('patchTxShape never mutates its input row (rollback depends on the captured original)', () => {
  const raw = standardLedger().visibleRows().find(t => t.id === 'chk2');
  const shaped = toTxShape(raw);
  const frozen = JSON.stringify(shaped);
  patchTxShape(shaped, { user_category: 'Pets', user_description: 'X', excluded: true });
  assert.equal(JSON.stringify(shaped), frozen);
});

// --- Scenario 12: biggest movers (Trends month-over-month deltas) ------------
// The "previous month" fixture is hand-built against EXPECTED.groups (July):
//   Groceries 100 (July 109.5 -> +9.5), Travel 220 (July 220 -> 0, skipped),
//   Utilities 55 (July 120 -> +65), Pets 90 (absent in July -> -90 fall);
// every July-only category rises from 0 (Vehicle +85, Home maint +75, …).

function juneRows() {
  const A = makeAccounts();
  return [
    makeTx(A.checking, 'p1', '2026-06-05', 100.0, 'SAFEWAY 1467 EVERETT WA'), // Groceries
    makeTx(A.card1, 'p2', '2026-06-07', 220.0, 'CAPITAL ONE TRAVEL PORTLAND'), // Travel — identical to July
    makeTx(A.checking, 'p3', '2026-06-10', 55.0, 'PUGET SOUND ENERGY BILL PAY'), // Utilities
    makeTx(A.checking, 'p4', '2026-06-14', 90.0, 'EVERGREEN VET CLINIC', { user_category: 'Pets' }), // only in June
  ];
}

test('biggestMovers ranks rises AND falls by |delta|: a new category rises from 0, a disappeared one falls to 0', () => {
  // Each month's rows are washed per-fetch, exactly as getBiggestMovers'
  // reads deliver them: July's chk5↔sav1 pair goes _internal, so no
  // fabricated transfer bucket outranks the real movers.
  const movers = biggestMovers(washed(standardLedger().visibleRows()), washed(juneRows()));
  assert.deepEqual(
    movers.map(m => m.label),
    ['Pets', 'Vehicle expenses', 'Home maintenance and improvement', 'Utilities', 'Dining out'],
    'top 5 by |delta|, signs interleaved'
  );
  // The disappeared category: present only in June, falls to 0.
  near(movers[0].delta, -90.0, 'Pets fall');
  near(movers[0].prev, 90.0);
  near(movers[0].curr, 0);
  // The new category: present only in July, rises from 0.
  near(movers[1].delta, 85.0, 'Vehicle rise');
  near(movers[1].prev, 0);
  near(movers[1].curr, 85.0);
  // Ordering invariant, independent of the hand-computed list above.
  for (let i = 1; i < movers.length; i++) {
    assert.ok(Math.abs(movers[i - 1].delta) >= Math.abs(movers[i].delta), 'sorted by |delta|');
  }
});

test('biggestMovers skips negligible deltas and honors the limit opt', () => {
  const curr = washed(standardLedger().visibleRows());
  const all = biggestMovers(curr, washed(juneRows()), { limit: 100 });
  // Travel is $220 in BOTH months — a zero delta never earns a slot.
  assert.ok(!all.some(m => m.label === 'Travel and vacation'), 'unchanged category skipped');
  // Everything else moved by >= $1: 9 July categories + Pets − shared(3) = ...
  // Groceries/Utilities changed, Travel didn't: 9 − 1 + 1 = 9 movers.
  assert.equal(all.length, 9);
  assert.equal(biggestMovers(curr, washed(juneRows()), { limit: 3 }).length, 3);
  // A sub-dollar wobble is noise: shrink June Groceries by 50¢ from July's total.
  // limit:100 so the assertion exercises the $1 noise floor itself — at the
  // default top-5, eight larger movers crowd the 50¢ delta out and the check
  // passes even with minDelta loosened to a penny (verified by mutation).
  const A = makeAccounts();
  const wobble = washed([makeTx(A.checking, 'w1', '2026-06-05', 109.0, 'SAFEWAY 1467 EVERETT WA')]);
  assert.ok(
    !biggestMovers(curr, wobble, { limit: 100 }).some(m => m.label === 'Groceries'),
    'a 50¢ delta is skipped even with slots to spare'
  );
});

test('biggestMovers excludes non-spend rows STRUCTURALLY: washed pairs, the card-payment veto, Return, loan rows, excluded rows, money in', () => {
  const A = makeAccounts();
  // Junk that must move NOTHING under the linked-boundary model. The transfer
  // is a complete two-leg pair, so the per-fetch wash marks both _internal —
  // exclusion by structure, not by the transfer CATEGORY (an unpaired leg
  // COUNTS now; pinned below). The autopay leg has no card counter-leg in the
  // junk, so it stays unpaired — the card-payment VETO is what excludes it.
  const junk = month => [
    makeTx(A.checking, `${month}j1`, `2026-${month}-12`, 300.0, 'ONLINE BANKING TRANSFER TO SAVINGS'),
    makeTx(A.savings, `${month}j1b`, `2026-${month}-13`, -300.0, 'ONLINE BANKING TRANSFER FROM CHECKING'),
    makeTx(A.checking, `${month}j2`, `2026-${month}-15`, 400.0, 'CAPITAL ONE AUTOPAY PYMT'),
    makeTx(A.mortgage, `${month}j3`, `2026-${month}-15`, 800.0, 'ESCROW DISBURSEMENT COUNTY TAX'),
    makeTx(A.card1, `${month}j4`, `2026-${month}-20`, -50.0, 'RIVER GEAR RETURNS'), // → Return
    makeTx(A.checking, `${month}j5`, `2026-${month}-21`, 500.0, 'SAFEWAY 1467 EVERETT WA', { excluded: true }),
    makeTx(A.checking, `${month}j6`, `2026-${month}-01`, -2500.0, 'PAYROLL DIRECT DEP'), // money in
  ];
  const base = biggestMovers(washed(standardLedger().visibleRows()), washed(juneRows()), { limit: 100 });
  // Junk in EITHER month moves nothing (the excluded Safeway row alone would
  // otherwise swing Groceries by $500, the loan escrow row its bucket by $800).
  assert.deepEqual(
    biggestMovers(washed(standardLedger().visibleRows()), washed([...juneRows(), ...junk('06')]), { limit: 100 }),
    base
  );
  assert.deepEqual(
    biggestMovers(washed([...standardLedger().visibleRows(), ...junk('07')]), washed(juneRows()), { limit: 100 }),
    base
  );
  // …and the guarded buckets never surface as movers at all.
  const labels = biggestMovers(
    washed([...standardLedger().visibleRows(), ...junk('07')]),
    washed([...juneRows(), ...junk('06')]),
    { limit: 100 }
  ).map(m => m.label);
  assert.ok(!labels.includes(TRANSFER_CATEGORY), 'no transfer bucket');
  assert.ok(!labels.includes(RETURN_CATEGORY), 'no Return bucket');

  // The counterpoint the old category-based test could not express: drop the
  // counter-leg and the SAME transfer-worded row crosses the linked boundary,
  // stays unpaired, and IS a mover — visible under the transfer label, by
  // design (this is what fails if isSpend regresses to category exclusion).
  const unpaired = junk('07').filter(t => t.id !== '07j1b');
  const tb = biggestMovers(
    washed([...standardLedger().visibleRows(), ...unpaired]),
    washed(juneRows()),
    { limit: 100 }
  ).find(m => m.label === TRANSFER_CATEGORY);
  assert.ok(tb, 'an unpaired boundary-crossing transfer IS a mover');
  near(tb.delta, 300.0, 'exactly the unpaired leg, a rise from 0');
  near(tb.prev, 0);
});

test('biggestMovers over empty months', () => {
  assert.deepEqual(biggestMovers([], []), []);
  // One empty side degenerates to that month's groups (largest first, capped
  // at 5): all rises when prev is empty, all falls when curr is. Rows washed
  // per-fetch as the adapter delivers them — unwashed, the chk5 leg would
  // fabricate a $300 transfer "fall" outranking Travel's real $220 one.
  const visible = washed(standardLedger().visibleRows());
  const rises = biggestMovers(visible, []);
  assert.equal(rises.length, 5);
  assert.deepEqual(
    rises.map(m => m.label),
    spendingGroups(visible).slice(0, 5).map(g => g.label),
    'prev empty: top groups, as rises'
  );
  assert.ok(rises.every(m => m.delta > 0 && m.prev === 0));
  const falls = biggestMovers([], visible);
  assert.ok(falls.every(m => m.delta < 0 && m.curr === 0));
  near(falls[0].delta, -EXPECTED.groups['Travel and vacation'].amount, 'largest fall');
});

test('biggestMovers is deterministic: equal |delta| ties break alphabetically', () => {
  const A = makeAccounts();
  const curr = [
    makeTx(A.checking, 't1', '2026-07-05', 40.0, 'SAFEWAY 1467 EVERETT WA'), // Groceries +40
    makeTx(A.checking, 't2', '2026-07-06', 40.0, 'ACME COFFEE 0042'), // Coffee and snacks +40
    makeTx(A.checking, 't3', '2026-07-07', 40.0, 'PUGET SOUND ENERGY BILL PAY'), // Utilities +40
  ];
  assert.deepEqual(
    biggestMovers(curr, []).map(m => m.label),
    ['Coffee and snacks', 'Groceries', 'Utilities']
  );
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
