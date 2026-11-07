import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'admin',
  plugins: [react()],
  // Relative to root (admin/), so go up to web/node_modules
  cacheDir: '../node_modules/.vite-admin',
  build: {
    outDir: '../dist/admin',
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/admin': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
});
