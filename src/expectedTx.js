// Pure core for expected/scheduled transactions (Session 6 item 3, Design B).
// DISPLAY-ONLY by contract (the envelopePace rule): nothing here ever touches
// the envelope walk, `available`, or any spending/income total — an
// expectation is a forward-looking note, and a matched one just points at the
// real transaction row. dataAdapter does the I/O; this module only decides.
//
// Imports only existing pure modules — no React, no Supabase.
import { descSimilarity } from './csvImport.js';
import { merchantKey } from './txClassify.js';

// Per-cadence date window for matching a real transaction to an expectation
// (|posted − due| in days). Scaled like recurring.js's dueSoonDays: a weekly
// bill drifts a couple of days, an annual renewal can land weeks off.
export const EXPECTED_WINDOW_DAYS = { weekly: 4, monthly: 7, annual: 30, once: 7 };

// How far past due a still-pending expectation reads as "missed?" (the UI's
// red flag with Dismiss / Mark paid). Mirrors recurring.js staleDays
// (weekly 14, monthly/annual capped 60); a one-shot bill uses the weekly 14 —
// two weeks late on a typed single bill is worth asking about. NEVER used to
// auto-dismiss: the unmatched bill is the alarm.
export const EXPECTED_STALE_DAYS = { weekly: 14, monthly: 60, annual: 60, once: 14 };

// Dup-gate tolerance for seeding: a new expectation with the same
// recurring_key whose due date lands within ±gapTol days of an existing
// PENDING one is the same cycle, not a new bill. Same per-band values as
// recurring.js gapTol; 'once' has no cadence jitter so only the exact day
// collides.
export const EXPECTED_DUP_TOL_DAYS = { weekly: 2, monthly: 4, annual: 15, once: 0 };

// Fraction of the expected amount a real charge may differ by and still
// match — the same ±20% band recurring detection uses for "similar amounts".
export const EXPECTED_AMOUNT_TOL_PCT = 0.2;

// Runaway guard for projectFutureCycles (the MAX_WALK_MONTHS spirit): no
// render should ever ask for more than a few years of projected cycles.
const MAX_PROJECTED_CYCLES = 200;

