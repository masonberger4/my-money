import { getServiceClient, requireUser } from './_lib/supabase.js';
import {
  fetchAccountSet,
  normalizeAccountSet,
  inferAccountType,
  normalizeBalance,
  normalizeAvailableBalance,
  sanitizeFeedMessage,
  SFIN_PREFIX,
  FIRST_PULL_DAYS,
  OVERLAP_DAYS,
  MAX_LOOKBACK_DAYS,
  clampStartDate,
  coverageShortfall,
  watermarkUpdate,
  MIN_PULL_MINUTES,
  INCLUDE_PENDING,
} from './_lib/simplefin.js';
import { classifyDescription } from '../src/txClassify.js';

// depository + credit fund the spending/cash-flow views; loan lets linked
// debts (mortgage, student/personal loans) sync their balances for the debt
// tracker. Loan accounts carry sparse/no transaction rows — under Plaid their
// real data (APR, minimum payment, due date) comes from the Liabilities
// product; under SimpleFIN it is hand-entered.
const ALLOWED_TYPES = new Set(['depository', 'credit', 'loan']);

const DAY_MS = 86_400_000;

// Columns that may not exist yet on the shared production database.
// Module scope so a warm invocation only has to learn each one once.
// transactions.source landed with the CSV-import migration; last_attempt_at was
// added to the SimpleFIN migration after it was first published.
let txHaveSource = true;
let hasAttemptColumn = true;
let hasSnapshotTable = true;

// PostgREST/Postgres codes for "that column/table isn't there". Previews share
// the production database, so every read and write has to survive the window
// between a branch deploying and Mason pasting its migration.
function errorBlob(error) {
  return `${error.message || ''} ${error.details || ''} ${error.hint || ''}`.toLowerCase();
}

// A missing COLUMN. The name must appear: PostgREST names it in the message,
// and matching on the code alone would let a DIFFERENT missing column be
// mistaken for the optional one and silently dropped.
export function isMissingColumnError(error, name) {
  if (!error) return false;
  const blob = errorBlob(error);
  if (!blob.includes(String(name).toLowerCase())) return false;
  if (error.code === 'PGRST204' || error.code === '42703') return true;
  return /column/.test(blob);
}

// A missing TABLE — deliberately NOT the same test. A missing-column error
// mentions the table name too ("column simplefin_access.last_attempt_at does
// not exist"), so a loose check would read a column problem as "SimpleFIN isn't
// installed" and silently switch the whole feed off with nothing surfaced.
export function isMissingTableError(error, table) {
  if (!error) return false;
  const blob = errorBlob(error);
  if (!blob.includes(String(table).toLowerCase())) return false;
  if (error.code === 'PGRST205' || error.code === '42P01') return true;
  return /could not find the table|relation .* does not exist/.test(blob);
}

// =============================================================================
// SimpleFIN
//
// Where Plaid gives one access token per institution and a per-institution
// cursor, SimpleFIN gives ONE access URL covering every bank the user linked at
// the Bridge, fetched in a single GET with no cursor and no pagination. So this
// pass is per-access-URL, not per-institution: pull once, then fan the response
// out into institutions (per SimpleFIN org), accounts and transactions.
// =============================================================================

// The household's learned merchant→category rules, as a plain object for
// classifyDescription. Read under service_role (RLS bypassed). Returns {} when
// the migration hasn't been pasted yet — nothing is guessed, so an untaught
// merchant simply stays Uncategorized.
//
// Shape: { merchantKey: [{ amount, category }, ...] } — `amount: null` is the
// any-amount rule (see src/txClassify.js). The `amount` COLUMN arrives with
// migration 20260805000002, which is pasted AFTER the deploy, so this must
// keep working without it: a missing COLUMN retries the narrower select, which
// is a SEPARATE test from a missing TABLE (conflating them would read a column
// problem as "no rules at all" and silently revert every taught merchant on
// the next pull).
async function loadCategoryRules(supabase, householdId) {
  const read = cols =>
    supabase.from('category_rules').select(cols).eq('household_id', householdId);
  let { data, error } = await read('merchant_key, category, amount');
  if (error && isMissingColumnError(error, 'amount')) {
    ({ data, error } = await read('merchant_key, category'));
  }
  if (error) {
    if (isMissingTableError(error, 'category_rules')) return {};
    throw error;
  }
  const rules = {};
  for (const r of data || []) {
    const amt = r.amount == null || r.amount === '' ? null : Number(r.amount);
    (rules[r.merchant_key] ||= []).push({
      amount: Number.isFinite(amt) ? amt : null,
      category: r.category,
    });
  }
  return rules;
}

