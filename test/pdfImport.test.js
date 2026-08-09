// Tests for the pure PDF-statement parsing core (src/pdfImport.js) and the
// CSV-side parsers on the same write path (parseMoney/parseDate/detectHeader
// in src/csvImport.js — the PDF path reuses them via buildRows).
//
// Fixtures are entirely synthetic (test/helpers/pdfFixtures.js): they model
// the SHAPES of the real statements CLAUDE.md documents — a card statement
// with Trans Date + Post Date + Description + Amount, and a mortgage
// statement whose Payments/Charges table splits across two pages — with
// invented merchants and amounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeDate,
  looksLikeMoney,
  normalizeMoneyText,
  findStatementPeriod,
  collectYearContext,
  resolveYearWindow,
  inferYear,
  parseFlexibleDate,
  groupIntoLines,
  splitLineIntoCells,
  lineCellStarts,
  findHeaderLines,
  suggestBoundaries,
  suggestRoles,
  autoDetectTemplate,
  defaultTemplate,
  applyTemplate,
  normalizeDebitCredit,
  rowTotals,
  TEMPLATE_VERSION,
} from '../src/pdfImport.js';
import {
  parseMoney,
  parseDate,
  parseCsv,
  detectHeader,
  buildRows,
  analyzeCsv,
  importPlan,
} from '../src/csvImport.js';
import { TRANSFER_CATEGORY, FALLBACK_CATEGORY } from '../src/categoryMap.js';
import {
  run,
  page,
  textLine,
  CARD,
  cardRow,
  cardHeader,
  cardTemplate,
  cardStatementPage,
  MORTGAGE,
  mortgageRow,
  mortgageHeader,
  mortgageTemplate,
  mortgagePreamble,
} from './helpers/pdfFixtures.js';

// ---------------------------------------------------------------------------
// Shape tests — looksLikeDate / looksLikeMoney / normalizeMoneyText
// ---------------------------------------------------------------------------

test('normalizeMoneyText maps unicode minus, en-dash and em-dash to ASCII "-"', () => {
  assert.equal(normalizeMoneyText('−45.00'), '-45.00'); // U+2212 minus
  assert.equal(normalizeMoneyText('–45.00'), '-45.00'); // en-dash
  assert.equal(normalizeMoneyText('—45.00'), '-45.00'); // em-dash
  assert.equal(normalizeMoneyText('$1,234.56'), '$1,234.56'); // untouched
});

test('REGRESSION: a unicode-minus amount is money and survives as a NEGATIVE, not a dropped row', () => {
  // The source comment says why this matters: parseMoney only understands
  // ASCII '-', so a raw-string test would make such a row fail the shape
  // filter and be silently DROPPED — not mis-signed. Pin all three parts:
  const raw = '−69.31';
  assert.equal(looksLikeMoney(raw), true, 'shape filter must accept it');
  assert.ok(Number.isNaN(parseMoney(raw)), 'raw string is unparseable — that is the trap');
  assert.equal(parseMoney(normalizeMoneyText(raw)), -69.31, 'normalized it parses negative');
});

test('looksLikeMoney accepts statement money shapes and rejects years/bare integers', () => {
  for (const v of ['(45.00)', '- $69.31', '$1,234.56', '-141.66', '8.00', '1,234']) {
    assert.equal(looksLikeMoney(v), true, v);
  }
  assert.equal(looksLikeMoney('2026'), false, 'a bare year is not money');
  assert.equal(looksLikeMoney('123'), false, 'a bare integer with no cents/$ is not money');
  assert.equal(looksLikeMoney(''), false);
  assert.equal(looksLikeMoney('TOTAL'), false);
});

test('looksLikeDate accepts all five documented forms and rejects non-dates', () => {
  for (const v of ['May 23', 'May 23, 2026', '5/23/2026', '2026-05-23', '23 May']) {
    assert.equal(looksLikeDate(v), true, v);
  }
  for (const v of ['', 'May', 'TOTAL', 'Description', '45.00']) {
    assert.equal(looksLikeDate(v), false, v);
  }
});

// ---------------------------------------------------------------------------
// CSV-side parsers on the same write path — parseMoney / parseDate /
// detectHeader, pinned directly instead of only through analyzeCsv.
// ---------------------------------------------------------------------------

test('parseMoney: the documented shapes', () => {
  assert.equal(parseMoney('$1,234.50'), 1234.5);
  assert.equal(parseMoney('(45.00)'), -45);
  assert.equal(parseMoney('-45'), -45);
  assert.equal(parseMoney('+45'), 45);
  assert.equal(parseMoney(''), 0, 'blank is 0, not NaN — Debit/Credit cells are often empty');
  assert.ok(Number.isNaN(parseMoney('N/A')));
});

test('parseMoney: "(-45.00)" double-flips to POSITIVE — documented current behavior', () => {
  // Parens set negative, then the inner '-' flips it back. No real bank prints
  // this shape; pinned so a refactor that changes it is a conscious decision.
  assert.equal(parseMoney('(-45.00)'), 45);
});

test('parseDate: the two-digit-year pivot is at 70', () => {
  assert.equal(parseDate('12/31/69'), '2069-12-31', '< 70 → 2000s');
  assert.equal(parseDate('1/1/70'), '1970-01-01', '≥ 70 → 1900s');
});

test('parseDate: impossible dates are null, separator variants parse', () => {
  assert.equal(parseDate('2026-02-30'), null, 'Feb 30 does not exist');
  assert.equal(parseDate('5.23.26'), '2026-05-23');
  assert.equal(parseDate('5-23-2026'), '2026-05-23');
  assert.equal(parseDate('13/1/2026'), null, 'month 13');
  assert.equal(parseDate('hello'), null);
  assert.equal(parseDate(''), null);
});

