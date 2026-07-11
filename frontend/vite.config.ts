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
    host: true,
    port: 5173,
    strictPort: true,
    hmr: {
      protocol: 'ws',
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
      // YouTube proxy stream: long-lived media stream with a SLOW first byte on a cold resolve
      // (~4s while the backend resolves the URL before any data flows). The default proxy timeout
      // kills that gap → the browser gets a 500 and the media element reports a format error. Same
      // treatment as the SSE endpoints above. Listed before /api so it matches first.
      // `agent: false` (see /api/browser-session below): card hover-preview now opens many of
      // these mid-stream and tears them down abruptly on mouse-leave, which is exactly the kind
      // of unclean chunked-response close that poisons a pooled keep-alive socket — without this,
      // that can silently hang unrelated widget fetches (including the /api/health probe) even
      // though the backend's own logs show a clean 200.
      '/api/youtube/stream': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        proxyTimeout: 0,
        timeout: 0,
        agent: false,
      },
      // browser-session + the boot progress feed are SSE streams every tab opens on load, but
      // they were falling through to the generic '/api' proxy below — sharing its keep-alive
      // socket POOL with ordinary widget fetches. When Bun's chunked SSE framing trips Node's
      // HTTP parser ("Invalid character in chunk size"), it corrupts that pooled socket and the
      // widget responses reusing it never make it back to the browser (backend logs 200, the
      // browser hangs on a spinner). `agent: false` gives these streams unpooled, single-use
      // sockets so a bad SSE frame can never poison a sibling request. Listed before '/api'.
      '/api/browser-session': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        proxyTimeout: 0,
        timeout: 0,
        agent: false,
      },
      '/api/system/boot': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        proxyTimeout: 0,
        timeout: 0,
        agent: false,
      },
      // Coding app: /api/coding/terminal is a WebSocket (the xterm.js terminal
      // attached to the user's tmux+claude session) — needs ws: true, same as the STT
      // stream entry above. Covers the whole /api/coding prefix (harmless for the
      // plain JSON pane-control routes under it too) rather than listing the one
      // dynamic path.
      '/api/coding': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
        proxyTimeout: 0,
        timeout: 0,
        agent: false,
      },
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // Belt-and-suspenders: don't reuse pooled sockets for ordinary API traffic either, so a
        // stray chunked/streaming response can't desync a socket a later widget fetch reuses.
        agent: false,
        configure: (proxy) => {
          proxy.on('error', (err, _req, res) => {
            if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
              if ('writeHead' in res) { res.writeHead(503); res.end() }
              return
            }
            console.error('[proxy]', err.message)
          })
        },
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
    // The default 500kB warning fired on the old 8.5MB monolithic entry. After code-splitting,
    // the eager first-paint path is ~1MB gzip across cacheable chunks; every remaining chunk
    // above 500kB is either the app core (index) or a single third-party library isolated to a
    // lazy route it only loads on demand (mdi icon set, maplibre, alphatab, codemirror). Raise
    // the threshold so the warning stops flagging those intentional isolations. If a NEW eager
    // chunk grows past this, that's worth investigating — check the index/vendor-* sizes.
    chunkSizeWarningLimit: 2900,
    rollupOptions: {
      output: {
        // Split heavy vendor libs into their own cacheable chunks instead of one monolithic
        // entry bundle. Libs used only by lazy routes (maplibre/xterm/codemirror/alphatab)
        // become dynamic chunks the entry never loads; the rest are separate long-cache files
        // so a code change doesn't re-download all of node_modules.
        // Isolate the heaviest leaf libraries. Those used only by lazy routes (maplibre, xterm,
        // codemirror, alphatab, audio synths) become dynamic chunks the entry never loads.
        // Everything else returns undefined so Rollup's automatic per-route splitting distributes
        // it — a catch-all "vendor" bucket would just rebuild one monolithic always-loaded chunk.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("maplibre") || id.includes("pmtiles")) return "vendor-maplibre";
          if (id.includes("react-syntax-highlighter") || id.includes("refractor") || id.includes("lowlight") || id.includes("highlight.js")) return "vendor-syntax";
          if (id.includes("@xterm")) return "vendor-xterm";
          if (id.includes("@codemirror") || id.includes("@uiw") || id.includes("codemirror")) return "vendor-codemirror";
          if (id.includes("@coderline/alphatab")) return "vendor-alphatab";
          if (id.includes("@dicebear")) return "vendor-dicebear";
          if (id.includes("katex")) return "vendor-katex";
          if (id.includes("spessasynth") || id.includes("@tonejs") || id.includes("soundtouch")) return "vendor-audio";
          if (id.includes("react-router") || id.includes("/react-dom/") || id.includes("/react/") || id.includes("/scheduler/")) return "vendor-react";
          if (id.includes("@tanstack")) return "vendor-tanstack";
          // Icon libraries get one chunk each (each is large and reached from broadly-shared
          // components) so they're cached independently of app code and of each other, instead
          // of collapsing into one ~3MB blob or bloating the entry chunk.
          if (id.includes("@tabler/icons")) return "vendor-tabler";
          if (id.includes("lucide-react")) return "vendor-lucide";
          // @mdi/js is intentionally NOT bucketed: it's only dynamically imported now (HAIcon,
          // for custom icons), so Rollup isolates it into a lazy chunk loaded on demand.
          // Markdown/radix/motion are used by eager pages, so isolate them for caching.
          if (id.includes("react-markdown") || id.includes("remark") || id.includes("rehype") || id.includes("micromark") || id.includes("mdast") || id.includes("/hast") || id.includes("unified") || id.includes("unist") || id.includes("/vfile") || id.includes("/decode-named") || id.includes("/property-information")) return "vendor-markdown";
          if (id.includes("@radix-ui")) return "vendor-radix";
          if (id.includes("framer-motion") || id.includes("motion-dom") || id.includes("motion-utils")) return "vendor-motion";
        },
      },
    },
  },
});
