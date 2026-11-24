import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: { '/api': { target: process.env.FIRE_VITE_BRIDGE_URL ?? 'http://127.0.0.1:8080', changeOrigin: true } },
    watch: { ignored: ['**/screenshots/**', '**/test-results/**', '**/playwright-report/**'] },
    fs: { allow: ['../..'] },
  },
});