test('detectHeader skips preamble junk and finds the real header row', () => {
  const rows = parseCsv(
    ['SYNTH CREDIT UNION', '', 'Account: ****1234', 'Date,Description,Debit,Credit', '3/1/2026,STORE,4.50,'].join('\n')
  );
  const detected = detectHeader(rows);
  assert.ok(detected);
  assert.equal(detected.headerIndex, 3);
  assert.deepEqual(
    { date: detected.columns.date, description: detected.columns.description, debit: detected.columns.debit, credit: detected.columns.credit },
    { date: 0, description: 1, debit: 2, credit: 3 }
  );
});

test('detectHeader on a headerless file returns null', () => {
  assert.equal(detectHeader(parseCsv('3/1/2026,STORE,4.50,\n3/2/2026,OTHER,,9.00')), null);
});

// ---------------------------------------------------------------------------
// Year inference — findStatementPeriod / collectYearContext /
// resolveYearWindow / inferYear / parseFlexibleDate
// ---------------------------------------------------------------------------

test('findStatementPeriod finds a genuine billing-cycle range', () => {
  const pg = cardStatementPage([['May 26', 'May 27', 'RIVER GROCERY', '45.00']]);
  assert.deepEqual(findStatementPeriod([pg]), { start: '2026-05-25', end: '2026-06-23' });
});

test('findStatementPeriod rejects an arbitrary far-apart date pair (the span filter)', () => {
  // A copyright-era date "ranged" to the due date is not a billing cycle.
  const pg = page(1, textLine(40, [['Jan 1, 2023 through Jul 18, 2026', 40]]));
  assert.equal(findStatementPeriod([pg]), null);
});

test('findStatementPeriod handles the partial-range shorthand (year only on the close)', () => {
  const pg = page(1, textLine(40, [['May 25 - Jun 23, 2026', 40]]));
  assert.deepEqual(findStatementPeriod([pg]), { start: '2026-05-25', end: '2026-06-23' });
});

test('partial-range shorthand steps the start back a year when the cycle wraps', () => {
  const pg = page(1, textLine(40, [['Dec 15 - Jan 14, 2026', 40]]));
  assert.deepEqual(findStatementPeriod([pg]), { start: '2025-12-15', end: '2026-01-14' });
});

test('two-digit years in a period pivot at 70 (1900s vs 2000s)', () => {
  const pg = page(1, textLine(40, [['May 25, 99 - Jun 23, 99', 40]]));
  assert.deepEqual(findStatementPeriod([pg]), { start: '1999-05-25', end: '1999-06-23' });
});

test('collectYearContext gathers every explicitly-dated string in the document', () => {
  const pg = page(1, [
    run('Payment Due Date: ', 40, 30),
    run('Jul 18, 2026', 130, 30),
    run('06/20/2026', 40, 50),
    run('Rev. 2023-01-15', 40, 70),
  ]);
  const ctx = collectYearContext([pg]);
  assert.deepEqual(ctx.years, [2023, 2026]);
  assert.equal(ctx.min, '2023-01-15');
  assert.equal(ctx.max, '2026-07-18');
});

test('resolveYearWindow: the period anchors the window; stale fine-print years do not widen it', () => {
  const pg = cardStatementPage([['May 26', 'May 27', 'RIVER GROCERY', '45.00']], {
    finePrint: 'Form rev. Mar 3, 2023 — see reverse for terms',
  });
  const win = resolveYearWindow([pg]);
  assert.equal(win.source, 'period');
  assert.deepEqual(win.years, [2026], 'the 2023 revision year must not enter the window');
});

test('resolveYearWindow falls back to the header-median when no period exists (mortgage shape)', () => {
  // Page-1 dates: 06/20/2026, 07/01/2026, 07/01/2052 (maturity). Anchoring on
  // the MAX would put the window in 2052; the median keeps it in 2026.
  const pg = page(1, mortgagePreamble());
  const win = resolveYearWindow([pg]);
  assert.equal(win.source, 'header-median');
  assert.ok(win.min >= '2026-01-01' && win.max <= '2026-12-31', `window ${win.min}..${win.max} must stay in 2026`);
});

test('inferYear picks the year closest to the window, including across Dec→Jan', () => {
  const ctx = { min: '2025-11-30', max: '2026-02-28', years: [2025, 2026] };
  assert.equal(inferYear(12, 28, ctx), '2025-12-28');
  assert.equal(inferYear(1, 3, ctx), '2026-01-03');
  assert.equal(inferYear(6, 15, null), null, 'no context → no guess');
});

test('parseFlexibleDate resolves every supported form, using the window only when needed', () => {
  const ctx = { min: '2026-04-10', max: '2026-08-07', years: [2026] };
  assert.equal(parseFlexibleDate('May 23', ctx), '2026-05-23');
  assert.equal(parseFlexibleDate('23 May', ctx), '2026-05-23');
  assert.equal(parseFlexibleDate('May 23, 2027', ctx), '2027-05-23', 'an explicit year wins over the window');
  assert.equal(parseFlexibleDate('23 May 2027', ctx), '2027-05-23');
  assert.equal(parseFlexibleDate('5/23/2026', null), '2026-05-23');
  assert.equal(parseFlexibleDate('2026-05-23', null), '2026-05-23');
  assert.equal(parseFlexibleDate('Feb 30', ctx), null, 'an impossible day never resolves');
  assert.equal(parseFlexibleDate('TOTAL', ctx), null);
  assert.equal(parseFlexibleDate('May 23', null), null, 'month-name date with no window cannot resolve');
});

// ---------------------------------------------------------------------------
// Geometry — groupIntoLines / splitLineIntoCells / lineCellStarts /
// findHeaderLines / suggestBoundaries / suggestRoles
// ---------------------------------------------------------------------------

