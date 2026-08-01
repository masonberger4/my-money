// api/sync.js orchestration — pullOneAccessUrl driven end to end against an
// in-memory Supabase fake (test/helpers/fakeSupabase.js) and a stubbed
// globalThis.fetch serving SimpleFIN wire fixtures (the simplefinToken.test.js
// pattern). The extracted pure decisions are already pinned elsewhere
// (watermarkUpdate/coverageShortfall/attemptThrottleFilter in
// test/syncDecisions.test.js; classifyFeedMessage/clamp/normalization in
// test/simplefin*.test.js) — this file covers the orchestration BODY those
// decisions plug into: insert-only type protection, seenAccount/seenTx dedup,
// null-balance keep-last, institution re-homing, how the watermark
// advance/hold/reset decisions are APPLIED, snapshot append candidacy, and
// both throttle-skip paths.
//
// ORDERING NOTE — sticky degrade flags. api/sync.js keeps three per-instance
// flags (txHaveSource / hasAttemptColumn / hasSnapshotTable) that latch false
// once a missing column/table is seen. node --test gives this file its own
// process, but within the file the module state persists across tests, so the
// two degrade tests that flip flags run LAST: everything asserting `source` on
// stored transactions or a balance_snapshots append must stay above them.
// (The flags themselves are deliberate and stay — previews share the PROD
// database, and every future migration reopens the deploy-before-migration
// window. See the backlog entry.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { pullOneAccessUrl } from '../api/sync.js';
import { MAX_LOOKBACK_DAYS, FIRST_PULL_DAYS } from '../api/_lib/simplefin.js';
import { FALLBACK_CATEGORY } from '../src/categoryMap.js';
import { makeFakeSupabase } from './helpers/fakeSupabase.js';

const HH = 'hh-1';
// A PUBLIC IP literal, not a hostname: the SSRF gate (assertPublicHost) now
// RESOLVES hostnames via DNS, and api/sync.js — correctly — exposes no
// injectable-lookup seam. An IP literal is classified by isPrivateIp without
// any resolution, and no traffic ever leaves the process: globalThis.fetch is
// stubbed for every pull below.
const ACCESS_URL = 'https://u:p@8.8.8.8/simplefin';
const DAY_MS = 86400000;

const daysAgoIso = n => new Date(Date.now() - n * DAY_MS).toISOString();
const epochDaysAgo = n => Math.floor((Date.now() - n * DAY_MS) / 1000);

// --- wire fixtures (protocol v1 shape; normalizeAccountSet reads both) -------

const ORG = { name: 'BECU', domain: 'becu.org', url: 'https://becu.org' };
const ORG_KEY = 'domain:becu.org'; // orgKey(): no id → domain fallback

// SimpleFIN wire signs: negative = money OUT of the account (the app negates).
const wireTx = (id, amount, description, extra = {}) => ({
  id,
  posted: epochDaysAgo(3),
  amount,
  description,
  ...extra,
});

const wireAcct = (id, name, balance, transactions = [], extra = {}) => ({
  id,
  name,
  currency: 'USD',
  'balance-date': epochDaysAgo(1),
  org: ORG,
  transactions,
  ...(balance === undefined ? {} : { balance }),
  ...extra,
});

const accessRow = (over = {}) => ({
  id: 'sf1',
  access_url: ACCESS_URL,
  last_pulled_at: null,
  last_attempt_at: null,
  ...over,
});

const seedAccess = (over = {}) => [accessRow(over)];

const pull = (fake, row, opts = {}) =>
  pullOneAccessUrl(fake.client, HH, row, { force: false, categoryRules: {}, ...opts });

// --- fetch stub --------------------------------------------------------------

function withFetchStub(script, fn, { events } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (events) events.push('fetch');
    const r =
      typeof script === 'function' ? script(String(url), init, calls.length) : script[calls.length - 1];
    if (!r) throw new Error(`fetch stub: no scripted response for call ${calls.length}`);
    const status = r.status ?? 200;
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: name => (r.headers || {})[String(name).toLowerCase()] ?? null },
      text: async () => body,
    };
  };
  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => {
      globalThis.fetch = original;
    });
}

