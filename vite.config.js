import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Pinned to exactly what Vite 5 emitted by default (its
    // ESBUILD_MODULES_TARGET). Vite 6 changed the default to
    // 'baseline-widely-available' (~safari16), so upgrading the toolchain would
    // otherwise have raised this app's iOS floor from 14 to 16 as a silent side
    // effect — and both CI jobs render in Chromium, so nothing here would have
    // caught it (the pdf.js iOS lesson, applied to the bundle itself). Raising
    // the floor is a real decision that buys smaller output; make it
    // deliberately, not by installing a new Vite.
    target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
    rollupOptions: {
      output: {
        // Split the stable third-party libraries out of the main chunk so a
        // deploy (several/day) only re-downloads the app code — sw.js caches
        // /assets/* by fingerprint, and react/supabase-js change ~never.
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('@supabase')) return 'vendor-supabase';
            if (
              id.includes('/react/') ||
              id.includes('/react-dom/') ||
              id.includes('/scheduler/')
            ) {
              return 'vendor-react';
            }
          }
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
