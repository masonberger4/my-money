// The tax lens over already-categorized transactions: Schedule E line totals
// for a rental entity, the personal deduction buckets, and the IRS
// standard-mileage valuation. Pure and zero-import (the cashFlow.js /
// recurring.js pattern) so test/taxReport.test.js covers it under plain
// `node --test`, and so nothing here can touch React or Supabase.
//
// Everything in this file is RECORD-KEEPING for the preparer, not tax advice:
// it produces "one number per IRS line, with the rows behind it". Judgment
// calls (capital vs repair, personal-use %, whether something is deductible at
// all) stay with the human — the UI says so.
//
// Sign convention: the app stores positive = money out, negative = money in
// (see CLAUDE.md). Expense-line totals therefore SUM the amounts as stored, so
// a refund (negative row in a mapped category) nets against its line, which is
// what the preparer wants. Unmapped negatives on a rental entity are treated
// as rents received.

// Schedule E (Form 1040), Part I expense lines for tax year 2025/2026.
// Line 18 (depreciation) is deliberately NOT mappable: depreciation is
// computed from the capital-expense list, not from cash transactions — that is
// the whole point of the is_capital flag.
export const SCHEDULE_E_LINES = [
  { line: 5, label: 'Advertising' },
  { line: 6, label: 'Auto and travel' },
  { line: 7, label: 'Cleaning and maintenance' },
  { line: 8, label: 'Commissions' },
  { line: 9, label: 'Insurance' },
  { line: 10, label: 'Legal and other professional fees' },
  { line: 11, label: 'Management fees' },
  { line: 12, label: 'Mortgage interest (paid to banks)' },
  { line: 13, label: 'Other interest' },
  { line: 14, label: 'Repairs' },
  { line: 15, label: 'Supplies' },
  { line: 16, label: 'Taxes' },
  { line: 17, label: 'Utilities' },
  { line: 19, label: 'Other' },
];

// The mapping value for "this category is rent coming in" (Schedule E line 3,
// Rents received). Categories mapped here contribute income even when a row is
// positive (a returned deposit nets against rents).
export const RENTS_KEY = 'rents';

// EMPTY BY DESIGN since the user-owned category system landed (2026-08-04).
// This used to seed two built-in categories onto lines 14 and 17; those
// built-ins no longer exist — the household creates every category — so there
// is nothing honest to pre-map. Category→line mapping is now fully user-driven
// through the existing `tax:maps` settings key, and everything unmapped shows
// in the VISIBLE amber "not on any line yet" bucket rather than being guessed
// (the Uncategorized lesson, applied to tax lines). Kept as an exported
// constant so the callers' `?? DEFAULT_SCHEDULE_E_MAP` fallbacks keep meaning
// "no mapping yet" without a second empty-object literal.
export const DEFAULT_SCHEDULE_E_MAP = {};

const round2 = (v) => Math.round(v * 100) / 100;

function lineLabel(line) {
  for (const l of SCHEDULE_E_LINES) if (l.line === line) return l.label;
  return null;
}

