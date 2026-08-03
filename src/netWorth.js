// Net worth over time, folded from balance_snapshots — pure (no React, no
// Supabase; the only import is the pure sign rule, so tests run in plain Node).
//
// Inputs mirror the adapter shapes exactly:
//   snapshots: [{ account_id, captured_on: 'YYYY-MM-DD', balance }] — balance
//     in the STORED convention (debts positive = owed). Order not assumed;
//     the fold sorts by captured_on (the date-only string sorts lexically).
//   accounts:  [{ id, type }] — the accounts that COUNT. Hidden exclusion is
//     the caller's job (Mason 2026-08-03: hidden accounts' balances are OUT,
//     consistent with the query-level rule), so this fold never sees them and
//     drops any snapshot row whose account isn't listed (a snapshot can
//     outlive an account's unhidden status).
//
// Returns [{ date, total }] oldest first, one point per distinct snapshot
// date. `total` is assets minus debts: each account's LATEST snapshot
// on-or-before the date, run through displayBalance (credit/loan negate) and
// summed. Accounts snapshot only on balance change, so the fold CARRIES each
// account's last value forward — a day where only one bank reported must not
// read as the others hitting zero. An account with no snapshot yet before a
// date contributes 0 (there is nothing honest to claim for it).
import { displayBalance } from './accountBalance.js';

export function netWorthSeries(snapshots, accounts) {
  const typeById = new Map();
  for (const a of accounts || []) typeById.set(a.id, a.type);
  const rows = (snapshots || [])
    .filter(s => typeById.has(s.account_id))
    .slice()
    .sort((a, b) => (a.captured_on < b.captured_on ? -1 : a.captured_on > b.captured_on ? 1 : 0));
  const last = new Map(); // account_id -> signed (displayed) balance
  const points = [];
  let cur = null;
  for (const s of rows) {
    last.set(s.account_id, displayBalance(s.balance, typeById.get(s.account_id)));
    let total = 0;
    for (const v of last.values()) total += v;
    if (cur && cur.date === s.captured_on) cur.total = total;
    else points.push((cur = { date: s.captured_on, total }));
  }
  return points;
}
