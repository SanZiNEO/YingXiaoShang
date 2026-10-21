import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The renderer lives in apps/desktop/src/renderer; Vite builds it as this app's
// front end so the desktop and web UIs cannot drift apart.
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3081',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
