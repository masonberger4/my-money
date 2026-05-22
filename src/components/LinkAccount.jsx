import { useCallback, useEffect, useState } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { db } from '../db.js';
import { createLinkToken, exchangePublicToken } from '../plaidClient.js';
import { runSync } from '../sync.js';

export default function LinkAccount({ label = '+ Add account', onLinked }) {
  const [linkToken, setLinkToken] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    createLinkToken()
      .then(res => {
        if (!cancelled) setLinkToken(res.link_token);
      })
      .catch(err => {
        console.error('link token error', err);
        if (!cancelled) setError('Could not start Plaid Link');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSuccess = useCallback(
    async (publicToken, metadata) => {
      setLoading(true);
      try {
        const { access_token } = await exchangePublicToken(publicToken);
        await db.institutions.add({
          name: metadata?.institution?.name || 'Bank',
          accessToken: access_token,
          cursor: null,
          lastSync: null,
        });
        await runSync();
        if (onLinked) onLinked();
      } catch (err) {
        console.error('exchange/sync failed', err);
        setError('Linking failed. Try again.');
      } finally {
        setLoading(false);
      }
    },
    [onLinked]
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
  });

  return (
    <button
      className="ibtn"
      onClick={() => open()}
      disabled={!ready || loading || !!error}
      title={error || ''}
    >
      {loading ? 'Linking…' : label}
    </button>
  );
}
