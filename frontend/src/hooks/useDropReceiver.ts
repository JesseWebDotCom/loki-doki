import { useEffect } from 'react'
import { toast } from 'sonner'
import {
  getDeviceId, getDeviceLabel, downloadDrop, dismissDrop, formatBytes,
  type DropPreview,
} from '@/lib/drop'

// App-wide receive channel for Drop. Mounted once from AppShell (alongside
// useBrowserSession), it holds an SSE stream open so incoming files/links land as an
// actionable toast anywhere in the app, not just while the Drop page is open. It also
// re-emits events on `window` so an open Drop page can refresh its inbox live.

function emit(name: string, detail: unknown) {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

export function useDropReceiver() {
  useEffect(() => {
    const deviceId = getDeviceId()
    const label = getDeviceLabel()
    const url = `/api/drop/stream?deviceId=${encodeURIComponent(deviceId)}&label=${encodeURIComponent(label)}`
    const es = new EventSource(url, { withCredentials: true })

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

    return () => es.close()
  }, [])
}