// Read the household's stored access URLs. Returns null — not an error — when
// the SimpleFIN migration hasn't been pasted yet.
async function loadAccessRows(supabase, householdId) {
  const read = columns =>
    supabase.from('simplefin_access').select(columns).eq('household_id', householdId);

  let { data, error } = await read('id, access_url, last_pulled_at, last_attempt_at');
  if (error && isMissingColumnError(error, 'last_attempt_at')) {
    // The throttle column was added to this migration after it was first
    // published, so a database that ran the earlier version won't have it yet.
    // Fall back to throttling on last_pulled_at (the original behavior) rather
    // than refusing to sync.
    hasAttemptColumn = false;
    ({ data, error } = await read('id, access_url, last_pulled_at'));
  }
  if (error) {
    if (isMissingTableError(error, 'simplefin_access')) return null;
    throw error;
  }
  return data || [];
}

// Find-or-create one institution row per SimpleFIN org. Returns a Map of
// orgKey → { id, disabled }. A disabled institution is one the user removed
// from the app (see api/unlink-institution.js): its org stays on the feed
// because the access URL is shared, so the row is kept as a tombstone and its
// accounts are never recreated.
async function resolveOrgInstitutions(supabase, householdId, orgs) {
  const { data: existing, error } = await supabase
    .from('institutions')
    .select('id, simplefin_org_id, status')
    .eq('household_id', householdId)
    .not('simplefin_org_id', 'is', null);
  if (error) throw error;

  const byKey = new Map();
  for (const inst of existing || []) {
    byKey.set(inst.simplefin_org_id, { id: inst.id, disabled: inst.status === 'disabled' });
  }

  const missing = orgs.filter(o => !byKey.has(o.key));
  if (missing.length) {
    const { data: inserted, error: insErr } = await supabase
      .from('institutions')
      .insert(
        missing.map(o => ({
          household_id: householdId,
          name: o.label,
          simplefin_org_id: o.key,
          status: 'active',
        }))
      )
      .select('id, simplefin_org_id');
    if (insErr) throw insErr;
    for (const inst of inserted || []) {
      byKey.set(inst.simplefin_org_id, { id: inst.id, disabled: false });
    }
  }
  return byKey;
}

// Append today's balance-history rows (debt tracker groundwork; also seeds the
// future net-worth chart). One row per account per day, only when the balance
// changed — the caller filters, the (account_id, captured_on) upsert dedups.
// Runs as SERVICE_ROLE, where the current_household_id() default resolves to
// NULL, so household_id is set EXPLICITLY on every row (see Gotchas). Best
// effort: a missing balance_snapshots table (migration not pasted yet — previews
// share the prod database) switches it off quietly, and any other failure is
// logged rather than allowed to break the sync — history is auxiliary, the
// balances themselves already landed on `accounts`.
async function appendBalanceSnapshots(supabase, householdId, snapshots, capturedOn) {
  if (!hasSnapshotTable || !snapshots.length) return;
  const { error } = await supabase.from('balance_snapshots').upsert(
    snapshots.map(s => ({
      household_id: householdId,
      account_id: s.accountId,
      captured_on: capturedOn,
      balance: s.balance,
    })),
    { onConflict: 'account_id,captured_on' }
  );
  if (error) {
    if (isMissingTableError(error, 'balance_snapshots')) {
      hasSnapshotTable = false;
      return;
    }
    console.warn('[sync:simplefin] balance snapshot append failed', error.message || error);
  }
}

