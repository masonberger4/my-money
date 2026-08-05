// Renders the REAL Dashboard against mocked I/O. Relative imports only — this
// runs on a CI checkout, not one machine's absolute paths.
import { createRoot } from 'react-dom/client';
import '../../src/ui.css';
import { initTheme } from '../../src/theme.js';
import Dashboard from '../../src/components/Dashboard.jsx';

initTheme();
createRoot(document.getElementById('root')).render(<Dashboard refreshTick={0} />);