// --- throttle ----------------------------------------------------------------

test('throttle: a fresh last_attempt_at skips before any DB write or Bridge request', () =>
  withFetchStub([], async calls => {
    const fresh = new Date(Date.now() - 5 * 60_000).toISOString();
    const pulled = daysAgoIso(1);
    const fake = makeFakeSupabase({
      simplefin_access: seedAccess({ last_attempt_at: fresh, last_pulled_at: pulled }),
    });
    const res = await pull(fake, accessRow({ last_attempt_at: fresh, last_pulled_at: pulled }));
    assert.equal(res.skipped, 'throttled');
    assert.equal(res.last_pulled_at, pulled);
    assert.equal(calls.length, 0, 'the Bridge is never contacted');
    assert.equal(fake.writes.length, 0, 'not even the attempt stamp is written');
  }));

test('throttle: the conditional attempt stamp is the lock — a stale read that lost the race skips', () =>
  withFetchStub([], async calls => {
    // Another device stamped last_attempt_at AFTER our loadAccessRows read: the
    // row we were handed says NULL, the database says two minutes ago. The
    // in-memory check passes, so only the conditional UPDATE (zero rows back)
    // stands between us and a second Bridge hit inside the window.
    const fresh = new Date(Date.now() - 2 * 60_000).toISOString();
    const fake = makeFakeSupabase({ simplefin_access: seedAccess({ last_attempt_at: fresh }) });
    const res = await pull(fake, accessRow({ last_attempt_at: null }));
    assert.equal(res.skipped, 'throttled');
    assert.equal(calls.length, 0);
    assert.equal(fake.writes.length, 1, 'exactly the guarded stamp attempt');
    assert.equal(fake.writes[0].table, 'simplefin_access');
    assert.equal(fake.writes[0].matched, 0, 'the or= guard matched no row — someone else stamped first');
    assert.equal(fake.rows('simplefin_access')[0].last_attempt_at, fresh, 'the winner\'s stamp survives');
  }));

// --- first pull --------------------------------------------------------------

