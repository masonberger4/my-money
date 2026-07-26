import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './ui.css';

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
