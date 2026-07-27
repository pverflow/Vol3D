import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  base: './',
  assetsInclude: ['**/*.glsl'],
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks: {
          fflate: ['fflate'],
        }
      }
    }
  },
})
