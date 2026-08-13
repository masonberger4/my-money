// The client-side sync wrapper (src/sync.js) — ~50 pure lines whose
// over-strictness once blockaded production: pullWasClean gates whether
// statement import will insert rows, and during the SimpleFIN advisory
// deadlock it rejected EVERY SimpleFIN account because advisories were
// arriving in `warnings`. Advisories now travel in a separate `advisories`
// key (see the first Gotcha in CLAUDE.md), and this file pins that an
// advisory-carrying result still reads as clean — plus the single-flight
// dedupe the UI relies on to not double-hit /api/sync.
//
// runSync is driven end-to-end through the real apiClient against a stubbed
// globalThis.fetch (the simplefinToken.test.js pattern): in plain Node
// `import.meta.env` is undefined, so supabaseClient's guard leaves the token
// null and the only transport is the global fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pullWasClean, runSync } from '../src/sync.js';

// --- pullWasClean ------------------------------------------------------------

test('a clean pull is clean', () => {
  assert.equal(pullWasClean({ results: [{ institution: 'BECU', added: 5 }], failures: [] }), true);
});

test('every bank clean across a multi-institution pull is clean', () => {
  assert.equal(
    pullWasClean({
      results: [{ institution: 'BECU' }, { institution: 'Capital One' }],
      failures: [],
    }),
    true
  );
});

test('warnings on any result make the pull unclean — even a bank the caller does not care about', () => {
  // One broken bank stalls the shared last_pulled_at watermark for EVERY bank
  // (one row per access URL), so the verdict is deliberately whole-pull.
  assert.equal(pullWasClean({ results: [{ warnings: ['bank said no'] }], failures: [] }), false);
  assert.equal(
    pullWasClean({
      results: [{ institution: 'BECU' }, { institution: 'Chase', warnings: ['partial'] }],
      failures: [],
    }),
    false
  );
});

test('an error entry makes the pull unclean, via failures or via results alone', () => {
  const errored = { institution: 'Chase', error: 'pull threw' };
  assert.equal(pullWasClean({ results: [errored], failures: [errored] }), false);
  // failures is derived by execute(); the rule must not depend on the caller
  // having carried it along.
  assert.equal(pullWasClean({ results: [errored] }), false);
});

test('a throttle-skipped pull is unclean — nothing was read from the feed', () => {
  assert.equal(pullWasClean({ results: [{ skipped: 'throttled' }], failures: [] }), false);
});

test('REGRESSION: advisories alone do NOT make a pull unclean', () => {
  // The production blockade: SimpleFIN's date-range notices about OUR OWN
  // request landed in `warnings`, so pullWasClean rejected every SimpleFIN
  // account and blocked all CSV/PDF import. Advisories now ride a separate
  // key that this predicate must never inspect.
  assert.equal(
    pullWasClean({
      results: [{ institution: 'BECU', advisories: ['range exceeds recommended 45 days'] }],
      failures: [],
    }),
    true
  );
  // Belt and braces: an empty warnings array alongside advisories is still clean.
  assert.equal(
    pullWasClean({
      results: [{ institution: 'BECU', advisories: ['capped'], warnings: [] }],
      failures: [],
    }),
    true
  );
});

test('an empty warnings array is not a warning', () => {
  assert.equal(pullWasClean({ results: [{ institution: 'BECU', warnings: [] }], failures: [] }), true);
});

test('missing or partial shapes are unclean, never a throw', () => {
  assert.equal(pullWasClean(), false); // no argument at all
  assert.equal(pullWasClean({}), false); // neither key
  assert.equal(pullWasClean({ results: [], failures: [] }), false); // no access URL configured
  assert.equal(pullWasClean({ results: null, failures: [] }), false);
  assert.equal(pullWasClean({ results: 'oops', failures: [] }), false);
  assert.equal(pullWasClean({ results: [null], failures: [] }), false); // a hole in the array
  assert.equal(pullWasClean({ results: [{ institution: 'BECU' }] }), true); // failures omitted, clean results → clean
});

