// Net worth fold — hand-computed constants against src/netWorth.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { netWorthSeries, debtTotalSeries, sparklinePoints } from '../src/netWorth.js';

const ACCTS = [
  { id: 'chk', type: 'depository' },
  { id: 'sav', type: 'depository' },
  { id: 'card', type: 'credit' },
  { id: 'loan', type: 'loan' },
];

test('empty inputs give an empty series', () => {
  assert.deepEqual(netWorthSeries([], ACCTS), []);
  assert.deepEqual(netWorthSeries(null, ACCTS), []);
  assert.deepEqual(netWorthSeries([{ account_id: 'chk', captured_on: '2026-08-01', balance: 5 }], []), []);
});

test('single account, assets stay positive', () => {
  const out = netWorthSeries(
    [
      { account_id: 'chk', captured_on: '2026-08-01', balance: 1000 },
      { account_id: 'chk', captured_on: '2026-08-03', balance: 1250.5 },
    ],
    ACCTS,
  );
  assert.deepEqual(out, [
    { date: '2026-08-01', total: 1000 },
    { date: '2026-08-03', total: 1250.5 },
  ]);
});

test('debts subtract via the displayBalance sign rule (credit AND loan)', () => {
  const out = netWorthSeries(
    [
      { account_id: 'chk', captured_on: '2026-08-01', balance: 2000 },
      { account_id: 'card', captured_on: '2026-08-01', balance: 500 }, // stored positive = owed
      { account_id: 'loan', captured_on: '2026-08-01', balance: 3000 },
    ],
    ACCTS,
  );
  // 2000 − 500 − 3000
  assert.deepEqual(out, [{ date: '2026-08-01', total: -1500 }]);
});

test('carry-forward: an account that did not move keeps its last value', () => {
  const out = netWorthSeries(
    [
      { account_id: 'chk', captured_on: '2026-08-01', balance: 1000 },
      { account_id: 'card', captured_on: '2026-08-01', balance: 400 },
      // 08-02: only the card reported — checking must carry forward, not drop to 0
      { account_id: 'card', captured_on: '2026-08-02', balance: 300 },
      // 08-04: only checking reported — card carries at 300
      { account_id: 'chk', captured_on: '2026-08-04', balance: 1100 },
    ],
    ACCTS,
  );
  assert.deepEqual(out, [
    { date: '2026-08-01', total: 600 },  // 1000 − 400
    { date: '2026-08-02', total: 700 },  // 1000 − 300
    { date: '2026-08-04', total: 800 },  // 1100 − 300
  ]);
});

test('an account with no snapshot yet contributes 0 until its first one', () => {
  const out = netWorthSeries(
    [
      { account_id: 'chk', captured_on: '2026-08-01', balance: 500 },
      { account_id: 'sav', captured_on: '2026-08-03', balance: 250 },
    ],
    ACCTS,
  );
  assert.deepEqual(out, [
    { date: '2026-08-01', total: 500 },  // sav not yet seen → 0, not dropped
    { date: '2026-08-03', total: 750 },
  ]);
});

test('snapshots for accounts NOT in the list (hidden) are ignored entirely', () => {
  const out = netWorthSeries(
    [
      { account_id: 'chk', captured_on: '2026-08-01', balance: 100 },
      { account_id: 'ghost', captured_on: '2026-08-01', balance: 9999 },
      { account_id: 'ghost', captured_on: '2026-08-02', balance: 9999 },
    ],
    ACCTS,
  );
  // The ghost's rows must not even mint a 08-02 point.
  assert.deepEqual(out, [{ date: '2026-08-01', total: 100 }]);
});

test('one point per date, and unsorted input is sorted by date', () => {
  const out = netWorthSeries(
    [
      { account_id: 'card', captured_on: '2026-08-02', balance: 50 },
      { account_id: 'chk', captured_on: '2026-08-01', balance: 300 },
      { account_id: 'sav', captured_on: '2026-08-02', balance: 20 },
    ],
    ACCTS,
  );
  assert.deepEqual(out, [
    { date: '2026-08-01', total: 300 },
    { date: '2026-08-02', total: 270 }, // 300 + 20 − 50, single merged point
  ]);
});

test('numeric-string balances (PostgREST) coerce like displayBalance does', () => {
  const out = netWorthSeries(
    [
      { account_id: 'chk', captured_on: '2026-08-01', balance: '100.25' },
      { account_id: 'card', captured_on: '2026-08-01', balance: '40.25' },
    ],
    ACCTS,
  );
  assert.deepEqual(out, [{ date: '2026-08-01', total: 60 }]);
});

// --- clampSeries: the display-window trim that keeps the boundary carry -----
// REGRESSION (2026-08-03 review): getNetWorthSeries used to pass the 365-day
// window to the snapshot FETCH; change-only snapshots meant a static account
// (manual loan typed once) aged out of the window and its whole balance
// silently vanished from every point, headline included. The fold now runs
// over full history and clampSeries trims the points afterwards.
import { clampSeries } from '../src/netWorth.js';