test('groupIntoLines merges runs within the y-tolerance and splits farther ones', () => {
  const lines = groupIntoLines([
    run('B', 50, 100),
    run('A', 10, 102), // within 3pt of the first → same line, x-ordered
    run('C', 10, 106), // > 3pt away → its own line
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'A B');
  assert.equal(lines[1].text, 'C');
  assert.equal(lines[0].height, 10);
});

test('splitLineIntoCells: a run whose midpoint sits exactly ON a boundary lands in the RIGHT cell', () => {
  const line = { runs: [run('L', 10, 0, 20), run('R', 45, 0, 10)] }; // R's mid = 50
  assert.deepEqual(splitLineIntoCells(line, [0.5], 100), ['L', 'R']);
});

test('lineCellStarts reports each column-content left edge, null for empty columns', () => {
  const line = { runs: [run('ONLY RIGHT', 60, 0, 30)] };
  assert.deepEqual(lineCellStarts(line, [0.5], 100), [null, 60]);
});

test('findHeaderLines: a real column header qualifies; a summary line carrying date VALUES does not', () => {
  const lines = groupIntoLines([
    ...cardHeader(10),
    run('Payment Due Date:', 40, 30),
    run('Jul 18, 2026', 140, 30),
    run('Account ending in 7885', 260, 30),
    run('Total Amount Due', 40, 50), // no "date" word at all
    run('date and amount '.repeat(9), 40, 70), // > 120 chars → too long to be a header
  ]);
  assert.deepEqual(findHeaderLines(lines), [0]);
});

test('suggestBoundaries cuts wide whitespace gaps and honors minGap', () => {
  const wide = { runs: [run('AAAA', 100, 10, 20), run('BBBB', 140, 10, 20)] }; // 19pt gap
  const cuts = suggestBoundaries([wide], 612);
  assert.equal(cuts.length, 1);
  const cutX = cuts[0] * 612;
  assert.ok(cutX > 120 && cutX < 140, `cut ${cutX} should fall inside the gap`);

  const narrow = { runs: [run('AAAA', 100, 10, 20), run('BBBB', 125, 10, 20)] }; // 4pt gap < 8
  assert.equal(suggestBoundaries([narrow], 612).length, 0);
});

test('suggestRoles is content-driven: date/date2 by column order, one money column → amount', () => {
  const sampleRows = [
    ['May 23', 'May 24', 'ACME STORE', '12.34'],
    ['May 24', 'May 25', 'RIVER CAFE', '8.00'],
    ['May 25', 'May 26', 'NORTH MARKET', '45.10'],
  ];
  assert.deepEqual(suggestRoles(sampleRows, null), ['date', 'date2', 'description', 'amount']);
});

test('suggestRoles: two money columns use header wording only to break the debit/credit tie', () => {
  const sampleRows = [
    ['Jun 1', 'COUNTY TAX DISBURSEMENT', '', '35.00'],
    ['Jun 15', 'PAYMENT RECEIVED', '2,412.60', ''],
    ['Jun 20', 'LATE FEE ASSESSMENT', '', '15.00'],
  ];
  // Header names the pair: Payments → credit, Charges → debit (even though the
  // credit column sits LEFT of the debit column here).
  assert.deepEqual(
    suggestRoles(sampleRows, ['Date', 'Description', 'Payments', 'Charges']),
    ['date', 'description', 'credit', 'debit']
  );
  // No header → positional default: left = debit, right = credit.
  assert.deepEqual(suggestRoles(sampleRows, null), ['date', 'description', 'debit', 'credit']);
});

// ---------------------------------------------------------------------------
// autoDetectTemplate
// ---------------------------------------------------------------------------

const CARD_ROWS = [
  ['May 26', 'May 27', 'RIVER GROCERY 1467', '45.00'],
  ['May 30', 'May 31', 'ACME COFFEE 0042', '6.50'],
  ['Jun 2', 'Jun 3', 'ONLINE BANKING TRANSFER TO SAVINGS', '250.00'],
  ['Jun 5', 'Jun 6', 'MYSTERY VENDOR LLC', '12.00'],
  ['Jun 20', 'Jun 21', 'CAPITAL ONE MOBILE PYMT', '-141.66'],
];

test('autoDetectTemplate on the card layout: header, boundaries, roles, POSTED date default', () => {
  const t = autoDetectTemplate([cardStatementPage(CARD_ROWS)]);
  assert.ok(t);
  assert.equal(t.version, TEMPLATE_VERSION);
  assert.deepEqual(t.roles, ['date', 'date2', 'description', 'amount']);
  assert.equal(t.dateColumn, 'date2', 'card statements default to the posted date (matches the feed)');
  assert.equal(t.amountMode, 'signed');
  assert.equal(t.amountSign, 'out_positive');
  assert.equal(t.boundaries.length, 3);
  assert.ok(t.startAnchor.includes('Trans Date'), 'anchor is the header text');
});

test('autoDetectTemplate on the mortgage layout: debit/credit pair named by the header', () => {
  const pg = page(1, [
    ...mortgagePreamble(),
    ...textLine(100, 'ACTIVITY SINCE LAST STATEMENT'),
    ...mortgageHeader(120),
    ...mortgageRow(140, 'Jun 1', 'COUNTY TAX DISBURSEMENT', { charge: '35.00' }),
    ...mortgageRow(160, 'Jun 15', 'PAYMENT RECEIVED THANK YOU', { payment: '2,412.60' }),
    ...mortgageRow(180, 'Jun 18', 'PAYMENT REVERSAL UNAPPLIED', { payment: '-2,412.60' }),
    ...mortgageRow(200, 'Jun 20', 'LATE FEE ASSESSMENT', { charge: '15.00' }),
  ]);
  const t = autoDetectTemplate([pg]);
  assert.ok(t);
  assert.deepEqual(t.roles, ['date', 'description', 'credit', 'debit']);
  assert.equal(t.amountMode, 'debitcredit');
  assert.equal(t.dateColumn, 'date');
});

test('autoDetectTemplate on a page of prose returns null instead of throwing', () => {
  const pg = page(1, [
    ...textLine(40, 'Dear customer, thank you for banking with us.'),
    ...textLine(60, 'Nothing in this letter is a table.'),
  ]);
  assert.equal(autoDetectTemplate([pg]), null);
  assert.equal(autoDetectTemplate([]), null);
  assert.equal(autoDetectTemplate(null), null);
});

test('defaultTemplate is a sane manual-mapping seed', () => {
  const t = defaultTemplate();
  assert.equal(t.version, TEMPLATE_VERSION);
  assert.deepEqual(t.roles, ['date', 'description', 'amount']);
  assert.equal(t.amountMode, 'signed');
  assert.equal(t.boundaries.length, 2);
});

// ---------------------------------------------------------------------------
// applyTemplate — anchors, region exclusion, pages, glue, date2, amount modes
// ---------------------------------------------------------------------------

test('applyTemplate parses only the anchored region; header lands in skipped', () => {
  const res = applyTemplate([cardStatementPage(CARD_ROWS)], cardTemplate());
  assert.equal(res.anchorFound, true);
  assert.equal(res.layoutSuspect, false);
  assert.equal(res.grid.length, CARD_ROWS.length);
  assert.equal(res.rowMeta.length, CARD_ROWS.length);
  // Posted dates drive (dateColumn: 'date2'), resolved to ISO from the period.
  assert.deepEqual(
    res.grid.map(r => r[0]),
    ['2026-05-27', '2026-05-31', '2026-06-03', '2026-06-06', '2026-06-21']
  );
  assert.deepEqual(res.grid.map(r => r[1]), CARD_ROWS.map(r => r[2]));
  // The only in-region non-row line is the column header.
  assert.deepEqual(res.skipped.map(s => s.text), ['Trans Date Post Date Description Amount']);
});

test('anchor-exclusion semantics are decided: pre-anchor, post-stop, excluded-page and anchor lines are dropped with NO skipped[] entry', () => {
  const pgExtra = page(2, [...cardRow(40, 'Jun 9', 'Jun 10', 'EXCLUDED PAGE ROW', '99.00')]);
  const res = applyTemplate([cardStatementPage(CARD_ROWS), pgExtra], cardTemplate({ pages: [1] }));
  const everywhere = JSON.stringify({ grid: res.grid, skipped: res.skipped });
  for (const dropped of [
    'SYNTH BANK', // pre-anchor prose
    'Statement Period', // pre-anchor period line
    'TRANSACTION DETAIL', // the start anchor itself
    'FEES SUMMARY', // the stop anchor itself
    'Total fees charged', // post-stop prose
    'EXCLUDED PAGE ROW', // template-excluded page
  ]) {
    assert.ok(!everywhere.includes(dropped), `"${dropped}" must appear in neither grid nor skipped`);
  }
});

test('a missing start anchor ⇒ anchorFound false + layoutSuspect true (the re-confirm signal)', () => {
  const res = applyTemplate([cardStatementPage(CARD_ROWS)], cardTemplate({ startAnchor: 'NO SUCH MARKER' }));
  assert.equal(res.anchorFound, false);
  assert.equal(res.layoutSuspect, true);
  assert.equal(res.grid.length, 0);
});

test('an empty grid ⇒ layoutSuspect true even when the anchor was found', () => {
  const pg = page(1, [
    ...textLine(40, 'TRANSACTION DETAIL'),
    ...textLine(60, 'No activity this period.'),
  ]);
  const res = applyTemplate([pg], cardTemplate());
  assert.equal(res.anchorFound, true);
  assert.equal(res.grid.length, 0);
  assert.equal(res.layoutSuspect, true);
});

test('dateColumn switches which date drives the transaction date', () => {
  const pages = [cardStatementPage([['May 26', 'May 27', 'RIVER GROCERY', '45.00']])];
  const posted = applyTemplate(pages, cardTemplate({ dateColumn: 'date2' }));
  const trans = applyTemplate(pages, cardTemplate({ dateColumn: 'date' }));
  assert.equal(posted.grid[0][0], '2026-05-27');
  assert.equal(trans.grid[0][0], '2026-05-26');
});

test('amountSign passes through to buildOpts and buildRows honors it; columns match the mode', () => {
  const pages = [cardStatementPage([['May 26', 'May 27', 'RIVER GROCERY', '45.00']])];
  const outPos = applyTemplate(pages, cardTemplate({ amountSign: 'out_positive' }));
  assert.equal(outPos.buildOpts.amountSign, 'out_positive');
  assert.equal(outPos.buildOpts.headerIndex, -1);
  assert.deepEqual(outPos.columns, { date: 0, description: 1, debit: -1, credit: -1, amount: 4 });
  assert.equal(buildRows(outPos.grid, outPos.buildOpts).rows[0].amount, 45);

  const inPos = applyTemplate(pages, cardTemplate({ amountSign: 'in_positive' }));
  assert.equal(inPos.buildOpts.amountSign, 'in_positive');
  assert.equal(buildRows(inPos.grid, inPos.buildOpts).rows[0].amount, -45);
});

test('debitcredit mode routes the pair through normalizeDebitCredit into canonical columns', () => {
  const pg = page(1, [
    ...mortgagePreamble(),
    ...textLine(100, 'ACTIVITY SINCE LAST STATEMENT'),
    ...mortgageHeader(120),
    ...mortgageRow(140, 'Jun 15', 'PAYMENT RECEIVED THANK YOU', { payment: '2,412.60' }),
    ...mortgageRow(160, 'Jun 18', 'PAYMENT REVERSAL UNAPPLIED', { payment: '-2,412.60' }),
    ...mortgageRow(180, 'Jun 20', 'LATE FEE ASSESSMENT', { charge: '15.00' }),
  ]);
  const res = applyTemplate([pg], mortgageTemplate());
  assert.deepEqual(res.columns, { date: 0, description: 1, debit: 2, credit: 3, amount: -1 });
  // payment → credit; NEGATIVE payment (reversal) → positive debit; charge → debit
  assert.deepEqual(res.grid.map(r => [r[2], r[3]]), [
    ['', '2412.60'],
    ['2412.60', ''],
    ['15.00', ''],
  ]);
  const { rows } = buildRows(res.grid, res.buildOpts);
  assert.deepEqual(rows.map(r => r.amount), [-2412.6, 2412.6, 15]);
});

// --- multi-page + continuation gluing ---------------------------------------

test('REGRESSION: a description-only line at the TOP of the next page is NOT glued across the page break', () => {
  // Fixture constrained so deleting the `pg.page === lastPage` check would
  // actually flip the test: pdfExtract y-coordinates are per-page top-down, so
  // page 2's first line must sit at a y slightly LARGER than page 1's last
  // row's y and within 1.8×line-height of it — otherwise the y-delta checks
  // reject the glue on their own and the page check pins nothing. Page 1's
  // last table row is also the page's LAST non-empty line (a trailing footer
  // would reset the continuation state), and the stray line starts at the
  // parent's exact description left edge.
  const p1 = page(1, [
    ...mortgagePreamble(),
    ...textLine(100, 'ACTIVITY SINCE LAST STATEMENT'),
    ...mortgageHeader(120),
    ...mortgageRow(140, 'Jun 1', 'COUNTY TAX DISBURSEMENT', { charge: '35.00' }),
    ...mortgageRow(160, 'Jun 15', 'PAYMENT RECEIVED THANK YOU', { payment: '2,412.60' }),
    ...mortgageRow(700, 'Jun 18', 'PAYMENT REVERSAL', { payment: '-2,412.60' }), // last line of page 1
  ]);
  const p2 = page(2, [
    run('UNAPPLIED FUNDS NOTICE', MORTGAGE.x.desc, 708), // desc-only, y 708-700=8 < 18, same left edge
    ...mortgageRow(728, 'Jun 20', 'LATE FEE ASSESSMENT', { charge: '15.00' }),
    ...mortgageRow(748, 'Jun 22', 'PAYMENT RECEIVED THANK YOU', { payment: '2,412.60' }),
    ...textLine(770, 'IMPORTANT MESSAGES'),
    ...textLine(780, 'Your servicer will never ask for credentials by phone.'),
  ]);
  const res = applyTemplate([p1, p2], mortgageTemplate());
  assert.equal(res.grid.length, 5, 'the page-split table yields all rows');
  assert.deepEqual(res.rowMeta.map(m => m.page), [1, 1, 1, 2, 2]);
  assert.equal(res.grid[2][1], 'PAYMENT REVERSAL', 'nothing glued across the page break');
  assert.ok(res.skipped.some(s => s.text === 'UNAPPLIED FUNDS NOTICE'), 'the stray line is skipped, not glued');
});

test('a genuine same-page wrap IS glued onto its parent description', () => {
  const pg = page(1, [
    ...textLine(58, [['Statement Period:', 40], ['May 25, 2026 - Jun 23, 2026', 150]]),
    ...textLine(80, 'TRANSACTION DETAIL'),
    ...cardHeader(100),
    ...cardRow(120, 'May 26', 'May 27', 'ACME COFFEE', '6.50'),
    run('STORE 0042 SEATTLE WA', CARD.x.desc, 133), // 13pt below, same left edge
    ...cardRow(153, 'May 30', 'May 31', 'NORTH HARDWARE', '45.00'),
  ]);
  const res = applyTemplate([pg], cardTemplate({ stopAnchor: '' }));
  assert.equal(res.grid.length, 2);
  assert.equal(res.grid[0][1], 'ACME COFFEE STORE 0042 SEATTLE WA');
  assert.equal(res.grid[1][1], 'NORTH HARDWARE');
});

test('REGRESSION: a centred page footer in the description band is NOT glued (left-edge test)', () => {
  // The footer passes every geometric test EXCEPT left-edge alignment: it sits
  // 13pt under the last row and its midpoint falls inside the description
  // band — the source comment documents this exact failure shape.
  const footer = 'Additional Information on the next page';
  const pg = page(1, [
    ...textLine(58, [['Statement Period:', 40], ['May 25, 2026 - Jun 23, 2026', 150]]),
    ...textLine(80, 'TRANSACTION DETAIL'),
    ...cardHeader(100),
    ...cardRow(300, 'May 26', 'May 27', 'ACME COFFEE', '6.50'),
    run(footer, 208, 313), // centred: mid ≈ 306 → desc band; left edge 208 ≠ 165
  ]);
  const res = applyTemplate([pg], cardTemplate({ stopAnchor: '' }));
  assert.equal(res.grid[0][1], 'ACME COFFEE');
  assert.ok(res.skipped.some(s => s.text === footer));
});

test('conservation, correctly scoped: every in-scope non-empty line lands in exactly one of grid/glued/skipped', () => {
  const footer = 'Additional Information on the next page';
  const p1 = page(1, [
    ...textLine(40, 'SYNTH BANK Card Services'),
    ...textLine(58, [['Statement Period:', 40], ['May 25, 2026 - Jun 23, 2026', 150]]),
    ...textLine(80, 'TRANSACTION DETAIL'),
    ...cardHeader(100),
    ...cardRow(120, 'May 26', 'May 27', 'ACME COFFEE', '6.50'),
    run('STORE 0042 SEATTLE WA', CARD.x.desc, 133), // glued continuation
    ...cardRow(153, 'May 30', 'May 31', 'NORTH HARDWARE', '45.00'),
    run(footer, 208, 166), // in-region non-row → skipped
    ...cardRow(190, 'Jun 2', 'Jun 3', 'GREEN GROCERY', '12.00'),
  ]);
  const p2 = page(2, [
    ...cardRow(40, 'Jun 5', 'Jun 6', 'BLUE FUEL STATION', '30.00'),
    ...textLine(60, 'FEES SUMMARY'),
    ...textLine(80, 'Total fees charged this period'),
  ]);
  const p3 = page(3, [...cardRow(40, 'Jun 9', 'Jun 10', 'EXCLUDED PAGE ROW', '99.00')]);

  const res = applyTemplate([p1, p2, p3], cardTemplate({ pages: [1, 2] }));

  // grid + parallel rowMeta: the four full rows.
  assert.equal(res.grid.length, 4);
  assert.equal(res.rowMeta.length, 4);
  // glued: the wrap is inside its parent's description, in no other bucket.
  assert.equal(res.grid[0][1], 'ACME COFFEE STORE 0042 SEATTLE WA');
  // skipped: exactly the in-scope non-row, non-glue, non-anchor lines.
  assert.deepEqual(res.skipped.map(s => s.text).sort(), [
    footer,
    'Trans Date Post Date Description Amount',
  ]);
  // Everything OUTSIDE the scope (pre-anchor, anchors, post-stop, excluded
  // page) is deliberately dropped without a trace — decided behavior.
  const everywhere = JSON.stringify({ grid: res.grid, skipped: res.skipped });
  for (const dropped of ['SYNTH BANK', 'Statement Period', 'TRANSACTION DETAIL', 'FEES SUMMARY', 'Total fees', 'EXCLUDED PAGE ROW']) {
    assert.ok(!everywhere.includes(dropped), `"${dropped}" leaked into grid/skipped`);
  }
});

// ---------------------------------------------------------------------------
// normalizeDebitCredit — the reversal netting
// ---------------------------------------------------------------------------

test('normalizeDebitCredit: a negative in one column becomes a positive in the other', () => {
  // The mortgage "back out an unapplied payment" case: -$3,520.95 printed in
  // Payments (credit) is really money OUT — a positive debit.
  assert.deepEqual(normalizeDebitCredit('', '-3,520.95'), { debit: '3520.95', credit: '' });
  assert.deepEqual(normalizeDebitCredit('-45.00', ''), { debit: '', credit: '45.00' });
});

test('normalizeDebitCredit: both-populated pairs net; a zero net empties both', () => {
  assert.deepEqual(normalizeDebitCredit('100.00', '30.00'), { debit: '70.00', credit: '' });
  assert.deepEqual(normalizeDebitCredit('30.00', '100.00'), { debit: '', credit: '70.00' });
  assert.deepEqual(normalizeDebitCredit('50.00', '50.00'), { debit: '', credit: '' });
});

test('normalizeDebitCredit passes unparseable input through untouched (buildRows drops it, not a crash)', () => {
  assert.deepEqual(normalizeDebitCredit('N/A', ''), { debit: 'N/A', credit: '' });
  assert.deepEqual(normalizeDebitCredit('12.00', 'garbage'), { debit: '12.00', credit: 'garbage' });
});

// ---------------------------------------------------------------------------
// rowTotals — computed from buildRows OUTPUT, not the raw grid
// ---------------------------------------------------------------------------

test('rowTotals sums buildRows output with an out/in split and 2-decimal rounding', () => {
  const pages = [
    cardStatementPage([
      ['May 26', 'May 27', 'ACME COFFEE', '10.10'],
      ['May 28', 'May 29', 'RIVER GROCERY', '20.20'],
      ['May 30', 'May 31', 'REFUND CREDIT MEMO', '-0.30'],
    ]),
  ];
  const res = applyTemplate(pages, cardTemplate());
  const { rows } = buildRows(res.grid, res.buildOpts);
  assert.deepEqual(rowTotals(rows), { out: 30.3, in: 0.3 });
});

test('rowTotals excludes what buildRows drops (why it takes built rows, not the grid)', () => {
  // A zero-net debit/credit pair reaches the grid but buildRows skips it as a
  // zero-amount row; summing the grid would print a total covering rows the
  // user is not about to import.
  const pg = page(1, [
    ...mortgagePreamble(),
    ...textLine(100, 'ACTIVITY SINCE LAST STATEMENT'),
    ...mortgageHeader(120),
    ...mortgageRow(140, 'Jun 15', 'PAYMENT RECEIVED THANK YOU', { payment: '2,412.60' }),
    ...mortgageRow(160, 'Jun 16', 'MISC ADJUSTMENT WASH', { payment: '50.00', charge: '50.00' }),
  ]);
  const res = applyTemplate([pg], mortgageTemplate());
  assert.equal(res.grid.length, 2, 'the wash row still parses into the grid');
  const { rows, skipped } = buildRows(res.grid, res.buildOpts);
  assert.equal(rows.length, 1);
  assert.equal(skipped.length, 1);
  assert.deepEqual(rowTotals(rows), { out: 0, in: 2412.6 });
});

// ---------------------------------------------------------------------------
// Integration round-trip: synthetic pages → applyTemplate → buildRows
// ---------------------------------------------------------------------------

test('round-trip: categories, signs and transfer flags come out per the shared classifier', () => {
  // Every category here comes from a TAUGHT rule — since 2026-08-04 the
  // classifier guesses nothing, so a merchant with no rule imports
  // Uncategorized (asserted at the end of this test).
  const rules = new Map([
    ['MYSTERY VENDOR LLC', 'Side hustles and business'],
    ['RIVER GROCERY', 'Groceries'],
    ['ACME COFFEE', 'Coffee and snacks'],
  ]);
  const res = applyTemplate([cardStatementPage(CARD_ROWS)], cardTemplate());
  const { rows } = buildRows(res.grid, { ...res.buildOpts, rules });

  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(r => r.amount), [45, 6.5, 250, 12, -141.66]);

  const byDesc = Object.fromEntries(rows.map(r => [r.description, r]));
  assert.equal(byDesc['RIVER GROCERY 1467'].mapped_category, 'Groceries', 'learned rule, whole-token prefix');
  assert.equal(byDesc['ACME COFFEE 0042'].mapped_category, 'Coffee and snacks');
  assert.equal(byDesc['MYSTERY VENDOR LLC'].mapped_category, 'Side hustles and business', 'learned rule');
  assert.equal(byDesc['CAPITAL ONE MOBILE PYMT'].mapped_category, TRANSFER_CATEGORY, 'issuer + payment wording');

  const transfer = byDesc['ONLINE BANKING TRANSFER TO SAVINGS'];
  assert.equal(transfer.raw_category, 'TRANSFER_OUT');
  assert.equal(transfer.isTransfer, true);
  assert.equal(transfer.mapped_category, TRANSFER_CATEGORY);

  // Without the learned rules, EVERY ordinary merchant stays a VISIBLE
  // unknown — only the transfer/card-payment guards still assign a category.
  const bare = buildRows(res.grid, res.buildOpts).rows;
  const bareByDesc = Object.fromEntries(bare.map(r => [r.description, r]));
  assert.equal(bareByDesc['MYSTERY VENDOR LLC'].mapped_category, FALLBACK_CATEGORY);
  assert.equal(bareByDesc['RIVER GROCERY 1467'].mapped_category, FALLBACK_CATEGORY);
  assert.equal(bareByDesc['ACME COFFEE 0042'].mapped_category, FALLBACK_CATEGORY);
  assert.equal(bareByDesc['CAPITAL ONE MOBILE PYMT'].mapped_category, TRANSFER_CATEGORY, 'the guards survive');
});