// --- runSync single-flight, against a stubbed fetch --------------------------

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Install a fetch stub for the duration of fn. Each recorded call carries the
// parsed JSON body so tests can tell a forced request from a normal one.
// `respond(call)` may return a promise (gated tests) or a plain scripted
// response { status, body }.
function withFetchStub(respond, fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const r = await respond(call, calls.length);
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body ?? ''),
    };
  };
  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => {
      globalThis.fetch = original;
    });
}

// Let the awaits between runSync() and the fetch stub (getAccessToken, the
// request wrapper) drain so "the fetch happened" is observable.
const settle = () => new Promise(r => setImmediate(r));

test('two concurrent runSync calls share ONE underlying request', () =>
  withFetchStub(
    () => ({ body: { results: [{ institution: 'BECU', added: 3 }] } }),
    async calls => {
      const a = runSync();
      const b = runSync();
      assert.equal(a, b, 'single-flight must hand back the same in-flight promise');
      const [ra, rb] = await Promise.all([a, b]);
      assert.equal(calls.length, 1, 'exactly one POST /api/sync');
      assert.equal(calls[0].url, '/api/sync');
      assert.equal(calls[0].method, 'POST');
      assert.deepEqual(calls[0].body, { force: false });
      assert.equal(ra, rb);
      assert.deepEqual(ra.results, [{ institution: 'BECU', added: 3 }]);
      assert.deepEqual(ra.failures, []);
    }
  ));

test('the single-flight slot clears once a sync settles — the next call fetches again', () =>
  withFetchStub(
    () => ({ body: { results: [{ institution: 'BECU' }] } }),
    async calls => {
      await runSync();
      await runSync();
      assert.equal(calls.length, 2, 'sequential syncs are not deduped');
    }
  ));

test('the slot clears after a FAILED sync too — a broken pull cannot wedge sync forever', () =>
  withFetchStub(
    (call, n) =>
      n === 1
        ? { status: 500, body: { error: 'server exploded' } }
        : { body: { results: [{ institution: 'BECU' }] } },
    async calls => {
      await assert.rejects(runSync(), err => {
        assert.equal(err.status, 500);
        return true;
      });
      const second = await runSync();
      assert.equal(calls.length, 2, 'the failure must not leave a dead promise in the slot');
      assert.deepEqual(second.failures, []);
    }
  ));

test('force bypasses the single-flight dedupe and carries force: true', async () => {
  const gate = deferred();
  await withFetchStub(
    async call => {
      if (call.body.force === false) await gate.promise; // hold the normal sync open
      return { body: { results: [{ institution: 'BECU' }] } };
    },
    async calls => {
      let normal;
      try {
        normal = runSync();
        await settle();
        assert.equal(calls.length, 1, 'the normal sync is in flight');

        // A forced sync is a deliberate user action; folding it into the
        // running background sync would silently drop the force.
        const forced = await runSync({ force: true });
        assert.equal(calls.length, 2, 'force issued its own request');
        assert.deepEqual(calls[1].body, { force: true });
        assert.deepEqual(forced.results, [{ institution: 'BECU' }]);

        // ...but a normal call arriving meanwhile still joins the original.
        assert.equal(runSync(), normal, 'normal callers keep sharing the in-flight sync');
        assert.equal(calls.length, 2);
      } finally {
        gate.resolve(); // release even on assertion failure, so later tests see a clear slot
      }
      await normal;
    }
  );
});

test('a per-institution error resolves (never rejects) and lands in failures', () =>
  withFetchStub(
    () => ({
      body: {
        results: [
          { institution: 'BECU', added: 2 },
          { institution: 'Chase', error: 'connection needs attention' },
        ],
      },
    }),
    async () => {
      const warned = [];
      const originalWarn = console.warn;
      console.warn = (...args) => warned.push(args);
      try {
        const r = await runSync();
        assert.equal(r.failures.length, 1);
        assert.equal(r.failures[0].institution, 'Chase');
        assert.equal(warned.length, 1, 'each failed institution is warned once');
        // The whole point of the resolve-with-error shape: the verdict comes
        // from pullWasClean, not from whether the promise rejected.
        assert.equal(pullWasClean(r), false);
      } finally {
        console.warn = originalWarn;
      }
    }
  ));