const SERIES = [
  { date: '2025-01-10', total: -900 },
  { date: '2025-06-01', total: -850 },
  { date: '2026-07-01', total: -400 },
  { date: '2026-08-01', total: -100 },
];

test('clampSeries: no sinceDate (or empty) passes through', () => {
  assert.deepEqual(clampSeries(SERIES, null), SERIES);
  assert.deepEqual(clampSeries([], '2026-01-01'), []);
  assert.deepEqual(clampSeries(null, '2026-01-01'), []);
});

test('clampSeries keeps the last pre-window point so carry crosses the boundary', () => {
  assert.deepEqual(clampSeries(SERIES, '2026-01-01'), [
    { date: '2025-06-01', total: -850 }, // the carry point, real date kept
    { date: '2026-07-01', total: -400 },
    { date: '2026-08-01', total: -100 },
  ]);
});

test('clampSeries: window starting at/before the first point keeps everything', () => {
  assert.deepEqual(clampSeries(SERIES, '2025-01-10'), SERIES);
  assert.deepEqual(clampSeries(SERIES, '2024-01-01'), SERIES);
});

test('clampSeries: an all-pre-window series keeps just its latest point (headline stays real)', () => {
  assert.deepEqual(clampSeries(SERIES, '2026-08-02'), [{ date: '2026-08-01', total: -100 }]);
});

test('static account survives a window a year past its only snapshot (end-to-end shape)', () => {
  // The bug scenario: a loan snapshotted once, checking moving inside the
  // window. Fold full history, then clamp — the loan's balance must still be
  // in every in-window total.
  const folded = netWorthSeries(
    [
      { account_id: 'loan', captured_on: '2025-06-01', balance: 10000 },
      { account_id: 'chk', captured_on: '2026-07-15', balance: 2000 },
    ],
    ACCTS,
  );
  assert.deepEqual(clampSeries(folded, '2026-06-01'), [
    { date: '2025-06-01', total: -10000 },
    { date: '2026-07-15', total: -8000 }, // 2000 − 10000: the loan did NOT vanish
  ]);
});

// --- 2026-10 audit: the Debt tab's fold and sparkline live here now --------
// Dashboard.jsx carried an inline, untested copy of the carry-forward fold
// (stored sign, relying on the adapter's captured_on ordering) and its own
// sparkline scale, whose `Math.max(...,1)` floor and `max*.02` span squashed
// an all-in-credit series into the bottom of the chart.

const snap = (account_id, captured_on, balance) => ({ account_id, captured_on, balance });

// The retired inline fold, verbatim in behavior: correct only on SORTED input.
function oldInlineFold(rows) {
  const last = {}, pts = []; let cur = null;
  for (const s of rows) {
    last[s.account_id] = Number(s.balance) || 0;
    const total = Object.values(last).reduce((a, b) => a + b, 0);
    if (cur && cur.date === s.captured_on) cur.total = total;
    else pts.push(cur = { date: s.captured_on, total });
  }
  return pts;
}

test('debtTotalSeries: stored sign, carry-forward across a one-bank day, one point per date', () => {
  const pts = debtTotalSeries([
    snap('card', '2026-01-01', 1000),
    snap('loan', '2026-01-01', '5000.50'),
    snap('card', '2026-01-05', 800), // only the card reported — the loan carries
    snap('card', '2026-01-05', 750), // same-day restatement collapses into one point
    snap('loan', '2026-01-09', 4900),
  ], ['card', 'loan']);
  assert.deepEqual(pts, [
    { date: '2026-01-01', total: 6000.5 },
    { date: '2026-01-05', total: 5750.5 },
    { date: '2026-01-09', total: 5650 },
  ]);
});

test('debtTotalSeries sorts by date itself — unsorted input folds the same', () => {
  const sorted = [
    snap('card', '2026-01-01', 1000), snap('loan', '2026-01-02', 5000),
    snap('card', '2026-01-03', 900), snap('loan', '2026-01-04', 4800),
  ];
  const shuffled = [sorted[3], sorted[1], sorted[2], sorted[0]];
  assert.deepEqual(debtTotalSeries(shuffled), debtTotalSeries(sorted));
  assert.deepEqual(debtTotalSeries(shuffled), oldInlineFold(sorted));
});

test('debtTotalSeries: debtIds limits the fold; empty and null inputs give []', () => {
  const rows = [snap('card', '2026-01-01', 100), snap('gone', '2026-01-01', 999)];
  assert.deepEqual(debtTotalSeries(rows, ['card']), [{ date: '2026-01-01', total: 100 }]);
  assert.deepEqual(debtTotalSeries([], ['card']), []);
  assert.deepEqual(debtTotalSeries(null), []);
});

