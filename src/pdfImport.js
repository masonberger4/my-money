// PDF statement import — pure parsing core (no pdf.js, no React, no Supabase).
//
// Takes the positioned text runs produced by src/pdfExtract.js and turns them
// into the SAME 2-D cell grid + column mapping that src/csvImport.js's
// buildRows() already consumes. That is the whole design: a PDF becomes a
// CSV-shaped grid, so every downstream behavior — sign handling, category
// mapping, transfer flags, the stable dedup id, the preview, the standalone
// insert and the comparison/reconciliation audit — is reused unchanged.
//
// There is NO per-bank code. A layout is described by a TEMPLATE the user
// confirms once in the visual editor (see PdfTemplateEditor.jsx) and which is
// then saved per account and re-applied to later statements — always through
// the existing preview/confirm gate.

import { parseDate as parseNumericDate, parseMoney } from './csvImport.js';

export const TEMPLATE_VERSION = 1;

// Roles a column can carry. 'date2' is a second date column (card statements
// have Trans Date + Post Date); only the one marked 'date' is used, the other
// is kept so the user can switch which one drives the transaction date.
export const COLUMN_ROLES = ['date', 'date2', 'description', 'debit', 'credit', 'amount', 'ignore'];

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

// ---------------------------------------------------------------------------
// Cheap shape tests. These decide which lines are transaction rows, so they are
// deliberately strict: a false positive invents a transaction.
// ---------------------------------------------------------------------------

// "May 23" | "May 23, 2026" | "5/23/2026" | "2026-05-23" | "23 May"
const MONTH_NAME_RE = new RegExp(`^(${Object.keys(MONTHS).join('|')})\\.?\\s+(\\d{1,2})(?:\\s*,?\\s*(\\d{4}))?$`, 'i');
const DAY_MONTH_RE = new RegExp(`^(\\d{1,2})\\s+(${Object.keys(MONTHS).join('|')})\\.?(?:\\s*,?\\s*(\\d{4}))?$`, 'i');

export function looksLikeDate(s) {
  const v = String(s ?? '').trim();
  if (!v) return false;
  if (MONTH_NAME_RE.test(v) || DAY_MONTH_RE.test(v)) return true;
  return parseNumericDate(v) !== null;
}

// A money cell: optional sign/parens, optional $, digits with optional
// thousands separators and cents. Requires a digit. "- $69.31" and "$1,234.56"
// and "(45.00)" all qualify; a bare "2026" does not (no separator/decimal and
// four digits is far more likely a year — statements always show cents).
const MONEY_RE = /^[-+−–—(]?\s*\$?\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})?\s*\)?$|^[-+−–—(]?\s*\$?\s*\d+\.\d{2}\s*\)?$/;

export function looksLikeMoney(s) {
  // Normalize FIRST: some statement generators print a Unicode minus (U+2212)
  // or en-dash instead of a hyphen, and parseMoney only understands ASCII '-'.
  // Testing the raw string would make such a row fail the shape filter and be
  // silently dropped instead of imported as a negative amount.
  const v = normalizeMoneyText(s).trim();
  if (!v) return false;
  if (!/\d/.test(v)) return false;
  if (!MONEY_RE.test(v)) return false;
  // Reject a bare integer with no cents and no currency marker (e.g. a year or
  // a count) unless it carries $ / , / sign — statements print cents.
  if (/^\d+$/.test(v)) return false;
  return Number.isFinite(parseMoney(v));
}

// Normalize the unicode minus / en-dash some statements use so parseMoney's
// ASCII '-' handling applies.
export function normalizeMoneyText(s) {
  return String(s ?? '').replace(/[−–—]/g, '-');
}

// ---------------------------------------------------------------------------
// Dates. Month-name dates ("May 23") carry no year, so the year is inferred
// from the dates that DO have one elsewhere in the document (statement period,
// due date…). Resolved to ISO here so csvImport's parseDate just passes it
// through — the shipped CSV path is left untouched.
// ---------------------------------------------------------------------------

function isoFrom(y, m, d) {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > dim) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function dayNum(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

// A dated range like "May 25, 2026 - Jun 23, 2026" or "(06/17/2026 -
// 07/16/2026)" — i.e. the statement period. Bank-agnostic: it matches the
// shape, not any particular label.
// A date carrying its own year (4- or 2-digit), and one without ("May 25").
const D = '(?:[A-Za-z]{3,9}\\.?\\s*\\d{1,2},?\\s*\\d{2,4}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2})';
const D_NOYEAR = '(?:[A-Za-z]{3,9}\\.?\\s*\\d{1,2})';
const SEP = '\\s*(?:-|–|—|to|through|thru)\\s*';
// "May 25, 2026 - Jun 23, 2026" | "(06/17/2026 - 07/16/2026)" and the common
// shorthand where only the closing date carries the year: "May 25 - Jun 23, 2026".
const RANGE_RE = new RegExp(`(${D})${SEP}(${D})`, 'i');
const RANGE_PARTIAL_RE = new RegExp(`(${D_NOYEAR})${SEP}(${D})`, 'i');

function parseAnyDated(s) {
  const v = String(s).trim();
  const m = v.match(/^([A-Za-z]{3,9})\.?\s*(\d{1,2})\s*,?\s*(\d{2,4})$/);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (!mo) return null;
    let y = Number(m[3]);
    if (m[3].length === 2) y += y >= 70 ? 1900 : 2000;
    return isoFrom(y, mo, Number(m[2]));
  }
  return parseNumericDate(v);
}