// rows: transactions already filtered to ONE entity and ONE calendar year by
// the caller, each { id, transaction_date, amount, category, merchant_name,
// is_capital, placed_in_service, useful_life_years, excluded }.
// mapping: { [category]: lineNumber | 'rents' } — anything else is unmapped.
// Never throws (it runs during render, and there is no error boundary).
export function scheduleEReport(rows, mapping) {
  const map = mapping && typeof mapping === 'object' ? mapping : {};
  const lineTotals = new Map();
  const unmappedByCat = new Map();
  const capital = [];
  let rentsTotal = 0;
  let rentsCount = 0;
  // The rows that landed in rents by DEFAULT (unmapped money in), not by an
  // explicit mapping — reported separately so the preparer can audit line 3
  // instead of trusting a guess. Same visibility rule as the unmapped bucket:
  // a refund in an unmapped expense category lands here, and only showing the
  // subtotal makes that reviewable.
  let defaultedTotal = 0;
  let defaultedCount = 0;

  for (const t of Array.isArray(rows) ? rows : []) {
    if (!t || t.excluded) continue;
    const amount = Number(t.amount) || 0;
    if (amount === 0) continue;

    // Capital expenses are pulled out FIRST, whatever their category mapping:
    // an improvement is depreciated over its useful life, and letting it also
    // land on an expense line would double-count it.
    if (t.is_capital) {
      capital.push({
        id: t.id ?? null,
        date: t.transaction_date || '',
        description: t.merchant_name || '',
        amount: round2(amount),
        placed_in_service: t.placed_in_service || null,
        useful_life_years: t.useful_life_years ?? null,
      });
      continue;
    }

    const target = map[t.category];
    if (target === RENTS_KEY) {
      // Stored negative = money in, so income is the negated sum.
      rentsTotal += -amount;
      rentsCount += 1;
    } else if (typeof target === 'number' && lineLabel(target)) {
      lineTotals.set(target, (lineTotals.get(target) || 0) + amount);
    } else if (amount < 0) {
      // Unmapped money IN on a rental entity is rent until told otherwise.
      rentsTotal += -amount;
      rentsCount += 1;
      defaultedTotal += -amount;
      defaultedCount += 1;
    } else {
      const cat = t.category || 'Uncategorized';
      const cur = unmappedByCat.get(cat) || { total: 0, count: 0 };
      cur.total += amount;
      cur.count += 1;
      unmappedByCat.set(cat, cur);
    }
  }

  const lines = SCHEDULE_E_LINES.map(({ line, label }) => ({
    line,
    label,
    total: round2(lineTotals.get(line) || 0),
  }));
  const unmapped = [...unmappedByCat.entries()]
    .map(([category, v]) => ({ category, total: round2(v.total), count: v.count }))
    .sort((a, b) => b.total - a.total || (a.category < b.category ? -1 : 1));
  capital.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const totalExpenses = round2(lines.reduce((s, l) => s + l.total, 0));
  const unmappedTotal = round2(unmapped.reduce((s, u) => s + u.total, 0));
  const capitalTotal = round2(capital.reduce((s, c) => s + c.amount, 0));

  const rentsRounded = round2(rentsTotal);
  return {
    rents: {
      total: rentsRounded,
      count: rentsCount,
      defaulted: { total: round2(defaultedTotal), count: defaultedCount },
    },
    lines,
    totalExpenses,
    unmapped,
    unmappedTotal,
    capital: { total: capitalTotal, items: capital },
    // Cash result of the mapped picture only — depreciation (line 18) and the
    // unmapped bucket are deliberately not in it; the preparer owns those.
    // Subtract the same rounded value rents.total shows, so the on-screen
    // identity rents − expenses = net can never be off by a cent.
    net: round2(rentsRounded - totalExpenses),
  };
}

// Month-by-month cash P&L for an entity: everything in vs everything out,
// capital included (it is cash that left). rows as in scheduleEReport.
export function entityMonthly(rows) {
  const byMonth = new Map();
  for (const t of Array.isArray(rows) ? rows : []) {
    if (!t || t.excluded) continue;
    const amount = Number(t.amount) || 0;
    const ym = (t.transaction_date || '').slice(0, 7);
    if (!ym || amount === 0) continue;
    const cur = byMonth.get(ym) || { ym, income: 0, expenses: 0 };
    if (amount < 0) cur.income += -amount;
    else cur.expenses += amount;
    byMonth.set(ym, cur);
  }
  return [...byMonth.values()]
    .map((m) => ({ ym: m.ym, income: round2(m.income), expenses: round2(m.expenses), net: round2(m.income - m.expenses) }))
    .sort((a, b) => (a.ym < b.ym ? -1 : 1));
}

