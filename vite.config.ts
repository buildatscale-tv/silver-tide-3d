import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5190,
    host: true,
    allowedHosts: ['.ts.net'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
