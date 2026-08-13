// Renders the REAL Dashboard against mocked I/O. Relative imports only — this
// runs on a CI checkout, not one machine's absolute paths.
import { createRoot } from 'react-dom/client';
import '../../src/ui.css';
import { initTheme } from '../../src/theme.js';
// The REAL App, not Dashboard directly (2026-08-12): with supabaseClient
// mocked (fifth alias), App's whole startup path runs — auth resolution, the
// institution count, ErrorBoundary — and lands on Dashboard via the same
// branch production takes. A crash anywhere on that path now fails the gate.
import App from '../../src/App.jsx';

initTheme();
createRoot(document.getElementById('root')).render(<App />);
