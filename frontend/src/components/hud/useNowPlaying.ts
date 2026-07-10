import { useEffect, useState, useSyncExternalStore } from 'react'
import { getActiveSource, pickMediaWinner, subscribeActiveSource } from '@/lib/mediaCoordinator'
import { useRadio } from '@/context/RadioContext'
import { useLiveRadio } from '@/context/LiveRadioContext'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import { useSongArt } from '@/components/music/SongArt'
import { proxyImg } from '@/lib/img'
import type { NowPlaying, UserPresence } from '@/lib/presence'

// Two-tier now-playing for the HUD island.
//
// Tier 1: media playing IN THIS WINDOW (the island window's own playback
// contexts). Full transport controls. This is the common desktop case, since
// companion "play X" directives drive the HUD window's own engines. YouTube is
// deliberately absent: its player element lives in YoutubeMiniBar, which only
// AppShell mounts, so YT can never actually sound from the /hud window.
//
// Tier 2: media playing ANYWHERE ELSE (main window, a browser tab, another
// device), read from the server snapshot every player already reports to
// /api/pod/now-playing (GET /api/pod/presence, 5 min staleness TTL server-side).
// Display-only; clicking deep-links into the main window.

export interface NowPlayingInfo {
  tier: 1 | 2
  source: 'radio' | 'liveRadio' | 'podcast' | 'youtube'
  title: string
  artist: string | null
  artUrl: string | null
  playing: boolean
  /** Seek position for the progress bar; null when unknown (live streams). */
  positionSec: number | null
  durationSec: number | null
  controls: {
    toggle?: () => void
    next?: () => void
    prev?: () => void
    stop?: () => void
    seek?: (sec: number) => void
  } | null
  deepLink: string
}

const PRESENCE_POLL_MS = 5000

function snapshotArt(cover: string): string | null {
  if (!cover) return null
  return cover.startsWith('/') ? cover : proxyImg(cover)
}

function snapshotDeepLink(np: NowPlaying): string {
  if (np.source === 'youtube' && np.videoId) return `/videos/youtube/watch/${np.videoId}`
  if (np.source === 'podcast') return '/podcasts'
  return '/music/now-playing'
}

export function useNowPlaying(): NowPlayingInfo | null {
  const activeSource = useSyncExternalStore(subscribeActiveSource, getActiveSource)
  const radio = useRadio()
  const live = useLiveRadio()
  const pod = usePodcastPlayback()

  // Hooks run unconditionally; the radio art query is a no-op without a track.
  const radioArt = useSongArt(radio.currentTrack?.videoId, radio.currentTrack?.title, radio.currentTrack?.author)

  const present = {
    podcast: !!pod.track,
    radio: radio.active,
    liveRadio: live.active && !radio.active,
  }
  const winner = pickMediaWinner(present, activeSource)
  const hasLocal = winner !== null && winner !== 'youtube' && winner !== 'studio'

  // Tier 2 snapshot, polled only while nothing local is playing.
  const [snapshot, setSnapshot] = useState<NowPlaying | null>(null)
  useEffect(() => {
    if (hasLocal) return
    let alive = true
    const tick = async () => {
      try {
        const r = await fetch('/api/pod/presence', { credentials: 'include' })
        if (!r.ok || !alive) return
        const d = (await r.json()) as UserPresence
        if (alive) setSnapshot(d.nowPlaying ?? null)
      } catch { /* offline, keep last */ }
    }
    void tick()
    const t = setInterval(tick, PRESENCE_POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [hasLocal])

  if (winner === 'podcast' && pod.track) {
    return {
      tier: 1,
      source: 'podcast',
      title: pod.track.title,
      artist: pod.track.showName ?? null,
      artUrl: pod.track.coverUrl ? proxyImg(pod.track.coverUrl) : null,
      playing: pod.playing,
      positionSec: pod.positionSec,
      durationSec: pod.duration || null,
      controls: { toggle: pod.toggle, next: pod.next, prev: pod.prev, stop: pod.close, seek: pod.seek },
      deepLink: '/podcasts',
    }
  }
  if (winner === 'radio' && radio.active) {
    return {
      tier: 1,
      source: 'radio',
      title: radio.currentTrack?.title ?? radio.station?.label ?? 'AI Radio',
      artist: radio.currentTrack?.author ?? null,
      artUrl: radioArt ?? (radio.currentTrack?.thumbnail ? proxyImg(radio.currentTrack.thumbnail) : null),
      playing: radio.active && !radio.paused,
      positionSec: radio.positionSec,
      durationSec: radio.durationSec || null,
      controls: { toggle: radio.togglePause, next: radio.skip, stop: radio.stop, seek: radio.seek },
      deepLink: '/music/now-playing',
    }
  }
  if (winner === 'liveRadio' && live.active) {
    return {
      tier: 1,
      source: 'liveRadio',
      title: live.mode === 'recording' ? (live.recording?.title ?? 'Recording') : (live.station?.name ?? 'Live Radio'),
      artist: live.mode === 'recording' ? (live.recording?.stationName ?? null) : null,
      artUrl: live.station?.favicon ? proxyImg(live.station.favicon) : null,
      playing: live.active && !live.paused,
      positionSec: live.mode === 'recording' ? live.positionSec : null,
      durationSec: live.mode === 'recording' ? (live.durationSec || null) : null,
      controls: { toggle: live.togglePause, stop: live.stop, seek: live.mode === 'recording' ? live.seek : undefined },
      deepLink: '/music/live',
    }
  }

  if (snapshot && !hasLocal) {
    return {
      tier: 2,
      source: snapshot.source === 'youtube' ? 'youtube' : snapshot.source === 'podcast' ? 'podcast' : 'radio',
      title: snapshot.title,
      artist: snapshot.artist,
      artUrl: snapshotArt(snapshot.cover),
      playing: snapshot.playing,
      positionSec: snapshot.positionSec ?? null,
      durationSec: snapshot.durationSec || null,
      controls: null,
      deepLink: snapshotDeepLink(snapshot),
    }
  }

  return null
}
