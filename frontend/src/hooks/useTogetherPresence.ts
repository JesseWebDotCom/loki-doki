// Listening Together: register THIS session in the household presence registry.
//
// Mounted once (AppShell) inside the player providers. Heartbeats the session's
// device id, its user-agent label, and a snapshot of whatever the local player is
// doing, so other household sessions can list it in their Devices popover and
// remote-control it. Idle sessions still heartbeat (slower) - they remain valid
// targets for "play jazz on the living room TV".
//
// A session only advertises itself while it can ACTUALLY be driven, i.e. while its
// browser-session SSE stream is up: visible, or hidden-but-playing (the exact
// keepWhenHidden rule in useBrowserSession). A hidden idle tab drops its stream to
// spare the per-origin connection pool, so listing it would offer a target whose
// commands silently go nowhere.
//
// The registry itself is in-memory server-side, so this is fire-and-forget: a
// missed beat costs nothing and a closed tab ages out (plus a pagehide beacon).

import { useEffect, useRef } from 'react'
import { useRadio } from '@/context/RadioContext'
import { useLiveRadio } from '@/context/LiveRadioContext'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import { useAuth } from '@/context/AuthContext'
import { hasActiveMedia } from '@/lib/mediaCoordinator'
import { getDeviceId, getDeviceLabel } from '@/lib/together/deviceIdentity'
import { clearPresenceBeacon, reportPresence, type PlayerSnapshot } from '@/lib/together/api'

const PLAYING_MS = 5_000
const IDLE_MS = 20_000

export function useTogetherPresence() {
  const { user } = useAuth()
  const radio = useRadio()
  const live = useLiveRadio()
  const pod = usePodcastPlayback()

  // The contexts re-render every second while media plays; read them through a ref
  // so the heartbeat effect can depend on [] and never resets its interval.
  const snapRef = useRef<PlayerSnapshot | null>(null)
  snapRef.current = (() => {
    if (radio.active && radio.currentTrack) {
      return {
        source: 'radio',
        title: radio.currentTrack.title,
        artist: radio.currentTrack.author ?? null,
        cover: radio.currentTrack.thumbnail ?? '',
        positionSec: Math.round(radio.positionSec),
        durationSec: Math.round(radio.durationSec),
        playing: !radio.paused,
        volume: radio.volume,
      }
    }
    if (live.active) {
      return {
        source: 'liveRadio',
        title: live.station?.name ?? live.recording?.title ?? 'Live Radio',
        artist: live.recording?.stationName ?? (live.station ? 'Live Radio' : null),
        cover: live.station?.favicon ?? '',
        positionSec: Math.round(live.positionSec),
        durationSec: Math.round(live.durationSec),
        playing: !live.paused,
        volume: live.volume,
      }
    }
    if (pod.track) {
      return {
        source: 'podcast',
        title: pod.track.title,
        artist: pod.track.showName,
        cover: pod.track.coverUrl ?? '',
        positionSec: Math.round(pod.positionSec),
        durationSec: Math.round(pod.track.durationSec ?? pod.duration),
        playing: pod.playing,
        volume: pod.volume,
      }
    }
    return null
  })()

  const signedIn = !!user?.id
  useEffect(() => {
    if (!signedIn) return
    const deviceId = getDeviceId()
    const label = getDeviceLabel()
    let timer: ReturnType<typeof setTimeout> | null = null
    let advertised = false

    // Mirrors useBrowserSession's keepWhenHidden: exactly when the command stream is up.
    const targetable = () => document.visibilityState === 'visible' || hasActiveMedia()

    const beat = () => {
      const snap = snapRef.current
      if (targetable()) {
        advertised = true
        void reportPresence(deviceId, label, snap).catch(() => {})
      } else if (advertised) {
        // Went hidden with nothing playing: drop out of the list now rather than
        // lingering as an undrivable target until the staleness timeout.
        advertised = false
        void fetch('/api/together/presence/clear', {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId }),
        }).catch(() => {})
      }
      // Cadence follows what the player is doing: a playing session is worth
      // tracking closely (the remote shows live progress), an idle one is not.
      timer = setTimeout(beat, snap?.playing ? PLAYING_MS : IDLE_MS)
    }
    beat()

    // Re-advertise the moment the tab is shown again, instead of waiting a full beat.
    const onVisibility = () => { if (document.visibilityState === 'visible') beatNow() }
    const beatNow = () => { if (timer) clearTimeout(timer); beat() }
    document.addEventListener('visibilitychange', onVisibility)

    const onHide = () => clearPresenceBeacon(deviceId)
    window.addEventListener('pagehide', onHide)
    return () => {
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onHide)
    }
  }, [signedIn])
}
