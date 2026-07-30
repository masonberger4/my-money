// Unit tests for the pure parts of api/_lib/simplefin.js — the feed-message
// classifier and the lookback clamp.
//
// Why this file exists: nothing in the repo loads api/*.js except
// test/apiLoads.test.js, which only proves the module imports. So this
// classifier would otherwise ship with no net at all — and its failure mode is
// exactly the production bug it was written to fix: SimpleFIN returns notices
// about the DATE RANGE WE ASKED FOR in the same array as broken-bank reports,
// api/sync.js counted them as errors, and the sync deadlocked (watermark stayed
// NULL -> next pull asked for the same oversized window -> same notice) while
// every pull wrote hundreds of transactions perfectly well. Statement import was
// blocked into every SimpleFIN account for the same reason.
//
// The two strings at the top are verbatim from the live Bridge.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFeedMessage,
  normalizeAccountSet,
  clampStartDate,
  sanitizeFeedMessage,
  MAX_LOOKBACK_DAYS,
} from '../api/_lib/simplefin.js';

const CAPPED = 'Requested date range exceeds limit of 90 days and was capped.';
const RECOMMENDED =
  'Requested date range exceeds recommended range of 45 days. In the future, this may be capped.';

const DAY = 86400000;

test('the two live Bridge notices classify as capped vs advisory', () => {
  // The ordering trap: both mention "capped". Only the first says data WAS
  // truncated; the second is a warning about future requests. Getting this
  // backwards either invents a coverage gap or hides a real one.
  assert.equal(classifyFeedMessage(CAPPED), 'capped');
  assert.equal(classifyFeedMessage(RECOMMENDED), 'advisory');
});

test('a reworded date-range notice still classifies (conjunctive, not a fixed phrase)', () => {
  assert.equal(
    classifyFeedMessage('The date range requested exceeds the recommended range of 45 days.'),
    'advisory'
  );
  assert.equal(
    classifyFeedMessage('Requested date range exceeds the maximum of 90 days; results were capped.'),
    'capped'
  );
});

test('a TRUNCATED notice still classifies — sanitizeFeedMessage caps at 300 chars', () => {
  // readFeedEntry appends " (CODE)" and sanitizes msg and code separately, so
  // neither end of the original sentence is guaranteed to survive. The regexes
  // must therefore be anchored at neither end.
  assert.equal(classifyFeedMessage(sanitizeFeedMessage(RECOMMENDED).slice(0, 40)), 'advisory');
  assert.equal(classifyFeedMessage(sanitizeFeedMessage(CAPPED).slice(0, 44)), 'capped');
});

test('v2 code-only entries classify from the code alone', () => {
  // A code with no prose is the case a text-only allowlist misses entirely.
  assert.equal(classifyFeedMessage({ code: 'DATE_RANGE_CAPPED' }), 'capped');
  assert.equal(classifyFeedMessage({ code: 'DATE_RANGE_EXCEEDED' }), 'advisory');
  // readFeedEntry composes "msg (CODE)", so nothing may be $-anchored.
  assert.equal(classifyFeedMessage({ code: 'DATE_RANGE_EXCEEDED', msg: RECOMMENDED }), 'advisory');
});

test('REGRESSION: the classifier is an ALLOWLIST — unknown messages stay errors', () => {
  // This is the polarity that matters. A denylist would silently swallow the
  // next unfamiliar real failure, leaving the bank feed quietly stale.
  for (const msg of [
    'BECU: Connection may need attention.',
    'Authentication failed for Capital One - please reconnect.',
    'Payment required.',
    'MFA challenge pending for Chase.',
    'Stale data: last successful login 12 days ago.',
    'Rate limit exceeded, try again later.',
    'Zorkbank flarn 7', // novel and meaningless — must NOT be downgraded
  ]) {
    assert.equal(classifyFeedMessage(msg), 'error', msg);
  }
  // The JSON.stringify fallback shape (no msg, no code) is also an error.
  assert.equal(classifyFeedMessage({ foo: 1 }), 'error');
  assert.equal(classifyFeedMessage(null), 'error');
});

