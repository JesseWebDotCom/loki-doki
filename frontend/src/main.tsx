import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import './index.css'
import 'katex/dist/katex.min.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/shared/ErrorBoundary.tsx'
import { persistOptions } from './lib/prefetch/persist.ts'

// Register the pmtiles:// protocol so MapLibre can read offline vector-tile
// archives served by the maps backend. Guarded so HMR never double-registers.
declare global {
  interface Window {
    __lokidokiPmtilesProtocolInstalled__?: boolean
  }
}
if (!window.__lokidokiPmtilesProtocolInstalled__) {
  const pmtilesProtocol = new Protocol()
  maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile)
  window.__lokidokiPmtilesProtocolInstalled__ = true
}

// When the network interface changes on sleep/wake, Vite's ESM fetches fail with
// ERR_NETWORK_CHANGED and the page goes white. Detect HMR WS disconnect → reconnect
// and reload so the fresh module graph loads cleanly.
if (import.meta.hot) {
  let hmrWasDisconnected = false
  import.meta.hot.on('vite:ws:disconnect', () => { hmrWasDisconnected = true })
  import.meta.hot.on('vite:ws:connect', () => {
    if (hmrWasDisconnected) location.reload()
  })
}

if ('serviceWorker' in navigator) {
  if (import.meta.env.DEV) {
    navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister()))
  } else {
    navigator.serviceWorker.register('/sw.js')
  }
}

// gcTime is deliberately long: prefetched queries have NO observer, so at the default
// 5-min gcTime a boot-time/idle warm would be garbage-collected before the user clicks
// the app. 30 min keeps warmed pinned-app data alive until it's needed. Per-query
// staleTime still governs freshness (most warmed queries set their own).
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000, gcTime: 30 * 60_000 } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />
        </BrowserRouter>
      </PersistQueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)
