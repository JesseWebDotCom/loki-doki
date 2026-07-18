// Companion listen/watch-along: bridges whatever is playing right now (AI-radio music,
// live internet radio, podcasts, docked mini-player videos) into the companion's UI
// context, so the companion knows the item, the exact playhead, and the lyric/transcript
// lines the user just heard, and can talk about it like it's listening along.
//
// Position and windows are resolved at SEND time via UIContextEntry.getDescription, so
// nothing re-publishes (or re-renders consumers) on every playback tick. The full-page
// video watch route publishes its own equivalent entry (see WatchPage): the dock is
// cleared while that page owns the video, so this bridge never sees it.

import { useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useRadio } from '@/context/RadioContext'
import { useLiveRadio } from '@/context/LiveRadioContext'
import { usePodcastPlayback, type TranscriptTurn } from '@/context/PodcastPlaybackContext'
import { useYoutubePlayback } from '@/context/YoutubePlaybackContext'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { getLyrics } from '@/lib/music/catalogApi'
import { parseVtt } from '@/lib/youtube/transcript'
import {
  MEDIA_GUIDANCE, estimatedTranscriptWindow, fmtProgress, lyricsWindow, truncate,
  videoCompanionBlock,
} from '@/lib/companionMedia'

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/

export function NowPlayingCompanionBridge() {
  const radio = useRadio()
  const live = useLiveRadio()
  const pod = usePodcastPlayback()
  const yt = useYoutubePlayback()

  const musicTrack = radio.active ? radio.currentTrack : null
  const ytTrack = yt.track
  // Only bare YouTube ids have caption transcripts (local/plex refs and other sources don't).
  const ytId = ytTrack && (!ytTrack.source || ytTrack.source === 'youtube') && YT_ID_RE.test(ytTrack.videoId)
    ? ytTrack.videoId : null

  // Synced lyrics for the current song. Same fetch the Now-Playing panel warms, so this is
  // usually a cache hit. `restricted` means this profile's content settings hide them.
  const { data: lyrics } = useQuery({
    queryKey: ['music-lyrics', musicTrack?.author ?? '', musicTrack?.title ?? ''],
    queryFn: () => getLyrics(musicTrack?.author ?? '', musicTrack?.title ?? ''),
    enabled: !!musicTrack?.title, staleTime: Infinity,
  })

  // Generated-podcast transcript, when the loaded track didn't arrive with one inline
  // (e.g. resumed from the queue). RSS episodes simply have none, the window stays empty.
  const { data: fetchedTurns } = useQuery({
    queryKey: ['companion-podcast-transcript', pod.track?.episodeId ?? ''],
    queryFn: async (): Promise<TranscriptTurn[]> => {
      const r = await fetch(`/api/podcasts/episodes/${pod.track!.episodeId}`, { credentials: 'include' })
      if (!r.ok) return []
      const j = (await r.json()) as { episode?: { transcript?: TranscriptTurn[] } }
      return j.episode?.transcript ?? []
    },
    enabled: !!pod.track && !pod.track.transcript?.length, staleTime: Infinity,
  })

  // Timed captions for a docked video (shared key with the watch page's publisher).
  const { data: ytLines } = useQuery({
    queryKey: ['companion-yt-transcript', ytId ?? ''],
    queryFn: async () => {
      const vtt = await fetch(`/api/youtube/transcript/${ytId}`, { credentials: 'include' })
        .then(r => (r.ok ? r.text() : '')).catch(() => '')
      return parseVtt(vtt)
    },
    enabled: !!ytId, staleTime: Infinity,
  })

  // Everything getDescription needs, mirrored fresh each render so the send-time closure
  // always reads the live playhead (the contexts tick every second while playing).
  const snap = { radio, live, pod, yt, lyrics, fetchedTurns, ytLines }
  const snapRef = useRef(snap)
  snapRef.current = snap

  // What (if anything) the companion is listening/watching along to. Priority follows the
  // audio coordinator: only one source really plays; a loaded-but-paused one still counts.
  const current =
    (pod.track && { kind: 'podcast' as const, title: pod.track.title, sub: pod.track.showName }) ||
    (musicTrack && { kind: 'music' as const, title: musicTrack.title, sub: musicTrack.author ?? undefined }) ||
    (live.active && { kind: 'live' as const, title: live.recording?.title ?? live.station?.name ?? 'Live radio', sub: live.recording?.stationName }) ||
    (ytTrack && { kind: 'video' as const, title: ytTrack.title, sub: ytTrack.author ?? undefined }) ||
    null

  usePublishUIContext({
    label: current ? truncate(current.title, 24) : undefined,
    // The static description doubles as the republish key: it changes only when the item
    // does. The live details (position, play state, windows) come from getDescription.
    description: current
      ? `${current.kind === 'video' ? 'Watching' : 'Listening to'} "${current.title}"${current.sub ? ` (${current.sub})` : ''}`
      : '',
    getDescription: () => buildMediaBlock(snapRef.current),
  })

  return null
}