test('first pull: one institution per org; accounts arrive hidden with an inferred, normalized shape', () => {
  const fake = makeFakeSupabase({
    simplefin_access: seedAccess(),
    // A manual account already present — the sfin-scoped reads and writes must
    // never touch it.
    accounts: [
      {
        id: 'man-1',
        household_id: HH,
        plaid_account_id: 'manual:abc',
        name: 'Imported',
        type: 'depository',
        hidden: false,
        current_balance: 42,
      },
    ],
  });
  const wire = {
    errors: [],
    accounts: [
      wireAcct('A1', 'Everyday Checking', '1500.00', [wireTx('t1', '-45.00', 'ZURPLE COFFEE ROASTERS SEATTLE')]),
      // A card by product name only, balance NEGATIVE on the wire (= owed).
      wireAcct('A2', 'Venture X', '-500.00'),
      // Not in ALLOWED_TYPES → counted, never written.
      wireAcct('A3', 'Total Brokerage', '9000.00'),
    ],
  };
  return withFetchStub(
    [{ body: wire }],
    async calls => {
      const res = await pull(fake, accessRow());

      const insts = fake.rows('institutions');
      assert.equal(insts.length, 1, 'one institution per SimpleFIN org');
      assert.equal(insts[0].simplefin_org_id, ORG_KEY);
      assert.equal(insts[0].name, 'BECU');
      assert.equal(insts[0].status, 'active');
      assert.ok(insts[0].last_successful_pull_at, 'bookkeeping stamped the pull');

      const sfin = fake.rows('accounts').filter(a => String(a.plaid_account_id).startsWith('sfin:'));
      assert.equal(sfin.length, 2, 'brokerage filtered out by ALLOWED_TYPES');
      const chk = sfin.find(a => a.plaid_account_id === 'sfin:A1');
      const card = sfin.find(a => a.plaid_account_id === 'sfin:A2');
      assert.equal(chk.type, 'depository');
      assert.equal(chk.subtype, 'checking');
      assert.equal(card.type, 'credit', 'product name alone ("Venture X") resolves as a card');
      assert.equal(card.current_balance, 500, 'debt stored POSITIVE = owed (normalizeBalance flip)');
      for (const a of [chk, card]) {
        assert.equal(a.hidden, true, 'hidden on arrival — unhiding is what confirms the guessed type');
        assert.equal(a.mask, '');
        assert.equal(a.household_id, HH);
      }
      const acctUpsert = fake.writes.find(w => w.table === 'accounts' && w.op === 'upsert');
      assert.equal(acctUpsert.options.onConflict, 'institution_id,plaid_account_id');
      assert.equal(acctUpsert.options.ignoreDuplicates, true);

      assert.equal(fake.rows('accounts').find(a => a.id === 'man-1').current_balance, 42, 'manual account untouched');

      // The request itself is clamped to the feed's real reach…
      const startSec = Number(new URL(calls[0].url).searchParams.get('start-date'));
      assert.ok(
        Math.abs(startSec * 1000 - (Date.now() - MAX_LOOKBACK_DAYS * DAY_MS)) < DAY_MS,
        `start-date is ~${MAX_LOOKBACK_DAYS} days back, not FIRST_PULL_DAYS`
      );
      // …and the attempt stamp lands BEFORE the Bridge is contacted, so a
      // timeout still counts as an attempt.
      assert.ok(
        fake.events.indexOf('update:simplefin_access') < fake.events.indexOf('fetch'),
        'last_attempt_at is stamped before the request'
      );

      // Wanted FIRST_PULL_DAYS, served MAX_LOOKBACK_DAYS: reported as a
      // shortfall while the watermark still advances (stalling recovers nothing).
      assert.ok(res.coverage_shortfall);
      const sf = fake.rows('simplefin_access')[0];
      assert.ok(sf.last_pulled_at, 'watermark advanced on the clean first pull');
      assert.ok(Date.now() - Date.parse(sf.last_pulled_at) < 60_000);
      assert.equal(sf.last_error, null);

      assert.equal(res.institutions, 1);
      assert.equal(res.accounts, 2);
      assert.equal(res.accounts_created, 2);
      assert.equal(res.ignored_accounts, 1);
      assert.ok(!('warnings' in res));
    },
    { events: fake.events }
  );
});

test('transactions: sign flip, sfin: ids, source tag, and the learned rule beating the keyword table', () => {
  const fake = makeFakeSupabase({ simplefin_access: seedAccess() });
  const wire = {
    errors: [],
    accounts: [
      wireAcct('A1', 'Everyday Checking', '1500.00', [
        wireTx('t1', '-4.50', 'ZURPLE COFFEE ROASTERS SEATTLE'),
        wireTx('t2', '-99.00', 'XQWJVK QZPLR'),
        wireTx('t3', '2500.00', 'ACH CREDIT ACME CORP', { payee: 'ACME' }),
      ]),
    ],
  };
  // The keyword table would file t1 under coffee; the household's learned rule
  // must win — this is the "corrected merchant reverts on the next pull" bug.
  const rules = { 'ZURPLE COFFEE ROASTERS': 'Entertainment and subscriptions' };
  return withFetchStub([{ body: wire }], async () => {
    const res = await pull(fake, accessRow(), { categoryRules: rules });
    const txs = fake.rows('transactions');
    assert.equal(res.transactions, 3);
    assert.equal(txs.length, 3);

    const t1 = txs.find(t => t.plaid_tx_id === 'sfin:t1');
    const acctUuid = fake.rows('accounts').find(a => a.plaid_account_id === 'sfin:A1').id;
    assert.equal(t1.account_id, acctUuid);
    assert.equal(t1.household_id, HH);
    assert.equal(t1.amount, 4.5, 'wire -4.50 (money out) → app +4.50');
    assert.equal(t1.source, 'simplefin');
    assert.equal(t1.mapped_category, 'Entertainment and subscriptions', 'learned rule wins at write time');

    const t2 = txs.find(t => t.plaid_tx_id === 'sfin:t2');
    assert.equal(t2.mapped_category, FALLBACK_CATEGORY, 'unknown merchants stay a VISIBLE unknown');

    const t3 = txs.find(t => t.plaid_tx_id === 'sfin:t3');
    assert.equal(t3.amount, -2500, 'money in stays negative');
    assert.equal(t3.merchant_name, 'ACME', 'payee is the merchant string when the server sends one');

    const txUpsert = fake.writes.find(w => w.table === 'transactions' && w.op === 'upsert');
    assert.equal(txUpsert.options.onConflict, 'account_id,plaid_tx_id');
  });
});

