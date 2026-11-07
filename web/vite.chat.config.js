import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'chat',
  plugins: [react()],
  cacheDir: '../node_modules/.vite-chat',
  build: {
    outDir: '../dist/chat',
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5174,
    proxy: {
      '/app': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
});
