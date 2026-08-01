// Tests for the pure debt-payoff model (src/debtPayoff.js).
//
// Amortization constants are hand-computed (cents-rounded monthly accrual, the
// same arithmetic the module does), in the style of test/envelopes.test.js:
// the numbers in the assertions are the spec, not echoes of the code.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_MONTHS,
  debtMonthlyRate,
  isMortgage,
  orderDebts,
  amortizeOne,
  simulatePayoff,
  payoffWhatIf,
  addMonths,
  debtFreeMonth,
} from '../src/debtPayoff.js';

const debt = (over = {}) => ({
  id: over.id ?? 'd1',
  name: over.name ?? 'Card',
  type: over.type ?? 'credit',
  subtype: over.subtype ?? null,
  current_balance: 0,
  apr: null,
  interest_rate: null,
  minimum_payment: 0,
  ...over,
});

// --- rate normalization ------------------------------------------------------

test('debtMonthlyRate = (apr ?? interest_rate) / 100 / 12, percent stored', () => {
  assert.equal(debtMonthlyRate({ apr: 12 }), 0.01);
  assert.equal(debtMonthlyRate({ apr: null, interest_rate: 6 }), 0.005);
  // apr wins when both are present (the ?? in the spec).
  assert.equal(debtMonthlyRate({ apr: 24, interest_rate: 6 }), 0.02);
  // absent / junk / negative all read as 0, never NaN.
  assert.equal(debtMonthlyRate({}), 0);
  assert.equal(debtMonthlyRate({ apr: 'n/a' }), 0);
  assert.equal(debtMonthlyRate({ apr: -3 }), 0);
});

// --- single-debt amortization: hand-computed ---------------------------------

test('hand-computed: $1000 at 12% APR, $100/mo -> 11 months, $58.98 interest', () => {
  // 1% monthly. Balance walk (interest rounded to cents each month):
  // 1000.00 +10.00 -100 = 910.00
  //  910.00 + 9.10 -100 = 819.10
  //  819.10 + 8.19 -100 = 727.29
  //  727.29 + 7.27 -100 = 634.56
  //  634.56 + 6.35 -100 = 540.91
  //  540.91 + 5.41 -100 = 446.32
  //  446.32 + 4.46 -100 = 350.78
  //  350.78 + 3.51 -100 = 254.29
  //  254.29 + 2.54 -100 = 156.83
  //  156.83 + 1.57 -100 =  58.40
  //   58.40 + 0.58 -100 =  cleared (month 11)
  // interest total = 58.98
  const r = amortizeOne({ balance: 1000, ratePercent: 12, payment: 100 });
  assert.deepEqual(r, { months: 11, totalInterest: 58.98, stalled: false });
});

test('zero APR is a linear payoff with zero interest', () => {
  const r = amortizeOne({ balance: 1000, ratePercent: 0, payment: 100 });
  assert.deepEqual(r, { months: 10, totalInterest: 0, stalled: false });
});

test('zero balance costs nothing and takes no time', () => {
  assert.deepEqual(amortizeOne({ balance: 0, ratePercent: 24, payment: 50 }), {
    months: 0,
    totalInterest: 0,
    stalled: false,
  });
});

test('payment at or below monthly interest stalls immediately, never loops', () => {
  // $1000 at 12% accrues $10/mo; a $10 payment can never reduce the balance.
  const r = amortizeOne({ balance: 1000, ratePercent: 12, payment: 10 });
  assert.equal(r.stalled, true);
  assert.equal(r.months, 0, 'bails before burning MAX_MONTHS iterations');
  // Zero payment is the same verdict.
  assert.equal(amortizeOne({ balance: 1000, ratePercent: 0, payment: 0 }).stalled, true);
});

test('the month cap is a guard, not a date: a 600+ month payoff flags stalled', () => {
  // $100k at 0% paying $1/mo would take 100000 months.
  const r = amortizeOne({ balance: 100000, ratePercent: 0, payment: 1 });
  assert.equal(r.months, MAX_MONTHS);
  assert.equal(r.stalled, true);
});

// --- strategy ordering -------------------------------------------------------

const small6 = () => debt({ id: 'small', current_balance: 500, apr: 6, minimum_payment: 25 });
const big24 = () => debt({ id: 'big', current_balance: 2000, apr: 24, minimum_payment: 50 });

test('snowball orders smallest balance first, avalanche highest APR first', () => {
  assert.deepEqual(orderDebts([big24(), small6()], 'snowball').map(d => d.id), ['small', 'big']);
  assert.deepEqual(orderDebts([small6(), big24()], 'avalanche').map(d => d.id), ['big', 'small']);
});