test('round-trip: re-parsing the same statement yields IDENTICAL plaid_tx_ids (idempotent re-import)', () => {
  const parseOnce = () => {
    const res = applyTemplate([cardStatementPage(CARD_ROWS)], cardTemplate());
    return buildRows(res.grid, res.buildOpts).rows;
  };
  const first = parseOnce();
  const second = parseOnce();
  for (const id of first.map(r => r.plaid_tx_id)) assert.match(id, /^csv:[0-9a-f]{16}:\d+$/);
  assert.deepEqual(second.map(r => r.plaid_tx_id), first.map(r => r.plaid_tx_id));
  // …and a re-import against the first import's ids flags every row a dupe.
  const res = applyTemplate([cardStatementPage(CARD_ROWS)], cardTemplate());
  const reimport = buildRows(res.grid, { ...res.buildOpts, existingIds: new Set(first.map(r => r.plaid_tx_id)) });
  assert.ok(reimport.rows.every(r => r.isDuplicate));
});

test('round-trip: rows on/after the feed boundary are flagged overlap and excluded from the importable set', () => {
  const overlapFrom = '2026-06-15';
  const res = applyTemplate([cardStatementPage(CARD_ROWS)], cardTemplate());
  const { rows } = buildRows(res.grid, { ...res.buildOpts, overlapFrom });
  const overlapping = rows.filter(r => r.isOverlap).map(r => r.description);
  assert.deepEqual(overlapping, ['CAPITAL ONE MOBILE PYMT'], 'only the Jun 21 row is inside the feed');
  const plan = importPlan(rows, { overlapFrom });
  assert.equal(plan.verdict, 'both');
  for (const r of plan.newRows) assert.ok(r.date < overlapFrom);
  assert.equal(plan.newRows.length, 4);
});

