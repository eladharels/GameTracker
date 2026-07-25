/* global process */
// (eslint.config.js only registers browser globals; this file runs in Node under Vite.)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The app builds its API base as `${window.location.origin}/api`. In production
// nginx serves the SPA and proxies /api to the backend, so that resolves correctly.
// Under `npm run dev` the origin is the Vite dev server (http://localhost:5173), and
// without a proxy Vite would answer /api/* with the SPA index.html — every API call
// would come back as HTML. This proxy forwards /api to the Express backend so local
// development works exactly like production.
// The fallback below is a dev-server proxy target, not a credential — the literal is
// the local backend's default address and is never a secret.
// nosemgrep: hardcoded-secret-fallback-outside-entry
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000'

// The bulk "refresh metadata" endpoint (POST /api/user/:username/refresh-metadata)
// walks the whole library against the external game APIs and can run for minutes,
// so allow a generous window before the proxy gives up.
const API_PROXY_TIMEOUT_MS = 5 * 60 * 1000

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        // timeout: browser -> proxy socket; proxyTimeout: proxy -> backend socket.
        timeout: API_PROXY_TIMEOUT_MS,
        proxyTimeout: API_PROXY_TIMEOUT_MS,
      },
    },
  },
})
