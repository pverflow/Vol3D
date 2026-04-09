import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  base: './',
  assetsInclude: ['**/*.glsl'],
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