test('seenAccount/seenTx: a response repeating an account and a tx id upserts each once, no abort', () => {
  // The fake enforces the real Postgres rule: an ON CONFLICT DO UPDATE payload
  // that hits one row twice aborts the whole statement. Without the dedup sets
  // this pull would FAIL outright, not just double-write.
  const fake = makeFakeSupabase({ simplefin_access: seedAccess() });
  const wire = {
    errors: [],
    accounts: [
      wireAcct('A1', 'Everyday Checking', '1500.00', [
        wireTx('t1', '-10.00', 'ZZZ ONE'),
        wireTx('t1', '-10.00', 'ZZZ ONE'), // repeated inside the account
      ]),
      // …and the whole account listed twice: the second listing is skipped.
      wireAcct('A1', 'Everyday Checking', '1500.00', [wireTx('t2', '-20.00', 'ZZZ TWO')]),
    ],
  };
  return withFetchStub([{ body: wire }], async () => {
    const res = await pull(fake, accessRow());
    assert.equal(res.accounts, 1);
    assert.equal(res.accounts_created, 1);
    assert.equal(res.transactions, 1);
    assert.deepEqual(
      fake.rows('transactions').map(t => t.plaid_tx_id),
      ['sfin:t1'],
      'the duplicate listing contributes nothing'
    );
    assert.equal(fake.rows('accounts').length, 1);
  });
});

// --- second pull: the user-owned-columns rule ---------------------------------

const secondPullSeed = (acctOver = {}) => ({
  simplefin_access: seedAccess({ last_pulled_at: daysAgoIso(10) }),
  institutions: [
    { id: 'inst-1', household_id: HH, simplefin_org_id: ORG_KEY, status: 'active', name: 'BECU' },
  ],
  accounts: [
    {
      id: 'acct-1',
      household_id: HH,
      institution_id: 'inst-1',
      plaid_account_id: 'sfin:A1',
      name: 'Venture X',
      type: 'credit',
      subtype: 'credit card',
      hidden: false,
      nickname: 'Our card',
      color: '#123456',
      current_balance: 500,
      ...acctOver,
    },
  ],
});

test('second pull: balance updates run through the STORED type; user-owned columns are never written', () => {
  const fake = makeFakeSupabase(secondPullSeed());
  const wire = { errors: [], accounts: [wireAcct('A1', 'Venture X Rewards', '-750.00')] };
  return withFetchStub([{ body: wire }], async () => {
    const res = await pull(fake, accessRow({ last_pulled_at: daysAgoIso(10) }));
    assert.equal(res.accounts_created, 0);
    assert.ok(!('coverage_shortfall' in res), 'a steady-state incremental pull has no shortfall');

    const acctWrites = fake.writes.filter(w => w.table === 'accounts');
    assert.deepEqual(acctWrites.map(w => w.op), ['update'], 'per-row update, never a bulk upsert restating types');
    assert.deepEqual(
      Object.keys(acctWrites[0].patch).sort(),
      ['available_balance', 'currency', 'current_balance', 'last_balance_at', 'name'],
      'type/subtype/hidden/nickname/color are absent from the patch by construction'
    );

    const row = fake.rows('accounts')[0];
    assert.equal(row.type, 'credit');
    assert.equal(row.subtype, 'credit card');
    assert.equal(row.hidden, false);
    assert.equal(row.nickname, 'Our card');
    assert.equal(row.color, '#123456');
    // inferAccountType never ran — the feed's -750 normalized through the
    // stored, user-owned type: positive = owed.
    assert.equal(row.current_balance, 750);
    assert.equal(row.name, 'Venture X Rewards');

    // Balance moved 500 → 750: one snapshot row, stored sign, explicit
    // household_id (service_role — the RLS default resolves to NULL there).
    const snaps = fake.rows('balance_snapshots');
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].account_id, 'acct-1');
    assert.equal(snaps[0].balance, 750);
    assert.equal(snaps[0].household_id, HH);
    assert.match(snaps[0].captured_on, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Math.abs(Date.parse(snaps[0].captured_on) - Date.now()) < 2 * DAY_MS);
    const snapUpsert = fake.writes.find(w => w.table === 'balance_snapshots');
    assert.equal(snapUpsert.options.onConflict, 'account_id,captured_on');
  });
});

