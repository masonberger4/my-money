import LinkAccount from './LinkAccount.jsx';

export default function EmptyState({ onLinked }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg)',
        color: 'var(--text)',
        fontFamily: "'DM Sans','Helvetica Neue',sans-serif",
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        className="card"
        style={{
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          padding: '28px 28px 24px',
          maxWidth: 360,
          width: '100%',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '.08em',
            color: 'var(--muted)',
            textTransform: 'uppercase',
            marginBottom: 8,
          }}
        >
          my-money
        </div>
        <div
          style={{
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: '-.02em',
            marginBottom: 8,
          }}
        >
          Connect your first account
        </div>
        <div
          style={{
            fontSize: 13,
            color: 'var(--muted)',
            marginBottom: 20,
            lineHeight: 1.5,
          }}
        >
          Link a bank or card via Plaid to start seeing your spending.
        </div>
        <LinkAccount onLinked={onLinked} />
      </div>
    </div>
  );
}