test('one format per account: the same transaction worded CSV-style vs PDF-style gets DIFFERENT dedup ids', () => {
  // The dedup hash covers (date, amount, normalized description). A bank words
  // the same purchase differently in its CSV export and its PDF statement, so
  // the ids differ and importing both formats double-inserts — the documented
  // Gotcha this test exists to explain.
  const res = applyTemplate(
    [cardStatementPage([['May 26', 'May 27', 'RIVER GROCERY STORE 1467', '45.00']])],
    cardTemplate()
  );
  const pdfId = buildRows(res.grid, res.buildOpts).rows[0].plaid_tx_id;

  const differentWording = analyzeCsv('Date,Description,Debit,Credit\n5/27/2026,RIVER GROCERY #1467,45.00,');
  assert.notEqual(differentWording.rows[0].plaid_tx_id, pdfId);

  // Same date+amount+wording WOULD collide — the id spaces are compatible; it
  // is the wording drift that defeats dedup, not the format.
  const sameWording = analyzeCsv('Date,Description,Debit,Credit\n5/27/2026,RIVER GROCERY STORE 1467,45.00,');
  assert.equal(sameWording.rows[0].plaid_tx_id, pdfId);
});

// ---------------------------------------------------------------------------
// Sectioned statements (the Discover Cashback Debit shape, 2026-08-09): one
// unsigned Amount column, direction carried by "Deposits and Credits" /
// "... Withdrawals" headings. Without the section flip every deposit imported
// as money OUT and the comparison audit called every deposit a "sync gap".
// ---------------------------------------------------------------------------
import {
  DEPOSIT,
  depositRow,
  depositTemplate,
  depositStatementPage,
} from './helpers/pdfFixtures.js';
import { classifySectionHeading } from '../src/pdfImport.js';

