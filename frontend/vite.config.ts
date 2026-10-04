/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

const API = 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  build: {
    // desktop workstation app; the main chunk is mostly React + Radix and loads once
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: API,
        changeOrigin: true,
        // http-proxy buffers nothing by default, but compression middleware upstream
        // or an accept-encoding negotiation can still hold SSE frames; ask for identity.
        configure: (proxy) => {
          proxy.on('proxyReq', (req, incoming) => {
            if (incoming.url?.startsWith('/api/events')) {
              req.setHeader('accept-encoding', 'identity')
            }
          })
          proxy.on('proxyRes', (res) => {
            if (res.headers['content-type']?.includes('text/event-stream')) {
              res.headers['cache-control'] = 'no-cache, no-transform'
              res.headers['x-accel-buffering'] = 'no'
            }
          })
        },
      },
      '/media': { target: API, changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    exclude: ['e2e/**', 'node_modules/**'],
  },
})