test('runSync + pullWasClean round-trip: clean pull → clean verdict, bodiless response → unclean', () =>
  withFetchStub(
    (call, n) => (n === 1 ? { body: { results: [{ institution: 'BECU' }] } } : { body: {} }),
    async () => {
      assert.equal(pullWasClean(await runSync()), true);
      // A response with no results key at all must read as "don't trust it".
      assert.equal(pullWasClean(await runSync()), false);
    }
  ));

// --- setSyncCompletionHook ----------------------------------------------------
// Month-navigation caching (Mason, 2026-08-04): plain month switches reuse the
// dataAdapter's memoised rows, so a completed sync MUST be an invalidation
// moment — dataAdapter registers invalidateEnvelopeSpending through this hook
// (pinned by test/invalidationMatrix.test.js). These tests pin the mechanism:
// the hook fires per completed execute (success OR failure — a rejected pull
// may still have written rows server-side before failing), never breaks the
// sync itself, and re-registration replaces.
import { setSyncCompletionHook } from '../src/sync.js';

// Every test restores a null hook — later tests in this file must not
// accidentally observe a counter from an earlier one.
function withHook(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } finally {
      setSyncCompletionHook(null);
    }
  };
}

test('the completion hook fires once per successful sync, after the response', () =>
  withFetchStub(
    () => ({ body: { results: [{ institution: 'BECU', added: 1 }] } }),
    withHook(async calls => {
      let fired = 0;
      setSyncCompletionHook(() => {
        fired++;
        // The request has already happened when the hook runs — the caches
        // are dropped AFTER the new rows exist, never before. Compare against
        // `fired`, not 1: the hook fires again for the force run below, and a
        // hardcoded 1 makes that second firing throw (swallowed by
        // notifySyncCompletion, so the test still passed — but it logged a
        // scary assertion error into every suite run).
        assert.equal(calls.length, fired, 'hook must run after the fetch');
      });
      await runSync();
      assert.equal(fired, 1);
      await runSync({ force: true });
      assert.equal(fired, 2, 'the force path notifies too — Refresh and retype ride it');
    })
  ));

test('the completion hook fires even when the pull REJECTS — a failed sync may still have written rows', () =>
  withFetchStub(
    () => ({ status: 500, body: { error: 'server exploded' } }),
    withHook(async () => {
      let fired = 0;
      setSyncCompletionHook(() => fired++);
      await assert.rejects(runSync());
      assert.equal(fired, 1, 'finally-semantics: rejection still notifies');
    })
  ));

test('a throwing hook never turns a good sync into a failed one', () =>
  withFetchStub(
    () => ({ body: { results: [{ institution: 'BECU' }] } }),
    withHook(async () => {
      setSyncCompletionHook(() => {
        throw new Error('cache bookkeeping exploded');
      });
      const errs = [];
      const originalError = console.error;
      console.error = (...args) => errs.push(args);
      try {
        const r = await runSync();
        assert.deepEqual(r.failures, []);
        assert.equal(errs.length, 1, 'the hook failure is logged, not propagated');
      } finally {
        console.error = originalError;
      }
    })
  ));

test('two single-flight joiners share one sync and therefore ONE hook firing', () =>
  withFetchStub(
    () => ({ body: { results: [{ institution: 'BECU' }] } }),
    withHook(async calls => {
      let fired = 0;
      setSyncCompletionHook(() => fired++);
      await Promise.all([runSync(), runSync()]);
      assert.equal(calls.length, 1);
      assert.equal(fired, 1, 'one execute → one invalidation');
    })
  ));

test('re-registering the hook replaces the previous one — last registration wins', () =>
  withFetchStub(
    () => ({ body: { results: [{ institution: 'BECU' }] } }),
    withHook(async () => {
      let first = 0;
      let second = 0;
      setSyncCompletionHook(() => first++);
      setSyncCompletionHook(() => second++);
      await runSync();
      assert.equal(first, 0);
      assert.equal(second, 1);
    })
  ));

test('a null hook is fine — syncs run un-notified (sync.js standalone)', () =>
  withFetchStub(
    () => ({ body: { results: [{ institution: 'BECU' }] } }),
    withHook(async () => {
      setSyncCompletionHook(null);
      const r = await runSync();
      assert.deepEqual(r.failures, []);
    })
  ));