// The PostgREST condition that makes the pre-request throttle stamp a
// CONDITIONAL update (see its use below: the row itself is the lock against
// two devices racing). Pure and exported for test/syncDecisions.test.js,
// because both of its load-bearing details fail silently: the `is.null` arm
// (a bare .lt() never matches NULL, and api/simplefin-claim.js resets the
// stamp to null — drop the arm and the first unforced pull after a claim
// matches no row and reads as "throttled" forever), and the cutoff value
// (PostgREST's or= grammar splits on commas and parens, so the timestamp
// must never contain either — an ISO string doesn't, a locale string would).
export function attemptThrottleFilter(nowMs) {
  const cutoff = new Date(nowMs - MIN_PULL_MINUTES * 60_000).toISOString();
  return `last_attempt_at.is.null,last_attempt_at.lt.${cutoff}`;
}

// Exported for test/syncOrchestration.test.js only — nothing else imports it.
export async function pullOneAccessUrl(supabase, householdId, accessRow, { force, categoryRules }) {
  const now = new Date();
  const lastPulled = accessRow.last_pulled_at ? new Date(accessRow.last_pulled_at) : null;
  // Throttle on the last ATTEMPT, not the last success — otherwise a broken
  // connection would be retried on every dashboard load forever. Falls back to
  // the success watermark where the column isn't there yet.
  const attemptStamp = hasAttemptColumn ? accessRow.last_attempt_at : accessRow.last_pulled_at;
  const lastAttempt = attemptStamp ? new Date(attemptStamp) : null;

  if (!force && lastAttempt && now.getTime() - lastAttempt.getTime() < MIN_PULL_MINUTES * 60_000) {
    return {
      institution: 'SimpleFIN',
      skipped: 'throttled',
      last_pulled_at: lastPulled ? lastPulled.toISOString() : null,
    };
  }

  // Incremental: re-request an overlap window because a bank can amend or
  // late-post a transaction inside a date we already pulled. Re-seeing a row is
  // free — the upsert lands on the same (account_id, plaid_tx_id).
  const floor = now.getTime() - FIRST_PULL_DAYS * DAY_MS;
  const wantedStartMs = lastPulled
    ? Math.max(lastPulled.getTime() - OVERLAP_DAYS * DAY_MS, floor)
    : floor;
  // SimpleFIN serves at most 90 days per request, so what we WANT and what we
  // can ASK FOR are two different dates. Clamping here (as well as inside
  // fetchAccountSet) is what lets the shortfall be reported instead of silently
  // dropped: `clamped` means there is a window we wanted and cannot get from the
  // feed at all, and statement import is the only way it ever arrives.
  const { startMs } = clampStartDate(wantedStartMs, now.getTime());
  const startDate = new Date(startMs);
  const shortfall = coverageShortfall(wantedStartMs, now.getTime());
  if (shortfall) {
    console.warn(
      '[sync:simplefin] feed reach is %d days: wanted from %s, requesting from %s',
      MAX_LOOKBACK_DAYS,
      shortfall.wanted_from,
      shortfall.served_from
    );
  }

  // Stamped before the request, so a timeout or a crashed invocation still
  // counts as an attempt and the throttle holds. The stamp is CONDITIONAL and
  // doubles as the real throttle check: the read at loadAccessRows is stale by
  // the time we get here, so two devices syncing in the same window would both
  // pass the check above and both hit the Bridge. Updating only where the
  // stored stamp is still outside the window makes the row itself the lock —
  // zero rows back means someone else stamped first. NULL must match too (a
  // bare .lt() never matches NULL, and the post-claim reset in
  // api/simplefin-claim.js sets it null).
  if (hasAttemptColumn) {
    let stamp = supabase
      .from('simplefin_access')
      .update({ last_attempt_at: now.toISOString() })
      .eq('id', accessRow.id);
    if (!force) {
      stamp = stamp.or(attemptThrottleFilter(now.getTime()));
    }
    const { data: stamped, error: attemptErr } = await stamp.select('id');
    if (attemptErr) {
      if (!isMissingColumnError(attemptErr, 'last_attempt_at')) throw attemptErr;
      hasAttemptColumn = false;
    } else if (!force && !(stamped || []).length) {
      return {
        institution: 'SimpleFIN',
        skipped: 'throttled',
        last_pulled_at: lastPulled ? lastPulled.toISOString() : null,
      };
    }
  }

  const json = await fetchAccountSet(accessRow.access_url, {
    startDate,
    pending: INCLUDE_PENDING,
  });
  // `errors` is REAL problems only; date-range notices about our own request
  // arrive separately (see classifyFeedMessage). Only `errors` may hold the
  // watermark back or block statement import.
  const { errors, advisories, capped, accounts, skipped } = normalizeAccountSet(json);

  if (skipped) {
    console.warn('[sync:simplefin] skipped %d unusable account object(s)', skipped);
  }
  for (const note of [...capped, ...advisories]) {
    console.warn('[sync:simplefin] feed advisory (not a failure): %s', note);
  }
  // SimpleFIN reports a broken bank connection as a free-text string in the
  // response body rather than an HTTP error, and keeps returning the accounts
  // it *can* reach. Nothing back at all plus ANY message means the pull failed —
  // deliberately every message class, not just `errors`: an advisory arriving
  // with zero accounts is a Bridge that answered without answering, and treating
  // that as success would advance the watermark over data we never saw. Zero
  // accounts and zero messages is a Bridge with no banks linked yet, which is
  // not an error.
  const allMessages = [...errors, ...capped, ...advisories];
  if (allMessages.length && accounts.length === 0) {
    throw new Error(`SimpleFIN reported: ${allMessages.join('; ')}`);
  }

  // ---- institutions, one per org -------------------------------------------
  const orgs = [];
  const seenOrg = new Set();
  for (const acct of accounts) {
    const key = acct.org.key || 'unknown';
    if (seenOrg.has(key)) continue;
    seenOrg.add(key);
    orgs.push({ key, label: acct.org.label });
  }
  const instByOrg = await resolveOrgInstitutions(supabase, householdId, orgs);

  // ---- accounts -------------------------------------------------------------
  const { data: existingRows, error: acctErr } = await supabase
    .from('accounts')
    .select('id, plaid_account_id, institution_id, type, subtype, current_balance')
    .eq('household_id', householdId)
    .like('plaid_account_id', `${SFIN_PREFIX}%`);
  if (acctErr) throw acctErr;
  const existingByExternal = new Map((existingRows || []).map(a => [a.plaid_account_id, a]));

  const toInsert = [];
  const toUpdate = [];
  // Balance-history candidates (debt tracker groundwork): externalId + the
  // balance as STORED (debts positive — balance_snapshots mirrors
  // accounts.current_balance, never the display sign).
  const snapshotCandidates = [];
  const usable = [];
  const typeByExternal = new Map();
  let ignoredTypes = 0;

  // A response that listed the same account twice would build the same
  // transaction rows twice, and Postgres rejects an upsert whose payload hits
  // one row twice ("ON CONFLICT DO UPDATE command cannot affect row a second
  // time") — which would fail the entire sync, not just the duplicate.
  const seenAccount = new Set();

  for (const acct of accounts) {
    const inst = instByOrg.get(acct.org.key || 'unknown');
    if (!inst || inst.disabled) continue;

    const externalId = SFIN_PREFIX + acct.externalId;
    if (seenAccount.has(externalId)) continue;
    seenAccount.add(externalId);
    const existing = existingByExternal.get(externalId);

    // The account's type is INSERT-ONLY. SimpleFIN sends no type at all, so it
    // is guessed from the name once; after that it is user-owned (the Accounts
    // tab can correct it) and the feed must never clobber the correction —
    // the same rule that protects nickname/color/hidden.
    const guessed = existing ? null : inferAccountType(acct.name, acct.org, acct.balance);
    const type = existing ? existing.type : guessed.type;
    const subtype = existing ? existing.subtype : guessed.subtype;
    if (guessed?.uncertain) {
      // Worth a log line: a card guessed as checking turns every purchase on it
      // into household spending the moment the account is unhidden.
      console.warn(
        '[sync:simplefin] account type is a GUESS for "%s" (%s) -> %s/%s — confirm it in the Accounts tab',
        acct.name,
        acct.org.label,
        type,
        subtype
      );
    }

    if (!ALLOWED_TYPES.has(type)) {
      ignoredTypes++;
      continue;
    }

    const balance = normalizeBalance(type, acct.balance);
    if ((type === 'credit' || type === 'loan') && acct.balance != null) {
      // The debt-balance sign convention is the one thing the protocol doesn't
      // pin down (see normalizeBalance). Log both so a real card can settle it.
      console.log(
        '[sync:simplefin] debt balance %s: feed=%s stored=%s (verify the sign)',
        acct.name,
        acct.balance,
        balance
      );
    }

    usable.push({ acct, externalId });
    // Needed when classifying this account's transactions below — `collect`
    // only sees normalized feed accounts, which carry no type.
    typeByExternal.set(externalId, type);

    // ONE convention now: money available to spend, positive-is-good (see
    // normalizeAvailableBalance — this column previously held the raw feed
    // value when the feed sent one and the normalized owed-amount when it
    // didn't, which read as "available" money on a card that was in fact debt).
    const available = normalizeAvailableBalance(type, acct.availableBalance, acct.balance);

    // Append a history row only when there is a balance and it actually moved
    // (a first sight of the account counts as a move). ≤ one row per account
    // per day — same-day re-pulls land on the (account_id, captured_on) upsert.
    if (balance != null && (!existing || Number(existing.current_balance) !== balance)) {
      snapshotCandidates.push({ externalId, balance });
    }

    if (existing) {
      toUpdate.push({
        id: existing.id,
        patch: {
          name: acct.name,
          currency: acct.currency,
          // A degraded connection can return the account with a blank balance.
          // parseMoney maps that to null (deliberately — absent must not read
          // as zero), but writing the null over a known balance would show the
          // account as $0.00 in every view. Keep the last known good instead.
          ...(balance == null ? {} : { current_balance: balance }),
          // The don't-write-null guard is keyed on `balance`, NOT on
          // `available`. A blank BALANCE is the tell for a degraded read, and
          // then we keep the last known good for both columns. But on a HEALTHY
          // read a null `available` is now MEANINGFUL — it is how a card whose
          // feed sends no available-balance is stored — so it must be written,
          // or a row carrying a stale value (including one written under the
          // old two-convention scheme, i.e. the owed amount) would never be
          // corrected.
          ...(balance == null ? {} : { available_balance: available }),
          ...(balance == null
            ? {}
            : { last_balance_at: acct.balanceDate || now.toISOString() }),
          // Re-home the account if its org now resolves to a different
          // institution — e.g. the Bridge flipped protocol version and the org
          // id moved. Without this the account would be stranded under the old
          // institution while a new empty one sat beside it.
          ...(existing.institution_id !== inst.id ? { institution_id: inst.id } : {}),
        },
      });
    } else {
      toInsert.push({
        household_id: householdId,
        institution_id: inst.id,
        plaid_account_id: externalId,
        name: acct.name,
        official_name: '',
        type,
        subtype,
        // SimpleFIN sends no mask, and the name often already ends in the last
        // four digits — leaving it empty avoids "Checking 1234 ··1234" labels.
        mask: '',
        current_balance: balance,
        available_balance: available,
        currency: acct.currency,
        last_balance_at: acct.balanceDate || now.toISOString(),
        // Hidden on arrival, on purpose. The original reason — a bank fed by
        // both Plaid and SimpleFIN would land its transactions twice — died
        // with Plaid. The surviving reason is sharper: SimpleFIN sends no
        // account type, so it is GUESSED from the account name a few lines up,
        // and that guess governs three separate numbers at READ time (see the
        // account-type Convention in CLAUDE.md): a card mistaken for a
        // checking account turns its refunds into income, lets card-payment
        // wording veto real purchases out of spending, and counts its balance
        // as an asset instead of a debt. Hidden
        // accounts are fully browsable in the Accounts tab but excluded from
        // spending, trends and totals, so unhiding is the deliberate act that
        // CONFIRMS the type — and `hidden` is user-owned, so no later sync
        // re-hides it.
        hidden: true,
      });
    }
  }

  if (toInsert.length) {
    const { error } = await supabase
      .from('accounts')
      .upsert(toInsert, {
        onConflict: 'institution_id,plaid_account_id',
        ignoreDuplicates: true,
      });
    if (error) throw error;
  }
  for (const { id, patch } of toUpdate) {
    // One statement per account (there are only ever a handful) rather than a
    // bulk upsert: a bulk upsert would have to restate type/subtype/hidden in
    // every row, which is exactly what must not be overwritten.
    const { error } = await supabase.from('accounts').update(patch).eq('id', id);
    if (error) throw error;
  }

  // ---- transactions ---------------------------------------------------------
  const { data: idRows, error: idErr } = await supabase
    .from('accounts')
    .select('id, plaid_account_id')
    .eq('household_id', householdId)
    .like('plaid_account_id', `${SFIN_PREFIX}%`);
  if (idErr) throw idErr;
  const uuidByExternal = new Map((idRows || []).map(a => [a.plaid_account_id, a.id]));

  // ---- balance snapshots (debt tracker) -------------------------------------
  await appendBalanceSnapshots(
    supabase,
    householdId,
    snapshotCandidates
      .map(s => ({ accountId: uuidByExternal.get(s.externalId), balance: s.balance }))
      .filter(s => s.accountId),
    now.toISOString().slice(0, 10)
  );

  const txRows = [];
  // Same duplicate hazard as accounts, one level down: a repeated transaction
  // id inside one account would make the upsert touch a row twice and abort.
  const seenTx = new Set();
  const collect = normalizedAccounts => {
    for (const acct of normalizedAccounts) {
      const externalId = SFIN_PREFIX + acct.externalId;
      const accountUuid = uuidByExternal.get(externalId);
      if (!accountUuid) continue;
      const acctType = typeByExternal.get(externalId);
      for (const tx of acct.transactions) {
        const dedupKey = `${accountUuid}|${tx.externalId}`;
        if (seenTx.has(dedupKey)) continue;
        seenTx.add(dedupKey);
        // SimpleFIN ships no category, so it is derived from the descriptor at
        // write time — the same keyword table the CSV importer uses. `payee` is
        // the cleaner merchant string when the server sends one; memo is left
        // out because freeform text ("transfer for rent") would mislabel bills.
        const descriptor =
          tx.payee && tx.payee !== tx.description
            ? `${tx.payee} ${tx.description}`
            : tx.description;
        // The account type is what stops a card PURCHASE from being read as a
        // card PAYMENT and dropped from spending entirely (see txClassify.js).
        // `rules` is the household's learned merchant memory — without it here,
        // every corrected merchant would revert to Uncategorized on the next pull.
        const { raw_category, mapped_category } = classifyDescription(
          descriptor,
          tx.amount,
          acctType,
          categoryRules
        );
        txRows.push({
          household_id: householdId,
          account_id: accountUuid,
          plaid_tx_id: SFIN_PREFIX + tx.externalId,
          date: tx.date,
          amount: tx.amount,
          merchant_name: tx.payee || '',
          description: tx.description,
          raw_category,
          mapped_category,
          pending: tx.pending,
          pulled_at: now.toISOString(),
        });
      }
    }
  };
  collect(usable.map(u => u.acct));

  // Backfill accounts we're seeing for the first time. One access URL covers
  // every bank linked at the Bridge, so a bank added there later just shows up
  // in a later pull — and that pull's start-date came from the shared
  // watermark, which would cap the newcomer at the 30-day overlap. Re-request
  // full history, scoped to only the new accounts (`account` is a repeatable
  // param) so this costs one extra call the first time a bank appears.
  const backfillIds = toInsert
    .map(r => String(r.plaid_account_id).slice(SFIN_PREFIX.length))
    .filter(Boolean);
  let backfillFailed = false;
  if (backfillIds.length && lastPulled) {
    try {
      const history = await fetchAccountSet(accessRow.access_url, {
        startDate: new Date(floor),
        pending: INCLUDE_PENDING,
        accountIds: backfillIds,
      });
      const before = txRows.length;
      // fetchAccountSet clamps this start to MAX_LOOKBACK_DAYS, so `floor`
      // (FIRST_PULL_DAYS back) is the reach we want, not what arrives — a new
      // account gets the feed's whole window and no more, whatever that is.
      const backfillSet = normalizeAccountSet(history);
      collect(backfillSet.accounts);
      // A real error here means the new account's history is incomplete. It used
      // to be discarded silently: only `.accounts` was read, so a broken bank in
      // the backfill response looked identical to a clean one.
      if (backfillSet.errors.length) {
        throw new Error(`SimpleFIN reported: ${backfillSet.errors.join('; ')}`);
      }
      console.log(
        '[sync:simplefin] backfilled %d row(s) of history for %d new account(s)',
        txRows.length - before,
        backfillIds.length
      );
    } catch (err) {
      // Not fatal — the accounts and their recent transactions are already
      // written. But this pull can't simply be retried: backfillIds comes from
      // the accounts INSERTED this time round, so by the next pull they exist
      // and nothing would trigger it again. Flagged so the watermark is reset
      // instead, which makes the next pull a full-history one for every
      // account (idempotent upserts make that safe, just a bigger response).
      backfillFailed = true;
      console.warn('[sync:simplefin] history backfill failed', err?.message || err);
    }
  }

  let written = 0;
  const batch = 500;
  for (let i = 0; i < txRows.length; i += batch) {
    const slice = txRows.slice(i, i + batch);
    const attempt = withSource =>
      supabase
        .from('transactions')
        .upsert(
          withSource ? slice.map(r => ({ ...r, source: 'simplefin' })) : slice,
          { onConflict: 'account_id,plaid_tx_id' }
        );

    let { error } = await attempt(txHaveSource);
    if (error && txHaveSource && isMissingColumnError(error, 'source')) {
      txHaveSource = false;
      ({ error } = await attempt(false));
    }
    if (error) throw error;
    written += slice.length;
  }

  // ---- bookkeeping ----------------------------------------------------------
  const instIds = [...new Set(usable.map(u => instByOrg.get(u.acct.org.key || 'unknown')?.id))].filter(
    Boolean
  );
  if (instIds.length) {
    const { error } = await supabase
      .from('institutions')
      .update({
        last_successful_pull_at: now.toISOString(),
        status: 'active',
        last_error: null,
      })
      .in('id', instIds);
    if (error) throw error;
  }

  // Advance the data watermark ONLY on a pull with no REAL error. A partial
  // failure comes back as HTTP 200 with the reachable banks plus an error
  // string for the broken one — moving the watermark then would leave the
  // broken bank's outage window behind forever once it exceeded the 30-day
  // overlap. Leaving it put means the next pull re-requests from where the
  // last good one ended; startDate is floored at FIRST_PULL_DAYS so a bank the
  // user never fixes can't grow the window without bound.
  //
  // "REAL error" is load-bearing, and the distinction is not cosmetic: counting
  // SimpleFIN's date-range notices here deadlocked the feed in production. The
  // watermark stayed NULL, so every pull asked for the full FIRST_PULL_DAYS
  // window, which re-emitted the notice, which kept the watermark NULL — while
  // each of those pulls wrote hundreds of transactions perfectly well. Statement
  // import was collateral: pullWasClean treats any `warnings` as unclean.
  //
  // A CAPPED range does not hold the watermark either, which looks wrong and
  // isn't: stalling recovers nothing, because the next pull computes the same
  // start and is served the same truncated response, so the un-served window
  // only grows. A coverage shortfall is reported (below) instead of being
  // expressed as a refusal to move.
  //
  // A failed history backfill clears the watermark instead, so the next pull
  // re-requests full history for every account — the only way to give the new
  // account the history it missed, since it will no longer look "new".
  // last_attempt_at still holds the throttle, so this can't turn into a loop.
  //
  // The decision itself is pure — watermarkUpdate in api/_lib/simplefin.js,
  // pinned by test/syncDecisions.test.js, because its failure mode (the
  // advisory deadlock) had no alarm anywhere.
  const { error: accessErr } = await supabase
    .from('simplefin_access')
    .update(watermarkUpdate({ errors, backfillFailed, nowIso: now.toISOString() }))
    .eq('id', accessRow.id);
  if (accessErr) throw accessErr;

  return {
    institution: 'SimpleFIN',
    institutions: instIds.length,
    accounts: usable.length,
    accounts_created: toInsert.length,
    ignored_accounts: ignoredTypes,
    transactions: written,
    ...(errors.length ? { warnings: errors } : {}),
    // Deliberately NOT `warnings`. pullWasClean (src/sync.js) rejects a result
    // carrying warnings, and gating statement import on a note about our own
    // request is what blocked every import into every SimpleFIN account.
    ...(capped.length || advisories.length ? { advisories: [...capped, ...advisories] } : {}),
    // The window we wanted and the feed cannot serve. Nothing downstream can
    // recover it — statement import is the path — so it is surfaced rather than
    // dropped.
    ...(shortfall ? { coverage_shortfall: shortfall } : {}),
  };
}

