// Debt payoff math. Pure module, zero imports (like recurring.js): operates on
// plain debt objects shaped like `accounts` rows ({ id, name, type, subtype,
// current_balance, apr, interest_rate, minimum_payment }), touches no network.
//
// Sign convention: balances arrive STORED-positive (positive = owed) — the
// same convention accounts.current_balance keeps for credit/loan — and every
// dollar figure returned here is a plain positive amount. Only presentation
// flips signs (displayBalance); this module never does.
//
// Rates are PERCENT (24.99, not 0.2499). The normalized annual rate is
// `apr ?? interest_rate`, divided by 100 and by 12 for monthly math — the one
// normalization the spec pins down.
//
// Edge cases handled, never infinite-looped:
//   * zero/absent APR      → linear payoff.
//   * payment <= monthly interest → the balance can never fall; flagged
//     `stalled: true` immediately instead of grinding to the month cap.
//   * zero balance         → 0 months, 0 interest.
//   * MAX_MONTHS (600 = 50 years) is a runaway guard on the loop; tripping it
//     also flags `stalled` rather than quietly returning a wrong date.

// Runaway guard, not a planning horizon.
export const MAX_MONTHS = 600;

const round2 = x => Math.round(x * 100) / 100;

// Normalized MONTHLY rate from a debt row: (apr ?? interest_rate) / 100 / 12.
// Absent, non-numeric or negative rates read as 0 (a manual loan with no rate
// typed in yet still amortizes linearly rather than crashing the view).
export function debtMonthlyRate(debt) {
  const pct = debt?.apr ?? debt?.interest_rate;
  const n = Number(pct);
  return Number.isFinite(n) && n > 0 ? n / 100 / 12 : 0;
}

// Mortgages dominate a snowball/avalanche and make "debt-free date"
// meaningless — the Debt view excludes them from the payoff projection by
// default (still listed as debts). Matched on subtype or name.
export function isMortgage(debt) {
  if (!debt || debt.type !== 'loan') return false;
  return /mortgage/i.test(String(debt.subtype || '')) || /mortgage/i.test(String(debt.name || ''));
}

// Priority order: snowball = smallest balance first; avalanche = highest rate
// first. Ties break toward the other strategy's key so ordering is total and
// deterministic. Never mutates the input.
export function orderDebts(debts, strategy = 'snowball') {
  const bal = d => Number(d.current_balance) || 0;
  const arr = [...debts];
  if (strategy === 'avalanche') {
    arr.sort((a, b) => debtMonthlyRate(b) - debtMonthlyRate(a) || bal(a) - bal(b));
  } else {
    arr.sort((a, b) => bal(a) - bal(b) || debtMonthlyRate(b) - debtMonthlyRate(a));
  }
  return arr;
}

// Single-debt amortization: fixed payment against balance at ratePercent APR.
// Interest accrues monthly on the running balance, rounded to cents. Returns
// { months, totalInterest, stalled }.
export function amortizeOne({ balance, ratePercent = 0, payment }) {
  let bal = round2(Number(balance) || 0);
  const pct = Number(ratePercent);
  const r = Number.isFinite(pct) && pct > 0 ? pct / 100 / 12 : 0;
  const pay = Number(payment) || 0;
  if (bal <= 0) return { months: 0, totalInterest: 0, stalled: false };
  if (pay <= 0) return { months: 0, totalInterest: 0, stalled: true };

  let months = 0;
  let interest = 0;
  while (bal > 0 && months < MAX_MONTHS) {
    const i = round2(bal * r);
    // Payment doesn't beat this month's interest: the balance can never fall.
    // Bail now — waiting for the month cap would just burn 600 iterations to
    // learn the same thing.
    if (pay <= i) return { months, totalInterest: round2(interest), stalled: true };
    interest = round2(interest + i);
    bal = round2(bal + i - pay);
    months++;
  }
  return { months, totalInterest: round2(interest), stalled: bal > 0 };
}

// Month-by-month schedule for ONE debt at a fixed payment — amortizeOne's
// exact math, kept row by row for the drill-in view. Same guards: immediate
// stall when the payment doesn't beat the month's interest (rows stop there),
// MAX_MONTHS runaway cap flags `stalled` with the rows it did compute. The
// one presentational difference: the FINAL payment is capped at balance +
// interest (nobody overpays the last month), so sum(principal) conserves the
// starting balance exactly while months/totalInterest stay identical to
// amortizeOne (the cap only fires in the month the loop ends anyway).
// Returns { rows: [{ month, payment, interest, principal, balance }],
//           months, totalInterest, stalled } — month is 1-based, balance is
// the remaining stored-positive owed after that month's payment.
export function amortizationSchedule({ balance, ratePercent = 0, payment }) {
  let bal = round2(Number(balance) || 0);
  const pct = Number(ratePercent);
  const r = Number.isFinite(pct) && pct > 0 ? pct / 100 / 12 : 0;
  const pay = Number(payment) || 0;
  const rows = [];
  if (bal <= 0) return { rows, months: 0, totalInterest: 0, stalled: false };
  if (pay <= 0) return { rows, months: 0, totalInterest: 0, stalled: true };
  let totalInterest = 0;
  while (bal > 0 && rows.length < MAX_MONTHS) {
    const i = round2(bal * r);
    if (pay <= i) return { rows, months: rows.length, totalInterest, stalled: true };
    const p = Math.min(pay, round2(bal + i));
    totalInterest = round2(totalInterest + i);
    bal = round2(bal + i - p);
    rows.push({ month: rows.length + 1, payment: p, interest: i, principal: round2(p - i), balance: bal });
  }
  return { rows, months: rows.length, totalInterest, stalled: bal > 0 };
}