test('null-balance keep-last: a blank balance never overwrites the known one, and is no snapshot', () => {
  const fake = makeFakeSupabase(secondPullSeed());
  // A degraded connection: the account comes back with NO balance field.
  const wire = { errors: [], accounts: [wireAcct('A1', 'Venture X', undefined)] };
  return withFetchStub([{ body: wire }], async () => {
    await pull(fake, accessRow({ last_pulled_at: daysAgoIso(10) }));
    const patch = fake.writes.find(w => w.table === 'accounts' && w.op === 'update').patch;
    assert.deepEqual(Object.keys(patch).sort(), ['currency', 'name'], 'no balance, no last_balance_at');
    assert.equal(fake.rows('accounts')[0].current_balance, 500, 'last known good balance kept');
    assert.ok(!fake.events.includes('upsert:balance_snapshots'), 'a null balance is never a snapshot candidate');
  });
});

test('snapshot candidacy: an UNCHANGED balance appends no history row', () => {
  const fake = makeFakeSupabase(secondPullSeed());
  const wire = { errors: [], accounts: [wireAcct('A1', 'Venture X', '-500.00')] }; // normalizes to the stored 500
  return withFetchStub([{ body: wire }], async () => {
    await pull(fake, accessRow({ last_pulled_at: daysAgoIso(10) }));
    assert.ok(!fake.events.includes('upsert:balance_snapshots'), 'only a moved balance is a candidate');
    assert.equal(fake.rows('accounts')[0].current_balance, 500);
  });
});

test('institution re-homing: an account whose org resolved to a different institution moves with it', () => {
  const fake = makeFakeSupabase(secondPullSeed({ institution_id: 'inst-stale' }));
  const wire = { errors: [], accounts: [wireAcct('A1', 'Venture X', '-500.00')] };
  return withFetchStub([{ body: wire }], async () => {
    await pull(fake, accessRow({ last_pulled_at: daysAgoIso(10) }));
    const patch = fake.writes.find(w => w.table === 'accounts' && w.op === 'update').patch;
    assert.equal(patch.institution_id, 'inst-1', 'the patch re-homes rather than stranding the account');
    assert.equal(fake.rows('accounts')[0].institution_id, 'inst-1');
  });
});

test('a disabled institution is a tombstone: its accounts and transactions are never recreated', () => {
  const fake = makeFakeSupabase({
    simplefin_access: seedAccess(),
    institutions: [
      { id: 'inst-1', household_id: HH, simplefin_org_id: ORG_KEY, status: 'disabled', name: 'BECU' },
    ],
  });
  const wire = {
    errors: [],
    accounts: [wireAcct('A1', 'Everyday Checking', '1500.00', [wireTx('t1', '-10.00', 'ZZZ')])],
  };
  return withFetchStub([{ body: wire }], async () => {
    const res = await pull(fake, accessRow());
    assert.equal(res.accounts, 0);
    assert.equal(res.accounts_created, 0);
    assert.equal(res.transactions, 0);
    assert.equal(fake.rows('accounts').length, 0);
    assert.equal(fake.rows('transactions').length, 0);
    const insts = fake.rows('institutions');
    assert.equal(insts.length, 1, 'no duplicate institution inserted beside the tombstone');
    assert.equal(insts[0].status, 'disabled', 'bookkeeping never revives it');
  });
});

// --- watermark application: advance / hold / reset ---------------------------