test('a real failure that quotes our request stays an error (veto beats the range match)', () => {
  // Feed prose is free text and can contain a bank name or our own wording, so
  // "needs attention"/"reconnect" vetoes the date-range path.
  assert.equal(
    classifyFeedMessage(
      'Chase: unable to return the requested date range; the connection needs attention.'
    ),
    'error'
  );
  assert.equal(
    classifyFeedMessage('Requested date range exceeds what we can serve - please reconnect this bank.'),
    'error'
  );
  assert.equal(
    classifyFeedMessage('Login failed for "Requested date range exceeds limit of 90 days"'),
    'error'
  );
});

test('a bare "capped" is truncation unless it is about FUTURE requests', () => {
  // Erring toward 'capped' is the safe direction — it reports a shortfall the
  // user can fill from a statement instead of silently dropping the window.
  assert.equal(classifyFeedMessage('Requested date range capped.'), 'capped');
  // …but the live 45-day notice says "may be capped" and must stay advisory,
  // or every ordinary first pull would report a coverage gap it doesn't have.
  assert.equal(classifyFeedMessage(RECOMMENDED), 'advisory');
  assert.equal(
    classifyFeedMessage('Requested date range exceeds 45 days; it might be capped later.'),
    'advisory'
  );
  // Both signals present: past-tense truncation wins.
  assert.equal(
    classifyFeedMessage('Requested date range exceeds recommended range of 45 days and was capped.'),
    'capped'
  );
});

test('prose that normalizes onto a code key does NOT bypass the per-bank veto', () => {
  // The code-set lookup reads the v2 `code` field only. Before that, a per-bank
  // entry whose wording normalized to DATE_RANGE_CAPPED skipped the veto — which
  // contradicted the documented rule.
  assert.equal(classifyFeedMessage({ msg: 'Date range capped', conn_id: 'c1' }), 'error');
  // With no per-bank structure the same prose is classified on its merits.
  assert.equal(classifyFeedMessage('Date range capped'), 'capped');
});

test('REGRESSION: a real failure that ALSO mentions a date range stays an error', () => {
  // Every one of these was mis-downgraded during review — a broken bank whose
  // message happened to contain a range subject plus a limit word slipped out of
  // `errors`, which advances the watermark and clears last_error, leaving the
  // outage with no alarm anywhere. Two causes, both fixed: the trouble veto ran
  // AFTER the code allowlist, and `\bauthenticat\b` could not match
  // "Authentication" (the trailing word boundary fails against the "ion").
  for (const msg of [
    'Connection to Jenius may need attention (date range exceeded).',
    'Account may need attention: requested date range exceeds limit.',
    'Authentication error: requested date range exceeds limit of 90 days.',
    'Access denied for the requested date range limit.',
    'Rate limit exceeded for the requested date range; try again later.',
  ]) {
    assert.equal(classifyFeedMessage(msg), 'error', msg);
  }
  // An allowlisted code must not rescue real-trouble prose either — the code
  // vocabulary is our guess, so it may outrank per-bank structure but never the
  // trouble test.
  assert.equal(
    classifyFeedMessage({
      code: 'DATE_RANGE_EXCEEDED',
      msg: 'Please reconnect BECU - credentials expired',
      conn_id: 'c1',
    }),
    'error'
  );
  assert.equal(
    classifyFeedMessage({ code: 'date-range-exceeded', msg: 'Login failed', account_id: 'a1' }),
    'error'
  );
  // …and the two live notices must be untouched by all of that hardening.
  assert.equal(classifyFeedMessage(CAPPED), 'capped');
  assert.equal(classifyFeedMessage(RECOMMENDED), 'advisory');
});

