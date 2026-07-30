// CSV import — pure parsing & mapping core (no React, no Supabase).
//
// Turns raw bank-CSV text into the exact transaction rows the standalone
// importer will upsert. Everything here is deterministic and side-effect free
// so it can be unit-tested and dry-run without touching the database. The
// Supabase writes live in dataAdapter.js (importCsvTransactions et al.).
//
// BECU is the first (and only auto-detected) preset: separate Debit/Credit
// columns of positive magnitudes, dates in M/D/YYYY, and a header row that may
// sit below a few preamble lines. Other banks fall back to manual column
// mapping in the UI, which feeds the same buildRows() below.
//
// Amount sign convention (matches the rest of the app: positive = money OUT):
//   csvSignedValue = Credit - Debit      (positive = money in)
//   amount         = -csvSignedValue     (= Debit - Credit, positive = out)
// So a purchase (Debit) lands positive and a deposit (Credit) lands negative.

// The descriptor→category rule table and the internal-transfer tagging moved to
// src/txClassify.js when the SimpleFIN sync became a second caller (it also
// gets a descriptor and no category). Re-exported here so this module's public
// surface — which test/csvImport.test.js imports from — is unchanged.
import { guessCategory, transferRawCategory } from './txClassify.js';

export { guessCategory, transferRawCategory, invalidRuleCategories } from './txClassify.js';

// ---------------------------------------------------------------------------
// CSV tokenizer — a small state machine so quoted fields (embedded commas,
// escaped "" quotes, embedded newlines) parse correctly. Naive split(',')
// mangles descriptions like "AMAZON, INC". Handles CRLF/LF and a leading BOM.
// Returns an array of rows, each an array of cell strings.
// ---------------------------------------------------------------------------
export function parseCsv(text) {
  const rows = [];
  if (text == null) return rows;
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // strip BOM
  let field = '';
  let row = [];
  let inQuotes = false;
  let i = 0;
  const n = s.length;
  let sawAny = false; // did the current row have any content/structure?

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    sawAny = false;
  };

  while (i < n) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      // Only an opening quote at the START of a field enters quoted mode. A
      // stray '"' mid-field (e.g. a literal inch mark: 55" TV) is kept as a
      // literal char — otherwise it would swallow the next delimiter, newline,
      // and following rows, silently dropping real transactions. Matches the
      // lenient behavior of Papaparse / Python's csv.
      inQuotes = true;
      sawAny = true;
      i++;
      continue;
    }
    if (c === ',') {
      endField();
      sawAny = true;
      i++;
      continue;
    }
    if (c === '\r') {
      // swallow CRLF and lone CR as a single row break
      endRow();
      if (s[i + 1] === '\n') i++;
      i++;
      continue;
    }
    if (c === '\n') {
      endRow();
      i++;
      continue;
    }
    field += c;
    sawAny = true;
    i++;
  }
  // flush trailing field/row (file not ending in newline)
  if (field !== '' || row.length > 0 || sawAny) endRow();
  return rows;
}

// A row is "blank" when every cell is empty/whitespace. These are skipped
// wholesale (preamble spacer lines, trailing newline artifacts).
function isBlankRow(cells) {
  return !cells || cells.every(c => String(c ?? '').trim() === '');
}

// ---------------------------------------------------------------------------
// Header detection. Column synonyms are matched case-insensitively against the
// cells of each row; the first row that yields a date column plus either a
// (debit AND credit) pair or a single amount column is treated as the header.
// This lets the real header sit under BECU preamble lines.
// ---------------------------------------------------------------------------
const HEADER_SYNONYMS = {
  date: [/^post(ing|ed)?\s*date$/i, /^transaction\s*date$/i, /date/i],
  description: [/description/i, /^memo$/i, /^name$/i, /payee/i, /^details?$/i, /transaction/i],
  debit: [/^debit$/i, /debit/i, /withdrawal/i, /^amount\s*debit$/i, /charges?/i, /money\s*out/i],
  credit: [/^credit$/i, /credit/i, /deposit/i, /^amount\s*credit$/i, /payments?/i, /money\s*in/i],
  amount: [/^amount$/i, /^transaction\s*amount$/i],
};

