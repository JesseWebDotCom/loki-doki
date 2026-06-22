import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import './index.css'
import 'katex/dist/katex.min.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/shared/ErrorBoundary.tsx'

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

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)
