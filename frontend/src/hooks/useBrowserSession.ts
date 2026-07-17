import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast as sonnerToast } from 'sonner'
import { useRadio } from '@/context/RadioContext'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import { useServerHealth } from '@/context/ServerHealthContext'
import { djStationById } from '@/lib/music/catalogApi'
import { dispatchTransport, hasActiveMedia } from '@/lib/mediaCoordinator'
import { manageEventSource } from '@/lib/managedEventSource'
import { getDeviceId, getDeviceLabel } from '@/lib/drop'
import { setDockYieldFromServer } from '@/lib/voice/dockYield'
import { getVoiceWants } from '@/lib/voice/voiceOwnership'

// Receives commands pushed from a controller device (a Tab5 button press → server →
// here) and acts on them in THIS browser session: navigate, open a URL, or drive the
// radio player (play/pause/next/prev/play a station). This is how the physical controller
// remote-controls the app open in the browser.
//
// The registration also carries voice-arbitration metadata: the Doki Dock desktop app
// registers with dock=1 (surface 'hud' for the island window), and the server pushes
// `voice` events telling web tabs on the same machine to yield companion speech to the
// dock (see lib/voice/dockYield.ts). Dock sessions receive `dock` events - server→dock
// requests (read-only file ops) relayed to the Electron main process over the preload
// bridge, with the result POSTed back.
//
// The stream is visibility-managed (see managedEventSource.ts): hidden tabs release
// their connection so multiple tabs can't exhaust the browser's per-origin pool -
// EXCEPT a hidden tab that's playing media, which stays connected so a device remote
// can still drive it. Reconnecting on focus also means the backend's most-recent-tab
// command routing follows the tab the user is actually looking at. The dock HUD keeps
// its stream open even hidden - its registration IS the dock's presence signal - and a
// hidden hands-free tab stays connected so it hears the dock start/stop.
export function useBrowserSession({ surface = 'app' }: { surface?: 'app' | 'hud' } = {}) {
  const navigate = useNavigate()
  const radio = useRadio()
  const podcast = usePodcastPlayback()
  const { reportAlive } = useServerHealth()
  const reportAliveRef = useRef(reportAlive)
  reportAliveRef.current = reportAlive
  // useRadio()/usePodcastPlayback() return a fresh value every second while media plays (the
  // engine's positionSec ticks). Read them through refs so the SSE-opening effect can depend on
  // []; depending on `radio` tore down and reopened the EventSource once per second, dropping
  // any command that landed in a reconnect gap.
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  const radioRef = useRef(radio)
  radioRef.current = radio
  const podcastRef = useRef(podcast)
  podcastRef.current = podcast

  useEffect(() => {
    return manageEventSource(() => {
      const isDock = !!window.lokiDesktop
      // Cast addressing: reuse Drop's stable per-browser id + friendly label so this tab
      // is a "play it here" target. TV mode marks itself so it sorts first in the picker.
      const isTv = typeof window !== 'undefined' && window.location.pathname.startsWith('/tv')
      const params = new URLSearchParams({
        dock: isDock ? '1' : '0',
        surface,
        deviceId: getDeviceId(),
        label: isTv ? `${getDeviceLabel()} (TV)` : getDeviceLabel(),
        tv: isTv ? '1' : '0',
      })
      const es = new EventSource(`/api/browser-session?${params}`, { withCredentials: true })

      // Every SSE ping proves the backend is up. This stream is also exactly what starves
      // the /api/health probe when the connection pool fills, so without this signal the
      // "server unreachable" banner shows while the server is demonstrably alive.
      es.onopen = () => reportAliveRef.current()
      es.addEventListener('ping', () => reportAliveRef.current())

      es.addEventListener('command', (e: MessageEvent) => {
        void (async () => {
          try {
            const cmd = JSON.parse(e.data as string) as Record<string, unknown>
            // Whether this command actually produced its effect — gates the ack below. A
            // command that silently no-ops (e.g. a podcast tile whose fetch found nothing
            // playable) must NOT ack success, or the device thinks it worked and never shows
            // its "didn't fire" state — it just looks like nothing happened.
            let handled = true
            switch (cmd.type) {
              case 'navigate':
                if (typeof cmd.path === 'string') navigateRef.current(cmd.path)
                else handled = false
                break
              case 'open_url':
                if (typeof cmd.url === 'string') window.open(cmd.url, '_blank', 'noopener')
                else handled = false
                break
              case 'app_action': {
                const payload = (cmd.payload ?? {}) as Record<string, unknown>
                if (cmd.action === 'play_pause') radioRef.current.togglePause()
                else if (cmd.action === 'next_track') radioRef.current.skip()
                else if (cmd.action === 'prev_track') radioRef.current.seek(0)
                else if (cmd.action === 'play_station' && typeof payload.stationId === 'string') {
                  const dj = await djStationById(payload.stationId)
                  if (dj) { radioRef.current.start(dj); navigateRef.current('/music/now-playing') }
                  else { handled = false; console.warn('[controller] play_station: station not found', payload.stationId) }
                }
                else if (cmd.action === 'play_podcast' && typeof payload.showId === 'string') {
                  // A controller podcast tile → play the show's newest READY episode.
                  const showId = payload.showId
                  const res = await fetch(`/api/podcasts/shows/${showId}/episodes`, { credentials: 'include' })
                    .then(r => r.json()).catch(() => null) as { episodes?: Array<{ id: string; title: string; status?: string; durationSec?: number }> } | null
                  const ep = res?.episodes?.find(e => e.status === 'ready')
                  if (ep) {
                    podcastRef.current.play({
                      episodeId: ep.id, showId, title: ep.title, durationSec: ep.durationSec ?? undefined,
                      showName: typeof payload.showName === 'string' ? payload.showName : 'Podcast',
                      coverUrl: `/api/podcasts/shows/${showId}/cover`,
                    })
                    navigateRef.current('/podcasts')
                  } else {
                    handled = false
                    console.warn('[controller] play_podcast: no ready episode', { showId, episodes: res?.episodes?.length })
                  }
                }
                else handled = false
                break
              }
              case 'watch_invite': {
                // Watch Together: someone in the household started a synced session and
                // invited everyone. Surface a live toast with a one-tap Join.
                const p = (cmd.payload ?? {}) as { title?: string; fromName?: string }
                if (typeof cmd.path === 'string') {
                  const path = cmd.path
                  sonnerToast(`${p.fromName ?? 'Someone'} invited you to watch together`, {
                    description: typeof p.title === 'string' ? p.title : undefined,
                    duration: 30_000,
                    action: { label: 'Join', onClick: () => navigateRef.current(path) },
                  })
                } else handled = false
                break
              }
              case 'media_transport': {
                // Transport from a device's native player bar → drive whichever engine is
                // active (radio or youtube), routed through the media coordinator.
                dispatchTransport(String(cmd.transport ?? ''), typeof cmd.position === 'number' ? cmd.position : undefined)
                break
              }
              default:
                handled = false
            }
            // Confirm we actually handled it (the device's fire-and-verify follow-up). If it
            // didn't fire, withhold the ack — the server's pending-ack timeout then reports
            // back to the device as a failure, so it can un-sink the tile / show "didn't work"
            // instead of a false "success" that leaves nothing visibly happening.
            if (handled && typeof cmd.ackId === 'string') {
              void fetch('/api/browser-session/ack', {
                method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ackId: cmd.ackId }),
              }).catch(() => {})
            }
          } catch { /* malformed */ }
        })()
      })

      // Server-arbitrated "dock wins" voice signal: {yield: true} means a Doki Dock on
      // this machine owns companion speech and this tab must go quiet.
      es.addEventListener('voice', (e: MessageEvent) => {
        try {
          const state = JSON.parse(e.data as string) as { yield?: unknown }
          setDockYieldFromServer(state.yield === true)
        } catch { /* malformed */ }
      })

      // Server → dock requests (read-only file ops for the companion). Only the desktop
      // shell can serve these; older shells without the bridge report back immediately
      // so the awaiting tool call fails fast instead of timing out.
      es.addEventListener('dock', (e: MessageEvent) => {
        void (async () => {
          let requestId: string | undefined
          try {
            const req = JSON.parse(e.data as string) as { requestId?: string; type?: string; action?: string; path?: string }
            if (typeof req.requestId !== 'string') return
            requestId = req.requestId
            let result: { ok: boolean; error?: string; data?: unknown }
            if (req.type !== 'files') result = { ok: false, error: 'unsupported_request' }
            else if (!window.lokiDesktop?.fsRequest) result = { ok: false, error: 'shell_outdated' }
            else result = await window.lokiDesktop.fsRequest({ action: String(req.action ?? ''), path: String(req.path ?? '') })
            await fetch('/api/browser-session/dock-result', {
              method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ requestId, result }),
            })
          } catch {
            if (requestId) {
              void fetch('/api/browser-session/dock-result', {
                method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requestId, result: { ok: false, error: 'dock_error' } }),
              }).catch(() => {})
            }
          }
        })()
      })

      es.onerror = () => {} // EventSource auto-reconnects

      return es
    }, { keepWhenHidden: () => surface === 'hud' || hasActiveMedia() || getVoiceWants() })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- radio/podcast/navigate read via refs; surface is fixed per mount
  }, [])
}
