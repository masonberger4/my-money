import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

// Plaid's free tier caps production Items per developer account. When one
// credential fills up, add another entry to PLAID_CREDENTIALS and new links
// route there automatically.
export const MAX_ITEMS_PER_CREDENTIAL = Number(
  process.env.PLAID_MAX_ITEMS_PER_CREDENTIAL || 10
);

// PLAID_CREDENTIALS: JSON array of {key, client_id, secret}, in fill order.
// Falls back to the legacy PLAID_CLIENT_ID/PLAID_SECRET pair as key "main".
export function getCredentials() {
  const raw = process.env.PLAID_CREDENTIALS;
  if (raw) {
    let list;
    try {
      list = JSON.parse(raw);
    } catch {
      throw new Error('PLAID_CREDENTIALS is not valid JSON');
    }
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('PLAID_CREDENTIALS must be a non-empty JSON array');
    }
    for (const c of list) {
      if (!c.key || !c.client_id || !c.secret) {
        throw new Error(
          'Each PLAID_CREDENTIALS entry needs key, client_id, and secret'
        );
      }
    }
    const keys = new Set(list.map(c => c.key));
    if (keys.size !== list.length) {
      throw new Error('PLAID_CREDENTIALS keys must be unique');
    }
    return list;
  }
  if (process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET) {
    return [
      {
        key: 'main',
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
      },
    ];
  }
  throw new Error('Set PLAID_CREDENTIALS (or PLAID_CLIENT_ID + PLAID_SECRET)');
}

const clients = new Map();

export function getPlaidClient(credentialKey) {
  if (clients.has(credentialKey)) return clients.get(credentialKey);
  const cred = getCredentials().find(c => c.key === credentialKey);
  if (!cred) {
    throw new Error(`Unknown Plaid credential key: ${credentialKey}`);
  }
  const client = new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[process.env.PLAID_ENV || 'production'],
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': cred.client_id,
          'PLAID-SECRET': cred.secret,
        },
      },
    })
  );
  clients.set(credentialKey, client);
  return client;
}

// Pick the first credential with room for another Item, given a
// {credential_key: count} map of Items already linked per credential.
// Returns {key, used, capacity} or null if everything is full.
export function pickCredential(usedCounts) {
  for (const cred of getCredentials()) {
    const used = usedCounts[cred.key] || 0;
    if (used < MAX_ITEMS_PER_CREDENTIAL) {
      return { key: cred.key, used, capacity: MAX_ITEMS_PER_CREDENTIAL };
    }
  }
  return null;
}
