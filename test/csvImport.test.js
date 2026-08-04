// Tests for the pure CSV-import core (src/csvImport.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv,
  analyzeCsv,
  transferRawCategory,
  guessCategory,
  importPlan,
  CSV_TX_ID_PREFIX,
} from '../src/csvImport.js';
import { TRANSFER_CATEGORY, FALLBACK_CATEGORY } from '../src/categoryMap.js';
import { pullWasClean } from '../src/sync.js';

// --- parseCsv: the quoted/embedded-comma cases its own comment names --------

test('parseCsv handles quoted fields with embedded commas', () => {
  assert.deepEqual(parseCsv('a,"AMAZON, INC",b'), [['a', 'AMAZON, INC', 'b']]);
});

test('parseCsv handles escaped "" quotes inside quoted fields', () => {
  assert.deepEqual(parseCsv('"he said ""hi""",x'), [['he said "hi"', 'x']]);
});

test('parseCsv handles embedded newlines inside quoted fields', () => {
  assert.deepEqual(parseCsv('"line1\nline2",y\nz,w'), [['line1\nline2', 'y'], ['z', 'w']]);
});

test('parseCsv handles CRLF row breaks and a leading BOM', () => {
  assert.deepEqual(parseCsv('\ufeffa,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);
});

// --- Dedup-id idempotency ----------------------------------------------------

const HEADER = 'Date,Description,Debit,Credit';
const LINES = [
  '3/1/2026,SAFEWAY #123,45.00,',
  '3/1/2026,SAFEWAY #123,45.00,', // genuinely identical → per-day ordinal
  '3/2/2026,"AMAZON, INC",12.34,',
  '3/3/2026,PAYROLL DEPOSIT,,1000.00',
];

test('re-importing the same file yields identical plaid_tx_ids (idempotent)', () => {
  const first = analyzeCsv([HEADER, ...LINES].join('\n'));
  const second = analyzeCsv([HEADER, ...LINES].join('\n'));
  const ids = first.rows.map(r => r.plaid_tx_id);
  assert.equal(ids.length, LINES.length);
  for (const id of ids) assert.match(id, new RegExp(`^${CSV_TX_ID_PREFIX}[0-9a-f]{16}:\\d+$`));
  assert.deepEqual(second.rows.map(r => r.plaid_tx_id), ids);
  // With the first import's ids as existingIds, every re-imported row is a dupe.
  const reimport = analyzeCsv([HEADER, ...LINES].join('\n'), { existingIds: new Set(ids) });
  assert.ok(reimport.rows.every(r => r.isDuplicate));
});

test('identical rows are distinguished only by ordinal, never the file row-index', () => {
  const { rows } = analyzeCsv([HEADER, ...LINES].join('\n'));
  const [a, b] = rows.filter(r => r.description === 'SAFEWAY #123').map(r => r.plaid_tx_id);
  assert.equal(a.replace(/:\d+$/, ''), b.replace(/:\d+$/, ''));
  assert.match(a, /:0$/);
  assert.match(b, /:1$/);
});

test('ids are independent of row order within the file (distinct rows)', () => {
  // The next export can prepend rows and shift every position; ids must not
  // depend on it. (Ordinals only order genuinely identical rows, so distinct
  // rows keep the same ids under any ordering.)
  const distinct = LINES.filter((_, i) => i !== 1);
  const forward = analyzeCsv([HEADER, ...distinct].join('\n'));
  const reversed = analyzeCsv([HEADER, ...[...distinct].reverse()].join('\n'));
  assert.deepEqual(
    new Set(forward.rows.map(r => r.plaid_tx_id)),
    new Set(reversed.rows.map(r => r.plaid_tx_id))
  );
});

// --- transferRawCategory / card-payment handling -----------------------------

test('a genuine transfer descriptor gets a TRANSFER_OUT/IN raw_category by sign', () => {
  assert.equal(transferRawCategory('ONLINE BANKING TRANSFER TO SAVINGS', 500), 'TRANSFER_OUT');
  assert.equal(transferRawCategory('Online Banking Transfer From Checking', -500), 'TRANSFER_IN');
  assert.equal(transferRawCategory('ONLINE BANKING TRANSFER TO SAVINGS', 0), '');
});

test('card-payment wording is NOT tagged as an internal transfer, but still categorizes as card payment', () => {
  // BECU words its own card payments as transfers ("Online Banking Transfer To
  // VISA") — washing must never remove them, so raw_category stays '' (counted
  // as cash spending), while guessCategory still maps them to the
  // transfer/card-payment category (excluded from purchase spending).
  for (const desc of ['ONLINE BANKING TRANSFER TO VISA 1234', 'CHASE CARD PAYMENT - THANK YOU']) {
    assert.equal(transferRawCategory(desc, 500), '');
    assert.equal(guessCategory(desc), TRANSFER_CATEGORY);
  }
});

test('an ordinary merchant string gets no transfer treatment', () => {
  assert.equal(transferRawCategory('SAFEWAY #1467 EVERETT WA', 45), '');
  assert.notEqual(guessCategory('SAFEWAY #1467 EVERETT WA'), TRANSFER_CATEGORY);
  assert.equal(guessCategory('TOTALLY UNKNOWN MERCHANT 42'), FALLBACK_CATEGORY);
});

// The assertion above is SYMBOLIC — it proves guessCategory and
// FALLBACK_CATEGORY agree, not what the value is, so it passes just as happily
// if both revert to a real category. That is precisely the regression that
// matters: making 'Shopping and gear' the fallback again would silently make
// "we don't recognise this merchant" indistinguishable from a confident answer,
// which is what Uncategorized exists to prevent. Pin the value itself.
test('the classifier fallback is the honest unknown, not a real category', () => {
  assert.equal(FALLBACK_CATEGORY, 'Uncategorized');
  assert.equal(guessCategory('TOTALLY UNKNOWN MERCHANT 42'), 'Uncategorized');
  // Since the keyword table's deletion (2026-08-04) EVERY untaught merchant
  // reads this way — there is no recognised-merchant arm left. A rule the
  // household taught is the only thing that moves a row off Uncategorized.
  assert.equal(guessCategory('NORDSTROM RACK #12'), 'Uncategorized');
  assert.equal(
    guessCategory('NORDSTROM RACK #12', { rules: { 'NORDSTROM RACK': 'Clothes' } }),
    'Clothes'
  );
});

// --- The overlap guard -------------------------------------------------------
//
// This is the property the whole "rebuild history from statements" feature
// rests on, and it had NO coverage at all. `csv:` and `sfin:` dedup ids live in
// separate namespaces and cannot see each other, so a single row imported on or
// after the feed's coverage start is a duplicate that nothing downstream can
// detect — it just silently doubles that transaction in every total.

const OVERLAP_HEADER = 'Date,Description,Debit,Credit';
const OVERLAP_LINES = [
  '3/1/2026,PRE FEED A,10.00,',   // before the boundary  -> importable
  '3/2/2026,PRE FEED B,20.00,',   // before the boundary  -> importable
  '3/3/2026,BOUNDARY DAY,30.00,', // ON the boundary      -> the feed owns it
  '3/4/2026,POST FEED,40.00,',    // after the boundary   -> the feed owns it
];
const overlapAnalysis = opts =>
  analyzeCsv([OVERLAP_HEADER, ...OVERLAP_LINES].join('\n'), opts);

test('the boundary day belongs to the FEED — on-or-after is overlap, the day before is not', () => {
  const { rows } = overlapAnalysis({ overlapFrom: '2026-03-03' });
  const byDesc = Object.fromEntries(rows.map(r => [r.description, r.isOverlap]));
  assert.equal(byDesc['PRE FEED B'], false, 'the day before the boundary must stay importable');
  assert.equal(byDesc['BOUNDARY DAY'], true, 'the boundary day itself belongs to the feed');
  assert.equal(byDesc['POST FEED'], true);
});

test('no overlapFrom (manual account, or a feed that has delivered nothing) flags nothing', () => {
  const { rows } = overlapAnalysis({});
  assert.ok(rows.every(r => r.isOverlap === false));
  assert.equal(rows.length, OVERLAP_LINES.length);
});

// The insert set the modal actually writes. If this ever includes a row dated
// on or after the boundary, money is being double-counted.
test('the importable set never contains a row on or after the boundary', () => {
  for (const boundary of ['2026-03-01', '2026-03-03', '2026-03-05']) {
    const { rows } = overlapAnalysis({ overlapFrom: boundary });
    const importable = rows.filter(r => !r.isDuplicate && !r.isOverlap);
    for (const r of importable) {
      assert.ok(r.date < boundary, `${r.description} (${r.date}) must not import at ${boundary}`);
    }
  }
});

// A row can be BOTH inside the feed's coverage and a re-import of one we already
// inserted. The dedup id must not depend on the overlap flag, or re-importing
// the same statement after the feed catches up would mint fresh ids and insert
// second copies of rows the first import already wrote.
test('overlap does not perturb the dedup id — re-import still dedups', () => {
  const plain = overlapAnalysis({});
  const guarded = overlapAnalysis({ overlapFrom: '2026-03-02' });
  assert.deepEqual(
    guarded.rows.map(r => r.plaid_tx_id),
    plain.rows.map(r => r.plaid_tx_id)
  );
  const reimport = overlapAnalysis({
    overlapFrom: '2026-03-02',
    existingIds: new Set(plain.rows.map(r => r.plaid_tx_id)),
  });
  assert.ok(reimport.rows.every(r => r.isDuplicate));
});

// --- importPlan: which sections the modal shows ------------------------------
//
// With Plaid gone, the target account can no longer say whether a file is a
// backfill or an audit — every account is manual or SimpleFIN-fed, and a fed
// account is a valid target for both. The file's date range answers it instead.

test('importPlan reads the file against the boundary', () => {
  const plan = overlapFrom => importPlan(overlapAnalysis({ overlapFrom }).rows, { overlapFrom });

  // Rows run 3/1 .. 3/4.
  assert.equal(plan('2026-03-10').verdict, 'import', 'entirely before the feed → a pure backfill');
  assert.equal(plan('2026-03-01').verdict, 'audit', 'entirely inside the feed → nothing to insert');
  assert.equal(plan('2026-03-03').verdict, 'both', 'straddling → import the old part, audit the rest');
  assert.equal(plan(null).verdict, 'import', 'no feed (manual account) → always an import');
  assert.equal(importPlan([], { overlapFrom: null }).verdict, 'empty');
});

test('importPlan: an audit verdict means an EMPTY insert set', () => {
  const overlapFrom = '2026-03-01';
  const { verdict, newRows, overlapCount } = importPlan(
    overlapAnalysis({ overlapFrom }).rows, { overlapFrom }
  );
  assert.equal(verdict, 'audit');
  assert.equal(newRows.length, 0);
  assert.equal(overlapCount, OVERLAP_LINES.length);
});

// THE invariant. A wrong verdict may render a confusing screen; it must never
// widen what gets written. Asserted across every boundary the fixture can
// straddle, including both ends.
test('importPlan: newRows never contains a row on or after the boundary', () => {
  for (const overlapFrom of ['2026-02-28', '2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-09']) {
    const { newRows } = importPlan(overlapAnalysis({ overlapFrom }).rows, { overlapFrom });
    for (const r of newRows) {
      assert.ok(r.date < overlapFrom, `${r.description} (${r.date}) must not import at ${overlapFrom}`);
    }
  }
});

test('importPlan tolerates junk instead of throwing during render', () => {
  // It runs inside a useMemo in CsvImport's body; a throw there is not caught by
  // ModalErrorBoundary (which that same body renders) and blanks the whole PWA.
  for (const junk of [undefined, null, 'nope', 42, {}]) {
    assert.equal(importPlan(junk).verdict, 'empty');
  }
});

// --- pullWasClean: "did the sync actually read the feed?" --------------------
//
// This gates whether statement import will insert rows over dates a later pull
// re-fetches. runSync RESOLVES on a failed pull (api/sync.js answers 200 with a
// per-result error so one broken bank doesn't fail the whole request), so
// "the promise didn't reject" is not evidence of anything.

test('pullWasClean rejects every shape a failed pull resolves with', () => {
  // A thrown pull — api/sync.js catches it and pushes an error result.
  assert.equal(pullWasClean({ results: [{ institution: 'SimpleFIN', error: 'HTTP 403' }], failures: [{ error: 'HTTP 403' }] }), false);
  // A PARTIAL per-bank failure: no error key at all, just warnings.
  assert.equal(pullWasClean({ results: [{ institution: 'SimpleFIN', warnings: ['Bank X: auth failed'] }], failures: [] }), false);
  // The once-an-hour throttle.
  assert.equal(pullWasClean({ results: [{ institution: 'SimpleFIN', skipped: 'throttled' }], failures: [] }), false);
  // No access URL at all — syncSimpleFin returns [].
  assert.equal(pullWasClean({ results: [], failures: [] }), false);
  // Junk / absent.
  for (const junk of [undefined, {}, { results: null }, { results: 'nope' }]) {
    assert.equal(pullWasClean(junk), false, JSON.stringify(junk));
  }
});

test('pullWasClean accepts a genuinely clean pull', () => {
  assert.equal(
    pullWasClean({ results: [{ institution: 'SimpleFIN', institutions: 2, accounts: 4, transactions: 137 }], failures: [] }),
    true
  );
  // An empty `warnings` array is still clean — api/sync.js omits the key
  // entirely when there are none, but don't make the caller depend on that.
  assert.equal(pullWasClean({ results: [{ institution: 'SimpleFIN', warnings: [] }], failures: [] }), true);
});

test('REGRESSION: a pull carrying only date-range advisories is CLEAN', () => {
  // This is the shape that deadlocked production. SimpleFIN returns notices
  // about the range WE asked for in the same array as broken-bank reports; when
  // api/sync.js put them in `warnings`, pullWasClean went false on every pull
  // forever, which blocked CSV/PDF import into every SimpleFIN account while the
  // feed was in fact working (490 transactions written that same pull).
  //
  // They now travel under an `advisories` key, and `coverage_shortfall` reports
  // history the feed cannot reach. Neither may block. Renaming either back to
  // `warnings` re-breaks import with an otherwise-green suite, which is exactly
  // why this assertion exists here rather than only in test/simplefin.test.js.
  const advisoryPull = {
    results: [
      {
        institution: 'SimpleFIN',
        institutions: 3,
        accounts: 7,
        transactions: 490,
        advisories: [
          'Requested date range exceeds recommended range of 45 days. In the future, this may be capped.',
        ],
        coverage_shortfall: { wanted_from: '2024-07-30', served_from: '2026-05-02' },
      },
    ],
    failures: [],
  };
  assert.equal(pullWasClean(advisoryPull), true);

  // …while a REAL per-bank error in `warnings` still blocks, unchanged.
  assert.equal(
    pullWasClean({
      results: [{ institution: 'SimpleFIN', transactions: 490, warnings: ['BECU: needs attention'] }],
      failures: [],
    }),
    false
  );
});

// One broken bank blocks import for ALL accounts, and that is correct rather
// than over-cautious: last_pulled_at lives on simplefin_access (one row per
// ACCESS URL, covering every bank) and only advances when the whole pull is
// error-free. So an unrelated bank's failure still means the next pull reaches
// back to the old watermark for everything — the same unsafe window.
  //
  // Note what `warnings` carries: real per-bank problems only. SimpleFIN's
  // date-range notices travel under `advisories` precisely so they cannot reach
  // this predicate (see the advisory gotcha in CLAUDE.md).
test('a partial failure is unclean even for accounts on a healthy bank', () => {
  const partial = { results: [{ institution: 'SimpleFIN', accounts: 6, transactions: 40, warnings: ['Chase: auth failed'] }], failures: [] };
  assert.equal(pullWasClean(partial), false);
});
