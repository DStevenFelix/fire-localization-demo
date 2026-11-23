import { defineConfig } from 'vite';
export default defineConfig({
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: '../app/static/spatial', emptyOutDir: true,
    lib: { entry: 'src/main.tsx', name: 'SocialnetSpatial', formats: ['iife'], fileName: () => 'map.js' },
  },
  esbuild: { jsx: 'automatic' },
});
