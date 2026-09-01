// Pure envelope-budgeting model (no Supabase/React/env) — importable from plain
// Node, so the walk is covered by test/envelopes.test.js. dataAdapter.js does
// all the I/O: it reads the rows, aggregates spending through the shared
// isSpend() predicate, and hands plain arrays in here.
//
//   available(cat, m) = assigned(cat, m) + carry(cat, m-1) - spent(cat, m)
//
// carry is the previous month's available for a rolling category and 0 for a
// non-rolling one. A month with no assignment contributes 0 — never the funding
// target — so a category cannot accrue a phantom balance out of months nobody
// actually budgeted. Every assignment comes from an explicit user action, which
// keeps the number on screen equal to the number the walk rolls forward.
//
// Deliberate deviation from real YNAB: YNAB takes *cash* overspending out of
// next month's Ready to Assign and lets the category start fresh. This app has
// no cash-vs-credit envelope split, so an overspent category just carries
// negative.

// Runaway guard on the month loop — NOT a correctness clamp. A rolling balance
// is the sum of every assignment and every dollar spent since the envelope
// opened, so the walk has to start at the category's first assignment however
// old that is: truncating the window would silently freeze a long-running
// sinking fund at a stale balance and drift further from the truth every month.
// 600 months is 50 years; tripping it means a corrupt `month` value, not a real
// budget, so the result is flagged `truncated` rather than quietly shortened.
export const MAX_WALK_MONTHS = 600;

export function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

// Accepts 'YYYY-MM' or a full 'YYYY-MM-DD' date, which is what Postgres hands
// back for budget_months.month.
export function normalizeMonthKey(value) {
  const s = String(value || '').slice(0, 7);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? s : null;
}

export function shiftMonthKey(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  return monthKey(Math.floor(total / 12), (total % 12) + 1);
}

// Whole months between two 'YYYY-MM' keys (b - a).
function monthDiff(a, b) {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

// Money math accumulates float residue over a long walk; snapping to cents
// keeps a zeroed-out envelope from rendering as a red "−$0". Rounding a tiny
// negative residue yields -0, which passes `>= 0` but fails `> 0` — enough to
// print a minus sign in front of a zero — so it is normalized away here.
export function cents(n) {
  const v = Math.round(n * 100) / 100;
  return v === 0 ? 0 : v;
}

// Months from `year`/`month` through the target date, counting this one.
export function monthsUntil(dateStr, year, month) {
  const target = normalizeMonthKey(dateStr);
  if (!target) return 1;
  const diff = monthDiff(monthKey(year, month), target) + 1;
  return diff > 0 ? diff : 1;
}

// The target the viewed month actually answers to: this month's override when
// one is set, else the category-level target. An override of 0 is a REAL
// answer ("ask nothing this month"), distinct from null (no override).
export function effectiveTarget(row) {
  if (!row) return null;
  return row.targetOverride ?? row.target ?? null;
}

// What this month still needs for the category to hit its target. A monthly
// target wants topping up to the target every month. A by-date target spreads
// what's still missing (counting money already carried in, not what's been
// spent out) over the months left, then asks only for THIS month's share — so
// funding it twice in one month is a no-op rather than a double payment.
//
// Resolution order: (1) a per-month targetOverride, when non-null — and an
// override always uses monthly-top-up semantics for that month, even on a
// by_date category (the user typed THIS month's number; spreading it over the
// remaining months would ask for a fraction of what they asked for). An
// override of 0 asks for nothing. (2) the category target, per its kind.
// (3) no target → 0. By-date carry math is untouched by overrides.
export function targetNeed(row, { year, month }) {
  if (!row) return 0;
  if (row.targetOverride != null) {
    const left = Number(row.targetOverride) - row.assigned;
    return left > 0 ? cents(left) : 0;
  }
  if (row.target == null) return 0;
  if (row.targetKind === 'by_date') {
    const share = (row.target - row.rolledOver) / monthsUntil(row.targetDate, year, month);
    const need = share - row.assigned;
    return need > 0 ? cents(need) : 0;
  }
  const left = row.target - row.assigned;
  return left > 0 ? cents(left) : 0;
}

// The Plan tab's progress bar: what an envelope has SPENT against the money
// actually in it (assigned + rolled over). Pure and shared, because the tab
// draws this bar at TWO levels since 2026-08-31 — once on each collapsed group
// heading (over the group's rollup) and once on every envelope row inside it —
// and two copies of the arithmetic would eventually disagree about the same
// envelope on the same screen.
//
// `pot` 0 is not "0% spent", it is "no envelope": the bar stays empty and the
// label reads em dash rather than claiming an infinite overspend.
export function envelopeBar({ assigned = 0, rolledOver = 0, spent = 0 } = {}) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const pot = num(assigned) + num(rolledOver);
  const s = num(spent);
  const ratio = pot > 0 ? s / pot : 0;
  // Clamped BELOW as well as above: `spent` folds isSpend, so a refund can take
  // an envelope's spent negative, and a negative width is invalid CSS — the
  // browser drops the declaration and .bar-fill falls back to a FULL bar on the
  // emptiest envelope there is.
  const width = pot > 0 ? Math.max(0, Math.min(ratio, 1)) * 100 : 0;
  // Label clamped, bar already is: $129 spent against a $1 pot is honestly
  // 12900%, but five digits overflow the 38px span and read as a glitch — the
  // real amounts sit in the assigned/spent text beside it.
  const label = pot > 0 ? (ratio > 9.99 ? '>999%' : `${Math.round(ratio * 100)}%`) : '—';
  return { pot, ratio, width, label };
}

