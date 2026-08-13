// How an account balance is SHOWN, as opposed to how it is stored.
//
// Stored convention (unchanged, and inherited from Plaid): `current_balance` is
// POSITIVE = money OWED for credit and loan accounts. A card with $5,127.97
// outstanding is +5127.97 in the database. SimpleFIN reports that same card as
// -5127.97 and api/_lib/simplefin.js normalizeBalance() flips it on the way in,
// so both feeds agree in the database.
//
// Display convention: a debt reads as NEGATIVE, because that is what it is
// against net worth. Only the presentation flips — nothing downstream of the
// stored column changes, which is what keeps the debt math natural (payoff
// amortization and utilization = current_balance / credit_limit both want a
// positive outstanding balance) and keeps Plaid-fed and SimpleFIN-fed rows
// identical while both feeds are live.
//
// Pure JS, no React and no Supabase, so the serverless assistant context can
// import it too — the Ask tab must describe balances the same way the screen
// shows them, or its answers contradict what the user is looking at.

export function isDebtAccount(type) {
  return type === 'credit' || type === 'loan';
}

// balance: the stored value (positive = owed for debts). type: accounts.type.
// Returns the number to render. Null/undefined passes through as 0 so callers
// can format it directly — a missing balance already reads as "$0.00" today.
export function displayBalance(balance, type) {
  const n = Number(balance ?? 0);
  if (!Number.isFinite(n)) return 0;
  const out = isDebtAccount(type) ? -n : n;
  // Never return -0: a paid-off card is a common state, and while the current
  // formatters happen to render -0 and 0 identically (fmtX tests `v < 0`,
  // toFixed prints "0.00"), a future display site calling toLocaleString on
  // the raw value would show "-$0.00". Normalize at the source.
  return out === 0 ? 0 : out;
}

// How old the balance on screen actually is.
//
// `accounts.last_balance_at` is stamped by every sync from the feed's own
// balance-date, and (since 2026-08-13) by a hand-typed manual balance — but
// nothing rendered it, so a figure typed in June and a figure pulled this
// morning looked identical, in the Debt tab and net worth alike. This is the
// unknowns-stay-visible rule applied to balances: the row already carried the
// answer.
//
// Returns null when there is nothing honest to say — no timestamp (a manual
// row typed before the stamp shipped, the getReceiptTxIds absence rule) or an
// unparseable one. Otherwise { date, staleDays }, where staleDays counts whole
// days back from `now` and is floored at 0 (a clock skew must never render a
// balance as being from the future).
export function balanceAsOf(account, now = new Date()) {
  const raw = account?.last_balance_at;
  if (!raw) return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return null;
  const ref = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(ref.getTime())) return null;
  const DAY = 86400000;
  return { date: at, staleDays: Math.max(0, Math.floor((ref.getTime() - at.getTime()) / DAY)) };
}

// Past this many days a balance gets a visible age. Chosen against the feed's
// own cadence: SimpleFIN refreshes about daily, so a fed account crossing two
// weeks means the feed has been quiet far longer than normal, and a manual
// balance that old is genuinely worth re-checking. Rendered MUTED, never amber
// — amber has to keep meaning "something is broken" (the coverage-notice
// rule), and an old balance is a known limit, not a fault.
export const BALANCE_STALE_DAYS = 14;