// Month + day with no year of its own ("May 25"), used for the common shorthand
// where only the closing date of a period carries the year.
function parseMonthDayOnly(s) {
  const m = String(s).trim().match(/^([A-Za-z]{3,9})\.?\s*(\d{1,2})$/);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  return mo ? { month: mo, day: Number(m[2]) } : null;
}

// Locate the statement period. This is what anchors year inference for the
// month-name dates in the table ("May 23" has no year of its own). Using the
// period — rather than every date in the document — matters: fine print carries
// stale revision dates (a 2023 copyright line) that would otherwise widen the
// window enough to make several years equally plausible.
export function findStatementPeriod(pages) {
  const ok = (a, b) => {
    if (!a || !b) return null;
    const span = dayNum(b) - dayNum(a);
    // A billing cycle, not an arbitrary pair of dates.
    if (span < 0 || span > 200) return null;
    return { start: a, end: b };
  };
  for (const pg of pages || []) {
    for (const line of groupIntoLines(pg.runs)) {
      // Both endpoints dated: "May 25, 2026 - Jun 23, 2026".
      const full = line.text.match(RANGE_RE);
      if (full) {
        const hit = ok(parseAnyDated(full[1]), parseAnyDated(full[2]));
        if (hit) return hit;
      }
      // Only the closing date dated: "May 25 - Jun 23, 2026". Take the year
      // from the end, stepping the start back a year when the cycle wraps.
      const partial = line.text.match(RANGE_PARTIAL_RE);
      if (partial) {
        const md = parseMonthDayOnly(partial[1]);
        const end = parseAnyDated(partial[2]);
        if (md && end) {
          const endYear = Number(end.slice(0, 4));
          let start = isoFrom(endYear, md.month, md.day);
          if (start && start > end) start = isoFrom(endYear - 1, md.month, md.day);
          const hit = ok(start, end);
          if (hit) return hit;
        }
      }
    }
  }
  return null;
}

// Every date with an explicit year found anywhere in the document. Their span
// is the year context; it covers the statement period, due dates, etc. without
// having to locate any one specific label (bank-agnostic).
export function collectYearContext(pages) {
  const years = new Set();
  const isoDates = [];
  const push = iso => { if (iso) { isoDates.push(iso); years.add(Number(iso.slice(0, 4))); } };
  for (const pg of pages || []) {
    for (const run of pg.runs || []) {
      const text = String(run.str || '');
      let m;
      const withYear = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/g;
      while ((m = withYear.exec(text))) {
        const mo = MONTHS[m[1].toLowerCase()];
        if (mo) push(isoFrom(Number(m[3]), mo, Number(m[2])));
      }
      const numeric = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g;
      while ((m = numeric.exec(text))) push(isoFrom(Number(m[3]), Number(m[1]), Number(m[2])));
      const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
      while ((m = iso.exec(text))) push(isoFrom(Number(m[1]), Number(m[2]), Number(m[3])));
    }
  }
  if (!isoDates.length) return null;
  isoDates.sort();
  return { min: isoDates[0], max: isoDates[isoDates.length - 1], years: [...years].sort(), all: isoDates };
}

// The window used to resolve year-less dates. Preference order:
//  1. the statement period, padded — transaction dates sit inside it (a card's
//     transaction date can fall a few days before the cycle start, hence the pad);
//  2. failing that, the dates printed on page 1, anchored on their MEDIAN.
// Either way the window stays under ~half a year, so a given month/day resolves
// to exactly one year — including across a December→January cycle.
const PERIOD_PAD_DAYS = 45;

export function resolveYearWindow(pages) {
  const period = findStatementPeriod(pages);
  if (period) {
    const min = shiftIso(period.start, -PERIOD_PAD_DAYS);
    const max = shiftIso(period.end, PERIOD_PAD_DAYS);
    return { min, max, years: yearsBetween(min, max), source: 'period' };
  }
  const ctx = collectYearContext((pages || []).slice(0, 1)) || collectYearContext(pages);
  if (!ctx || !ctx.all?.length) return null;
  // Anchor on the MEDIAN, never the latest date. Statements print dates far
  // outside the billing cycle — a mortgage shows a 2052 maturity date, fine
  // print carries old revision years — and anchoring on the max would put the
  // whole window decades away, resolving every row to the wrong year.
  const anchor = ctx.all[Math.floor(ctx.all.length / 2)];
  const min = shiftIso(anchor, -120);
  const max = shiftIso(anchor, 45);
  return { min, max, years: yearsBetween(min, max), source: 'header-median' };
}

