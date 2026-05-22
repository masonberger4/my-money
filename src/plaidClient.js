async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    err.detail = detail;
    throw err;
  }
  return res.json();
}

export function createLinkToken() {
  return postJson('/api/create-link-token', {});
}

export function exchangePublicToken(publicToken) {
  return postJson('/api/exchange-token', { public_token: publicToken });
}

export function syncTransactions(accessToken, cursor) {
  return postJson('/api/sync-transactions', {
    access_token: accessToken,
    cursor: cursor || null,
  });
}

export function getBalances(accessToken) {
  return postJson('/api/get-balances', { access_token: accessToken });
}