type Snap = {
  radio: ReturnType<typeof useRadio>
  live: ReturnType<typeof useLiveRadio>
  pod: ReturnType<typeof usePodcastPlayback>
  yt: ReturnType<typeof useYoutubePlayback>
  lyrics?: Awaited<ReturnType<typeof getLyrics>>
  fetchedTurns?: TranscriptTurn[]
  ytLines?: ReturnType<typeof parseVtt>
}

function buildMediaBlock(s: Snap): string {
  // Same priority as `current` above, keep the block and the chip describing one item.
  if (s.pod.track) return podcastBlock(s)
  if (s.radio.active && s.radio.currentTrack) return musicBlock(s)
  if (s.live.active) return liveRadioBlock(s)
  if (s.yt.track) {
    return videoCompanionBlock({
      title: s.yt.track.title, author: s.yt.track.author,
      positionSec: s.yt.positionSec, durationSec: s.yt.track.durationSec,
      playing: true, // the docked mini-player has no pause state; it plays while docked
      lines: s.ytLines ?? [],
    })
  }
  return ''
}

function musicBlock(s: Snap): string {
  const t = s.radio.currentTrack!
  const parts = [
    `The user is listening to music: "${t.title}"${t.author ? ` by ${t.author}` : ''}, at ${fmtProgress(s.radio.positionSec, s.radio.durationSec)}, currently ${s.radio.paused ? 'paused' : 'playing'}.`,
  ]
  // A direct track play mints an ad-hoc station named after the track, only a real
  // station selection is worth mentioning.
  if (s.radio.station && s.radio.station.label !== t.title) parts.push(`Station: ${s.radio.station.label} (AI Radio).`)
  if (s.radio.nextTrack) parts.push(`Up next: "${s.radio.nextTrack.title}"${s.radio.nextTrack.author ? ` by ${s.radio.nextTrack.author}` : ''}.`)
  if (s.lyrics?.restricted) {
    parts.push("This profile's content settings hide this song's lyrics, do not quote or recite them.")
  } else if (s.lyrics?.synced?.length) {
    const window = lyricsWindow(s.lyrics.synced, s.radio.positionSec)
    if (window) parts.push(window)
  }
  parts.push(MEDIA_GUIDANCE)
  return parts.join('\n')
}

function liveRadioBlock(s: Snap): string {
  const rec = s.live.recording
  const line = rec
    ? `The user is listening to a saved radio recording: "${rec.title}" from ${rec.stationName ?? 'a live station'}, at ${fmtProgress(s.live.positionSec, s.live.durationSec)}, currently ${s.live.paused ? 'paused' : 'playing'}.`
    : `The user is listening to the live internet radio station "${s.live.station?.name ?? 'Unknown'}", currently ${s.live.paused ? 'paused' : 'playing'}. (Live stream: there is no track metadata or transcript.)`
  return [line, MEDIA_GUIDANCE].join('\n')
}

function podcastBlock(s: Snap): string {
  const t = s.pod.track!
  const pos = s.pod.positionSec
  const dur = s.pod.duration || t.durationSec || 0
  const parts = [
    `The user is listening to a podcast: episode "${t.title}" from the show "${t.showName}", at ${fmtProgress(pos, dur)}, currently ${s.pod.playing ? 'playing' : 'paused'}.`,
  ]
  const ch = [...s.pod.chapters].reverse().find(c => pos >= c.startSec)
  if (ch) parts.push(`Current chapter: "${ch.title}".`)
  if (t.description) parts.push(`Episode description: ${truncate(t.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), 280)}`)
  if (s.pod.queue[0]) parts.push(`Up next in the queue: "${s.pod.queue[0].title}".`)
  const turns = t.transcript?.length ? t.transcript : (s.fetchedTurns ?? [])
  const window = estimatedTranscriptWindow(turns, pos, dur)
  if (window) parts.push(window)
  parts.push(MEDIA_GUIDANCE)
  return parts.join('\n')
}