function shiftIso(iso, days) {
  const d = new Date((dayNum(iso) + days) * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function yearsBetween(minIso, maxIso) {
  const a = Number(minIso.slice(0, 4));
  const b = Number(maxIso.slice(0, 4));
  const out = [];
  for (let y = a; y <= b; y++) out.push(y);
  return out;
}

// Pick the year that places month/day closest to the document's date span.
// Handles the December→January wrap (a "Dec 28" row on a Dec-25→Jan-23
// statement resolves to the earlier year, "Jan 5" to the later one).
export function inferYear(month, day, ctx) {
  if (!ctx) return null;
  const lo = dayNum(ctx.min);
  const hi = dayNum(ctx.max);
  const candidates = new Set();
  for (const y of ctx.years) { candidates.add(y - 1); candidates.add(y); candidates.add(y + 1); }
  let best = null;
  for (const y of [...candidates].sort((a, b) => a - b)) {
    const iso = isoFrom(y, month, day);
    if (!iso) continue;
    const n = dayNum(iso);
    const dist = n < lo ? lo - n : n > hi ? n - hi : 0;
    if (best === null || dist < best.dist) best = { y, dist, iso };
  }
  return best ? best.iso : null;
}

// Any supported date string → ISO, using the year context when the string has
// no year of its own. Returns null when it isn't a date at all.
export function parseFlexibleDate(s, ctx) {
  const v = String(s ?? '').trim();
  if (!v) return null;
  let m = v.match(MONTH_NAME_RE);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    const day = Number(m[2]);
    if (m[3]) return isoFrom(Number(m[3]), mo, day);
    return inferYear(mo, day, ctx);
  }
  m = v.match(DAY_MONTH_RE);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    const day = Number(m[1]);
    if (m[3]) return isoFrom(Number(m[3]), mo, day);
    return inferYear(mo, day, ctx);
  }
  return parseNumericDate(v);
}

// ---------------------------------------------------------------------------
// Runs → visual lines. Runs on (roughly) the same baseline form one line.
// ---------------------------------------------------------------------------
export function groupIntoLines(runs, { yTolerance = 3 } = {}) {
  const sorted = [...(runs || [])].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const run of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(run.y - last.y) <= yTolerance) {
      last.runs.push(run);
      last.y = (last.y * (last.runs.length - 1) + run.y) / last.runs.length;
    } else {
      lines.push({ y: run.y, runs: [run] });
    }
  }
  for (const line of lines) {
    line.runs.sort((a, b) => a.x - b.x);
    line.text = line.runs.map(r => r.str).join(' ').replace(/\s+/g, ' ').trim();
    line.height = Math.max(...line.runs.map(r => r.h || 10));
  }
  return lines;
}

// Split a line into cells using fractional x-boundaries (0..1 of page width).
// Fractions rather than absolute points so a template survives a statement
// rendered at a different page size/scale. A run is assigned by its MIDPOINT,
// which keeps right-aligned amounts (whose x-start drifts with digit count) in
// their own column.
export function splitLineIntoCells(line, boundaries, pageWidth) {
  const cuts = boundaries.map(b => b * pageWidth);
  const cells = new Array(cuts.length + 1).fill(null).map(() => []);
  for (const run of line.runs) {
    const mid = run.x + (run.w || 0) / 2;
    let col = 0;
    while (col < cuts.length && mid >= cuts[col]) col++;
    cells[col].push(run.str);
  }
  return cells.map(parts => parts.join(' ').replace(/\s+/g, ' ').trim());
}

// Left edge of each column's content on a line — the x where its text starts.
// Used to tell a wrapped description (which lines up under its parent) from a
// centred page footer that merely happens to sit in the description band.
export function lineCellStarts(line, boundaries, pageWidth) {
  const cuts = boundaries.map(b => b * pageWidth);
  const starts = new Array(cuts.length + 1).fill(null);
  for (const run of line.runs) {
    const mid = run.x + (run.w || 0) / 2;
    let col = 0;
    while (col < cuts.length && mid >= cuts[col]) col++;
    if (starts[col] === null || run.x < starts[col]) starts[col] = run.x;
  }
  return starts;
}

// ---------------------------------------------------------------------------
// Auto-detection: propose a template from the document so the user usually only
// has to confirm rather than build one from scratch.
// ---------------------------------------------------------------------------

const HEADER_WORDS = [
  [/\btrans(action)?\s*date\b|\bpost(ing|ed)?\s*date\b|\bdate\b/i, 'date'],
  [/\bdescription\b|\bmerchant\b|\bpayee\b|\bdetails?\b|\btransaction\b/i, 'description'],
  [/\bdebit\b|\bcharges?\b|\bwithdrawals?\b/i, 'debit'],
  [/\bcredit\b|\bpayments?\b|\bdeposits?\b/i, 'credit'],
  [/\bamount\b/i, 'amount'],
];

