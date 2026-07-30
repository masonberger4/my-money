import { useState } from 'react';
import AddAccount from './AddAccount.jsx';
import CsvImport from './CsvImport.jsx';

// The first-run screen: shown by App.jsx when the household has no institutions.
//
// It offers BOTH ways in, because they are not alternatives — they are the two
// halves of the off-Plaid plan. SimpleFIN covers the banks it covers; a
// statement import covers the ones it doesn't, and is the only route for a
// servicer no feed reaches. Offering only the feed would leave a user whose bank
// SimpleFIN can't reach staring at a dead end on the very first screen.
//
// Both paths open a modal that renders `className="overlay"` — which lives in
// src/ui.css, NOT in a <style> block inside Dashboard. That matters here
// specifically: Dashboard is not mounted on this screen, so a Dashboard-scoped
// rule would leave the modal with no backdrop and no fixed positioning, laid out
// inside this 360px card.
export default function EmptyState({ onLinked }) {
  const [importing, setImporting] = useState(false);

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
          Link your banks through SimpleFIN to sync balances and transactions
          automatically.
        </div>

        <AddAccount label="⚡ Connect with SimpleFIN" onLinked={onLinked} />

        <div
          style={{
            marginTop: 18,
            paddingTop: 16,
            borderTop: '1px solid var(--border)',
            fontSize: 12,
            color: 'var(--muted)',
            lineHeight: 1.5,
          }}
        >
          Bank not supported, or want older history?
          <div style={{ marginTop: 8 }}>
            <button className="ibtn" onClick={() => setImporting(true)}>
              ⤓ Import a statement
            </button>
          </div>
        </div>
      </div>

      {/* No accounts exist yet, so the importer's only reachable target is a new
          manual account — exactly what it does with `accounts={[]}`. */}
      {importing && (
        <CsvImport
          accounts={[]}
          onClose={() => setImporting(false)}
          onImported={onLinked}
        />
      )}
    </div>
  );
}
