import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
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
