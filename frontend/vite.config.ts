import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The API contract lives in the backend and is imported by both
      // sides, so a rename on the server breaks this build rather than
      // producing `undefined` in a browser at runtime.
      '@contract': fileURLToPath(
        new URL('../src/shared/contract.ts', import.meta.url),
      ),
    },
  },
  server: {
    // Proxy API calls to the backend in development. Without this the
    // browser would treat them as cross-origin and refuse them; with it,
    // the page talks only to its own origin and Vite forwards. The same
    // shape a reverse proxy takes in production, so nothing about the
    // frontend's URLs has to change when it is deployed.
    proxy: {
      '/uploads': 'http://localhost:3000',
      '/jobs': 'http://localhost:3000',
      '/files': 'http://localhost:3000',
      '/status': 'http://localhost:3000',
    },
  },
});