// The drill-in ledger behind a property card's numbers: the same rows
// entityMonthly totals, but as inspectable lists — Money in / Money out by
// stored sign (capital included: it is cash that left), with excluded and
// zero-amount rows in a visible "not counted" tail instead of silently
// dropped. The section totals MUST equal entityMonthly's year sums — the
// sheet opens from those numbers, and a list disagreeing with the number that
// was tapped is exactly the drift `counted` exists to prevent elsewhere
// (a test pins the identity). Never throws (runs during render).
export function entityLedger(rows) {
  const moneyIn = [];
  const moneyOut = [];
  const notCounted = [];
  let inTotal = 0;
  let outTotal = 0;
  for (const t of Array.isArray(rows) ? rows : []) {
    if (!t) continue;
    const amount = Number(t.amount) || 0;
    if (t.excluded || amount === 0) {
      notCounted.push(t);
      continue;
    }
    if (amount < 0) {
      moneyIn.push(t);
      inTotal += -amount;
    } else {
      moneyOut.push(t);
      outTotal += amount;
    }
  }
  // Newest first, like every transaction list; the id tie-break keeps a day
  // with several rows in one deterministic order.
  const byDateDesc = (a, b) => {
    const da = a.transaction_date || '';
    const db = b.transaction_date || '';
    if (da !== db) return da < db ? 1 : -1;
    const ia = String(a.id ?? '');
    const ib = String(b.id ?? '');
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  };
  moneyIn.sort(byDateDesc);
  moneyOut.sort(byDateDesc);
  notCounted.sort(byDateDesc);
  return {
    moneyIn: { rows: moneyIn, total: round2(inTotal) },
    moneyOut: { rows: moneyOut, total: round2(outTotal) },
    notCounted: { rows: notCounted },
  };
}

// ---------------------------------------------------------------------------
// Personal deductions (the non-entity side): year totals per bucket for the
// preparer. Buckets, not tax math — no AGI floors, no itemize-or-not logic.

export const DEDUCTION_BUCKETS = [
  { key: 'charitable', label: 'Charitable giving' },
  { key: 'medical', label: 'Medical and dental' },
  { key: 'taxes_paid', label: 'Taxes paid (property, etc.)' },
];

// Empty for the same reason as DEFAULT_SCHEDULE_E_MAP: its only entry mapped a
// deleted built-in category ('Healthcare and pharmacy' → medical). User-driven
// via `tax:maps`; unmapped stays visible.
export const DEFAULT_DEDUCTION_MAP = {};

const DEDUCTION_KEYS = new Set(DEDUCTION_BUCKETS.map((b) => b.key));

// rows: NON-entity transactions for the year; mapping { [category]: bucketKey }.
// An unknown bucket key (stale settings after a future rename) is skipped like
// an unmapped category — never silently accumulated into a bucket that no
// report row renders (the lineLabel() guard's sibling).
export function personalDeductionReport(rows, mapping) {
  const map = mapping && typeof mapping === 'object' ? mapping : {};
  const totals = new Map();
  for (const t of Array.isArray(rows) ? rows : []) {
    if (!t || t.excluded) continue;
    const bucket = map[t.category];
    if (!bucket || !DEDUCTION_KEYS.has(bucket)) continue;
    const amount = Number(t.amount) || 0;
    if (amount === 0) continue;
    const cur = totals.get(bucket) || { total: 0, count: 0 };
    cur.total += amount; // refunds (negative) net against the bucket
    cur.count += 1;
    totals.set(bucket, cur);
  }
  return DEDUCTION_BUCKETS.map(({ key, label }) => ({
    key,
    label,
    total: round2(totals.get(key)?.total || 0),
    count: totals.get(key)?.count || 0,
  }));
}

// ---------------------------------------------------------------------------
// IRS standard mileage rates (business), effective-dated. 2026 split mid-year:
// the IRS raised the rate to 76¢ effective July 1, 2026 (IRS newsroom /
// Journal of Accountancy, July 2026). VERIFY against irs.gov when a new tax
// year starts — this table is data that goes stale, and staleness here means
// a wrong deduction number.

export const MILEAGE_RATES = [
  { from: '2024-01-01', rate: 0.67 },
  { from: '2025-01-01', rate: 0.70 },
  { from: '2026-01-01', rate: 0.725 },
  { from: '2026-07-01', rate: 0.76 },
];

// ISO-string comparison on purpose: `new Date('2026-07-01')` is UTC-midnight
// and shifts a day in western timezones. Dates never touch Date here.
// Picks the MAX `from` ≤ the date rather than the last array entry, so a
// future January edit that appends out of order can't silently misprice every
// later drive (a test also pins the array as ascending).
export function mileageRate(isoDate) {
  if (typeof isoDate !== 'string' || !isoDate) return null;
  let found = null;
  for (const r of MILEAGE_RATES) {
    if (r.from <= isoDate && (!found || r.from > found.from)) found = r;
  }
  return found ? found.rate : null;
}

