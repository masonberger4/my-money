// src/apiClient.js — the client → api/ fetch wrappers, driven through the
// REAL module with globalThis.fetch stubbed (the retrying wrapper resolves
// fetch lazily, so a stub installed after import is the one it calls).
// supabaseClient.js has no env in Node, so getAccessToken() is null and no
// Authorization header is attached — irrelevant to what is pinned here.
//
// Pins: the wire-death retry covers apiClient's GET (its comment and the
// key-files row always said so; the default method set left it out, since
// that set is sized for supabase-js, which re-sends its own reads) and still
// never re-sends a POST; and a non-2xx error carries its status and parsed
// JSON body whatever the body is (Node's real Response, so the read-once
// body rule is the real one).
import test from 'node:test';
import assert from 'node:assert/strict';

import { getSimpleFinStatus, runServerSync, unlinkInstitution, claimSimpleFinToken } from '../src/apiClient.js';

async function withFetch(script, fn) {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init?.method });
    const next = script.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = saved;
  }
}

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('REGRESSION: the SimpleFIN status GET is re-sent after a wire death', async () => {
  // Safari's "Load failed" on a resumed PWA's dead socket. Before the opt-in
  // the GET threw on the first attempt: the feed-health banner silently never
  // appeared and the connect modal read "unavailable".
  await withFetch([new TypeError('Load failed'), jsonResponse({ connected: true })], async calls => {
    const status = await getSimpleFinStatus();
    assert.deepEqual(status, { connected: true });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'GET');
  });
});

test('the POST routes are still never re-sent', async () => {
  await withFetch([new TypeError('Load failed'), jsonResponse({ ok: true })], async calls => {
    await assert.rejects(runServerSync(), /Load failed/);
    assert.equal(calls.length, 1);
  });
});

// --- non-2xx errors: the body is read ONCE -----------------------------------

test('REGRESSION: a non-JSON error page keeps its HTTP status (no "Body is unusable")', async () => {
  // A Vercel 504 page. json() then text() on one body threw "Body is
  // unusable" before err.status was set, so the alert showed that TypeError
  // and SimpleFinConnect lost its "(HTTP 504)" hint.
  const page = '<html><body>504 Gateway Timeout</body></html>';
  await withFetch([new Response(page, { status: 504 })], async () => {
    await assert.rejects(unlinkInstitution('inst-1'), err => {
      assert.equal(err.status, 504);
      assert.equal(err.message, 'POST /api/unlink-institution → 504');
      assert.equal(err.detail, undefined, 'never the raw page — describeError would show it whole');
      assert.equal(err.body, page);
      return true;
    });
  });
});

test('a JSON error body still arrives parsed as err.detail', async () => {
  const body = { error: 'bad_token', message: 'That token was already used' };
  await withFetch([jsonResponse(body, 400)], async () => {
    await assert.rejects(claimSimpleFinToken('tok'), err => {
      assert.equal(err.status, 400);
      assert.deepEqual(err.detail, body);
      return true;
    });
  });
});

test('an empty error body: status kept, detail undefined', async () => {
  await withFetch([new Response(null, { status: 500 })], async () => {
    await assert.rejects(runServerSync(), err => {
      assert.equal(err.status, 500);
      assert.equal(err.detail, undefined);
      assert.equal(err.body, '');
      return true;
    });
  });
});
