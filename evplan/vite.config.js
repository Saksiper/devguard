import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// base './' → GitHub Pages gibi alt dizinde de çalışır (https://kullanici.github.io/depo/).
export default defineConfig({
  base: './',
  // n8ao yalnızca N8AOPostPass için postprocessing'ten Pass alıyor; kullanmadığımız için küçük bir taslakla değiştirilir.
  resolve: { alias: { postprocessing: fileURLToPath(new URL('./src/view/postprocessing-stub.js', import.meta.url)) } },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.js'] },
});
