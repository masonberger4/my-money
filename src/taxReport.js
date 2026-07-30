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

// Sensible-but-conservative defaults for a fresh entity mapping. Everything
// else stays unmapped ON PURPOSE — an unmapped bucket the user can see beats a
// silently wrong line (the Uncategorized lesson, applied to tax lines).
export const DEFAULT_SCHEDULE_E_MAP = {
  'Home maintenance and improvement': 14,
  Utilities: 17,
};

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

  return {
    rents: { total: round2(rentsTotal), count: rentsCount },
    lines,
    totalExpenses,
    unmapped,
    unmappedTotal,
    capital: { total: capitalTotal, items: capital },
    // Cash result of the mapped picture only — depreciation (line 18) and the
    // unmapped bucket are deliberately not in it; the preparer owns those.
    net: round2(rentsTotal - totalExpenses),
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

// ---------------------------------------------------------------------------
// Personal deductions (the non-entity side): year totals per bucket for the
// preparer. Buckets, not tax math — no AGI floors, no itemize-or-not logic.

export const DEDUCTION_BUCKETS = [
  { key: 'charitable', label: 'Charitable giving' },
  { key: 'medical', label: 'Medical and dental' },
  { key: 'taxes_paid', label: 'Taxes paid (property, etc.)' },
];

export const DEFAULT_DEDUCTION_MAP = {
  'Healthcare and pharmacy': 'medical',
};

// rows: NON-entity transactions for the year; mapping { [category]: bucketKey }.
export function personalDeductionReport(rows, mapping) {
  const map = mapping && typeof mapping === 'object' ? mapping : {};
  const totals = new Map();
  for (const t of Array.isArray(rows) ? rows : []) {
    if (!t || t.excluded) continue;
    const bucket = map[t.category];
    if (!bucket) continue;
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
export function mileageRate(isoDate) {
  if (typeof isoDate !== 'string' || !isoDate) return null;
  let found = null;
  for (const r of MILEAGE_RATES) {
    if (r.from <= isoDate) found = r;
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
  return {
    miles: round2(miles),
    amount: round2(amount),
    unratedMiles: round2(unratedMiles),
    byRate: [...byRate.values()]
      .map((r) => ({ rate: r.rate, miles: round2(r.miles), amount: round2(r.amount) }))
      .sort((a, b) => a.rate - b.rate),
  };
}

// ---------------------------------------------------------------------------
// CSV for the preparer. Amounts keep the app's stored sign and the column
// name says so — flipping signs on export would make a re-import through the
// CSV importer double-negate.

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function scheduleECsv(report, { entityName = '', year = '' } = {}) {
  const rows = [
    ['Schedule E worksheet', entityName, String(year)],
    ['Totals from categorized transactions. Not tax advice - review with your preparer.'],
    [],
    ['line', 'label', 'total'],
    ['3', 'Rents received', report.rents.total.toFixed(2)],
  ];
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
    rows.push(['date', 'description', 'amount_positive_is_outflow', 'placed_in_service', 'useful_life_years']);
    for (const c of report.capital.items) {
      rows.push([c.date, c.description, c.amount.toFixed(2), c.placed_in_service || '', c.useful_life_years ?? '']);
    }
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
