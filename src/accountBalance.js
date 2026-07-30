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
  return isDebtAccount(type) ? -n : n;
}
