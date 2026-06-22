import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      // Only the HTML entry needs no-store; versioned JS/CSS assets (URLs contain
      // ?v=hash) are safe to cache and must be cacheable so that a brief macOS
      // network-interface change (ERR_NETWORK_CHANGED) doesn't wipe the page.
      name: 'html-no-store',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.url || req.url === '/' || /\.html(\?|$)/.test(req.url)) {
            res.setHeader('Cache-Control', 'no-store')
          }
          next()
        })
      },
    },
    {
      // onnxruntime-web loads its WASM glue (`.mjs`) via dynamic import() from
      // `ort.env.wasm.wasmPaths` ('/ort/'). Vite's dev server refuses to
      // module-serve files in /public, so serve /ort/* directly here. (In a
      // production build, public/ort is copied to dist/ort and served static.)
      name: 'serve-ort-assets',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.url || !req.url.startsWith('/ort/')) return next()
          const name = path.basename(req.url.split('?')[0]!)
          const fp = path.join(here, 'public/ort', name)
          if (!fs.existsSync(fp)) return next()
          res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
          res.setHeader('Cache-Control', 'public, max-age=31536000')
          fs.createReadStream(fp).pipe(res)
        })
      },
    },
  ],
  resolve: {
    alias: {
      "@": path.resolve(here, "./src"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    historyApiFallback: true,
    hmr: {
      protocol: 'ws',
      host: 'localhost',
      port: 5173,
    },
    proxy: {
      // SSE endpoints: no proxy timeout, no response buffering.
      // http-proxy's default timeout kills long-running SSE connections mid-stream.
      '/api/chat/stream': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        proxyTimeout: 0,
        timeout: 0,
      },
      '/api/admin/archives/download': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        proxyTimeout: 0,
        timeout: 0,
      },
      '/api/admin/archives/install-kiwix': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        proxyTimeout: 0,
        timeout: 0,
      },
      // STT is a WebSocket — needs ws:true and no timeout, listed before /api so
      // it matches first. Without ws:true the upgrade never reaches the backend.
      '/api/stt/stream': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
        proxyTimeout: 0,
        timeout: 0,
      },
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // Any path served by the backend as static files (not a React route) needs
      // an entry here. Without it, Vite catches the request and serves the SPA
      // fallback (index.html → React home page) inside the iframe. See agents.md
      // "Iframe Page Pattern" for the full checklist.
      '/docs': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
