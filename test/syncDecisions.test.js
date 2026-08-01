// api/sync.js decision logic: the watermark decision (extracted pure as
// watermarkUpdate/coverageShortfall in api/_lib/simplefin.js) and the
// missing-table vs missing-column discrimination. The deadlock the watermark
// rules prevent had NO alarm anywhere — the only tell was last_pulled_at NULL
// while transactions kept arriving — which is exactly why it needs a test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isMissingTableError, isMissingColumnError } from '../api/sync.js';
import {
  watermarkUpdate,
  coverageShortfall,
  normalizeAccountSet,
  MAX_LOOKBACK_DAYS,
} from '../api/_lib/simplefin.js';

const NOW_ISO = '2026-07-31T12:00:00.000Z';

// --- the watermark decision --------------------------------------------------

test('REGRESSION: advisories and capped ranges ADVANCE the watermark and clear last_error', () => {
  // The production deadlock: notices about our own request counted as errors,
  // the watermark never advanced, every pull re-asked for the oversized
  // window and got the same notice — forever. The two live Bridge notices
  // must come out of normalizeAccountSet as non-errors, and a pull carrying
  // only them must advance.
  const set = normalizeAccountSet({
    errors: [
      'Requested date range exceeds limit of 90 days and was capped.',
      'Requested date range exceeds recommended range of 45 days. In the future, this may be capped.',
    ],
    accounts: [{ id: 'a1', name: 'Checking', balance: '10.00', transactions: [] }],
  });
  assert.deepEqual(set.errors, [], 'neither live notice is a real error');
  assert.deepEqual(watermarkUpdate({ errors: set.errors, nowIso: NOW_ISO }), {
    last_pulled_at: NOW_ISO,
    last_error: null,
  });
});

test('a REAL error holds the watermark and records last_error', () => {
  const patch = watermarkUpdate({ errors: ['BECU: needs attention'], nowIso: NOW_ISO });
  assert.ok(!('last_pulled_at' in patch), 'the watermark must not move');
  assert.equal(patch.last_error, 'BECU: needs attention');
});

test('a failed history backfill CLEARS the watermark (the next pull re-fetches full history)', () => {
  assert.deepEqual(watermarkUpdate({ errors: [], backfillFailed: true, nowIso: NOW_ISO }), {
    last_pulled_at: null,
    last_error: null,
  });
  // With errors too: the reset still wins over "hold", and the error records.
  const both = watermarkUpdate({ errors: ['Chase: auth failed'], backfillFailed: true, nowIso: NOW_ISO });
  assert.equal(both.last_pulled_at, null);
  assert.equal(both.last_error, 'Chase: auth failed');
});

test('last_error is joined and truncated at 1000 chars', () => {
  const errors = ['x'.repeat(600), 'y'.repeat(600)];
  const patch = watermarkUpdate({ errors, nowIso: NOW_ISO });
  assert.equal(patch.last_error.length, 1000);
  assert.ok(patch.last_error.startsWith('x'.repeat(600) + '; '));
});

// --- coverage shortfall ------------------------------------------------------

const DAY = 86400000;

test('coverageShortfall reports the clamped window instead of stalling the watermark', () => {
  const now = Date.UTC(2026, 6, 31);
  const wanted = now - 730 * DAY; // FIRST_PULL_DAYS reach
  const s = coverageShortfall(wanted, now);
  assert.deepEqual(s, {
    wanted_from: new Date(wanted).toISOString().slice(0, 10),
    served_from: new Date(now - MAX_LOOKBACK_DAYS * DAY).toISOString().slice(0, 10),
  });
  // The steady-state incremental pull (30-day overlap) is never a shortfall.
  assert.equal(coverageShortfall(now - 30 * DAY, now), null);
});

// --- missing table vs missing column -----------------------------------------

test('the adversarial case: a missing-COLUMN error that NAMES the table is not a missing table', () => {
  // "column simplefin_access.last_attempt_at does not exist" mentions the
  // table too; conflating the two tests reads a column problem as "SimpleFIN
  // isn't installed" and silently switches the whole feed off.
  const err = { code: '42703', message: 'column simplefin_access.last_attempt_at does not exist' };
  assert.equal(isMissingTableError(err, 'simplefin_access'), false);
  assert.equal(isMissingColumnError(err, 'last_attempt_at'), true);
});

test('a DIFFERENT missing column does not match the named one', () => {
  const err = { code: '42703', message: 'column transactions.source does not exist' };
  assert.equal(isMissingColumnError(err, 'last_attempt_at'), false);
  assert.equal(isMissingColumnError(err, 'source'), true);
});

test('a genuine missing-table error matches only the table test', () => {
  const pg = { code: '42P01', message: 'relation "simplefin_access" does not exist' };
  assert.equal(isMissingTableError(pg, 'simplefin_access'), true);
  assert.equal(isMissingColumnError(pg, 'last_attempt_at'), false);

  const postgrest = {
    code: 'PGRST205',
    message: "Could not find the table 'public.simplefin_access' in the schema cache",
  };
  assert.equal(isMissingTableError(postgrest, 'simplefin_access'), true);
  // …and a missing-table error for a DIFFERENT table doesn't match.
  assert.equal(isMissingTableError(pg, 'category_rules'), false);
});

test('null and garbage errors return false from both', () => {
  for (const junk of [null, undefined, {}, { code: '500' }, { message: 'network unreachable' }]) {
    assert.equal(isMissingTableError(junk, 'simplefin_access'), false, JSON.stringify(junk));
    assert.equal(isMissingColumnError(junk, 'last_attempt_at'), false, JSON.stringify(junk));
  }
});
