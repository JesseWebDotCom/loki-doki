import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import './index.css'
import 'katex/dist/katex.min.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/shared/ErrorBoundary.tsx'
import { persistOptions } from './lib/prefetch/persist.ts'
import { reportClientError } from './lib/clientErrorReport.ts'

// Errors that never reach the React tree (async handlers, unawaited promises) don't hit
// the ErrorBoundary - ship them to the backend log ring too so recurring breakage is
// diagnosable from Admin → logs instead of needing the user's devtools open at the time.
window.addEventListener('error', (e) => reportClientError('window-error', e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) => reportClientError('unhandled-rejection', e.reason))

// The pmtiles:// protocol MapLibre uses is registered inside the lazy MapsPage chunk so
// maplibre-gl isn't hoisted into this entry bundle. (window flag declared below.)
declare global {
  interface Window {
    __lokidokiPmtilesProtocolInstalled__?: boolean
  }
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
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // Self-heal: when a new SW takes control (a fresh deploy), reload ONCE so the page
      // runs the new build's chunks instead of the ones the old SW had cached. Without this,
      // a deploy needed several manual reloads and a stale/broken bundle could get stuck.
      reg.update().catch(() => {})
      let reloaded = false
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return
        reloaded = true
        window.location.reload()
      })
    }).catch(() => {})
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