// Seed for the watermark tests: A1 already exists, so the pull is a plain
// incremental one — a NEW account here would (correctly) trigger the history
// backfill's second fetch, which is its own test below.
const watermarkSeed = before => ({
  simplefin_access: seedAccess({ last_pulled_at: before }),
  institutions: [
    { id: 'inst-1', household_id: HH, simplefin_org_id: ORG_KEY, status: 'active', name: 'BECU' },
  ],
  accounts: [
    {
      id: 'acct-1',
      household_id: HH,
      institution_id: 'inst-1',
      plaid_account_id: 'sfin:A1',
      name: 'Everyday Checking',
      type: 'depository',
      subtype: 'checking',
      hidden: false,
      current_balance: 1500,
    },
  ],
});

test('an advisory-only pull ADVANCES the watermark, with the advisories kept out of warnings', () => {
  const before = daysAgoIso(10);
  const fake = makeFakeSupabase(watermarkSeed(before));
  const wire = {
    errors: [
      'Requested date range exceeds recommended range of 45 days. In the future, this may be capped.',
    ],
    accounts: [wireAcct('A1', 'Everyday Checking', '1500.00', [wireTx('t1', '-10.00', 'ZZZ')])],
  };
  return withFetchStub([{ body: wire }], async () => {
    const res = await pull(fake, accessRow({ last_pulled_at: before }));
    assert.equal(res.advisories.length, 1);
    assert.ok(!('warnings' in res), 'advisories must not reach warnings — pullWasClean reads warnings');
    assert.ok(!('coverage_shortfall' in res));
    const sf = fake.rows('simplefin_access')[0];
    assert.ok(Date.parse(sf.last_pulled_at) > Date.parse(before), 'the watermark moved');
    assert.equal(sf.last_error, null);
  });
});

test('a REAL error HOLDS the watermark and records last_error — while the data still lands', () => {
  const before = daysAgoIso(10);
  const fake = makeFakeSupabase(watermarkSeed(before));
  const wire = {
    errors: ['BECU may need attention: authentication failed'],
    accounts: [wireAcct('A1', 'Everyday Checking', '1500.00', [wireTx('t1', '-10.00', 'ZZZ')])],
  };
  return withFetchStub([{ body: wire }], async () => {
    const res = await pull(fake, accessRow({ last_pulled_at: before }));
    assert.equal(res.warnings.length, 1);
    const sf = fake.rows('simplefin_access')[0];
    assert.equal(sf.last_pulled_at, before, 'the watermark must not move over the broken bank\'s window');
    assert.match(sf.last_error, /need attention/);
    // The deadlock lesson in reverse: an error pull still WRITES what it got.
    assert.equal(fake.rows('transactions').length, 1);
  });
});

test('capped first pull: the notice travels as an advisory, the shortfall is reported, the watermark still advances', () => {
  const fake = makeFakeSupabase({ simplefin_access: seedAccess() });
  const wire = {
    errors: ['Requested date range exceeds limit of 90 days and was capped.'],
    accounts: [wireAcct('A1', 'Everyday Checking', '1500.00', [wireTx('t1', '-10.00', 'ZZZ')])],
  };
  return withFetchStub([{ body: wire }], async () => {
    const res = await pull(fake, accessRow());
    assert.ok(!('warnings' in res), 'a capped range is not a bank error');
    assert.equal(res.advisories.length, 1);
    const s = res.coverage_shortfall;
    assert.ok(s, 'the un-served window is surfaced, never silently dropped');
    assert.ok(Math.abs(Date.parse(s.wanted_from) - (Date.now() - FIRST_PULL_DAYS * DAY_MS)) < 2 * DAY_MS);
    assert.ok(Math.abs(Date.parse(s.served_from) - (Date.now() - MAX_LOOKBACK_DAYS * DAY_MS)) < 2 * DAY_MS);
    assert.ok(fake.rows('simplefin_access')[0].last_pulled_at, 'stalling recovers nothing — the watermark moves');
  });
});