// Pace warning (display-only, opt-in per envelope) — is a fungible envelope
// spending AHEAD of a flat month-pace? Compares the spent-so-far the walk
// already produced against a linear expectation: fraction-of-month-elapsed ×
// assigned. NEVER recomputes spending and NEVER touches the walk/available —
// purely a UI signal. `today` is the real wall-clock local day ('YYYY-MM-DD');
// pace is a question about the present, so a past or future viewed month never
// warns, and neither does an envelope with no assignment (a fixed bill spends
// 100% on day 1 by design — that's why the whole feature is opt-in). Returns
// null when there's nothing to warn about, else the pace numbers.
export const PACE_MARGIN = 0.1; // 10% of assigned headroom before "ahead"

export function envelopePace({ assigned, spent, year, month, today }) {
  const a = Number(assigned) || 0;
  const s = Number(spent) || 0;
  if (a <= 0 || s <= 0) return null;
  const parts = String(today || '').split('-').map(Number);
  const [ty, tm, td] = parts;
  // Only the month in progress: a completed month isn't "ahead of pace", and a
  // future month has nothing spent yet.
  if (ty !== year || tm !== month || !td) return null;
  const days = new Date(year, month, 0).getDate(); // month is 1-based → last day
  const elapsed = Math.min(Math.max(td, 1), days) / days;
  const expected = elapsed * a;
  if (s <= expected + PACE_MARGIN * a) return null;
  return { elapsed, expected: cents(expected), ahead: cents(s - expected) };
}

const DEFAULT_SETTING = { target: null, targetKind: 'monthly', targetDate: null, rollover: true };

