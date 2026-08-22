import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * The application is built INTO ../public, alongside the hand-written marketing
 * pages Netlify also serves from there.
 *
 * `emptyOutDir: false` because public/ is not ours alone -- index.html,
 * pricing.html, demo.html and the rest are committed files, and a build that
 * cleared the directory would delete the marketing site.
 *
 * The entry is app.html rather than index.html for the same reason: index.html
 * is the marketing home page. Vite rewrites app.html on every build with the
 * current content-hashed asset names, which is precisely what stopped happening
 * when the bundle was committed by hand and the source was left out of the repo.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@flph/shared': fileURLToPath(new URL('../src/shared/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: '../public',
    emptyOutDir: false,
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: { input: fileURLToPath(new URL('./app.html', import.meta.url)) },
  },
});
