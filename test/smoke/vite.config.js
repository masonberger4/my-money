// Smoke harness for the CI render check.
//
// WHY THIS IS CHECKED IN (a change from the old "local checks are gitignored"
// note): `npm test` never renders Dashboard.jsx and `vite build` never
// evaluates it, so a use-before-declaration in that file — a temporal-dead-zone
// ReferenceError on first render — passes BOTH gates green and ships an app
// that shows every user the ErrorBoundary instead of the dashboard. That
// happened once (2026-08-04, the `rulesOpen` hoist). Only a real browser
// rendering the real component catches it, so that check has to live in the
// repo where CI can run it.
//
// The screenshot harness stays gitignored and personal; this is the minimum
// that answers "does the app boot".
//
// The aliases are FULL-MATCH regexes on purpose (the same rule CLAUDE.md
// records): Dashboard imports only through dataAdapter/sync/db/apiClient, so
// swapping exactly those four keeps the real supabaseClient — and its env
// requirements — out of the render.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const M = resolve(here, 'mocks');

export default defineConfig({
  root: here,
  plugins: [react()],
  publicDir: resolve(repo, 'public'),
  resolve: {
    alias: [
      { find: /^.*\/dataAdapter\.js$/, replacement: `${M}/dataAdapter.js` },
      { find: /^.*\/sync\.js$/, replacement: `${M}/sync.js` },
      { find: /^\.\.?\/db\.js$/, replacement: `${M}/db.js` },
      { find: /^.*\/apiClient\.js$/, replacement: `${M}/apiClient.js` },
    ],
  },
  server: { fs: { allow: [repo] }, port: 5199, strictPort: true },
});
