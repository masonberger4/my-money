// makeRetryingFetch / friendlyError — the iOS "TypeError: Load failed" fix.
// Pins: a write that died on the wire is re-sent (PATCH/PUT/DELETE only —
// reads are postgrest-js's own retry budget), an answered request is never
// re-sent, POST and non-reusable bodies are left alone, an aborted request is
// not retried, and the alert wording.
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRetryingFetch, isNetworkError, friendlyError, NETWORK_FAILURE_TEXT } from '../src/netRetry.js';

const loadFailed = () => new TypeError('Load failed'); // Safari's wording
const failedToFetch = () => new TypeError('Failed to fetch'); // Chrome's

// A scripted fetch: each entry is either an Error (rejects) or a value
// (resolves). Records calls and the waits between them.
function harness(script, delays = [10, 20]) {
  const calls = [];
  const waits = [];
  const fetch = async (input, init) => {
    calls.push({ input, init });
    const next = script.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const sleep = async ms => { waits.push(ms); };
  return { calls, waits, fetch: makeRetryingFetch({ fetch, delays, sleep }) };
}

test('a PATCH that dies on the wire is re-sent and the second answer returned', async () => {
  const ok = { ok: true, status: 204 };
  const h = harness([loadFailed(), ok]);
  const init = { method: 'PATCH', body: '{"user_category":"Gas"}', headers: {} };
  const res = await h.fetch('https://x.supabase.co/rest/v1/transactions?id=eq.1', init);
  assert.equal(res, ok);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.waits, [10]);
  // Byte-identical resend: same url, same init object.
  assert.equal(h.calls[1].init, init);
  assert.equal(h.calls[1].input, h.calls[0].input);
});

test('the retry budget is the delays list; the last error escapes untouched', async () => {
  const last = failedToFetch();
  const h = harness([loadFailed(), loadFailed(), last]);
  await assert.rejects(h.fetch('https://x/a', { method: 'DELETE' }), e => e === last);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.waits, [10, 20]);
});

test('an answered request is never re-sent — a 500 Response comes back as-is', async () => {
  const bad = { ok: false, status: 500 };
  const h = harness([bad, { ok: true }]);
  const res = await h.fetch('https://x/a', { method: 'PATCH', body: '{}' });
  assert.equal(res, bad);
  assert.equal(h.calls.length, 1);
});

test('a non-network error is not a retry trigger', async () => {
  const boom = new Error('JSON parse failure');
  const h = harness([boom, { ok: true }]);
  await assert.rejects(h.fetch('https://x/a', { method: 'PATCH', body: '{}' }), e => e === boom);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.waits, []);
});

test('POST is never retried (insert duplicates, refresh tokens are single-use)', async () => {
  const h = harness([loadFailed(), { ok: true }]);
  await assert.rejects(h.fetch('https://x/auth/v1/token', { method: 'POST', body: '{}' }), /Load failed/);
  assert.equal(h.calls.length, 1);
});

test('a body that cannot be re-sent is never retried, nor is a Request object', async () => {
  const h = harness([loadFailed(), loadFailed()]);
  const stream = { locked: false }; // stands in for a ReadableStream
  await assert.rejects(h.fetch('https://x/a', { method: 'PUT', body: stream }), /Load failed/);
  assert.equal(h.calls.length, 1);
  await assert.rejects(h.fetch({ url: 'https://x/a', method: 'PATCH' }), /Load failed/);
  assert.equal(h.calls.length, 2);
});

test('an aborted request is not retried', async () => {
  const h = harness([loadFailed(), { ok: true }]);
  const signal = { aborted: true };
  await assert.rejects(h.fetch('https://x/a', { method: 'PATCH', body: '{}', signal }), /Load failed/);
  assert.equal(h.calls.length, 1);
});

test('reads are left to postgrest-js: GET (explicit or by omission) is not retried here', async () => {
  const h = harness([loadFailed(), loadFailed(), { ok: true }]);
  await assert.rejects(h.fetch(new URL('https://x/a')), /Load failed/);
  await assert.rejects(h.fetch('https://x/a', { method: 'get' }), /Load failed/);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.waits, []);
});

test('a URL input and a lower-case method are accepted for a write', async () => {
  const h = harness([loadFailed(), { ok: true }]);
  const res = await h.fetch(new URL('https://x/a'), { method: 'delete' });
  assert.equal(res.ok, true);
  assert.equal(h.calls.length, 2);
});

test('the default underlying fetch is resolved lazily from globalThis', async () => {
  const saved = globalThis.fetch;
  const f = makeRetryingFetch({ delays: [], sleep: async () => {} });
  try {
    globalThis.fetch = async () => ({ ok: true, swapped: true });
    const res = await f('https://x/a', { method: 'PATCH', body: '{}' });
    assert.equal(res.swapped, true);
  } finally {
    globalThis.fetch = saved;
  }
});

test('isNetworkError: browser wordings yes; answered/HTTP errors and plain errors no', () => {
  assert.equal(isNetworkError(loadFailed()), true);
  assert.equal(isNetworkError(failedToFetch()), true);
  assert.equal(isNetworkError(new TypeError('NetworkError when attempting to fetch resource.')), true);
  assert.equal(isNetworkError(new TypeError('fetch failed')), true); // undici
  // The shape postgrest-js actually hands the app: a plain object, the
  // TypeError's name folded into the message, empty code, no status.
  assert.equal(isNetworkError({ message: 'TypeError: Load failed', details: '', hint: '', code: '' }), true);
  const answered = Object.assign(new Error('Load failed'), { status: 502 });
  assert.equal(isNetworkError(answered), false);
  assert.equal(isNetworkError(new Error('permission denied for table transactions')), false);
  assert.equal(isNetworkError({ message: 'PGRST116', code: 'PGRST116' }), false);
  assert.equal(isNetworkError(null), false);
  assert.equal(isNetworkError('Load failed'), false);
});

test('friendlyError: network failures get the sentence, everything else keeps its message', () => {
  assert.equal(friendlyError(loadFailed()), NETWORK_FAILURE_TEXT);
  assert.match(NETWORK_FAILURE_TEXT, /reach the server/);
  const pg = { message: 'new row violates row-level security policy', code: '42501' };
  assert.equal(friendlyError(pg), pg.message);
  assert.equal(friendlyError('plain string'), 'plain string');
  assert.equal(friendlyError(undefined), undefined);
});
