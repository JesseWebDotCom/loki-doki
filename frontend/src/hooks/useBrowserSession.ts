import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRadio } from '@/context/RadioContext'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import { djStationById } from '@/lib/music/catalogApi'
import { dispatchTransport } from '@/lib/mediaCoordinator'

// Receives commands pushed from a controller device (a Tab5 button press → server →
// here) and acts on them in THIS browser session: navigate, open a URL, or drive the
// radio player (play/pause/next/prev/play a station). This is how the physical controller
// remote-controls the app open in the browser.
export function useBrowserSession() {
  const navigate = useNavigate()
  const radio = useRadio()
  const podcast = usePodcastPlayback()

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
              else if (cmd.action === 'play_podcast' && typeof payload.showId === 'string') {
                // A controller podcast tile → play the show's newest READY episode.
                const showId = payload.showId
                const res = await fetch(`/api/podcasts/shows/${showId}/episodes`, { credentials: 'include' })
                  .then(r => r.json()).catch(() => null) as { episodes?: Array<{ id: string; title: string; status?: string; durationSec?: number }> } | null
                const ep = res?.episodes?.find(e => e.status === 'ready')
                if (ep) {
                  podcast.play({
                    episodeId: ep.id, showId, title: ep.title, durationSec: ep.durationSec ?? undefined,
                    showName: typeof payload.showName === 'string' ? payload.showName : 'Podcast',
                    coverUrl: `/api/podcasts/shows/${showId}/cover`,
                  })
                  navigate('/podcasts')
                }
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
          // Confirm we actually handled it (the device's fire-and-verify follow-up).
          if (typeof cmd.ackId === 'string') {
            void fetch('/api/browser-session/ack', {
              method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ackId: cmd.ackId }),
            }).catch(() => {})
          }
        } catch { /* malformed */ }
      })()
    })

    es.onerror = () => {} // EventSource auto-reconnects

    return () => es.close()
  }, [navigate, radio])
}
