import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRadio } from '@/context/RadioContext'
import { djStationById } from '@/lib/music/catalogApi'
import { dispatchTransport } from '@/lib/mediaCoordinator'

// Receives commands pushed from a controller device (a Tab5 button press → server →
// here) and acts on them in THIS browser session: navigate, open a URL, or drive the
// radio player (play/pause/next/prev/play a station). This is how the physical controller
// remote-controls the app open in the browser.
export function useBrowserSession() {
  const navigate = useNavigate()
  const radio = useRadio()

  useEffect(() => {
    const es = new EventSource('/api/browser-session', { withCredentials: true })

    es.addEventListener('command', (e: MessageEvent) => {
      void (async () => {
        try {
          const cmd = JSON.parse(e.data as string) as Record<string, unknown>
          switch (cmd.type) {
            case 'navigate':
              if (typeof cmd.path === 'string') navigate(cmd.path)
              break
            case 'open_url':
              if (typeof cmd.url === 'string') window.open(cmd.url, '_blank', 'noopener')
              break
            case 'app_action': {
              const payload = (cmd.payload ?? {}) as Record<string, unknown>
              if (cmd.action === 'play_pause') radio.togglePause()
              else if (cmd.action === 'next_track') radio.skip()
              else if (cmd.action === 'prev_track') radio.seek(0)
              else if (cmd.action === 'play_station' && typeof payload.stationId === 'string') {
                const dj = await djStationById(payload.stationId)
                if (dj) { radio.start(dj); navigate('/music/now-playing') }
              }
              break
            }
            case 'media_transport': {
              // Transport from a device's native player bar → drive whichever engine is
              // active (radio or youtube), routed through the media coordinator.
              dispatchTransport(String(cmd.transport ?? ''), typeof cmd.position === 'number' ? cmd.position : undefined)
              break
            }
          }
        } catch { /* malformed */ }
      })()
    })

    es.onerror = () => {} // EventSource auto-reconnects

    return () => es.close()
  }, [navigate, radio])
}