// assignments: [{ category, month, assigned, targetOverride? }] — month may be
//              YYYY-MM or a date; targetOverride is the per-month funding
//              target override (budget_months.target_override), optional.
// spending:    [{ category, month, spent }]     — pre-aggregated by the adapter
// settings:    [{ category, target, targetKind, targetDate, rollover }]
export function walkEnvelopes({ assignments = [], spending = [], settings = [], year, month }) {
  const targetKey = monthKey(year, month);

  // category -> 'YYYY-MM' -> dollars, plus the earliest month anyone assigned in.
  const assigned = new Map();
  // Per-month target overrides ride the assignment rows, but ONLY the viewed
  // month's override reaches the output row — a past month's override is that
  // month's business and never leaks forward, and the carry math below never
  // reads overrides at all (they change what funding ASKS for, not what any
  // month rolled).
  const overrides = new Map(); // category -> viewed month's targetOverride
  let earliestKey = targetKey;
  for (const row of assignments) {
    const key = normalizeMonthKey(row.month);
    // A row we can't place in a month can't be walked; dropping it is the only
    // safe move, and it can only come from a corrupt write.
    if (!key || key > targetKey) continue;
    const amount = Number(row.assigned) || 0;
    if (!assigned.has(row.category)) assigned.set(row.category, new Map());
    const byMonth = assigned.get(row.category);
    byMonth.set(key, (byMonth.get(key) || 0) + amount);
    if (key === targetKey && row.targetOverride != null) {
      overrides.set(row.category, Number(row.targetOverride));
    }
    // Only a non-zero assignment opens an envelope — see catStart below.
    if (amount !== 0 && key < earliestKey) earliestKey = key;
  }

  const spent = new Map();
  for (const row of spending) {
    const key = normalizeMonthKey(row.month);
    if (!key) continue;
    if (!spent.has(row.category)) spent.set(row.category, new Map());
    const byMonth = spent.get(row.category);
    byMonth.set(key, cents((byMonth.get(key) || 0) + (Number(row.spent) || 0)));
  }

  const settingByCategory = new Map();
  for (const row of settings) {
    settingByCategory.set(row.category, {
      target: row.target == null ? null : Number(row.target),
      targetKind: row.targetKind === 'by_date' ? 'by_date' : 'monthly',
      targetDate: row.targetDate || null,
      rollover: row.rollover !== false,
    });
  }

  // The walk window: the earliest month anyone assigned in, through the month
  // being viewed. Viewing a month that predates every assignment walks just
  // that one month, carry 0.
  let startKey = earliestKey;
  const truncated = monthDiff(startKey, targetKey) >= MAX_WALK_MONTHS;
  if (truncated) startKey = shiftMonthKey(targetKey, -(MAX_WALK_MONTHS - 1));

  const months = [];
  for (let cur = startKey; ; cur = shiftMonthKey(cur, 1)) {
    months.push(cur);
    if (cur === targetKey) break;
  }

  // Every category that has an assignment, a target, or spending this month.
  const categories = new Set([...assigned.keys(), ...settingByCategory.keys()]);
  for (const [category, byMonth] of spent) {
    if (byMonth.has(targetKey)) categories.add(category);
  }

  const rows = [];
  for (const category of categories) {
    const setting = settingByCategory.get(category) || DEFAULT_SETTING;
    const assignedByMonth = assigned.get(category);
    const spentByMonth = spent.get(category);

    // A category's envelope begins at ITS OWN first assignment — never at the
    // household's. Walking a never-assigned category from someone else's start
    // month would turn its ordinary past spending into rolled-over "debt".
    // A zero assignment does not open one: moving money out of an envelope can
    // leave a 0 row behind, and that must stay equivalent to no row at all.
    let catStart = targetKey;
    if (assignedByMonth) {
      for (const [key, amount] of assignedByMonth) {
        if (amount !== 0 && key < catStart) catStart = key;
      }
    }
    if (catStart < startKey) catStart = startKey;

    let carry = 0;
    let row = null;
    for (const key of months) {
      if (key < catStart) continue;
      const a = assignedByMonth?.get(key) || 0;
      const s = spentByMonth?.get(key) || 0;
      const available = a + carry - s;
      if (key === targetKey) {
        row = {
          category,
          assigned: cents(a),
          rolledOver: cents(carry),
          spent: cents(s),
          available: cents(available),
          ...setting,
          // Only the VIEWED month's override — past overrides never leak
          // forward, and the carry math above never read this.
          targetOverride: overrides.has(category) ? overrides.get(category) : null,
        };
      }
      carry = setting.rollover ? available : 0;
    }
    if (row) rows.push(row);
  }

  rows.sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));

  // Totals describe the BUDGET, so they cover only categories that actually
  // have an envelope or a target — spending in an unbudgeted category is not
  // "over" anything.
  const totals = rows
    .filter(r => r.assigned !== 0 || r.rolledOver !== 0 || effectiveTarget(r) != null)
    .reduce(
      (acc, r) => ({
        assigned: cents(acc.assigned + r.assigned),
        rolledOver: cents(acc.rolledOver + r.rolledOver),
        spent: cents(acc.spent + r.spent),
        available: cents(acc.available + r.available),
        // The month's headline target is what THIS month actually asks for,
        // so an override replaces the category target in the sum.
        target: cents(acc.target + (effectiveTarget(r) || 0)),
      }),
      { assigned: 0, rolledOver: 0, spent: 0, available: 0, target: 0 }
    );

  return { month: targetKey, categories: rows, totals, truncated };
}

// Rule 1. `income` is whatever resolveBudgetIncome picked for the month —
// hand-entered for the month in progress, measured for a completed month (the
// hybrid rule below). Deliberately NOT carried over from prior months: income
// is a per-month figure, and a carry-forward would compound whatever months
// the user never filled in. One month in, one month out.
// Returns null when no income is set, so the UI can hide the number instead of
// showing a confident zero.
export function readyToAssign(income, totals) {
  const n = Number(income);
  if (income == null || income === '' || !Number.isFinite(n)) return null;
  return cents(n - (totals?.assigned || 0));
}

