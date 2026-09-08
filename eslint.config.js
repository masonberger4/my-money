// ESLint 10 flat config. ESM because package.json is "type": "module".
//
// Why this exists, in one line: `npm test` and `vite build` both pass on code
// that throws on first render — an undefined identifier, a hook called inside
// a branch — and the render gate only walks the paths it can reach. This
// catches the rest, in seconds, for free (CI job: `static checks`).
//
// What this is NOT: a style tool. No formatting rules, no Prettier. Every rule
// below is here because it finds a BUG, and every deliberate omission says why.
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  // Build output and dependencies only. public/sw.js and .claude/hooks/*.mjs
  // are deliberately IN scope: the worker runs on every phone, the hooks run in
  // every session AND inside the tests job, and both lint clean today.
  globalIgnores(['dist/', 'node_modules/']),

  js.configs.recommended,

  {
    // `.jsx` is NOT in ESLint's default file set, and a file it never parses
    // reports nothing — which reads exactly like "clean". Naming the extensions
    // is what puts src/components/ (8,000 lines of it) under the linter at all;
    // the first baseline taken here undercounted by seven findings for this
    // reason. See the doc-rot Gotcha.
    files: ['**/*.{js,jsx,mjs,cjs}'],
    languageOptions: {
      sourceType: 'module',
      // Core ESLint 10 tracks JSX identifiers on its own: an undefined <Comp/>
      // is a no-undef, and an import used only inside JSX is not "unused". That
      // is the whole reason eslint-plugin-react is NOT a dependency here.
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    linterOptions: {
      // A disable comment for a rule that no longer fires is a lie the next
      // reader believes. An error, so it dies in the PR that made it stale.
      reportUnusedDisableDirectives: 'error',
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // `({ omit, ...rest }) => rest` is the idiom for dropping a key: the
      // named binding IS the mechanism, not a leak.
      'no-unused-vars': ['error', { ignoreRestSiblings: true }],
      // A hook inside a branch or loop is a crash on the render that takes the
      // other path — the one hooks rule that finds real bugs in this codebase.
      'react-hooks/rules-of-hooks': 'error',
      // DELIBERATELY off, and not "for now". Effects here key on epoch
      // counters and id signatures BY DESIGN (the Wave C state fixes, 2026-09-08:
      // an effect keyed on the `accounts` array identity refetched 500 rows on
      // every rename). The dependency arrays are intentionally narrower than
      // the closure, so exhaustive-deps would flag nearly all of them and its
      // "fix" would restore the bug the epochs exist to prevent. Three stale
      // per-line disables for this rule were deleted when it went off here.
      'react-hooks/exhaustive-deps': 'off',
    },
  },

  // Globals per RUNTIME, never one union: `process` in src/ is a real bug (Vite
  // does not define it in the browser bundle) and `document` in api/ is one
  // too. A union would make no-undef blind to exactly those.
  { files: ['src/**'], languageOptions: { globals: globals.browser } },
  {
    files: [
      'api/**', 'dev-server.js', 'vite.config.js', 'eslint.config.js',
      'test/**', '.claude/hooks/**',
    ],
    languageOptions: { globals: globals.node },
  },
  // The smoke harness straddles both: its mocks and entry run in the browser,
  // while render.mjs is Node driving Playwright with `document` inside
  // page.evaluate callbacks. Merged on top of the node set above.
  { files: ['test/smoke/**'], languageOptions: { globals: globals.browser } },
  // A service worker has `self`, `caches` and `clients`, and no `window`.
  { files: ['public/sw.js'], languageOptions: { globals: globals.serviceworker } },
]);