const SECTIONED = [
  {
    heading: 'Deposits and Credits',
    rows: [
      ['Jul 04', 'Zelle Payment From A FRIEND', '600.00'],
      ['Jul 13', 'ACH Deposit PAYROLL From EMPLOYER', '2,640.00'],
    ],
    total: 'TOTAL DEPOSITS AND CREDITS $ 3,240.00',
  },
  {
    heading: 'Electronic Withdrawals',
    rows: [
      ['Jul 16', 'ACH Withdrawal CITY UTILITIES', '271.03'],
      ['Jul 20', 'ACH Withdrawal CABLE SVCS', '71.59'],
    ],
    total: 'TOTAL ELECTRONIC WITHDRAWALS $ 342.62',
  },
];

test('classifySectionHeading: direction words, digit veto, credit wins', () => {
  assert.equal(classifySectionHeading('Deposits and Credits'), 'in');
  assert.equal(classifySectionHeading('ATM and Debit Card Withdrawals'), 'out');
  assert.equal(classifySectionHeading('Electronic Withdrawals'), 'out');
  // Card statements: "Payments and Credits" are inflows to the card.
  assert.equal(classifySectionHeading('Payments and Credits'), 'in');
  // Totals and summary lines carry digits — never headings.
  assert.equal(classifySectionHeading('TOTAL DEPOSITS AND CREDITS $ 3,240.00'), null);
  assert.equal(classifySectionHeading('Deposits and Credits.......+$1,000.00'), null);
  assert.equal(classifySectionHeading(''), null);
  assert.equal(classifySectionHeading('ACCOUNT ACTIVITY'), null);
});

