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

// Returns { link_token, credential_key, credential_used, credential_capacity }.
// The server picks whichever Plaid credential still has free Item slots;
// a 409 with error 'plaid_capacity' means every credential is full.
export function createLinkToken() {
  return postJson('/api/create-link-token', {});
}

export function exchangePublicToken(publicToken, credentialKey, institutionName) {
  return postJson('/api/exchange-token', {
    public_token: publicToken,
    credential_key: credentialKey,
    institution_name: institutionName,
  });
}

// force: skip the server's SimpleFIN pull throttle (see api/_lib/simplefin.js).
export function runServerSync({ force = false } = {}) {
  return postJson('/api/sync', { force });
}

// Removes the Plaid Item (freeing its slot) and deletes the institution's
// accounts and transactions from the database.
export function unlinkInstitution(institutionId) {
  return postJson('/api/unlink-institution', { institution_id: institutionId });
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
// accounts and transactions it already imported in place.
export function disconnectSimpleFin() {
  return request('DELETE', '/api/simplefin-status');
}

// Undo a "Remove bank": clears the disabled tombstone so the next pull
// recreates that bank's accounts.
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
