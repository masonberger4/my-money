import LinkAccount from './LinkAccount.jsx';
import { ImportButton } from './DataTransfer.jsx';

export default function EmptyState({ onLinked }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg,#F7F6F2)',
        color: 'var(--text,#1a1a18)',
        fontFamily: "'DM Sans','Helvetica Neue',sans-serif",
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        '--bg': '#F7F6F2',
        '--card': '#FFFFFF',
        '--text': '#1a1a18',
        '--muted': '#888780',
        '--border': '#E4E2DC',
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
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            margin: '16px 0',
            color: 'var(--muted)',
            fontSize: 11,
          }}
        >
          <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          or
          <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        </div>
        <div
          style={{
            fontSize: 12,
            color: 'var(--muted)',
            marginBottom: 12,
            lineHeight: 1.5,
          }}
        >
          Already set up on another device? Mirror it here — export a backup
          there and import it below. No new bank connection is used.
        </div>
        <ImportButton onImported={onLinked} />
      </div>
    </div>
  );
}