test('avalanche never pays more total interest than snowball', () => {
  const debts = [small6(), big24()];
  const snow = simulatePayoff(debts, { strategy: 'snowball', extraMonthly: 100 });
  const aval = simulatePayoff(debts, { strategy: 'avalanche', extraMonthly: 100 });
  assert.equal(snow.stalled, false);
  assert.equal(aval.stalled, false);
  assert.ok(
    aval.totalInterest <= snow.totalInterest,
    `avalanche ${aval.totalInterest} should be <= snowball ${snow.totalInterest}`
  );
});

test('simulatePayoff hand-computed: one 0% debt is balance / budget months', () => {
  const r = simulatePayoff([debt({ current_balance: 100, minimum_payment: 50 })]);
  assert.equal(r.months, 2);
  assert.equal(r.totalInterest, 0);
  assert.equal(r.stalled, false);
  assert.deepEqual(r.perDebt, [{ id: 'd1', name: 'Card', months: 2, interest: 0 }]);
});

test('a cleared debt frees its minimum onto the next debt (snowball mechanic)', () => {
  // Two 0% debts, $100 and $300, mins $50 each -> budget $100/mo.
  // m1: A 100->50, B 300->250 (both minimums, no leftover).
  // m2: A's min clears it; the freed $50 rolls to B: 250->200.
  // m3, m4: B gets the whole $100 budget: 200 -> 100 -> 0 at month 4.
  const r = simulatePayoff([
    debt({ id: 'A', current_balance: 100, minimum_payment: 50 }),
    debt({ id: 'B', current_balance: 300, minimum_payment: 50 }),
  ]);
  assert.equal(r.months, 4);
  assert.deepEqual(r.perDebt.map(d => [d.id, d.months]), [['A', 2], ['B', 4]]);
});

test('a budget that cannot beat total interest stalls the simulation', () => {
  const r = simulatePayoff([debt({ current_balance: 1000, apr: 12, minimum_payment: 5 })]);
  assert.equal(r.stalled, true);
  assert.ok(r.months < MAX_MONTHS, 'bails early, not at the cap');
});

test('empty and zero-balance inputs are a clean no-op', () => {
  assert.deepEqual(simulatePayoff([]), { months: 0, totalInterest: 0, stalled: false, perDebt: [] });
  assert.equal(simulatePayoff([debt({ current_balance: 0, minimum_payment: 50 })]).months, 0);
});

// --- extra-payment what-if ---------------------------------------------------

test('interest saved is monotone in the extra payment, months never grow', () => {
  const debts = [small6(), big24()];
  const at = extra => payoffWhatIf(debts, { strategy: 'avalanche', extraMonthly: extra });
  const [e0, e50, e100, e200] = [at(0), at(50), at(100), at(200)];
  assert.equal(e0.interestSaved, 0, 'no extra saves nothing vs itself');
  assert.ok(e50.interestSaved > 0);
  assert.ok(e100.interestSaved >= e50.interestSaved);
  assert.ok(e200.interestSaved >= e100.interestSaved);
  assert.ok(e50.months <= e0.months && e100.months <= e50.months && e200.months <= e100.months);
  // The saving is exactly baseline minus plan.
  assert.equal(e100.interestSaved, +(e100.baselineInterest - e100.totalInterest).toFixed(2));
});

test('a stalled baseline yields no savings claim rather than a nonsense one', () => {
  // Minimums alone stall; the extra payment rescues it.
  const d = [debt({ current_balance: 1000, apr: 12, minimum_payment: 5 })];
  const r = payoffWhatIf(d, { extraMonthly: 100 });
  assert.equal(r.baselineStalled, true);
  assert.equal(r.stalled, false);
  assert.equal(r.interestSaved, 0);
  assert.equal(r.monthsSaved, 0);
});

// --- dates + mortgage exclusion ----------------------------------------------

test('addMonths / debtFreeMonth do plain month math incl. the year wrap', () => {
  assert.equal(addMonths('2026-08', 11), '2027-07');
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-08', 0), '2026-08');
  assert.equal(debtFreeMonth('2026-08', { months: 11, stalled: false }), '2027-07');
  assert.equal(debtFreeMonth('2026-08', { months: 0, stalled: false }), null);
  assert.equal(debtFreeMonth('2026-08', { months: 40, stalled: true }), null, 'no honest date when stalled');
});

test('isMortgage matches loan subtype or name, never a credit card', () => {
  assert.equal(isMortgage(debt({ type: 'loan', subtype: 'mortgage' })), true);
  assert.equal(isMortgage(debt({ type: 'loan', name: 'NewRez Mortgage' })), true);
  assert.equal(isMortgage(debt({ type: 'loan', name: 'Student loan' })), false);
  assert.equal(isMortgage(debt({ type: 'credit', name: 'Mortgage Rewards Card' })), false);
});
