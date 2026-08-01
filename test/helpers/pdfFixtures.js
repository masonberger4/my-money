// Synthetic PDF-statement fixtures for test/pdfImport.test.js.
//
// Everything here is INVENTED data modeling the SHAPES CLAUDE.md documents —
// a card statement (Trans Date + Post Date + Description + Amount) and a
// mortgage statement (Date + Description + Payments + Charges, table split
// across pages). No text runs, descriptors, or amounts come from any real
// statement.
//
// Coordinates mirror what src/pdfExtract.js delivers: top-left origin, y grows
// DOWNWARD, and each PAGE has its own y space — page 2's first line has a
// SMALLER y than page 1's last line. Several applyTemplate geometry tests are
// vacuous unless fixtures model that (see the multi-page glue test).

// One positioned text run, the exact shape pdfExtract emits.
// Width defaults to a monospace-ish 5pt/char so column midpoints are stable.
export function run(text, x, y, w = null, h = 10) {
  const str = String(text);
  return { str, x, y, w: w ?? str.length * 5, h };
}

// A right-aligned run (amounts): `right` is the x where the text ENDS.
export function runRight(text, right, y, h = 10) {
  const str = String(text);
  const w = str.length * 5;
  return { str, x: right - w, y, w, h };
}

export function page(pageNo, runs, { width = 612, height = 792 } = {}) {
  return { page: pageNo, width, height, runs };
}

// A free-standing line of one or more runs. parts: string, or [text, x] pairs.
export function textLine(y, parts, x = 40) {
  if (typeof parts === 'string') return [run(parts, x, y)];
  return parts.map(([text, px]) => run(text, px, y));
}

// ---------------------------------------------------------------------------
// Card-statement layout: Trans Date | Post Date | Description | Amount.
// Page width 612 (US letter at 72dpi). Boundaries cut at x≈98 / 153 / 459.
// ---------------------------------------------------------------------------
export const CARD = {
  width: 612,
  boundaries: [0.16, 0.25, 0.75],
  roles: ['date', 'date2', 'description', 'amount'],
  x: { trans: 40, post: 105, desc: 165, amountRight: 570 },
};

export function cardRow(y, transDate, postDate, desc, amount) {
  return [
    run(transDate, CARD.x.trans, y),
    run(postDate, CARD.x.post, y),
    run(desc, CARD.x.desc, y),
    runRight(String(amount), CARD.x.amountRight, y),
  ];
}

export function cardHeader(y) {
  return [
    run('Trans Date', CARD.x.trans, y),
    run('Post Date', CARD.x.post, y),
    run('Description', CARD.x.desc, y),
    run('Amount', 540, y),
  ];
}

export function cardTemplate(overrides = {}) {
  return {
    version: 1,
    boundaries: CARD.boundaries,
    roles: CARD.roles,
    dateColumn: 'date2',
    amountMode: 'signed',
    amountSign: 'out_positive',
    startAnchor: 'TRANSACTION DETAIL',
    stopAnchor: 'FEES SUMMARY',
    pages: null,
    ...overrides,
  };
}

// A ready-made single-page card statement: bank prose, a statement-period
// line, the start anchor, the column header, the given rows, the stop anchor,
// and post-table prose. rows: [transDate, postDate, desc, amount] tuples.
// Extra named lines let tests inject fine print etc. without re-deriving ys.
export function cardStatementPage(rows, {
  period = 'May 25, 2026 - Jun 23, 2026',
  finePrint = null,
  pageNo = 1,
} = {}) {
  const runs = [
    ...textLine(40, 'SYNTH BANK Card Services'),
    ...textLine(58, [['Statement Period:', 40], [period, 150]]),
    ...textLine(80, 'TRANSACTION DETAIL'),
    ...cardHeader(100),
  ];
  rows.forEach((r, i) => runs.push(...cardRow(120 + i * 20, ...r)));
  const afterRows = 120 + rows.length * 20;
  runs.push(...textLine(afterRows + 20, 'FEES SUMMARY'));
  runs.push(...textLine(afterRows + 40, 'Total fees charged this period'));
  if (finePrint) runs.push(...textLine(760, finePrint));
  return page(pageNo, runs);
}

// ---------------------------------------------------------------------------
// Mortgage-statement layout: Date | Description | Payments | Charges — a
// debit/credit pair where Payments = money in (credit) and Charges = money
// out (debit). The table splits across two pages in the multi-page fixtures.
// ---------------------------------------------------------------------------
export const MORTGAGE = {
  width: 612,
  boundaries: [0.19, 0.62, 0.79],
  roles: ['date', 'description', 'credit', 'debit'],
  x: { date: 50, desc: 130, payRight: 460, chargeRight: 585 },
};

// payment / charge are strings exactly as printed ('' for an empty cell).
export function mortgageRow(y, date, desc, { payment = '', charge = '' } = {}) {
  const runs = [run(date, MORTGAGE.x.date, y), run(desc, MORTGAGE.x.desc, y)];
  if (payment) runs.push(runRight(payment, MORTGAGE.x.payRight, y));
  if (charge) runs.push(runRight(charge, MORTGAGE.x.chargeRight, y));
  return runs;
}

export function mortgageHeader(y) {
  return [
    run('Date', MORTGAGE.x.date, y),
    run('Description', MORTGAGE.x.desc, y),
    runRight('Payments', MORTGAGE.x.payRight, y),
    runRight('Charges', MORTGAGE.x.chargeRight, y),
  ];
}

export function mortgageTemplate(overrides = {}) {
  return {
    version: 1,
    boundaries: MORTGAGE.boundaries,
    roles: MORTGAGE.roles,
    dateColumn: 'date',
    amountMode: 'debitcredit',
    amountSign: 'out_positive',
    startAnchor: 'ACTIVITY SINCE LAST STATEMENT',
    stopAnchor: 'IMPORTANT MESSAGES',
    pages: null,
    ...overrides,
  };
}

// Mortgage page-1 preamble: dated summary fields but NO period range, so
// resolveYearWindow must fall back to the header-median path. The 2052
// maturity date is the far-future outlier the median anchoring exists for.
export function mortgagePreamble() {
  return [
    ...textLine(30, 'SYNTH SERVICING LLC'),
    ...textLine(46, [['Statement Date:', 40], ['06/20/2026', 130]]),
    ...textLine(62, [['Payment Due Date:', 40], ['07/01/2026', 140]]),
    ...textLine(78, [['Maturity Date:', 40], ['07/01/2052', 130]]),
  ];
}

// Tiny seeded LCG, same pattern as test/cashFlow.test.js, so property-style
// tests are reproducible.
export function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
