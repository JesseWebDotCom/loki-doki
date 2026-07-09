import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useServerHealth } from '@/context/ServerHealthContext'
import { manageEventSource } from '@/lib/managedEventSource'
import {
  getDeviceId, getDeviceLabel, downloadDrop, dismissDrop, formatBytes,
  type DropPreview,
} from '@/lib/drop'

// App-wide receive channel for Drop. Mounted once from AppShell (alongside
// useBrowserSession), it holds an SSE stream open so incoming files/links land as an
// actionable toast anywhere in the app, not just while the Drop page is open. It also
// re-emits events on `window` so an open Drop page can refresh its inbox live.
//
// Visibility-managed (see managedEventSource.ts): a hidden tab drops its connection —
// its toast couldn't be seen anyway, every tab in this browser shares one deviceId, and
// each pinned SSE stream eats into the browser's small per-origin connection pool.

function emit(name: string, detail: unknown) {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

export function useDropReceiver() {
  const { reportAlive } = useServerHealth()
  const reportAliveRef = useRef(reportAlive)
  reportAliveRef.current = reportAlive

  useEffect(() => {
    return manageEventSource(() => {
      const deviceId = getDeviceId()
      const label = getDeviceLabel()
      const url = `/api/drop/stream?deviceId=${encodeURIComponent(deviceId)}&label=${encodeURIComponent(label)}`
      const es = new EventSource(url, { withCredentials: true })

      // Proof of life for the health banner — see the same wiring in useBrowserSession.
      es.onopen = () => reportAliveRef.current()
      es.addEventListener('ping', () => reportAliveRef.current())

      es.addEventListener('drop', (e: MessageEvent) => {
        try {
          const evt = JSON.parse(e.data as string) as { type: string; drop?: DropPreview }
          if (evt.type === 'incoming' && evt.drop) {
            const d = evt.drop
            emit('drop:incoming', d)
            if (d.kind === 'text') {
              toast(`Drop from ${d.senderLabel}`, {
                description: (d.body || '').slice(0, 140),
                duration: 12_000,
                action: {
                  label: 'Copy',
                  onClick: () => { void navigator.clipboard?.writeText(d.body || '').catch(() => {}); void dismissDrop(d.id) },
                },
                cancel: { label: 'Dismiss', onClick: () => void dismissDrop(d.id) },
              })
            } else {
              toast(`Drop from ${d.senderLabel}`, {
                description: `${d.fileName || 'file'} · ${formatBytes(d.sizeBytes)}`,
                duration: 15_000,
                action: { label: 'Save', onClick: () => downloadDrop(d) },
                cancel: { label: 'Dismiss', onClick: () => void dismissDrop(d.id) },
              })
            }
          } else if (evt.type === 'claimed' && evt.drop) {
            emit('drop:claimed', evt.drop)
          }
        } catch { /* malformed */ }
      })

      es.onerror = () => {} // EventSource auto-reconnects

      return es
    })
  }, [])
}
