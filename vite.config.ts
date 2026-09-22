import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787'
    }
  },
  preview: {
    host: true,
    port: 4173
  }
});
