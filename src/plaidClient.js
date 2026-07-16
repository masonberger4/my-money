import { getAccessToken } from './supabaseClient.js';

async function postJson(url, body) {
  const token = await getAccessToken();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    let detail;
    try {
      detail = await res.json();
    } catch {
      detail = await res.text();
    }
    const err = new Error(`POST ${url} → ${res.status}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return res.json();
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

export function runServerSync() {
  return postJson('/api/sync', {});
}

// Removes the Plaid Item (freeing its slot) and deletes the institution's
// accounts and transactions from the database.
export function unlinkInstitution(institutionId) {
  return postJson('/api/unlink-institution', { institution_id: institutionId });
}
