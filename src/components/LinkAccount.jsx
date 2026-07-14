import { useCallback, useEffect, useState } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { createLinkToken, exchangePublicToken } from '../plaidClient.js';
import { runSync } from '../sync.js';

export default function LinkAccount({ label = '+ Add account', onLinked }) {
  const [linkToken, setLinkToken] = useState(null);
  const [credentialKey, setCredentialKey] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    createLinkToken()
      .then(res => {
        if (cancelled) return;
        setLinkToken(res.link_token);
        setCredentialKey(res.credential_key);
      })
      .catch(err => {
        console.error('link token error', err);
        if (cancelled) return;
        if (err.status === 409 && err.detail?.error === 'plaid_capacity') {
          setError(err.detail.message);
        } else {
          setError('Could not start Plaid Link');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSuccess = useCallback(
    async (publicToken, metadata) => {
      setLoading(true);
      try {
        await exchangePublicToken(
          publicToken,
          credentialKey,
          metadata?.institution?.name || 'Bank'
        );
        await runSync();
        if (onLinked) onLinked();
      } catch (err) {
        console.error('exchange/sync failed', err);
        setError('Linking failed. Try again.');
      } finally {
        setLoading(false);
      }
    },
    [onLinked, credentialKey]
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