test('applyTemplate: sectioned statement flips deposits to money in', () => {
  const pages = [depositStatementPage(SECTIONED)];
  const applied = applyTemplate(pages, depositTemplate());
  assert.deepEqual(applied.sections, { in: true, out: true, applied: true });
  const { rows } = buildRows(applied.grid, applied.buildOpts);
  assert.equal(rows.length, 4);
  const amounts = rows.map(r => r.amount).sort((a, b) => a - b);
  assert.deepEqual(amounts, [-2640, -600, 71.59, 271.03]);
  const totals = rowTotals(rows);
  assert.deepEqual(totals, { out: 342.62, in: 3240 });
  // The heading BEFORE the first startAnchor occurrence governs page-1 rows —
  // the real statement prints "Deposits and Credits" above the column header.
  assert.equal(applied.rowMeta[0].section, 'in');
});

test('applyTemplate: auto-detect on the sectioned page also lands the flip', () => {
  // More rows than SECTIONED: auto-detect needs a real body under the header.
  const sections = [
    {
      heading: 'Deposits and Credits',
      rows: [
        ['Jul 04', 'Zelle Payment From A FRIEND', '600.00'],
        ['Jul 12', 'Zelle Payment From A FRIEND', '150.00'],
        ['Jul 13', 'ACH Deposit PAYROLL From EMPLOYER', '2,640.00'],
        ['Jul 24', 'ACH Deposit PAYROLL From EMPLOYER', '450.00'],
      ],
    },
    {
      heading: 'Electronic Withdrawals',
      rows: [
        ['Jul 16', 'ACH Withdrawal CITY UTILITIES', '271.03'],
        ['Jul 20', 'ACH Withdrawal CABLE SVCS', '71.59'],
        ['Jul 21', 'ACH Withdrawal CITY UTILITIES', '374.98'],
        ['Jul 28', 'Transfer To SAVINGS 0001', '3,417.00'],
      ],
    },
  ];
  const pages = [depositStatementPage(sections)];
  const det = autoDetectTemplate(pages);
  assert.ok(det, 'auto-detect finds the table');
  const applied = applyTemplate(pages, det);
  assert.equal(applied.sections.applied, true);
  const { rows } = buildRows(applied.grid, applied.buildOpts);
  const totals = rowTotals(rows);
  assert.deepEqual(totals, { out: 4134.6, in: 3840 });
});

