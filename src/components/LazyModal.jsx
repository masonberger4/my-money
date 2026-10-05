import { Suspense } from "react";
import { createPortal } from "react-dom";
import ErrorBoundary from "./ErrorBoundary.jsx";

// The wrapper for a lazyWithReload() modal: Suspense plus a boundary SCOPED to
// the modal. When the chunk still can't load after the one automatic reload
// (offline with the chunk never cached), or the modal throws while rendering,
// this card replaces only the modal — without it the throw reached App's
// boundary and the whole Dashboard, nav included, became "Something broke".
// The modal's own inner ErrorBoundary (CsvImport) can't cover a failed load:
// it lives inside the chunk that never arrived.
//
// Portalled for the same reason the modals are: a fixed overlay rendered under
// a `.card` (EmptyState's AddAccount) is otherwise clipped to that card.
function ModalLoadFailed({ onClose }) {
  return createPortal(
    <div className="overlay" onClick={onClose}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-label="Couldn't open this" onClick={e => e.stopPropagation()} style={{ maxWidth: "92vw", color: "var(--text)" }}>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Couldn't open this</div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--muted)", marginBottom: 14 }}>
          The app may have just updated, or you're offline. Your data is fine — reloading usually fixes it.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="ibtn" onClick={onClose}>Close</button>
          <button className="ibtn" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default function LazyModal({ label, onClose, children }) {
  return (
    <ErrorBoundary label={label} fallback={<ModalLoadFailed onClose={onClose} />}>
      <Suspense fallback={null}>{children}</Suspense>
    </ErrorBoundary>
  );
}
