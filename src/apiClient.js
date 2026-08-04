// Thin fetch wrappers around the serverless routes in api/, with the Supabase
// JWT attached. Was plaidClient.js until Plaid was removed — nothing in here
// is Plaid-specific any more, and a file named for a vendor it no longer talks
// to is worse than no name at all.
import { getAccessToken } from './supabaseClient.js';

async function request(method, url, body) {
  const token = await getAccessToken();
  const res = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    let detail;
    try {
      detail = await res.json();
    } catch {
      detail = await res.text();
    }
    const err = new Error(`${method} ${url} → ${res.status}`);
    err.status = res.status;
    err.detail = detail;
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

// Disconnect an institution. A SimpleFIN org is SOFT-HIDDEN by default: its
// accounts are marked hidden and the institution row is disabled (the tombstone
// that keeps the next pull from recreating it — one access URL covers every
// bank). Nothing is deleted; Restore in the SimpleFIN modal unhides the
// accounts that were visible at remove time. A manual "Imported" institution is
// still deleted outright (nothing recreates it, so no tombstone is needed).
//
// `permanent: true` is the buried real-delete path: the server requires the
// literal confirm string 'delete' alongside it, and then removes the accounts
// and every transaction under them (including CSV/PDF backfill) for good.
export function unlinkInstitution(institutionId, { permanent = false } = {}) {
  return postJson('/api/unlink-institution', {
    institution_id: institutionId,
    ...(permanent ? { permanent: true, confirm: 'delete' } : {}),
  });
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
// Returns { reply, stop_reason, usage }.
export function askAssistant(messages, opts = {}) {
  return postJson('/api/assistant', {
    messages,
    model: opts.model,
    effort: opts.effort,
  });
}
