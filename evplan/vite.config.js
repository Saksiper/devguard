import { defineConfig } from 'vite';

// base './' → GitHub Pages gibi alt dizinde de çalışır (https://kullanici.github.io/depo/).
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.js'] },
});
