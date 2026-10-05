// Thin fetch wrappers around the serverless routes in api/, with the Supabase
// JWT attached. Was plaidClient.js until Plaid was removed — nothing in here
// is Plaid-specific any more, and a file named for a vendor it no longer talks
// to is worse than no name at all.
import { getAccessToken } from './supabaseClient.js';
import { makeRetryingFetch } from './netRetry.js';
import { localTodayIso } from './format.js';

// Same wire-death retry the Supabase client gets (src/netRetry.js): a GET or
// the one DELETE here is re-sent if it never got a response; the POST routes
// (sync, unlink, claim, assistant) are never re-sent. GET is opted IN here
// (the default set leaves reads to postgrest-js's own retry, which this
// plain fetch doesn't have — without it the status read on a resumed PWA
// failed once and the feed-health banner silently never appeared).
const retryingFetch = makeRetryingFetch({ methods: ['GET', 'PUT', 'PATCH', 'DELETE'] });

async function request(method, url, body) {
  const token = await getAccessToken();
  const res = await retryingFetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    // Read the body ONCE: a body counts as consumed even when res.json()
    // fails to parse it, so the old json-then-text fallback threw "Body is
    // unusable" on any non-JSON error page (a Vercel 504, a proxy) before
    // err.status was set — the alert showed that raw TypeError and the
    // "(HTTP 504)" hint was lost. Every api/ route answers JSON, so non-JSON
    // only ever comes from the platform: `detail` is then undefined, never the
    // raw text (describeError would show a whole HTML page), and the first
    // 500 chars ride on err.body for the console.
    const text = await res.text().catch(() => '');
    let detail;
    try {
      detail = text ? JSON.parse(text) : undefined;
    } catch {
      detail = undefined;
    }
    const err = new Error(`${method} ${url} → ${res.status}`);
    err.status = res.status;
    err.detail = detail;
    err.body = text.slice(0, 500);
    throw err;
  }
  return res.json();
}

function postJson(url, body) {
  return request('POST', url, body || {});
}

// force: skip the server's SimpleFIN pull throttle (see api/_lib/simplefin.js).
export function runServerSync({ force = false } = {}) {
  return postJson('/api/sync', { force });
}

// Remove an institution. BOTH kinds are SOFT-HIDDEN by default (manual joined
// its SimpleFIN sibling 2026-08-13): the accounts are marked hidden and the
// set that was visible at remove time is recorded so Restore can bring back
// exactly those. Nothing is deleted either way. A SimpleFIN org additionally
// gets the disabled tombstone that keeps the next pull from recreating it (one
// access URL covers every bank); a manual "Imported" institution is already
// permanently disabled, so its settings record is the whole marker.
//
// `permanent: true` is the buried real-delete path for either kind: the server
// requires the literal confirm string 'delete' alongside it, and then removes
// the accounts and every transaction under them (including CSV/PDF backfill)
// for good.
export function unlinkInstitution(institutionId, { permanent = false } = {}) {
  return postJson('/api/unlink-institution', {
    institution_id: institutionId,
    ...(permanent ? { permanent: true, confirm: 'delete' } : {}),
  });
}

// Undo a manual "Imported" removal: unhides exactly the recorded set and
// consumes the record. The SimpleFIN twin is restoreSimpleFinInstitution
// below — a different route because that one must also clear the disabled
// tombstone, which a manual institution deliberately keeps forever.
export function restoreImportedInstitution(institutionId) {
  return postJson('/api/unlink-institution', { restore_institution_id: institutionId });
}

// ---- SimpleFIN --------------------------------------------------------------
// SimpleFIN replaces Plaid's Link SDK with a paste: the user connects their
// banks on SimpleFIN Bridge, copies the setup token it prints, and hands it
// over. The server claims the durable access URL and keeps it — the browser
// never sees it. Returns { ok, accounts } (accounts = how many the feed can
// already see), or a 400 with { error, message } for a bad/used token.
export function claimSimpleFinToken(setupToken) {
  return postJson('/api/simplefin-claim', { setup_token: setupToken });
}

// { connected, connections, last_pulled_at, last_error, institutions,
//   accounts, hidden_accounts, min_pull_minutes }
export function getSimpleFinStatus() {
  return request('GET', '/api/simplefin-status');
}

// Forgets the stored access URL — stops SimpleFIN syncing but leaves the
// accounts and transactions it already imported in place. The server requires
// the literal confirm string (the unlink permanent-delete discipline), so a
// bare DELETE can never silently kill the feed.
export function disconnectSimpleFin() {
  return request('DELETE', '/api/simplefin-status', { confirm: 'disconnect' });
}

// Undo a "Remove bank": clears the disabled tombstone and unhides exactly the
// accounts that were visible when the bank was removed (deliberately-hidden
// ones stay hidden). Returns { ok, restored, unhidden }.
export function restoreSimpleFinInstitution(institutionId) {
  return postJson('/api/simplefin-status', { restore_institution_id: institutionId });
}

// messages: [{role: 'user'|'assistant', content: string}, ...]
// opts: { model, effort } — validated server-side against the allowlist.
// Returns { reply, stop_reason, usage }, plus truncated: true when the answer
// hit max_tokens (the cut-off note is already in `reply`).
export function askAssistant(messages, opts = {}) {
  return postJson('/api/assistant', {
    messages,
    model: opts.model,
    effort: opts.effort,
    // The phone's OWN calendar day. The server validates it and falls back to
    // UTC — without it, the assistant spent the last hours of every month
    // answering about the next one while every screen said otherwise.
    today: localTodayIso(),
  });
}
