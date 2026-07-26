import { useCallback, useEffect, useState } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { createLinkToken, exchangePublicToken } from '../plaidClient.js';
import { runSync } from '../sync.js';

// Turn a failed API call into something a human can act on. err.detail is
// whatever the server route returned — Plaid errors carry error_code /
// error_message inside it.
function describeError(err, fallback) {
  const d = err?.detail;
  if (typeof d === 'string' && d) return `${fallback}: ${d}`;
  if (d?.message) return d.message;
  if (d?.error?.error_code) {
    return `${fallback}: Plaid ${d.error.error_code} — ${d.error.error_message || ''}`;
  }
  if (typeof d?.error === 'string' && d.error) return `${fallback}: ${d.error}`;
  if (err?.status) return `${fallback} (HTTP ${err.status})`;
  return fallback;
}

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
          setError(describeError(err, 'Could not start Plaid Link'));
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
        setError(describeError(err, 'Linking failed'));
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

  const waiting = !linkToken && !error;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <button
        className="ibtn"
        onClick={() => open()}
        disabled={!ready || loading || !!error}
        title={error || ''}
      >
        {loading ? 'Linking…' : waiting ? 'Preparing Plaid…' : label}
      </button>
      {error && (
        <div
          style={{
            maxWidth: 300,
            fontSize: 11,
            lineHeight: 1.5,
            color: 'var(--danger)',
            background: 'var(--danger-bg)',
            border: '1px solid var(--danger-border)',
            borderRadius: 8,
            padding: '8px 10px',
            textAlign: 'left',
            wordBreak: 'break-word',
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