test('clampStartDate accepts an ISO string, as fetchAccountSet’s JSDoc advertises', () => {
  // A string used to yield NaN, which the caller wrapped in a Date; buildAccountsUrl
  // then dropped start-date entirely and asked for EVERY transaction the Bridge holds.
  const now = Date.UTC(2026, 6, 29);
  const r = clampStartDate('2024-05-01', now);
  assert.equal(r.clamped, true);
  assert.equal(r.startMs, now - MAX_LOOKBACK_DAYS * DAY);
  assert.ok(Number.isFinite(r.startMs));
});

test('per-bank structure forces error, but an allowlisted code still wins', () => {
  // conn_id/account_id means the entry is pinned to one bank, so it is that
  // bank's problem whatever the prose says...
  assert.equal(classifyFeedMessage({ msg: CAPPED, account_id: 'acct_1' }), 'error');
  assert.equal(classifyFeedMessage({ msg: CAPPED, conn_id: 'c1' }), 'error');
  // ...unless SimpleFIN tells us the kind directly via an allowlisted code.
  assert.equal(classifyFeedMessage({ code: 'DATE_RANGE_CAPPED', conn_id: 'c1' }), 'capped');
});

test('normalizeAccountSet splits the three message classes and keeps accounts', () => {
  const r = normalizeAccountSet({
    errors: [CAPPED, RECOMMENDED, 'BECU: needs attention'],
    accounts: [{ id: 'a1', name: 'Checking', balance: '10.00', transactions: [] }],
  });
  assert.deepEqual(r.errors, ['BECU: needs attention']);
  assert.equal(r.capped.length, 1);
  assert.equal(r.advisories.length, 1);
  assert.equal(r.accounts.length, 1);
});

test('both wire shapes reach the classifier (v1 errors, v2 errlist)', () => {
  const r = normalizeAccountSet({
    errlist: [
      { code: 'DATE_RANGE_CAPPED' },
      { code: 'AUTH', msg: 'Login failed', conn_id: 'c1' },
    ],
    accounts: [{ id: 'a1', name: 'Checking', balance: '1.00', transactions: [] }],
  });
  assert.equal(r.errors.length, 1);
  assert.equal(r.capped.length, 1);
  assert.equal(r.advisories.length, 0);
});

test('clampStartDate holds the steady-state incremental pull untouched', () => {
  const now = Date.UTC(2026, 6, 29);
  // The ordinary pull is last_pulled_at − OVERLAP_DAYS (30). It must NEVER be
  // clamped, or the clamp would silently narrow every routine sync.
  const steady = clampStartDate(now - 30 * DAY, now);
  assert.equal(steady.clamped, false);
  assert.equal(steady.startMs, now - 30 * DAY);
});

test('clampStartDate pulls an over-long first request inside the feed ceiling', () => {
  const now = Date.UTC(2026, 6, 29);
  const first = clampStartDate(now - 730 * DAY, now);
  assert.equal(first.clamped, true);
  assert.equal(first.startMs, now - MAX_LOOKBACK_DAYS * DAY);
});

test('REGRESSION: the clamp stays inside SimpleFIN’s 90-day hard cap', () => {
  // Raising this past 90 re-arms the original bug: the request would be capped
  // server-side again, re-emitting the "was capped" notice on every pull.
  assert.ok(MAX_LOOKBACK_DAYS <= 90, `MAX_LOOKBACK_DAYS is ${MAX_LOOKBACK_DAYS}, must be <= 90`);
});

test('clampStartDate tolerates junk rather than throwing', () => {
  // It runs inside the sync path; a throw here would take the whole pull down.
  const now = Date.UTC(2026, 6, 29);
  assert.equal(clampStartDate(NaN, now).clamped, false);
  assert.equal(clampStartDate(now - 10 * DAY, NaN).clamped, false);
  // Date instances are accepted on both sides.
  assert.equal(clampStartDate(new Date(now - 730 * DAY), new Date(now)).clamped, true);
});
