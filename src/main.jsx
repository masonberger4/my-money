import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './ui.css';
import { initTheme } from './theme.js';

// Apply the stored theme before React renders, so the pre-Dashboard screens
// (Login, EmptyState, ConfigError) are themed too and the theme-color metas
// match a forced theme from the first paint rather than from Dashboard mount.
initTheme();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register the PWA service worker in production. Skipped in dev so it doesn't
// fight Vite HMR.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
