import { lazy, Suspense, useState } from 'react';

// Lazy for the same reason Dashboard lazies it — a static import here would
// pull the modal back into the main bundle and defeat the split.
const SimpleFinConnect = lazy(() => import('./SimpleFinConnect.jsx'));

// The "add a bank" button, and the owner of the connect modal it opens.
//
// Replaces LinkAccount.jsx, which wrapped Plaid Link. The shape is deliberately
// the same — a button that can sit in the empty state or as the dashboard's
// floating action button — so neither caller had to change beyond the import.
//
// One behavioural improvement comes free with the swap: LinkAccount minted a
// Plaid link token in a useEffect on mount, and App renders this button on every
// authenticated screen, so EVERY app open hit /api/create-link-token before the
// user had asked for anything. Nothing here talks to the server until the button
// is actually pressed.
export default function AddAccount({ label = '+ Add bank', onLinked }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="ibtn" onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && (
        <Suspense fallback={null}>
          <SimpleFinConnect
            onClose={() => setOpen(false)}
            onConnected={() => {
              if (onLinked) onLinked();
            }}
          />
        </Suspense>
      )}
    </>
  );
}
