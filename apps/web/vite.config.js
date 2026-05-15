import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        // false: keep browser Host/origin (e.g. localhost:5173) for the backend.
        // Avoids mismatch between client request URL and x402 `resource` field
        // (Express uses Host — with changeOrigin:true it becomes :8787 and facilitator may reject).
        changeOrigin: false,
        // With ngrok (HTTPS → Vite), forward headers so Express trust proxy sees https (X-Forwarded-Proto).
        xfwd: true,
      },
    },
  },
});
