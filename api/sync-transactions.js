import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

const plaidClient = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[process.env.PLAID_ENV || 'production'],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': process.env.PLAID_SECRET,
      },
    },
  })
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { access_token, cursor } = req.body || {};
  if (!access_token) {
    return res.status(400).json({ error: 'access_token required' });
  }
  try {
    const request = { access_token };
    if (cursor) request.cursor = cursor;
    const response = await plaidClient.transactionsSync(request);
    return res.status(200).json(response.data);
  } catch (err) {
    console.error('sync-transactions error', err?.response?.data || err);
    return res
      .status(500)
      .json({ error: err?.response?.data || err.message || 'Unknown error' });
  }
}
