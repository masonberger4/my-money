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
  const { public_token } = req.body || {};
  if (!public_token) {
    return res.status(400).json({ error: 'public_token required' });
  }
  try {
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    return res.status(200).json({
      access_token: response.data.access_token,
      item_id: response.data.item_id,
    });
  } catch (err) {
    console.error('exchange-token error', err?.response?.data || err);
    return res
      .status(500)
      .json({ error: err?.response?.data || err.message || 'Unknown error' });
  }
}