async function syncSimpleFin(supabase, householdId, { force }) {
  const accessRows = await loadAccessRows(supabase, householdId);
  if (accessRows === null || accessRows.length === 0) return [];

  const categoryRules = await loadCategoryRules(supabase, householdId);

  const results = [];
  for (const row of accessRows) {
    try {
      results.push(await pullOneAccessUrl(supabase, householdId, row, { force, categoryRules }));
    } catch (err) {
      const message = err?.message || 'Unknown error';
      console.error('[sync:simplefin] pull failed', err);
      // Record the failure but leave last_pulled_at alone: advancing the
      // watermark on a failed pull would skip past transactions we never read.
      // Sanitized because last_error is rendered in the connect modal and a
      // database error can quote feed-supplied text (an account name, say).
      const { error: recordErr } = await supabase
        .from('simplefin_access')
        .update({ last_error: sanitizeFeedMessage(message) })
        .eq('id', row.id);
      if (recordErr) {
        // error, not warn: the pull failed AND the record of the failure
        // failed, so the connect modal will show nothing — this log line is
        // the only place the double failure is visible at all.
        console.error(
          '[sync:simplefin] failed to record last_error for access row %s',
          row.id,
          recordErr.message || recordErr
        );
      }
      results.push({
        institution: 'SimpleFIN',
        error: message,
        needs_reauth: err?.code === 'auth_failed',
      });
    }
  }
  return results;
}