// A line is a column-header candidate if it mentions a date-ish word plus at
// least one money-ish word, and contains no actual VALUES of its own — no money
// and no dates. That last test matters: a line like
// "Payment Due Date: Jul 18, 2026 | Account ending in 7885" mentions both
// "Date" and "Payment" but is a summary field, not a table header.
export function findHeaderLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text;
    if (!t || t.length > 120) continue;
    if (!/\bdate\b/i.test(t)) continue;
    const moneyish = /\bamount\b|\bdebit\b|\bcredit\b|\bcharges?\b|\bpayments?\b|\bdeposits?\b|\bwithdrawals?\b/i.test(t);
    if (!moneyish) continue;
    if (lines[i].runs.some(r => looksLikeMoney(r.str) || looksLikeDate(r.str))) continue;
    out.push(i);
  }
  return out;
}

// How many transaction-shaped lines (a date-looking run AND a money-looking
// run) directly follow a candidate header. The real table header is the one
// with rows under it, so this is what picks between candidates.
function countBodyAfter(flat, headerIdx, limit = 60) {
  let n = 0;
  for (let i = headerIdx + 1; i < flat.length && i <= headerIdx + limit; i++) {
    const line = flat[i];
    if (line.runs.some(r => looksLikeDate(r.str)) && line.runs.some(r => looksLikeMoney(r.str))) n++;
  }
  return n;
}

// Column boundaries from vertical whitespace: mark every x covered by a run on
// the candidate lines, then cut in the middle of each sufficiently wide gap.
export function suggestBoundaries(lines, pageWidth, { minGap = 8, bins = 1 } = {}) {
  const width = Math.ceil(pageWidth / bins);
  const covered = new Uint8Array(width + 2);
  for (const line of lines) {
    for (const run of line.runs) {
      const a = Math.max(0, Math.floor(run.x / bins));
      const b = Math.min(width, Math.ceil((run.x + (run.w || 0)) / bins));
      for (let i = a; i <= b; i++) covered[i] = 1;
    }
  }
  // Trim leading/trailing empty margins so they don't become columns.
  let first = 0;
  while (first <= width && !covered[first]) first++;
  let last = width;
  while (last > first && !covered[last]) last--;
  const cuts = [];
  let gapStart = null;
  for (let i = first; i <= last; i++) {
    if (!covered[i]) {
      if (gapStart === null) gapStart = i;
    } else if (gapStart !== null) {
      if ((i - gapStart) * bins >= minGap) cuts.push(((gapStart + i) / 2) * bins);
      gapStart = null;
    }
  }
  return cuts.map(c => Math.round((c / pageWidth) * 10000) / 10000);
}

// Assign a role to each column from what its cells actually contain, using the
// header line's wording as a tie-breaker.
export function suggestRoles(sampleRows, headerCells) {
  const nCols = Math.max(sampleRows[0]?.length || 0, headerCells?.length || 0);
  const stats = [];
  for (let c = 0; c < nCols; c++) {
    let dates = 0, money = 0, text = 0, nonEmpty = 0, totalLen = 0;
    for (const row of sampleRows) {
      const v = (row[c] || '').trim();
      if (!v) continue;
      nonEmpty++;
      totalLen += v.length;
      if (looksLikeDate(v)) dates++;
      else if (looksLikeMoney(v)) money++;
      else text++;
    }
    stats.push({ c, dates, money, text, nonEmpty, avgLen: nonEmpty ? totalLen / nonEmpty : 0 });
  }
  const roles = new Array(nCols).fill('ignore');
  const headerRole = c => {
    const h = (headerCells && headerCells[c]) || '';
    for (const [re, role] of HEADER_WORDS) if (re.test(h)) return role;
    return null;
  };

  // Dates: columns where most non-empty cells parse as dates. First = 'date'.
  const dateCols = stats.filter(s => s.nonEmpty && s.dates / s.nonEmpty >= 0.6).map(s => s.c);
  dateCols.forEach((c, i) => { roles[c] = i === 0 ? 'date' : 'date2'; });

  // Money columns.
  const moneyCols = stats.filter(s => s.nonEmpty && s.money / s.nonEmpty >= 0.6 && roles[s.c] === 'ignore').map(s => s.c);
  if (moneyCols.length >= 2) {
    // Two money columns → debit/credit pair; use the header wording when it
    // disambiguates, else assume left = debit (out), right = credit (in).
    const named = moneyCols.map(c => headerRole(c));
    const debitIdx = named.indexOf('debit');
    const creditIdx = named.indexOf('credit');
    if (debitIdx >= 0 && creditIdx >= 0) {
      roles[moneyCols[debitIdx]] = 'debit';
      roles[moneyCols[creditIdx]] = 'credit';
    } else {
      roles[moneyCols[0]] = 'debit';
      roles[moneyCols[1]] = 'credit';
    }
    for (let i = 2; i < moneyCols.length; i++) roles[moneyCols[i]] = 'ignore';
  } else if (moneyCols.length === 1) {
    roles[moneyCols[0]] = 'amount';
  }

  // Description: the widest remaining text column.
  const textCols = stats.filter(s => roles[s.c] === 'ignore' && s.text > 0).sort((a, b) => b.avgLen - a.avgLen);
  if (textCols.length) roles[textCols[0].c] = 'description';
  return roles;
}