// logRows: [{ on_date, miles }]. Returns totals plus a per-rate breakdown
// (a year that straddles a rate change needs both lines on the log the
// preparer sees). Rows older than the rate table are counted in `unratedMiles`
// and valued at zero rather than guessed.
export function mileageDeduction(logRows) {
  const byRate = new Map();
  let miles = 0;
  let amount = 0;
  let unratedMiles = 0;
  for (const row of Array.isArray(logRows) ? logRows : []) {
    if (!row) continue;
    const m = Number(row.miles) || 0;
    if (m <= 0) continue;
    const rate = mileageRate(row.on_date);
    if (rate == null) {
      unratedMiles += m;
      continue;
    }
    miles += m;
    amount += m * rate;
    const cur = byRate.get(rate) || { rate, miles: 0, amount: 0 };
    cur.miles += m;
    cur.amount += m * rate;
    byRate.set(rate, cur);
  }
  const byRateRows = [...byRate.values()]
    .map((r) => ({ rate: r.rate, miles: round2(r.miles), amount: round2(r.amount) }))
    .sort((a, b) => a.rate - b.rate);
  return {
    miles: round2(miles),
    // Sum of the rounded per-rate rows, not a separately-rounded grand total —
    // the preparer's log shows the rows, and they must add up to the headline.
    amount: round2(byRateRows.reduce((s, r) => s + r.amount, 0)),
    unratedMiles: round2(unratedMiles),
    byRate: byRateRows,
  };
}

// ---------------------------------------------------------------------------
// CSV for the preparer. Amounts keep the app's stored sign and the column
// name (`amount_positive_is_outflow`) says so. Note this file is NOT meant to
// round-trip through the CSV importer: what actually protects against that is
// that detectHeader can't auto-map these headers (no synonym matches), so the
// importer demands manual mapping and shows a preview — the sign convention in
// the column name is documentation for the human, not import safety.

function csvCell(v) {
  let s = String(v ?? '');
  // Formula-injection guard: this file is handed to a preparer and opened in
  // Excel, where a cell starting `=`/`+`/`@`/tab executes. Bank text flows in
  // here verbatim, so those get a leading apostrophe. `-` is deliberately NOT
  // neutralized — toFixed amount cells must stay byte-identical (the pinned
  // positive=out sign rule), and `-60.00` is a number to Excel, not a formula.
  if (/^[=+@\t]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// receiptTxIds: Set of transaction ids that have a receipt photo attached, or
// null/undefined when the receipts feature isn't installed — the capital table
// then omits the column entirely rather than stamping every row MISSING.
export function scheduleECsv(report, { entityName = '', year = '', receiptTxIds = null } = {}) {
  const rows = [
    ['Schedule E worksheet', entityName, String(year)],
    ['Totals from categorized transactions. Not tax advice - review with your preparer.'],
    [],
    ['line', 'label', 'total'],
    ['3', 'Rents received', report.rents.total.toFixed(2)],
  ];
  if (report.rents.defaulted?.count > 0) {
    rows.push(['', `  of which ${report.rents.defaulted.count} unmapped deposit(s) counted as rent by default - review`, report.rents.defaulted.total.toFixed(2)]);
  }
  for (const l of report.lines) rows.push([String(l.line), l.label, l.total.toFixed(2)]);
  rows.push(['', 'Total expenses (mapped lines)', report.totalExpenses.toFixed(2)]);
  if (report.unmapped.length) {
    rows.push([]);
    rows.push(['', 'NOT MAPPED TO ANY LINE (review these)', report.unmappedTotal.toFixed(2)]);
    for (const u of report.unmapped) rows.push(['', u.category, u.total.toFixed(2)]);
  }
  if (report.capital.items.length) {
    rows.push([]);
    rows.push(['', 'Capital expenses (depreciate, do not deduct)', report.capital.total.toFixed(2)]);
    const header = ['date', 'description', 'amount_positive_is_outflow', 'placed_in_service', 'useful_life_years'];
    if (receiptTxIds) header.push('receipt');
    rows.push(header);
    for (const c of report.capital.items) {
      const row = [c.date, c.description, c.amount.toFixed(2), c.placed_in_service || '', c.useful_life_years ?? ''];
      if (receiptTxIds) row.push(receiptTxIds.has(c.id) ? 'yes' : 'MISSING');
      rows.push(row);
    }
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