test('applyTemplate: one heading kind alone never trips the flip', () => {
  const pages = [depositStatementPage([SECTIONED[1]])]; // withdrawals only
  const applied = applyTemplate(pages, depositTemplate());
  assert.deepEqual(applied.sections, { in: false, out: true, applied: false });
  const { rows } = buildRows(applied.grid, applied.buildOpts);
  assert.deepEqual(rowTotals(rows), { out: 342.62, in: 0 });
});

test('applyTemplate: sectionSigns:false is the escape hatch', () => {
  const pages = [depositStatementPage(SECTIONED)];
  const applied = applyTemplate(pages, depositTemplate({ sectionSigns: false }));
  assert.equal(applied.sections.applied, false);
  const { rows } = buildRows(applied.grid, applied.buildOpts);
  assert.deepEqual(rowTotals(rows), { out: 3582.62, in: 0 }); // old flat reading
});

test('applyTemplate: a printed negative inside Deposits is a reversal (money out)', () => {
  const sections = [
    {
      heading: 'Deposits and Credits',
      rows: [
        ['Jul 04', 'Zelle Payment From A FRIEND', '600.00'],
        ['Jul 05', 'Zelle Reversal', '-100.00'],
      ],
    },
    SECTIONED[1],
  ];
  const pages = [depositStatementPage(sections)];
  const applied = applyTemplate(pages, depositTemplate());
  const { rows } = buildRows(applied.grid, applied.buildOpts);
  const reversal = rows.find(r => /Reversal/.test(r.description));
  assert.equal(reversal.amount, 100); // flipped relative to print: out
  const deposit = rows.find(r => /FRIEND/.test(r.description));
  assert.equal(deposit.amount, -600);
});

test('applyTemplate: in_positive template flips the withdrawals side instead', () => {
  const pages = [depositStatementPage(SECTIONED)];
  const applied = applyTemplate(pages, depositTemplate({ amountSign: 'in_positive' }));
  const { rows } = buildRows(applied.grid, applied.buildOpts);
  // buildRows negates in_positive values; sections must land the same app signs.
  assert.deepEqual(rowTotals(rows), { out: 342.62, in: 3240 });
});

test('applyTemplate: debit/credit templates ignore section headings', () => {
  const pre = mortgagePreamble();
  const runs = [
    ...pre.map(r => r),
    ...textLine(100, 'Payments and Credits'),
    ...textLine(118, 'ACTIVITY SINCE LAST STATEMENT'),
    ...mortgageHeader(136),
    ...mortgageRow(154, '06/01/2026', 'PAYMENT RECEIVED', { payment: '2,100.00' }),
    ...textLine(180, 'Fees and Charges'),
    ...mortgageRow(198, '06/05/2026', 'LATE FEE', { charge: '35.00' }),
    ...textLine(230, 'IMPORTANT MESSAGES'),
  ];
  const applied = applyTemplate([page(1, runs)], mortgageTemplate());
  assert.equal(applied.sections.applied, false);
  const { rows } = buildRows(applied.grid, applied.buildOpts);
  assert.deepEqual(rowTotals(rows), { out: 35, in: 2100 });
});

test('applyTemplate: a heading breaks description continuation glue', () => {
  const sections = [
    { heading: 'Deposits and Credits', rows: [['Jul 04', 'Zelle Payment From A FRIEND', '600.00']] },
    { heading: 'Electronic Withdrawals', rows: [['Jul 16', 'ACH Withdrawal CITY UTILITIES', '271.03']] },
  ];
  const pages = [depositStatementPage(sections)];
  const applied = applyTemplate(pages, depositTemplate());
  const { rows } = buildRows(applied.grid, applied.buildOpts);
  assert.equal(rows.length, 2);
  assert.ok(!/Withdrawals/.test(rows[0].description), 'heading text never glued onto a row');
});
