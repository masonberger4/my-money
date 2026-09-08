// Network-failure handling for the browser's writes and reads.
//
// The failure shape this exists for (Mason's iPhone, 2026-09-08): picking a
// category on a transaction alerted "Couldn't save that change: TypeError:
// Load failed". "Load failed" is Safari's message for a fetch that never got
// a response — the same event Chrome reports as "Failed to fetch". On iOS it
// is mostly NOT a dead connection: the PWA comes back from the background (or
// the phone hops cells) and the first request goes out on an HTTP/2 socket
// the OS already closed underneath Safari. The request is lost, the very next
// one succeeds. Supabase-on-iOS threads are full of exactly this.
//
// Two pieces, both pure (no globals touched at import time):
//   makeRetryingFetch — a fetch wrapper the Supabase client is built on. It
//     resends a request that DIED ON THE WIRE (fetch threw a network
//     TypeError) — never one that got an answer (a 4xx/5xx Response is
//     returned untouched; PostgREST error handling stays supabase-js's job)
//     and never an aborted one. Only PATCH, PUT and DELETE are retried: a
//     PostgREST write with the same filter and payload lands the same row
//     state however many times it arrives (every `.update()` in the adapter
//     layer sets absolute values, never increments — keep it that way). The
//     wrapper also fronts the auth and storage sub-clients: auth's own
//     PUT/PATCH (`updateUser`, passkeys) are absolute-value writes this app
//     does not call today, and storage's DELETE is a remove — re-check here
//     before adding a call to either. GET/HEAD/OPTIONS are deliberately
//     NOT here — postgrest-js already re-sends those itself (its
//     RETRYABLE_METHODS, on by default), which is exactly why reads on the
//     phone self-heal and only writes ever showed the alert; stacking a
//     second budget on top would multiply the wait on a phone that really is
//     offline. POST is excluded on purpose — a plain `.insert()` sent twice
//     is a duplicate row, and a lost auth-refresh POST re-sent could burn a
//     single-use refresh token — and so is any body that can't be re-sent
//     (a stream). Two short waits, ~1.6 s worst case, so a genuinely offline
//     phone still gets an answer promptly.
//   friendlyError — what the alerts show. A network TypeError becomes a
//     sentence a person can act on; everything else keeps its own message.

const DEFAULT_DELAYS_MS = [400, 1200];
const RETRIED_METHODS = new Set(['PUT', 'PATCH', 'DELETE']);

// fetch rejects with a TypeError when the request never got a response (DNS,
// TLS, a dropped socket, CORS at the network layer). Browsers word it
// differently — match the wording, not the vendor. postgrest-js hands the
// caller a plain object whose message is "TypeError: Load failed" (the
// error's name prefixed, no status) — this must recognise that shape too,
// which is why the test is on the message rather than `instanceof`. An error
// that carries an HTTP status is an answered request and never counts.
const NETWORK_MESSAGE = /load failed|failed to fetch|networkerror|network request failed|network connection was lost|the internet connection appears to be offline/i;

export function isNetworkError(err) {
  if (!err || typeof err !== 'object') return false;
  if (typeof err.status === 'number') return false;
  const msg = String(err.message || '');
  if (NETWORK_MESSAGE.test(msg)) return true;
  // Node's undici wraps the cause: TypeError('fetch failed') { cause: … }.
  return err.name === 'TypeError' && /^fetch failed$/i.test(msg);
}

// A body fetch can re-send byte-for-byte. Strings are what supabase-js sends
// (JSON.stringify); URLSearchParams too. A ReadableStream is consumed by the
// first attempt and a FormData/Blob is safe but never sent by this app — keep
// the allowlist to what is known to be safe rather than guessing.
function reusableBody(body) {
  if (body === undefined || body === null) return true;
  if (typeof body === 'string') return true;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return true;
  return false;
}

function canRetry(input, init) {
  // A Request object may carry a one-shot body; only the (url, init) form is
  // retried, which is the form every supabase-js sub-client uses.
  if (typeof input !== 'string' && !(typeof URL !== 'undefined' && input instanceof URL)) return false;
  const method = String((init && init.method) || 'GET').toUpperCase();
  if (!RETRIED_METHODS.has(method)) return false;
  return reusableBody(init && init.body);
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// opts.fetch: the underlying fetch; resolved LAZILY from globalThis by default
//   so the wrapper can be built at module load (before any test swaps the
//   global) and called with the global as `this` (Safari rejects an unbound
//   fetch with "Illegal invocation").
// opts.delays: waits between attempts; its length is the retry budget.
// opts.sleep: injectable for tests.
export function makeRetryingFetch({ fetch, delays = DEFAULT_DELAYS_MS, sleep = defaultSleep } = {}) {
  const underlying = (input, init) => (fetch ? fetch(input, init) : globalThis.fetch(input, init));
  return async function retryingFetch(input, init) {
    const retriable = canRetry(input, init);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await underlying(input, init);
      } catch (err) {
        const aborted = Boolean(init && init.signal && init.signal.aborted);
        if (!retriable || aborted || attempt >= delays.length || !isNetworkError(err)) throw err;
        await sleep(delays[attempt]);
      }
    }
  };
}

// The alert text for a failed save/load. Keeps the shipped `${err.message||err}`
// behaviour for every error that is NOT a network failure.
export const NETWORK_FAILURE_TEXT =
  "couldn't reach the server. Check the connection and try again.";

export function friendlyError(err) {
  if (isNetworkError(err)) return NETWORK_FAILURE_TEXT;
  return (err && err.message) || err;
}