// 'YYYY-MM-DD' → whole days since epoch (string split, not new Date(string),
// so day arithmetic can't pick up UTC off-by-one surprises — recurring.js).
function dayNumber(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

function pad2(x) {
  return String(x).padStart(2, '0');
}

function isoDate(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function daysInMonth(y, m) {
  // Day 0 of the NEXT month is the last day of this one.
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function txDescriptor(t) {
  return t.merchant_name || t.description || '';
}

function expWindowDays(exp, override) {
  if (override != null) return override;
  return EXPECTED_WINDOW_DAYS[exp.cadence] ?? EXPECTED_WINDOW_DAYS.once;
}

// --- Matching ----------------------------------------------------------------
// Greedy nearest-date matching of pending expectations against real
// transactions. A pair is eligible when:
//   - account matches (an expectation with account_id null matches any account),
//   - |tx.amount − exp.amount| ≤ amountTolPct · exp.amount,
//   - |tx date − due date| ≤ the cadence's window,
//   - the descriptors agree: descSimilarity ≥ 0.4 OR merchantKey equality.
// Then pairs are taken nearest-date first, one tx per expectation and one
// expectation per tx. Deterministic: ties break on due date, expectation id,
// tx date, tx id — so reversed input order yields the same result.
export function matchExpected(pendingRows, txRows, { amountTolPct = EXPECTED_AMOUNT_TOL_PCT, windowDays } = {}) {
  const candidates = [];
  for (const exp of pendingRows || []) {
    if (!exp || !exp.due_date || !(exp.amount > 0)) continue;
    const dueDay = dayNumber(exp.due_date);
    const win = expWindowDays(exp, windowDays);
    const expKey = merchantKey(exp.description);
    for (const t of txRows || []) {
      if (!t || !t.transaction_date) continue;
      if (exp.account_id != null && t.account_id !== exp.account_id) continue;
      if (Math.abs(t.amount - exp.amount) > amountTolPct * exp.amount) continue;
      const dist = Math.abs(dayNumber(t.transaction_date) - dueDay);
      if (dist > win) continue;
      const desc = txDescriptor(t);
      if (descSimilarity(exp.description, desc) < 0.4 && merchantKey(desc) !== expKey) continue;
      candidates.push({ exp, tx: t, dist });
    }
  }
  candidates.sort(
    (a, b) =>
      a.dist - b.dist ||
      String(a.exp.due_date).localeCompare(String(b.exp.due_date)) ||
      String(a.exp.id).localeCompare(String(b.exp.id)) ||
      String(a.tx.transaction_date).localeCompare(String(b.tx.transaction_date)) ||
      String(a.tx.id).localeCompare(String(b.tx.id))
  );
  const usedExp = new Set();
  const usedTx = new Set();
  const out = [];
  for (const c of candidates) {
    if (usedExp.has(c.exp.id) || usedTx.has(c.tx.id)) continue;
    usedExp.add(c.exp.id);
    usedTx.add(c.tx.id);
    out.push({ expectationId: c.exp.id, txId: c.tx.id });
  }
  return out;
}

// --- Aggregation (the Budget tab's gray "Expected: $X" line) ------------------
// PENDING rows only — matched money already exists as a real transaction and
// dismissed money is the user saying "not this cycle".
export function expectedByCategory(rows) {
  const out = {};
  for (const r of rows || []) {
    if (!r || r.status !== 'pending' || !r.category) continue;
    out[r.category] = (out[r.category] || 0) + (Number(r.amount) || 0);
  }
  return out;
}

// --- Cycle-date derivation -----------------------------------------------------
// Next cycle's due date. weekly = +7 days; monthly = same day next month,
// clamped to the shorter month's length (Jan 31 → Feb 28/29), Dec → Jan wraps
// the year; annual = same month/day next year (Feb 29 → Feb 28). 'once' (or
// unknown cadence) never rolls — returns null.
export function rollForwardDate(dueDate, cadence) {
  if (!dueDate) return null;
  const [y, m, d] = String(dueDate).split('-').map(Number);
  if (cadence === 'weekly') {
    const dt = new Date(Date.UTC(y, m - 1, d + 7));
    return isoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  if (cadence === 'monthly') {
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    return isoDate(ny, nm, Math.min(d, daysInMonth(ny, nm)));
  }
  if (cadence === 'annual') {
    return isoDate(y + 1, m, Math.min(d, daysInMonth(y + 1, m)));
  }
  return null; // 'once' — no next cycle
}

// Render-only projection of future cycles through the end of a month
// ('YYYY-MM' key): the ISO due dates strictly AFTER the row's own due date,
// in order. Never persisted — future months render these lighter.
export function projectFutureCycles(row, throughMonthKey) {
  const out = [];
  if (!row || !row.due_date || !throughMonthKey) return out;
  let date = row.due_date;
  for (let i = 0; i < MAX_PROJECTED_CYCLES; i++) {
    date = rollForwardDate(date, row.cadence);
    if (!date || date.slice(0, 7) > throughMonthKey) break;
    out.push(date);
  }
  return out;
}

// --- Status lifecycle ----------------------------------------------------------
// One place that turns a stored row + the caller's clock into the rendered
// status. Stored statuses are 'pending' | 'matched' | 'dismissed'; 'overdue'
// is DERIVED (pending past due), never stored — same pattern as recurring's
// dueStatus. Without a clock a pending row stays 'pending' (pure, no
// Date.now() — the byte-determinism rule).
export function expectedStatus(row, today = null) {
  if (!row) return null;
  if (row.status === 'matched' || row.status === 'dismissed') return row.status;
  if (today && row.due_date && dayNumber(String(row.due_date)) < dayNumber(today)) return 'overdue';
  return 'pending';
}

// True when a pending row is overdue past the cadence's staleDays — the UI
// shows "missed?" with Dismiss / Mark paid. NEVER auto-dismissed.
export function isMissedExpected(row, today) {
  if (!row || !today || expectedStatus(row, today) !== 'overdue') return false;
  const stale = EXPECTED_STALE_DAYS[row.cadence] ?? EXPECTED_STALE_DAYS.once;
  return dayNumber(today) - dayNumber(String(row.due_date)) > stale;
}

// --- Seeding -------------------------------------------------------------------
// Build the insert fields from a detectRecurring item. Amount is the LAST
// charge, not the median (last-amount seeding — after a price hike the next
// bill is the new price, and the ±20% match band forgives jitter anyway).
export function seedFromRecurring(item) {
  if (!item) return null;
  return {
    recurring_key: item.key ?? null,
    description: item.name || item.key || '',
    category: item.category,
    account_id: item.account_id ?? null,
    amount: item.lastAmount,
    due_date: item.nextDate,
    cadence: item.cadence || 'once',
  };
}

// Dup-gate for addExpected: the same recurring_key with an existing PENDING
// row due within ± the cadence's gap tolerance is the same cycle — adding it
// again would double the Upcoming card. Hand-typed rows (recurring_key null)
// never gate: two rent-sized bills on the same day can be real.
export function isDuplicateExpected(fields, existingPending) {
  if (!fields || fields.recurring_key == null) return false;
  const tol = EXPECTED_DUP_TOL_DAYS[fields.cadence] ?? EXPECTED_DUP_TOL_DAYS.once;
  const day = dayNumber(String(fields.due_date));
  for (const r of existingPending || []) {
    if (!r || r.status !== 'pending' || r.recurring_key !== fields.recurring_key) continue;
    if (Math.abs(dayNumber(String(r.due_date)) - day) <= tol) return true;
  }
  return false;
}