// Bare-bones starting template for when auto-detect fails and the user must
// set the columns by hand in the editor. No dateColumn — applyTemplate
// defaults it to 'date'.
export function defaultTemplate() {
  return {
    version: TEMPLATE_VERSION,
    boundaries: [0.2, 0.7],
    roles: ['date', 'description', 'amount'],
    amountMode: 'signed',
    amountSign: 'out_positive',
    startAnchor: '',
    stopAnchor: '',
    pages: null,
  };
}

// Full auto-detect: find a header, derive boundaries from the rows beneath it,
// and propose roles + the anchor that bounds the table.
export function autoDetectTemplate(pages) {
  const perPage = (pages || []).map(pg => ({ ...pg, lines: groupIntoLines(pg.runs) }));
  const flat = [];
  for (const pg of perPage) for (const line of pg.lines) flat.push({ ...line, page: pg.page, pageWidth: pg.width });

  const headerIdxs = findHeaderLines(flat);
  if (!headerIdxs.length) return null;
  // Pick the candidate with the most transaction-shaped rows beneath it — the
  // real table header — rather than merely the first match in the document.
  let headerIdx = headerIdxs[0];
  let bestBody = -1;
  for (const idx of headerIdxs) {
    const n = countBodyAfter(flat, idx);
    if (n > bestBody) { bestBody = n; headerIdx = idx; }
  }
  if (bestBody <= 0) return null;
  const header = flat[headerIdx];
  const pageWidth = header.pageWidth;

  // Candidate body lines: the lines after the header that carry both a
  // date-looking and a money-looking run — i.e. plausible transaction rows.
  const body = [];
  for (let i = headerIdx + 1; i < flat.length && body.length < 40; i++) {
    const line = flat[i];
    const hasDate = line.runs.some(r => looksLikeDate(r.str));
    const hasMoney = line.runs.some(r => looksLikeMoney(r.str));
    if (hasDate && hasMoney) body.push(line);
  }
  if (!body.length) return null;

  const boundaries = suggestBoundaries([header, ...body], pageWidth);
  if (!boundaries.length) return null;

  const sampleRows = body.map(l => splitLineIntoCells(l, boundaries, pageWidth));
  const headerCells = splitLineIntoCells(header, boundaries, pageWidth);
  const roles = suggestRoles(sampleRows, headerCells);

  const hasDebitCredit = roles.includes('debit') && roles.includes('credit');
  return {
    version: TEMPLATE_VERSION,
    boundaries,
    roles,
    // Card statements print both a transaction date and a posted date. Plaid
    // reports the POSTED date, and the whole app follows Plaid's conventions —
    // so default to the second date column when there is one. Using the
    // transaction date instead makes almost every reconciled pair look like a
    // date mismatch. The editor lets the user switch.
    dateColumn: roles.includes('date2') ? 'date2' : 'date',
    amountMode: hasDebitCredit ? 'debitcredit' : 'signed',
    // Statements print money leaving the account as a positive charge, so a
    // single signed column is "positive = money out" — matching the app.
    amountSign: 'out_positive',
    startAnchor: header.text.slice(0, 60),
    stopAnchor: '',
    pages: null,
  };
}

// Detecting "this statement's layout changed" is deliberately EMPIRICAL rather
// than a hash of the document. A content hash of page 1 is useless here twice
// over: page 1 changes every month (balances, marketing, run counts) so it
// false-alarms constantly, and the template actually depends on the transaction
// table's geometry, which lives on later pages — so a real change there
// wouldn't be caught. Instead applyTemplate reports whether the anchor was
// found and whether any rows parsed; those are the only outcomes that matter,
// and neither can be tripped by cosmetic change.

