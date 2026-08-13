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
  amortizationSchedule,
  simulatePayoff,
  payoffWhatIf,
  addMonths,
  debtFreeMonth, payoffProgress } from '../src/debtPayoff.js';

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

// --- amortizationSchedule (the per-debt drill-in's rows) ---------------------

test('amortizationSchedule: linear payoff, zero rate — hand-computed', () => {
  const s = amortizationSchedule({ balance: 1000, ratePercent: 0, payment: 100 });
  assert.equal(s.stalled, false);
  assert.equal(s.months, 10);
  assert.equal(s.totalInterest, 0);
  assert.equal(s.rows.length, 10);
  assert.deepEqual(s.rows[0], { month: 1, payment: 100, interest: 0, principal: 100, balance: 900 });
  assert.deepEqual(s.rows[9], { month: 10, payment: 100, interest: 0, principal: 100, balance: 0 });
});

test('amortizationSchedule: 12% APR, $1200 @ $200/mo — hand-computed rows', () => {
  // r = 0.01/mo. m1: i=12.00, bal 1012.00; m2: i=10.12, bal 822.12;
  // m3: i=8.22, bal 630.34; m4: i=6.30, bal 436.64; m5: i=4.37, bal 241.01;
  // m6: i=2.41, bal 43.42; m7: i=0.43, final payment capped at 43.85, bal 0.
  const s = amortizationSchedule({ balance: 1200, ratePercent: 12, payment: 200 });
  assert.equal(s.stalled, false);
  assert.equal(s.months, 7);
  assert.equal(s.totalInterest, 43.85);
  assert.deepEqual(s.rows[0], { month: 1, payment: 200, interest: 12, principal: 188, balance: 1012 });
  assert.deepEqual(s.rows[5], { month: 6, payment: 200, interest: 2.41, principal: 197.59, balance: 43.42 });
  // Final payment is capped at balance + interest — never an overpay row.
  assert.deepEqual(s.rows[6], { month: 7, payment: 43.85, interest: 0.43, principal: 43.42, balance: 0 });
});

test('amortizationSchedule conserves the starting balance and its own totals', () => {
  const s = amortizationSchedule({ balance: 1200, ratePercent: 12, payment: 200 });
  const round2 = x => Math.round(x * 100) / 100;
  assert.equal(round2(s.rows.reduce((a, r) => a + r.principal, 0)), 1200);
  assert.equal(round2(s.rows.reduce((a, r) => a + r.interest, 0)), s.totalInterest);
  for (const r of s.rows) assert.equal(round2(r.interest + r.principal), r.payment);
});

test('amortizationSchedule months/interest agree with amortizeOne', () => {
  for (const c of [
    { balance: 1200, ratePercent: 12, payment: 200 },
    { balance: 5127.97, ratePercent: 24.99, payment: 150 },
    { balance: 1000, ratePercent: 0, payment: 100 },
    { balance: 333.33, ratePercent: 18, payment: 40 },
  ]) {
    const one = amortizeOne(c);
    const s = amortizationSchedule(c);
    assert.equal(s.months, one.months, JSON.stringify(c));
    assert.equal(s.totalInterest, one.totalInterest, JSON.stringify(c));
    assert.equal(s.stalled, one.stalled, JSON.stringify(c));
  }
});

test('amortizationSchedule: stall states are honest, never a fake schedule', () => {
  // Payment doesn't beat month-1 interest ($1000 @ 24% -> $20/mo interest).
  const stall = amortizationSchedule({ balance: 1000, ratePercent: 24, payment: 20 });
  assert.equal(stall.stalled, true);
  assert.equal(stall.rows.length, 0);
  assert.equal(stall.totalInterest, 0);
  // Zero / absent payment stalls immediately; zero balance is a clean no-op.
  assert.equal(amortizationSchedule({ balance: 500, payment: 0 }).stalled, true);
  assert.deepEqual(amortizationSchedule({ balance: 0, payment: 50 }),
    { rows: [], months: 0, totalInterest: 0, stalled: false });
  // MAX_MONTHS runaway cap: still owing after 600 months flags stalled with
  // the rows it DID compute (the view renders them plus the honest banner).
  const cap = amortizationSchedule({ balance: 100000, ratePercent: 0, payment: 1 });
  assert.equal(cap.stalled, true);
  assert.equal(cap.rows.length, MAX_MONTHS);
  assert.equal(cap.rows[MAX_MONTHS - 1].balance, 100000 - MAX_MONTHS);
});

// --- payoffProgress: how far a loan has come -------------------------------
// `original_balance` shipped with the debt migration and had no editor and no
// renderer. The fraction is only shown when it is a FACT — every shape that
// would make it a claim returns null and renders nothing.
test('payoffProgress: plain fraction paid, on the stored positive convention', () => {
  assert.equal(payoffProgress(9000, 6500).toFixed(2), '27.78');
  assert.equal(payoffProgress(10000, 2500), 75);
  assert.equal(payoffProgress(9000, 9000), 0);
  assert.equal(payoffProgress(9000, 0), 100);
});

test('payoffProgress: null wherever the number would be a claim, not a fact', () => {
  assert.equal(payoffProgress(null, 5000), null, 'no starting balance recorded');
  assert.equal(payoffProgress(undefined, 5000), null);
  assert.equal(payoffProgress(0, 0), null, 'nothing to be a fraction of');
  assert.equal(payoffProgress(-100, 50), null);
  assert.equal(payoffProgress(9000, null), null, 'no current balance');
  // A balance ABOVE the original is a real state (an extra draw on a
  // HELOC-shaped loan, or a starting figure typed too low). Hiding the bar is
  // the honest answer; negative progress would not be.
  assert.equal(payoffProgress(9000, 9500), null);
  assert.equal(payoffProgress('abc', 100), null);
});

test('payoffProgress: an overpaid loan clamps at 100 rather than exceeding it', () => {
  assert.equal(payoffProgress(9000, -250), 100);
});
