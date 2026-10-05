// src/apiClient.js — the client → api/ fetch wrappers, driven through the
// REAL module with globalThis.fetch stubbed (the retrying wrapper resolves
// fetch lazily, so a stub installed after import is the one it calls).
// supabaseClient.js has no env in Node, so getAccessToken() is null and no
// Authorization header is attached — irrelevant to what is pinned here.
//
// Pins: the wire-death retry covers apiClient's GET (its comment and the
// key-files row always said so; the default method set left it out, since
// that set is sized for supabase-js, which re-sends its own reads) and still
// never re-sends a POST.
import test from 'node:test';
import assert from 'node:assert/strict';

import { getSimpleFinStatus, runServerSync } from '../src/apiClient.js';

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