// ---------------------------------------------------------------------------
// Applying a template → the cell grid buildRows() consumes.
//
// Row selection is deliberately SHAPE-BASED rather than an absolute y-region:
// statements have a different number of rows every month, so a saved y-window
// would break on the next statement. A line is a transaction row only if its
// date column parses as a date AND a money column parses as money — and only
// while inside the anchored region (which excludes the summary blocks that also
// contain dates and dollar amounts, e.g. a mortgage statement's payment tables).
// ---------------------------------------------------------------------------
const CANONICAL_COLUMNS = { date: 0, description: 1, debit: 2, credit: 3, amount: 4 };
// How far a wrapped description line may start from its parent's left edge.
const DESC_CONTINUATION_X_TOL = 12;
// How far below its parent a wrapped line may sit, as a multiple of line
// height. This must stay BELOW the table's row pitch: if the band is wider
// than one row slot, then any fixed page element sitting where the next row
// would have gone (a footer, a section title) qualifies as a continuation.
// Measured on a real card statement: row pitch 16.8pt, genuine wraps 13.2pt
// below their parent, the page footer 16.8pt — so 1.8× line height (14.4pt)
// admits the wraps and excludes both.
const DESC_CONTINUATION_Y_FACTOR = 1.8;

// ---------------------------------------------------------------------------
// Sectioned statements. Deposit-account statements (Discover Cashback Debit is
// the live case) print ONE unsigned Amount column under direction-carrying
// section headings — "Deposits and Credits", then "ATM and Debit Card
// Withdrawals" / "Electronic Withdrawals". Read as a flat signed column, every
// deposit imports as money OUT: July 2026 parsed as $29,039.65 out / $0 in when
// the statement itself said $15,503.65 out + $13,536.00 in, and the comparison
// audit then reported every deposit as a "sync gap" (file +600 vs feed −600).
//
// classifySectionHeading decides a heading's direction. It only ever sees lines
// that carry NO digits (a real heading is words only), which is what keeps the
// ACCOUNT SUMMARY box ("Deposits and Credits...+$13,536.00") and the
// "TOTAL DEPOSITS AND CREDITS $ 13,536.00" rows from matching. Credit-ish words
// win when both kinds appear, so a card statement's "Payments and Credits"
// (both inflows to a card) reads 'in'.
// ---------------------------------------------------------------------------
const SECTION_IN_RE = /\b(deposits?|credits?|additions)\b/i;
const SECTION_OUT_RE = /\b(withdrawals?|debits?|purchases?|checks?|fees?|charges?|payments?)\b/i;

export function classifySectionHeading(text) {
  const v = String(text ?? '').trim();
  if (!v || v.length > 80) return null;
  if (/\d/.test(v)) return null; // headings are words only; totals/summary lines carry digits
  if (SECTION_IN_RE.test(v)) return 'in';
  if (SECTION_OUT_RE.test(v)) return 'out';
  return null;
}