test('zero accounts plus ANY message throws, leaving the watermark untouched but the attempt stamped', () => {
  const fake = makeFakeSupabase({ simplefin_access: seedAccess() });
  const wire = {
    errors: [
      'Requested date range exceeds recommended range of 45 days. In the future, this may be capped.',
    ],
    accounts: [],
  };
  return withFetchStub([{ body: wire }], async () => {
    await assert.rejects(() => pull(fake, accessRow()), /SimpleFIN reported/);
    const sfWrites = fake.writes.filter(w => w.table === 'simplefin_access');
    assert.equal(sfWrites.length, 1, 'only the pre-request attempt stamp was written');
    assert.deepEqual(Object.keys(sfWrites[0].patch), ['last_attempt_at']);
    const sf = fake.rows('simplefin_access')[0];
    assert.equal(sf.last_pulled_at, null, 'a Bridge that answered without answering must not advance anything');
    assert.ok(sf.last_attempt_at, 'but the throttle still holds — no retry loop');
  });
});

// --- new-account history backfill --------------------------------------------

const backfillSeed = () => ({
  simplefin_access: seedAccess({ last_pulled_at: daysAgoIso(10) }),
  institutions: [
    { id: 'inst-1', household_id: HH, simplefin_org_id: ORG_KEY, status: 'active', name: 'BECU' },
  ],
  accounts: [
    {
      id: 'acct-1',
      household_id: HH,
      institution_id: 'inst-1',
      plaid_account_id: 'sfin:A1',
      name: 'Everyday Checking',
      type: 'depository',
      subtype: 'checking',
      hidden: false,
      current_balance: 100,
    },
  ],
});

const backfillMainWire = () => ({
  errors: [],
  accounts: [
    wireAcct('A1', 'Everyday Checking', '100.00', [wireTx('t1', '-10.00', 'ZZZ ONE')]),
    // A bank newly linked at the Bridge appears mid-stream: the shared
    // watermark would cap it at the 30-day overlap, so full history is
    // re-requested for just this account.
    wireAcct('A2', 'Holiday Savings', '20.00', [wireTx('t2', '-5.00', 'ZZZ TWO')]),
  ],
});

test('a new account mid-stream triggers a scoped history backfill; its rows dedup into the same upsert', () => {
  const fake = makeFakeSupabase(backfillSeed());
  const history = {
    errors: [],
    accounts: [
      wireAcct('A2', 'Holiday Savings', '20.00', [
        wireTx('t2', '-5.00', 'ZZZ TWO'), // overlaps the main pull — seenTx must eat it
        wireTx('t3', '-15.00', 'ZZZ OLD', { posted: epochDaysAgo(60) }),
      ]),
    ],
  };
  return withFetchStub(
    (url, init, n) => ({ body: n === 1 ? backfillMainWire() : history }),
    async calls => {
      const res = await pull(fake, accessRow({ last_pulled_at: daysAgoIso(10) }));
      assert.equal(calls.length, 2);
      const url2 = new URL(calls[1].url);
      assert.deepEqual(url2.searchParams.getAll('account'), ['A2'], 'scoped to only the new account');
      const startSec = Number(url2.searchParams.get('start-date'));
      assert.ok(
        Math.abs(startSec * 1000 - (Date.now() - MAX_LOOKBACK_DAYS * DAY_MS)) < DAY_MS,
        'the backfill start is clamped too — fetchAccountSet is the structural backstop'
      );

      const a2 = fake.rows('accounts').find(a => a.plaid_account_id === 'sfin:A2');
      assert.equal(a2.type, 'depository');
      assert.equal(a2.subtype, 'savings');
      assert.equal(a2.hidden, true);

      assert.equal(res.transactions, 3, 't1 + t2 + backfilled t3, with the overlap deduped');
      assert.ok(fake.rows('transactions').some(t => t.plaid_tx_id === 'sfin:t3' && t.account_id === a2.id));
      assert.ok(fake.rows('simplefin_access')[0].last_pulled_at, 'clean pull: the watermark advanced');
    }
  );
});

