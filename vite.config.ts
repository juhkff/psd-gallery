import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

/**
 * `base` must match where GitHub Pages serves the site.
 *  - project site  -> "/<repo>/"      (see .github/workflows/deploy.yml)
 *  - user/apex site -> "/"
 * Override with BASE_PATH when building locally to test a subpath deploy.
 */
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    // The PSDs are served as-is from public/; never inline them.
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // ag-psd is only needed once a work is opened; keep it out of the
        // initial bundle so the gallery paints fast.
        // NOTE: Vite 8 bundles with rolldown, which dropped the object form of
        // `manualChunks` - this must stay a function.
        manualChunks: (id) => (id.includes('ag-psd') ? 'psd' : undefined),
      },
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  preview: {
    port: 4173,
    host: '127.0.0.1',
  },
});