export function applyTemplate(pages, template) {
  const t = template || {};
  const boundaries = t.boundaries || [];
  const roles = t.roles || [];
  const ctx = resolveYearWindow(pages);
  const wantPages = Array.isArray(t.pages) && t.pages.length ? new Set(t.pages) : null;

  const roleCol = role => roles.indexOf(role);
  const dateCol = roleCol(t.dateColumn === 'date2' && roles.includes('date2') ? 'date2' : 'date');
  const descCol = roleCol('description');
  const debitCol = roleCol('debit');
  const creditCol = roleCol('credit');
  const amountCol = roleCol('amount');

  const grid = [];
  const rowMeta = [];
  const skipped = [];
  let inside = !t.startAnchor;
  let anchorFound = !t.startAnchor;
  const startRe = t.startAnchor ? new RegExp(escapeRe(t.startAnchor).replace(/\\\s+/g, '\\s+'), 'i') : null;
  const stopRe = t.stopAnchor ? new RegExp(escapeRe(t.stopAnchor).replace(/\\\s+/g, '\\s+'), 'i') : null;
  let lastRowIndex = -1;
  let lastY = null;
  let lastPage = null;
  let lastDescX = null;

  // Section tracking (see classifySectionHeading above). The current section is
  // tracked even OUTSIDE the anchored region: on the live Discover layout the
  // "Deposits and Credits" heading sits immediately BEFORE the column-header
  // line that is the startAnchor, so gating on `inside` would leave page 1's
  // deposits unsectioned. rowSections[i] is the section grid[i] was read under
  // (null before any heading); the flip is applied after the scan, and only
  // when the gate below says this really is a sectioned statement.
  //
  // Two containment rules, both from adversarial review of the first cut:
  // - A "TOTAL …" line ends its section (curSection back to null), so rows
  //   under a later heading the classifier can't read (digits, odd wording)
  //   default to the flat reading instead of inheriting the previous
  //   direction — the safe failure is "not flipped".
  // - The stopAnchor also resets the section: a re-anchored continuation
  //   table must not inherit a direction from fine print between regions.
  let curSection = null;
  const rowSections = [];
  const TOTAL_LINE_RE = /^total\b/i;
  const noteSectionLine = text => {
    if (TOTAL_LINE_RE.test(String(text ?? '').trim())) { curSection = null; return false; }
    const heading = classifySectionHeading(text);
    if (!heading) return false;
    curSection = heading;
    return true;
  };

  for (const pg of pages || []) {
    if (wantPages && !wantPages.has(pg.page)) continue;
    const lines = groupIntoLines(pg.runs);
    for (const line of lines) {
      if (startRe && startRe.test(line.text)) { inside = true; anchorFound = true; lastRowIndex = -1; lastDescX = null; continue; }
      if (stopRe && stopRe.test(line.text)) { inside = false; curSection = null; lastRowIndex = -1; lastDescX = null; continue; }
      if (!inside) { noteSectionLine(line.text); continue; }

      const cells = splitLineIntoCells(line, boundaries, pg.width);
      const rawDate = dateCol >= 0 ? cells[dateCol] || '' : '';
      const iso = parseFlexibleDate(rawDate, ctx);
      const moneyCells = [debitCol, creditCol, amountCol].filter(c => c >= 0).map(c => cells[c] || '');
      const hasMoney = moneyCells.some(v => looksLikeMoney(v));

      if (iso && hasMoney) {
        const row = ['', '', '', '', ''];
        row[CANONICAL_COLUMNS.date] = iso;
        row[CANONICAL_COLUMNS.description] = descCol >= 0 ? cells[descCol] || '' : '';
        if (t.amountMode === 'debitcredit') {
          const pair = normalizeDebitCredit(
            normalizeMoneyText(debitCol >= 0 ? cells[debitCol] || '' : ''),
            normalizeMoneyText(creditCol >= 0 ? cells[creditCol] || '' : '')
          );
          row[CANONICAL_COLUMNS.debit] = pair.debit;
          row[CANONICAL_COLUMNS.credit] = pair.credit;
        } else {
          row[CANONICAL_COLUMNS.amount] = normalizeMoneyText(amountCol >= 0 ? cells[amountCol] || '' : '');
        }
        grid.push(row);
        rowSections.push(curSection);
        rowMeta.push({ page: pg.page, y: line.y, text: line.text, rawDate, section: curSection });
        lastRowIndex = grid.length - 1;
        lastY = line.y;
        lastPage = pg.page;
        lastDescX = descCol >= 0 ? lineCellStarts(line, boundaries, pg.width)[descCol] : null;
        continue;
      }

      // Continuation of the previous row's description: same page, immediately
      // below it, text only in the description column (no date, no money), AND
      // starting at the same left edge as the parent's description.
      //
      // That last test is load-bearing. Without it a centred page footer
      // ("Additional Information on the next page") satisfies every geometric
      // condition — it sits just under the last row of the page and its
      // midpoint falls in the description band — and gets glued onto a real
      // transaction's description. A wrapped description lines up under its
      // parent; a centred footer does not.
      const descOnly =
        lastRowIndex >= 0 &&
        pg.page === lastPage &&
        lastY !== null &&
        line.y - lastY > 0 &&
        line.y - lastY < (line.height || 10) * DESC_CONTINUATION_Y_FACTOR &&
        !iso &&
        !hasMoney &&
        descCol >= 0 &&
        (cells[descCol] || '').trim() !== '' &&
        cells.every((v, i) => i === descCol || !String(v).trim()) &&
        lastDescX !== null &&
        (() => {
          const x = lineCellStarts(line, boundaries, pg.width)[descCol];
          return x !== null && Math.abs(x - lastDescX) <= DESC_CONTINUATION_X_TOL;
        })();
      if (descOnly) {
        grid[lastRowIndex][CANONICAL_COLUMNS.description] =
          `${grid[lastRowIndex][CANONICAL_COLUMNS.description]} ${cells[descCol].trim()}`.replace(/\s+/g, ' ').trim();
        lastY = line.y;
        continue;
      }

      // Section headings are classified only AFTER the row and continuation
      // tests fail (review fix): a wrapped description's second line is often
      // digit-free and can contain direction words ("PREAUTHORIZED PAYMENT",
      // "PAYMENT THANK YOU") — geometry says it's a continuation, and the glue
      // must win or the text is silently dropped, which would change the row's
      // dedup hash and flip the section mid-table.
      if (noteSectionLine(line.text)) {
        // A heading ends any row, so a continuation can't glue across it.
        lastRowIndex = -1;
        lastDescX = null;
        continue;
      }

      if (line.text) skipped.push({ page: pg.page, y: Math.round(line.y), text: line.text.slice(0, 90) });
      lastRowIndex = -1;
      lastDescX = null;
    }
  }

  const columns =
    t.amountMode === 'debitcredit'
      ? { date: 0, description: 1, debit: 2, credit: 3, amount: -1 }
      : { date: 0, description: 1, debit: -1, credit: -1, amount: 4 };

  // Sectioned-statement sign fix. Gates, hardened by adversarial review:
  // - single amount column only (`debitcredit` templates carry direction in
  //   their columns already);
  // - `sectionSigns: false` is the per-template escape hatch, `true` forces
  //   the flip on for a layout the heuristics reject;
  // - in auto mode (field absent), BOTH directions must actually GOVERN rows
  //   (a heading with no transactions under it — fine print, tail-page
  //   disclosures — counts for nothing), and the flip must be CORRECTIVE:
  //   if the rows the flip would touch mostly already print the sign their
  //   section implies, the column is a signed one that happens to sit under
  //   direction-worded headings (a card statement's "Payments and Credits"
  //   over negative-printed payments) and flipping would invert correct
  //   values — so auto mode declines.
  // Rows read before any heading (or after a TOTAL line) keep the flat
  // amountSign reading. The flip is RELATIVE to the printed value, not an
  // abs(): a negative printed inside "Deposits and Credits" is a reversal and
  // must land as money out, exactly like normalizeDebitCredit's reasoning.
  let sectionsApplied = false;
  const sawIn = rowSections.includes('in');
  const sawOut = rowSections.includes('out');
  if (t.amountMode !== 'debitcredit' && t.sectionSigns !== false) {
    const inPositive = (t.amountSign || 'out_positive') === 'in_positive';
    const flips = []; // [index, printedValue]
    let alreadyAgree = 0;
    for (let i = 0; i < grid.length; i++) {
      const sec = rowSections[i];
      if (!sec) continue;
      // amountSign says what a POSITIVE cell means downstream; flip whenever
      // the section says the opposite of that.
      const flip = sec === 'in' ? !inPositive : inPositive;
      if (!flip) continue;
      const v = parseMoney(normalizeMoneyText(grid[i][CANONICAL_COLUMNS.amount]));
      if (!Number.isFinite(v) || v === 0) continue;
      // Would the UN-flipped reading already land on the section's side?
      // (Printed negatives under "Deposits and Credits" on an out_positive
      // template.) A few of these are reversals; a majority means the column
      // is already signed.
      const appNoFlip = inPositive ? -v : v;
      if (sec === 'in' ? appNoFlip < 0 : appNoFlip > 0) alreadyAgree++;
      flips.push([i, v]);
    }
    sectionsApplied =
      flips.length > 0 &&
      (t.sectionSigns === true ||
        (sawIn && sawOut && alreadyAgree / flips.length <= 0.5));
    if (sectionsApplied) {
      for (const [i, v] of flips) {
        grid[i][CANONICAL_COLUMNS.amount] = (-v).toFixed(2);
      }
    }
  }

  return {
    grid,
    columns,
    sections: { in: sawIn, out: sawOut, applied: sectionsApplied },
    // buildRows(): headerIndex -1 makes it read from row 0 (the grid has no
    // header row); dates are already ISO so parseDate passes them through.
    buildOpts: { headerIndex: -1, columns, amountSign: t.amountSign || 'out_positive' },
    rowMeta,
    skipped,
    yearContext: ctx,
    // Did the region marker this template relies on actually appear, and did
    // anything parse? Either failing means this statement doesn't match the
    // saved layout — the UI asks the user to re-confirm the columns.
    anchorFound,
    layoutSuspect: (!!t.startAnchor && !anchorFound) || grid.length === 0,
  };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Statements sometimes print a NEGATIVE value inside a Debit/Credit pair to
// mean a reversal (a mortgage statement shows "-$3,520.95" in Payments to back
// out an unapplied partial payment). buildRows() treats those two columns as
// positive magnitudes (Math.abs — deliberately, so a stray sign in a bank CSV
// can't flip a purchase into a deposit), which would collapse a reversal and
// the payment it reverses into the same direction.
//
// Resolve it here instead of loosening the shipped CSV rule: a negative in one
// column is exactly a positive in the other, so swap it across. The signed math
// (debit − credit) then comes out right and the CSV path is untouched.
export function normalizeDebitCredit(debitRaw, creditRaw) {
  const d = String(debitRaw ?? '').trim();
  const c = String(creditRaw ?? '').trim();
  const dv = d ? parseMoney(d) : 0;
  const cv = c ? parseMoney(c) : 0;
  if (!Number.isFinite(dv) || !Number.isFinite(cv)) return { debit: d, credit: c };
  // Net the pair, then place the magnitude in the column its sign implies.
  const net = dv - cv; // positive = money out
  if (net > 0) return { debit: net.toFixed(2), credit: '' };
  if (net < 0) return { debit: '', credit: (-net).toFixed(2) };
  return { debit: '', credit: '' };
}

// Totals of the rows that will ACTUALLY be imported, for the "does this match
// the statement's stated total?" check surfaced in the UI. Deliberately takes
// buildRows' output rather than the raw grid: only those rows carry the
// template's sign convention applied, and only they exclude the rows buildRows
// drops (unreadable or zero-amount). Summing the grid instead would print a
// total that doesn't correspond to anything the user is about to import.
export function rowTotals(builtRows) {
  let out = 0;
  let inn = 0;
  for (const r of builtRows || []) {
    const amt = Number(r.amount) || 0;
    if (amt > 0) out += amt;
    else inn += -amt;
  }
  return { out: Number(out.toFixed(2)), in: Number(inn.toFixed(2)) };
}