// =============================================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const user = await requireUser(req, res);
  if (!user) return;

  const force = !!(req.body || {}).force;

  try {
    const supabase = getServiceClient();

    // ONE pass now: SimpleFIN. The institutions/plaid_tokens lookup and the
    // per-institution Plaid loop that used to run first are gone with Plaid, and
    // with them the reason this handler read `institutions` at all — the
    // SimpleFIN pass resolves its own institutions from the org ids in the feed
    // response (see resolveOrgInstitutions), because one access URL covers every
    // bank and the org list is only knowable after the pull.
    //
    // The try/catch stays. It no longer protects a second feed from this one,
    // but it is what converts a thrown SimpleFIN error into a 200 carrying a
    // per-result error, which is the shape src/sync.js expects; letting it throw
    // would surface as a bare 500 with nothing to show the user.
    const results = [];
    try {
      results.push(...(await syncSimpleFin(supabase, user.householdId, { force })));
    } catch (err) {
      console.error('[sync:simplefin] pass failed', err);
      results.push({ institution: 'SimpleFIN', error: err?.message || 'Unknown error' });
    }

    return res.status(200).json({ results });
  } catch (err) {
    // Log the full error server-side; never echo upstream bodies to the
    // client — generic string + stable code only (same discipline as the
    // other routes' catch-alls).
    console.error('sync error', err?.response?.data || err);
    return res
      .status(500)
      .json({ error: 'sync_failed', message: 'Sync failed — try again.' });
  }
}