test('debtTotalSeries is the negated net-worth fold over the same debt accounts', () => {
  const debts = [{ id: 'card', type: 'credit' }, { id: 'loan', type: 'loan' }];
  const rows = [snap('card', '2026-02-01', 300), snap('loan', '2026-02-03', 1200), snap('card', '2026-02-07', -40)];
  const nw = netWorthSeries(rows, debts);
  assert.deepEqual(debtTotalSeries(rows, ['card', 'loan']), nw.map(p => ({ date: p.date, total: -p.total + 0 })));
});

test('debtTotalSeries matches the retired inline fold on adapter-ordered input (seeded random parity)', () => {
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let trial = 0; trial < 500; trial++) {
    const n = 1 + Math.floor(rand() * 12);
    const rows = [];
    for (let i = 0; i < n; i++) {
      const day = String(1 + Math.floor(rand() * 9)).padStart(2, '0');
      const acct = ['a', 'b', 'c'][Math.floor(rand() * 3)];
      rows.push(snap(acct, `2026-03-${day}`, Math.round((rand() * 4000 - 500) * 100) / 100));
    }
    // The adapter's order: captured_on, then account_id.
    rows.sort((x, y) => (x.captured_on < y.captured_on ? -1 : x.captured_on > y.captured_on ? 1
      : x.account_id < y.account_id ? -1 : x.account_id > y.account_id ? 1 : 0));
    assert.deepEqual(debtTotalSeries(rows, ['a', 'b', 'c']), oldInlineFold(rows), `trial ${trial}`);
  }
});

test('the Debt tab windows debtTotalSeries with clampSeries (carry crosses the boundary)', () => {
  const pts = debtTotalSeries([snap('loan', '2025-01-01', 9000), snap('card', '2026-06-01', 500)]);
  assert.deepEqual(clampSeries(pts, '2025-10-01'), [
    { date: '2025-01-01', total: 9000 },
    { date: '2026-06-01', total: 9500 },
  ]);
});

const ys = pts => pts.split(' ').map(p => Number(p.split(',')[1]));

test('sparklinePoints: an all-negative series spans the full height (no squash)', () => {
  const W = 300, H = 60;
  const y = ys(sparklinePoints([-50, -30], W, H));
  assert.equal(y[0], H - 4, 'the minimum sits on the bottom inset');
  assert.equal(y[1], 4, 'the maximum reaches the top inset');
});

test('sparklinePoints: a flat series draws a flat line (no divide-by-zero), < 2 values draws nothing', () => {
  assert.deepEqual(ys(sparklinePoints([5, 5, 5], 300, 60)), [56, 56, 56]);
  assert.equal(sparklinePoints([5], 300, 60), '');
  assert.equal(sparklinePoints([], 300, 60), '');
  assert.equal(sparklinePoints(null, 300, 60), '');
});

test('sparklinePoints reproduces both cards\' old output for ordinary positive series, byte for byte', () => {
  const W = 300, H = 60;
  const oldNw = v => {
    const max = Math.max(...v), min = Math.min(...v);
    const span = Math.max(max - min, Math.abs(max) * .02, 1);
    return v.map((t, i) => `${(i / (v.length - 1)) * W},${H - 4 - ((t - min) / span) * (H - 8)}`).join(' ');
  };
  const oldDebt = v => {
    const max = Math.max(...v, 1), min = Math.min(...v);
    const span = Math.max(max - min, max * .02, 1);
    return v.map((t, i) => `${(i / (v.length - 1)) * W},${H - 4 - ((t - min) / span) * (H - 8)}`).join(' ');
  };
  for (const v of [[12000, 11850.25, 11990, 11000], [5127.97, 5127.97], [250, 9000, 400], [-2500, 1200, 300]]) {
    assert.equal(sparklinePoints(v, W, H), oldNw(v));
    if (Math.max(...v) >= 1 && Math.min(...v) >= 0) assert.equal(sparklinePoints(v, W, H), oldDebt(v));
  }
});

test('Dashboard draws both sparklines through sparklinePoints and folds debt history with debtTotalSeries', async () => {
  const { readFileSync } = await import('node:fs');
  const dash = readFileSync(new URL('../src/components/Dashboard.jsx', import.meta.url), 'utf8');
  assert.match(dash, /sparklinePoints\(series\.map\(p=>p\.total\),W,H\)/);
  assert.match(dash, /sparklinePoints\(nwSeries\.map\(p=>p\.total\),W,H\)/);
  assert.match(dash, /debtTotalSeries\(debtSnaps,debts\.map\(d=>d\.id\)\)/);
  assert.doesNotMatch(dash, /last\[s\.account_id\]=Number\(s\.balance\)/, 'no inline fold copy');
  assert.doesNotMatch(dash, /Math\.max\(\.\.\.series\.map\(p=>p\.total\),1\)/, 'no drifted scale copy');
});