function matchColumn(cell, patterns) {
  const v = String(cell ?? '').trim();
  if (!v) return false;
  return patterns.some(re => re.test(v));
}

// Find, for one candidate header row, the index of the best cell for each role.
// "description" deliberately does not fall back to the generic /transaction/i
// pattern when a more specific column already claimed a role, to avoid a
// "Transaction Date" cell being read as the description.
function mapHeaderRow(cells) {
  const used = new Set();
  const pick = role => {
    const patterns = HEADER_SYNONYMS[role];
    // Prefer earlier (more specific) patterns; scan pattern-major so a strict
    // /^debit$/ wins over a loose /debit/ on a different column.
    for (const re of patterns) {
      for (let idx = 0; idx < cells.length; idx++) {
        if (used.has(idx)) continue;
        const v = String(cells[idx] ?? '').trim();
        if (v && re.test(v)) {
          used.add(idx);
          return idx;
        }
      }
    }
    return -1;
  };
  const date = pick('date');
  const description = pick('description');
  const debit = pick('debit');
  const credit = pick('credit');
  const amount = pick('amount');
  return { date, description, debit, credit, amount };
}

function isUsableMapping(m) {
  if (!m || m.date < 0) return false;
  const hasDebitCredit = m.debit >= 0 && m.credit >= 0;
  const hasAmount = m.amount >= 0;
  return (hasDebitCredit || hasAmount) && m.description >= 0;
}