// Multi-debt payoff simulation. Each month: interest accrues on every open
// debt; every debt gets its minimum; the leftover budget (extraMonthly plus
// every already-cleared debt's freed minimum — the "snowball" mechanic, which
// both strategies use) goes to the highest-priority open debt. The monthly
// budget is fixed at sum(minimums) + extraMonthly for the whole run.
//
// Returns { months, totalInterest, stalled, perDebt } where perDebt carries
// each debt's { id, name, months, interest } in priority order (months = the
// month number it was cleared, 0-based-from-start + 1; null if never).
export function simulatePayoff(debts, { strategy = 'snowball', extraMonthly = 0 } = {}) {
  const open = orderDebts(
    (debts || []).filter(d => (Number(d.current_balance) || 0) > 0),
    strategy
  ).map(d => ({
    id: d.id ?? null,
    name: d.name ?? '',
    balance: round2(Number(d.current_balance)),
    rate: debtMonthlyRate(d),
    min: Math.max(0, Number(d.minimum_payment) || 0),
    interest: 0,
    months: null,
  }));

  const result = () => ({
    months: 0,
    totalInterest: 0,
    stalled: false,
    perDebt: open.map(d => ({ id: d.id, name: d.name, months: d.months, interest: d.interest })),
  });

  if (!open.length) return result();

  const budget = round2(open.reduce((s, d) => s + d.min, 0) + Math.max(0, Number(extraMonthly) || 0));
  if (budget <= 0) return { ...result(), stalled: true };

  let months = 0;
  let totalInterest = 0;
  let remaining = open.slice();
  let stalled = false;

  while (remaining.length && months < MAX_MONTHS) {
    // Accrue interest.
    let monthInterest = 0;
    for (const d of remaining) {
      const i = round2(d.balance * d.rate);
      d.balance = round2(d.balance + i);
      d.interest = round2(d.interest + i);
      monthInterest = round2(monthInterest + i);
    }
    // The whole budget doesn't beat this month's interest: balances can never
    // fall from here (they only shrink over time, so interest only grows).
    if (budget <= monthInterest) {
      stalled = true;
      totalInterest = round2(totalInterest + monthInterest);
      break;
    }
    totalInterest = round2(totalInterest + monthInterest);

    // Minimums first (capped at what's left of the debt and of the budget)...
    let pool = budget;
    for (const d of remaining) {
      const p = round2(Math.min(d.min, d.balance, pool));
      d.balance = round2(d.balance - p);
      pool = round2(pool - p);
    }
    // ...then everything left rolls onto the highest-priority open debt(s).
    for (const d of remaining) {
      if (pool <= 0) break;
      const p = round2(Math.min(pool, d.balance));
      d.balance = round2(d.balance - p);
      pool = round2(pool - p);
    }

    months++;
    for (const d of remaining) if (d.balance <= 0) d.months = months;
    remaining = remaining.filter(d => d.balance > 0);
  }

  if (remaining.length && !stalled) stalled = true; // month cap tripped

  return {
    months,
    totalInterest: round2(totalInterest),
    stalled,
    perDebt: open.map(d => ({ id: d.id, name: d.name, months: d.months, interest: d.interest })),
  };
}

// The what-if the Debt view renders: the plan with extraMonthly, compared to
// the minimums-only baseline under the SAME strategy. interestSaved /
// monthsSaved are vs that baseline (0 when either run stalls — a stalled run
// has no meaningful total to subtract).
export function payoffWhatIf(debts, { strategy = 'snowball', extraMonthly = 0 } = {}) {
  const plan = simulatePayoff(debts, { strategy, extraMonthly });
  const baseline = simulatePayoff(debts, { strategy, extraMonthly: 0 });
  const comparable = !plan.stalled && !baseline.stalled;
  return {
    ...plan,
    baselineMonths: baseline.months,
    baselineInterest: baseline.totalInterest,
    baselineStalled: baseline.stalled,
    interestSaved: comparable ? round2(Math.max(0, baseline.totalInterest - plan.totalInterest)) : 0,
    monthsSaved: comparable ? Math.max(0, baseline.months - plan.months) : 0,
  };
}

// 'YYYY-MM' + n months → 'YYYY-MM'. String math, not new Date(string), so it
// can't pick up timezone off-by-one surprises (same reasoning as recurring.js).
export function addMonths(isoMonth, n) {
  const [y, m] = String(isoMonth).split('-').map(Number);
  const total = y * 12 + (m - 1) + Math.max(0, Math.trunc(n) || 0);
  const yy = Math.floor(total / 12);
  const mm = (total % 12) + 1;
  return `${yy}-${String(mm).padStart(2, '0')}`;
}

// Debt-free month for a plan started in startMonth ('YYYY-MM'): the month the
// last balance clears, or null when the plan stalled (no honest date exists —
// the visible-unknown rule, not a far-future guess).
export function debtFreeMonth(startMonth, plan) {
  if (!plan || plan.stalled || !plan.months) return null;
  return addMonths(startMonth, plan.months);
}
