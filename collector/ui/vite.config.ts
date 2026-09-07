import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Single source of truth for the UI bundle AND its test run. `vite build` emits
// fixed output names (no hashes, no assets/ dir) so the server serves them from
// stable paths: dist-ui/{index.html,app.js,app.css,fonts/*}. `inlineDynamicImports`
// keeps everything in app.js — one script tag, no chunk graph to wire into the
// static server. VITEST swaps in the browser entry points so component tests run
// against the same code the browser gets.
export default defineConfig({
  root: __dirname,
  publicDir: 'public',
  plugins: [svelte()],
  build: {
    outDir: '../dist-ui',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'chunk-[name].js',
        assetFileNames: (a) => (a.name?.endsWith('.css') ? 'app.css' : 'fonts/[name][extname]'),
        inlineDynamicImports: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
  },
  resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
});