test('a FAILED backfill resets the watermark to null — the only way the newcomer ever gets its history', () => {
  const fake = makeFakeSupabase(backfillSeed());
  // A broken bank inside the backfill response used to be discarded silently
  // (only .accounts was read); now it must flag backfillFailed.
  const history = { errors: ['Bank X: connection failed'], accounts: [] };
  return withFetchStub(
    (url, init, n) => ({ body: n === 1 ? backfillMainWire() : history }),
    async calls => {
      const res = await pull(fake, accessRow({ last_pulled_at: daysAgoIso(10) }));
      assert.equal(calls.length, 2);
      assert.ok(!res.error, 'not fatal — the accounts and recent transactions already landed');
      assert.equal(res.transactions, 2, 't1 + t2 from the main pull');
      assert.ok(fake.rows('accounts').some(a => a.plaid_account_id === 'sfin:A2'), 'A2 still inserted');
      const sf = fake.rows('simplefin_access')[0];
      assert.equal(sf.last_pulled_at, null, 'reset: by the next pull A2 no longer looks "new"');
      assert.equal(sf.last_error, null, 'the main pull itself was clean');
      assert.ok(sf.last_attempt_at, 'last_attempt_at still throttles, so the reset cannot loop');
    }
  );
});

// --- degrade paths -----------------------------------------------------------
// These two flip the module's sticky flags (txHaveSource, hasSnapshotTable) and
// MUST stay last — see the ordering note at the top of the file.

test('missing transactions.source column: one failed attempt, then the same rows land without it', () => {
  const fake = makeFakeSupabase(
    { simplefin_access: seedAccess() },
    { missingColumns: { transactions: ['source'] } }
  );
  const wire = {
    errors: [],
    accounts: [wireAcct('A1', 'Everyday Checking', '1500.00', [wireTx('t1', '-10.00', 'ZZZ')])],
  };
  return withFetchStub([{ body: wire }], async () => {
    const res = await pull(fake, accessRow());
    assert.equal(res.transactions, 1, 'the pull is not failed by the un-migrated column');
    const txWrites = fake.writes.filter(w => w.table === 'transactions');
    assert.equal(txWrites.length, 2, 'attempt with source, retry without');
    assert.equal(txWrites[0].error.code, 'PGRST204');
    assert.match(txWrites[0].error.message, /source/);
    assert.ok(txWrites[0].payload.every(r => 'source' in r));
    assert.equal(txWrites[1].error, undefined);
    assert.ok(txWrites[1].payload.every(r => !('source' in r)));
    assert.equal(fake.rows('transactions').length, 1);
    assert.ok(fake.rows('simplefin_access')[0].last_pulled_at, 'the watermark still advances');
  });
});

test('missing balance_snapshots table: the append degrades quietly, latches off, and never fails the pull', () => {
  const fake = makeFakeSupabase(
    { simplefin_access: seedAccess() },
    { missingTables: ['balance_snapshots'] }
  );
  const wireFor = balance => ({
    errors: [],
    accounts: [wireAcct('A1', 'Everyday Checking', balance, [wireTx('t1', '-10.00', 'ZZZ')])],
  });
  return withFetchStub(
    (url, init, n) => ({ body: wireFor(n === 1 ? '100.00' : '200.00') }),
    async calls => {
      const res1 = await pull(fake, accessRow());
      assert.ok(!res1.error && res1.accounts === 1, 'the pull itself succeeds');
      const attempts = () => fake.writes.filter(w => w.table === 'balance_snapshots');
      assert.equal(attempts().length, 1, 'one attempt, answered PGRST205');
      assert.equal(attempts()[0].error.code, 'PGRST205');
      assert.ok(fake.rows('simplefin_access')[0].last_pulled_at, 'watermark unaffected');

      // Second pull, balance CHANGED (a real candidate exists): the sticky
      // hasSnapshotTable flag — the deliberate degrade machinery — means the
      // missing table is not re-probed on every sync.
      const sf = fake.rows('simplefin_access')[0];
      const res2 = await pull(
        fake,
        accessRow({ last_pulled_at: sf.last_pulled_at, last_attempt_at: sf.last_attempt_at }),
        { force: true }
      );
      assert.equal(calls.length, 2);
      assert.ok(!res2.error);
      assert.equal(fake.rows('accounts')[0].current_balance, 200, 'the balance itself still lands');
      assert.equal(attempts().length, 1, 'no second attempt — the flag latched');
    }
  );
});