// Scan rows for the header. Returns { headerIndex, columns } or null.
export function detectHeader(rows) {
  for (let r = 0; r < rows.length; r++) {
    if (isBlankRow(rows[r])) continue;
    const m = mapHeaderRow(rows[r]);
    if (isUsableMapping(m)) {
      return { headerIndex: r, columns: m };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Value parsing.
// ---------------------------------------------------------------------------

// "$1,234.50" | "(45.00)" | "-45" | "" → number magnitude/sign. Returns 0 for
// blank. Parentheses and a leading minus both denote negatives (used only for
// the single-amount fallback; Debit/Credit columns are positive magnitudes).
export function parseMoney(raw) {
  let v = String(raw ?? '').trim();
  if (v === '') return 0;
  let neg = false;
  if (/^\(.*\)$/.test(v)) {
    neg = true;
    v = v.slice(1, -1);
  }
  v = v.replace(/[$\s,]/g, '');
  if (v.startsWith('-')) {
    neg = !neg;
    v = v.slice(1);
  }
  if (v.startsWith('+')) v = v.slice(1);
  if (v === '' || !/^\d*\.?\d+$/.test(v)) return NaN;
  const num = Number(v);
  if (!Number.isFinite(num)) return NaN;
  return neg ? -num : num;
}

// M/D/YYYY (BECU) or M/D/YY → ISO YYYY-MM-DD. Also passes through an already
// ISO date. Returns null when it can't parse — the caller flags the row rather
// than handing an ambiguous string to new Date().
export function parseDate(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return null;
  // already ISO
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const [, y, mo, d] = m;
    return isValidYmd(+y, +mo, +d) ? `${y}-${mo}-${d}` : null;
  }
  // M/D/YYYY or M/D/YY (also accepts - or . separators)
  m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) {
    let [, mo, d, y] = m;
    let year = +y;
    if (y.length === 2) year += year >= 70 ? 1900 : 2000;
    const mm = +mo;
    const dd = +d;
    if (!isValidYmd(year, mm, dd)) return null;
    return `${String(year).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }
  return null;
}

function isValidYmd(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month = last day
  return d <= dim;
}

// ---------------------------------------------------------------------------

// Dedup id. plaid_tx_id = 'csv:' + fnv1a64(date|amount|normDesc) + ':' + ordinal
// where ordinal counts how many EARLIER rows in this same file share the hash —
// used only to keep genuinely identical (date, amount, description) rows
// distinct. The absolute file row-index is deliberately NOT part of the id:
// the next export can prepend rows and shift every position, and folding that
// in would re-hash every transaction and break idempotent re-import.
// ---------------------------------------------------------------------------
export const CSV_TX_ID_PREFIX = 'csv:';

export function normalizeDescription(desc) {
  return String(desc ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

// 64-bit FNV-1a via BigInt (available in Node + all modern browsers). 64 bits
// keeps collisions between distinct rows negligible even over years of history
// — a collision would drop a real transaction as a false duplicate.
export function fnv1a64Hex(str) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    hash ^= BigInt(s.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

export function baseHash(dateIso, amount, normDesc) {
  // Normalize -0 and float noise via toFixed(2); numeric() column is 2-dp.
  const amt = (amount + 0).toFixed(2);
  return fnv1a64Hex(`${dateIso}|${amt}|${normDesc}`);
}

// ---------------------------------------------------------------------------
// Row construction. Given tokenized rows + a column mapping, produce the
// prospective transaction rows (ready to upsert) plus skipped-row diagnostics.
//
// opts:
//   headerIndex   — index of the header row (data starts after it)
//   columns       — { date, description, debit, credit, amount } indices
//   amountSign    — for single-amount columns: 'in_positive' (bank statement
//                   default: positive = deposit) or 'out_positive'.
//   existingIds   — Set of plaid_tx_id already in the DB for the target account
//                   (used to flag duplicates; empty for a brand-new account).
//   rules         — learned merchant→category rules (see category_rules).
//   overlapFrom   — ISO date where a live feed's own coverage begins. Rows on
//                   or after it are flagged isOverlap and must NOT be imported:
//                   csv: and sfin: dedup ids are different namespaces and can't
//                   see each other, so importing across the boundary silently
//                   double-counts every transaction in the overlap.
//
// Each built row carries display fields (rawDebit/rawCredit/rawDate) for the
// preview and the final insert-shape fields (date, amount, description, …).
// ---------------------------------------------------------------------------
export function buildRows(rows, opts = {}) {
  const {
    headerIndex = -1,
    columns,
    amountSign = 'in_positive',
    existingIds = new Set(),
    rules = null,
    overlapFrom = null,
  } = opts;
  if (!columns) throw new Error('buildRows requires a column mapping');

  const built = [];
  const skipped = [];
  const seenHash = new Map(); // baseHash → count within this file
  const seenId = new Set(); // plaid_tx_id already emitted this file

  const cell = (cells, idx) => (idx >= 0 && idx < cells.length ? cells[idx] : '');

  for (let r = headerIndex + 1; r < rows.length; r++) {
    const cells = rows[r];
    if (isBlankRow(cells)) continue;

    const rawDate = String(cell(cells, columns.date) ?? '').trim();
    const rawDesc = String(cell(cells, columns.description) ?? '').trim();
    const dateIso = parseDate(rawDate);

    // Compute the signed app amount (positive = money out).
    let amount;
    let rawDebit = '';
    let rawCredit = '';
    if (columns.debit >= 0 || columns.credit >= 0) {
      rawDebit = String(cell(cells, columns.debit) ?? '').trim();
      rawCredit = String(cell(cells, columns.credit) ?? '').trim();
      const debit = parseMoney(rawDebit);
      const credit = parseMoney(rawCredit);
      if (Number.isNaN(debit) || Number.isNaN(credit)) {
        amount = NaN;
      } else {
        // Debit/Credit columns are positive magnitudes by definition — take the
        // magnitude so a stray sign or "(45.00)" in a cell can't flip direction.
        // csvSignedValue = Credit - Debit (positive = in); amount = -that.
        amount = Math.abs(debit) - Math.abs(credit);
      }
    } else {
      const rawAmt = String(cell(cells, columns.amount) ?? '').trim();
      rawDebit = rawAmt;
      const signed = parseMoney(rawAmt); // may already carry a sign
      if (Number.isNaN(signed)) {
        amount = NaN;
      } else {
        // amountSign describes what a POSITIVE value in the column means.
        amount = amountSign === 'out_positive' ? signed : -signed;
      }
    }

    const problems = [];
    if (!dateIso) problems.push('unparseable date');
    if (Number.isNaN(amount)) problems.push('unparseable amount');
    if (!rawDesc) problems.push('empty description');
    // A zero-amount row carries no spend/income signal — skip as noise (e.g.
    // memo/informational lines) rather than inserting a $0 transaction.
    const zeroAmount = !Number.isNaN(amount) && Math.abs(amount) < 0.005;

    if (problems.length || zeroAmount) {
      skipped.push({
        rowIndex: r,
        rawDate,
        rawDesc,
        rawDebit,
        rawCredit,
        reason: problems.length ? problems.join(', ') : 'zero amount',
      });
      continue;
    }

    const normDesc = normalizeDescription(rawDesc);
    const hash = baseHash(dateIso, amount, normDesc);
    const ordinal = seenHash.get(hash) || 0;
    seenHash.set(hash, ordinal + 1);
    const plaid_tx_id = `${CSV_TX_ID_PREFIX}${hash}:${ordinal}`;

    const raw_category = transferRawCategory(rawDesc, amount);
    // Learned merchant rules apply here too, or a merchant taught from a synced
    // transaction would still import Uncategorized from a CSV.
    const mapped_category = guessCategory(rawDesc, { rules });

    built.push({
      // insert-shape (mirrors api/sync.js mapTransactionRow; household_id is
      // omitted so the column default current_household_id() fills it in on the
      // authenticated client, and user-owned columns are omitted so re-imports
      // preserve edits):
      plaid_tx_id,
      date: dateIso,
      amount: Number(amount.toFixed(2)),
      merchant_name: '',
      description: rawDesc,
      raw_category,
      mapped_category,
      pending: false,
      // preview-only / diagnostics (stripped before insert):
      rowIndex: r,
      rawDate,
      rawDebit,
      rawCredit,
      isTransfer: !!raw_category,
      isDuplicate: existingIds.has(plaid_tx_id) || seenId.has(plaid_tx_id),
      // Inside the live feed's coverage — the feed already has this period.
      isOverlap: !!overlapFrom && dateIso >= overlapFrom,
    });
    seenId.add(plaid_tx_id);
  }

  return { rows: built, skipped };
}

// Strip preview-only fields, leaving the exact object to upsert. `source` is
// added by the insert layer only when the column exists (graceful degrade).
const INSERT_KEYS = [
  'plaid_tx_id',
  'date',
  'amount',
  'merchant_name',
  'description',
  'raw_category',
  'mapped_category',
  'pending',
];
export function toInsertRow(built) {
  const out = {};
  for (const k of INSERT_KEYS) out[k] = built[k];
  return out;
}

// ---------------------------------------------------------------------------
// What the importer should DO with a parsed file, derived from where its rows
// fall relative to the feed's coverage.
//
// This exists because, with Plaid gone, the target account can no longer answer
// the question. Every account is now either manual or SimpleFIN-fed, and a fed
// account is a legitimate target for BOTH "fill in the history the feed never
// had" (inserts) and "check this statement against the feed" (inserts nothing).
// Asking the user to pick would be asking them to answer something the file
// already answers: rows before the boundary can only be backfill, rows on or
// after it can only be an audit.
//
//   'empty'  — nothing parsed
//   'import' — no boundary, or every row predates it → a pure backfill
//   'audit'  — every row is inside the feed's coverage → nothing to insert
//   'both'   — the file straddles the boundary → import the old part, audit the rest
//
// SAFETY: `verdict` is advisory — it decides which sections the modal shows and
// nothing else. The insert set is `newRows`, whose definition is unchanged and
// depends only on `isOverlap`/`isDuplicate`. So a wrong verdict can render a
// confusing screen; it structurally cannot widen what gets written.
export function importPlan(rows = [], { overlapFrom = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const overlapRows = list.filter(r => r.isOverlap);
  const newRows = list.filter(r => !r.isDuplicate && !r.isOverlap);
  const dupCount = list.filter(r => r.isDuplicate && !r.isOverlap).length;

  let verdict;
  if (list.length === 0) verdict = 'empty';
  else if (!overlapFrom) verdict = 'import';
  else if (overlapRows.length === list.length) verdict = 'audit';
  else if (overlapRows.length === 0) verdict = 'import';
  else verdict = 'both';

  return { verdict, newRows, overlapRows, dupCount, overlapCount: overlapRows.length };
}

// ---------------------------------------------------------------------------
// One-call convenience used by the UI: raw text → detection + built rows.
// Returns { header, columns, rows, skipped, needsManualMapping }.
// ---------------------------------------------------------------------------
export function analyzeCsv(text, { existingIds = new Set(), manualColumns = null, amountSign = 'in_positive', rules = null, overlapFrom = null } = {}) {
  const rows = parseCsv(text);
  const detected = manualColumns
    ? { headerIndex: manualColumns.headerIndex ?? -1, columns: manualColumns }
    : detectHeader(rows);
  if (!detected) {
    return {
      parsedRowCount: rows.length,
      header: null,
      columns: null,
      rows: [],
      skipped: [],
      needsManualMapping: true,
    };
  }
  const { rows: built, skipped } = buildRows(rows, {
    headerIndex: detected.headerIndex,
    columns: detected.columns,
    existingIds,
    amountSign,
    rules,
    overlapFrom,
  });
  return {
    parsedRowCount: rows.length,
    header: detected.headerIndex,
    columns: detected.columns,
    rows: built,
    skipped,
    needsManualMapping: false,
  };
}

// ===========================================================================
// Reconciliation (Comparison mode — Phase 2). When the import target is a
// Plaid-LINKED account, we insert NOTHING (that's the double-count trap).
// Instead we reconcile the CSV rows against what Plaid already synced and emit
// a read-only audit:
//   • matched            — same amount, dates within a few days (Plaid's
//                          posted/pending dates drift); the pair may still
//                          differ on date or category (flagged).
//   • amountMismatches    — no exact-amount match, but a leftover pair whose
//                          descriptions are clearly the same merchant a few
//                          days apart → likely the same txn at a different
//                          amount (a real discrepancy worth surfacing).
//   • csvOnly            — in the CSV, no Plaid counterpart → a sync GAP
//                          (Plaid missed it) worth investigating.
//   • plaidOnly          — synced by Plaid, absent from the CSV → pending /
//                          timing / not-yet-exported.
// Matching is exact-amount + date-window with a maximum bipartite matching so
// a cluster of equal-amount transactions pairs up as fully as possible (no
// greedy stranding), preferring the closest date then the most similar
// description as tie-breakers.
// ===========================================================================
const RECONCILE_WINDOW_DAYS = 4;
const AMOUNT_MISMATCH_MIN_SIMILARITY = 0.6;
// A same-transaction amount discrepancy (tip, pending→posted) is small; a large
// gap means two DIFFERENT purchases at the same merchant. Only surface an
// amount mismatch when the amounts are close, so the 2nd pass can't swallow a
// real sync gap by pairing two unrelated same-merchant transactions.
const AMOUNT_MISMATCH_MAX_ABS = 15; // dollars — covers small tips on small bills
const AMOUNT_MISMATCH_MAX_RATIO = 0.3; // …or within 30% for larger bills

function isoDayNumber(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (!y || !m || !d) return NaN;
  return Date.UTC(y, m - 1, d) / 86400000;
}

// Are two amounts close enough to plausibly be the same transaction?
function amountsAreClose(a, b) {
  const diff = Math.abs(Number(a) - Number(b));
  if (diff <= AMOUNT_MISMATCH_MAX_ABS) return true;
  const scale = Math.max(Math.abs(Number(a)), Math.abs(Number(b)), 0.01);
  return diff / scale <= AMOUNT_MISMATCH_MAX_RATIO;
}

// Deterministic ordering so reconcile is order-invariant: two callers passing
// the same rows in a different order get the same buckets (matters when an
// equal-amount cluster is count-imbalanced and only some rows can match).
function reconCmp(a, b) {
  const ad = String(a.date || '');
  const bd = String(b.date || '');
  if (ad !== bd) return ad < bd ? -1 : 1;
  const adesc = String(a.description || a.merchant_name || '');
  const bdesc = String(b.description || b.merchant_name || '');
  if (adesc !== bdesc) return adesc < bdesc ? -1 : 1;
  const aa = Number(a.amount);
  const ba = Number(b.amount);
  if (aa !== ba) return aa - ba;
  const aid = String(a.plaid_tx_id || '');
  const bid = String(b.plaid_tx_id || '');
  return aid < bid ? -1 : aid > bid ? 1 : 0;
}

// Generic bank-descriptor filler that says nothing about the merchant — kept
// out of the token set so two unrelated rows can't look "similar" merely by
// sharing "POS PURCHASE" etc. (which would let the amount-mismatch pass hide a
// real sync gap).
const DESC_STOPWORDS = new Set([
  'POS', 'PURCHASE', 'PAYMENT', 'PAYMENTS', 'DEBIT', 'CREDIT', 'CARD', 'ACH',
  'PENDING', 'RECURRING', 'ONLINE', 'MOBILE', 'TRANSACTION', 'TRANSFER', 'THE',
  'AND', 'FROM', 'WWW', 'COM', 'HTTP', 'HTTPS', 'INC', 'LLC', 'USA', 'US',
  'ATM', 'WITHDRAWAL', 'WITHDRAWALS', 'DEPOSIT', 'DEPOSITS', 'CHECK', 'CHECKS',
  'BILL', 'BILLPAY', 'AUTOPAY', 'WITHDRAW',
]);

// Token set for fuzzy description similarity — Plaid rewrites bank descriptors,
// so exact string equality is useless. Drop short, pure-numeric (store numbers,
// ref ids) and generic-filler tokens that add noise.
function descTokens(s) {
  const out = new Set();
  for (const t of normalizeDescription(s).replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/)) {
    if (t.length >= 3 && !/^\d+$/.test(t) && !DESC_STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

// Jaccard overlap of description tokens, 0..1.
export function descSimilarity(a, b) {
  const ta = descTokens(a);
  const tb = descTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

// Effective category for a Plaid row (user override wins), for the mismatch
// flag. Kept here so reconcile stays pure; dataAdapter passes the raw columns.
function plaidEffectiveCategory(p) {
  return p.user_category || p.mapped_category || 'Shopping and gear';
}

function plaidDescriptor(p) {
  return p.description || p.merchant_name || '';
}

// csvRows: built rows from analyzeCsv (amount positive = money out).
// plaidRows: existing synced rows on the target account, same sign convention,
//   each { plaid_tx_id, date, amount, description, merchant_name,
//          mapped_category, user_category, pending }.
export function reconcileCsv(inputCsvRows, inputPlaidRows, { windowDays = RECONCILE_WINDOW_DAYS } = {}) {
  // Sort copies deterministically so the result doesn't depend on input order
  // (never mutates the caller's arrays; also yields date-ordered buckets).
  const csvRows = [...inputCsvRows].sort(reconCmp);
  const plaidRows = [...inputPlaidRows].sort(reconCmp);
  const amtKey = x => (Number(x.amount) + 0).toFixed(2);

  // Bucket Plaid rows by exact amount so candidate lookup is cheap.
  const plaidByAmt = new Map();
  plaidRows.forEach((p, j) => {
    const k = amtKey(p);
    if (!plaidByAmt.has(k)) plaidByAmt.set(k, []);
    plaidByAmt.get(k).push(j);
  });

  // Adjacency: csv i → candidate plaid j (equal amount, within window),
  // ordered by closest date then most-similar description (best first).
  const adj = csvRows.map(c => {
    const cd = isoDayNumber(c.date);
    return (plaidByAmt.get(amtKey(c)) || [])
      .map(j => {
        const p = plaidRows[j];
        return {
          j,
          gap: Math.abs(cd - isoDayNumber(p.date)),
          sim: descSimilarity(c.description, plaidDescriptor(p)),
        };
      })
      .filter(e => Number.isFinite(e.gap) && e.gap <= windowDays)
      .sort((a, b) => a.gap - b.gap || b.sim - a.sim)
      .map(e => e.j);
  });

  // Maximum bipartite matching (Kuhn's augmenting paths). csv = left side.
  const matchOfPlaid = new Array(plaidRows.length).fill(-1); // plaid j → csv i
  const matchOfCsv = new Array(csvRows.length).fill(-1); // csv i → plaid j
  const tryMatch = (i, seen) => {
    for (const j of adj[i]) {
      if (seen[j]) continue;
      seen[j] = true;
      if (matchOfPlaid[j] === -1 || tryMatch(matchOfPlaid[j], seen)) {
        matchOfPlaid[j] = i;
        matchOfCsv[i] = j;
        return true;
      }
    }
    return false;
  };
  // Fewest-candidates-first tends to yield a larger matching.
  const order = csvRows.map((_, i) => i).sort((a, b) => adj[a].length - adj[b].length);
  for (const i of order) {
    if (adj[i].length) tryMatch(i, new Array(plaidRows.length).fill(false));
  }

  const matched = [];
  for (let i = 0; i < csvRows.length; i++) {
    const j = matchOfCsv[i];
    if (j < 0) continue;
    const c = csvRows[i];
    const p = plaidRows[j];
    matched.push({
      csv: c,
      plaid: p,
      dateGapDays: Math.abs(isoDayNumber(c.date) - isoDayNumber(p.date)),
      dateMismatch: c.date !== p.date,
      categoryMismatch: (c.mapped_category || '') !== plaidEffectiveCategory(p),
    });
  }

  let csvLeft = csvRows.filter((_, i) => matchOfCsv[i] < 0);
  const plaidLeftIdx = plaidRows.map((_, j) => j).filter(j => matchOfPlaid[j] < 0);

  // Second pass over the leftovers: pair by strong description similarity +
  // close date to surface likely same-txn AMOUNT discrepancies (each plaid row
  // used at most once, best similarity wins).
  const amountMismatches = [];
  const usedPlaid = new Set();
  const stillCsvOnly = [];
  for (const c of csvLeft) {
    const cd = isoDayNumber(c.date);
    let bestJ = -1;
    let bestSim = -1;
    for (const j of plaidLeftIdx) {
      if (usedPlaid.has(j)) continue;
      const p = plaidRows[j];
      if (!(Math.abs(cd - isoDayNumber(p.date)) <= windowDays)) continue;
      // Only a CLOSE amount can be the same txn; a large gap is a different
      // purchase (keep it as a real sync gap / timing row, don't pair it).
      if (!amountsAreClose(c.amount, p.amount)) continue;
      const sim = descSimilarity(c.description, plaidDescriptor(p));
      if (sim >= AMOUNT_MISMATCH_MIN_SIMILARITY && sim > bestSim) {
        bestSim = sim;
        bestJ = j;
      }
    }
    if (bestJ >= 0) {
      usedPlaid.add(bestJ);
      const p = plaidRows[bestJ];
      amountMismatches.push({
        csv: c,
        plaid: p,
        amountDiff: Number((Number(c.amount) - Number(p.amount)).toFixed(2)),
        dateGapDays: Math.abs(cd - isoDayNumber(p.date)),
        descSimilarity: Number(bestSim.toFixed(2)),
      });
    } else {
      stillCsvOnly.push(c);
    }
  }
  const plaidOnly = plaidLeftIdx.filter(j => !usedPlaid.has(j)).map(j => plaidRows[j]);

  return {
    matched,
    amountMismatches,
    csvOnly: stillCsvOnly,
    plaidOnly,
    counts: {
      csvTotal: csvRows.length,
      plaidTotal: plaidRows.length,
      matched: matched.length,
      amountMismatches: amountMismatches.length,
      csvOnly: stillCsvOnly.length,
      plaidOnly: plaidOnly.length,
    },
  };
}

// Min/max ISO date across built rows, for scoping the Plaid fetch to the CSV's
// period (± padding) so a 1-month CSV isn't compared against years of history.
export function csvDateRange(rows) {
  let min = null;
  let max = null;
  for (const r of rows) {
    if (!r.date) continue;
    if (min === null || r.date < min) min = r.date;
    if (max === null || r.date > max) max = r.date;
  }
  return { min, max };
}