// The hybrid income rule (Mason, 2026-08-13 — opens the income wall halfway).
// Which figure feeds Ready to Assign for a viewed month:
//   - The month IN PROGRESS (and any future month) stays MANUAL: its paychecks
//     haven't all landed, so the measured number is guaranteed-low exactly
//     while it's the one being budgeted against. Same for a month the clock
//     can't place (no todayKey): without a trustworthy "now", never switch.
//   - A COMPLETED month reads ACTUAL income measured from the ledger (the
//     shared cashIncome model — unpaired depository inflows), automatically.
//     The typed figure survives as the PLAN for comparison; it no longer
//     drives RTA once the month is over.
//   - Fallbacks that keep the old wall's honesty: a completed month is only
//     "measured" if the ledger actually covers it — coverageStart (the
//     household's earliest visible depository row) must be on/before the 1st,
//     else deriving would read missing history as $0 income. And a failed
//     actual read (actual == null) falls back to manual rather than blanking
//     RTA — a load hiccup must not zero the month.
// Returns { amount, source: 'manual'|'actual', manual, actual } — amount may
// be null (nothing to show), matching readyToAssign's null contract.
export function resolveBudgetIncome({ year, month, todayKey, manual, actual, coverageStart }) {
  const viewKey = monthKey(year, month);
  const curKey = normalizeMonthKey(String(todayKey || '').slice(0, 7));
  const manualOut = { amount: manual ?? null, source: 'manual', manual: manual ?? null, actual: actual ?? null };
  if (!curKey || viewKey >= curKey) return manualOut;
  const covered = coverageStart != null && String(coverageStart).slice(0, 10) <= `${viewKey}-01`;
  const a = Number(actual);
  if (!covered || actual == null || !Number.isFinite(a)) return manualOut;
  return { amount: cents(a), source: 'actual', manual: manual ?? null, actual: cents(a) };
}

// Moving money between envelopes is rule 3's actual mechanic: cover an
// overspent category from one that has room. Pure so the arithmetic (and the
// "leaves exactly zero" case, which must delete the row rather than store a 0)
// is testable without a database.
// Auto-fill: copy last month's assignments into the viewed month ("Fill from
// July"). MERGE semantics, deliberately not fundTargets': an envelope the user
// already assigned in this month is theirs and is skipped, and a zero sum is
// never written (a 0 row must stay equivalent to no row). An existing 0 row
// counts as absent — moveMoney can leave one behind, and filling it is exactly
// the sent-columns-only upsert that leaves any target_override on it intact.
// Negative source assignments are copied as-is: the user put the envelope in
// debt on purpose last month, and "helpfully" zeroing it would misstate the plan.
//
// source / existing: [{ category, assigned }] — the previous / viewed month's
// budget_months rows. Duplicate source categories sum first (mirroring the
// walk's byMonth accumulation). Returns:
//   { rows:    [{ category, assigned }],  // what to upsert into the viewed month
//     skipped: [{ category, assigned }],  // source amounts NOT copied (already set)
//     total }                             // sum of rows' assigned
export function planAutoFill({ source = [], existing = [], isBudgetable = () => true }) {
  // Sum duplicates, exactly like the walk does per month.
  const byCategory = new Map();
  for (const row of source) {
    const amount = Number(row.assigned) || 0;
    byCategory.set(row.category, (byCategory.get(row.category) || 0) + amount);
  }

  // Viewed-month categories that already hold a NON-ZERO assignment; a 0 row
  // is equivalent to no row and gets filled.
  const taken = new Set();
  for (const row of existing) {
    if ((Number(row.assigned) || 0) !== 0) taken.add(row.category);
  }

  const rows = [];
  const skipped = [];
  let total = 0;
  for (const [category, sum] of byCategory) {
    const amount = cents(sum);
    if (amount === 0) continue; // zero sums are dropped, never written
    if (!isBudgetable(category)) continue;
    if (taken.has(category)) {
      skipped.push({ category, assigned: amount });
      continue;
    }
    rows.push({ category, assigned: amount });
    total += amount;
  }
  return { rows, skipped, total: cents(total) };
}

export function planMove({ from, to, amount, assignedByCategory = {} }) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (!from || !to || from === to) return null;
  return [
    { category: from, assigned: cents((Number(assignedByCategory[from]) || 0) - n) },
    { category: to, assigned: cents((Number(assignedByCategory[to]) || 0) + n) },
  ];
}
