// Path A renderer for `audio` blocks (MaiPai FM, Live Radio, Podcast Network, Originals):
// a hidden same-origin <audio> element feeding the shared AudioVisualizer, with the
// artwork and program title as the on-screen picture.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Volume2 } from 'lucide-react'
import { AudioVisualizer } from '@/components/shared/AudioVisualizer'
import { TvSlate } from '@/components/maipaitv/TvSlate'
import { useMediaAnalyser } from '@/hooks/use-media-analyser'
import { paletteFromColors } from '@/lib/artPalette'
import { streamSrcForRef } from '@/lib/music/trackRef'
import { tvGlyph, type TvBlock, type TvChannel } from '@/lib/maipaitv/api'

interface QueueTrack { videoId: string; title: string; artist?: string | null }

interface TvAudioRendererProps {
  channel: TvChannel
  block: TvBlock
  suspended: boolean
}

export function TvAudioRenderer({ channel, block, suspended }: TvAudioRendererProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [trackIndex, setTrackIndex] = useState(0)
  const [needsTap, setNeedsTap] = useState(false)
  const [failed, setFailed] = useState(false)
  const errorStreak = useRef(0)
  const payload = block.payload
  const getAnalyser = useMediaAnalyser(audioRef, true)
  const palette = useMemo(() => paletteFromColors(channel.color, channel.colorDark), [channel.color, channel.colorDark])
  const Glyph = tvGlyph(channel.glyph)

  // Station blocks: pull a queue from the station generator once per block.
  const stationQuery = useQuery({
    queryKey: ['tv-station-queue', payload.src === 'station' ? payload.stationId : null, block.id],
    enabled: payload.src === 'station',
    staleTime: Infinity,
    queryFn: async () => {
      if (payload.src !== 'station') return [] as QueueTrack[]
      const r = await fetch('/api/music/stations/queue', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stationId: payload.stationId }),
      })
      if (!r.ok) throw new Error('Station unavailable')
      const data = await r.json() as { tracks: QueueTrack[] }
      return data.tracks
    },
  })

  // Live-radio blocks: play the household's first saved live station.
  const liveQuery = useQuery({
    queryKey: ['tv-live-radio-station'],
    enabled: payload.src === 'live-radio',
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const r = await fetch('/api/music/radio/live/library', { credentials: 'include' })
      if (!r.ok) throw new Error('No live radio stations')
      const data = await r.json() as { stations: Array<{ id: string; name: string }> }
      return data.stations[0] ?? null
    },
  })

  const tracks = stationQuery.data ?? []
  const currentTrack = payload.src === 'station' ? tracks[trackIndex % Math.max(1, tracks.length)] : null

  const { src, nowLine, subLine } = useMemo(() => {
    if (payload.src === 'podcast') {
      return {
        src: `/api/podcasts/episodes/${encodeURIComponent(payload.episodeId)}/stream`,
        nowLine: block.subtitle ?? block.title,
        subLine: payload.showTitle ?? block.title,
      }
    }
    if (payload.src === 'live-radio') {
      const st = liveQuery.data
      return {
        src: st ? `/api/music/radio/live/stream/${encodeURIComponent(st.id)}` : null,
        nowLine: st?.name ?? 'Live Radio',
        subLine: block.title,
      }
    }
    if (payload.src === 'station' && currentTrack) {
      return {
        src: streamSrcForRef(currentTrack.videoId),
        nowLine: currentTrack.title,
        subLine: currentTrack.artist ?? payload.stationName,
      }
    }
    return { src: null, nowLine: block.title, subLine: block.subtitle }
  }, [payload, currentTrack, liveQuery.data, block.title, block.subtitle])

  useEffect(() => { setFailed(false); errorStreak.current = 0; setTrackIndex(0) }, [block.id])

  // A one-track queue wraps onto itself: the src string never changes, so the play
  // effect will not re-run. Restart the same track explicitly.
  const advanceTrack = () => {
    const audio = audioRef.current
    if (tracks.length <= 1) {
      if (audio) { audio.currentTime = 0; void audio.play().catch(() => {}) }
      return
    }
    setTrackIndex((i) => i + 1)
  }

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !src) return
    if (suspended) { audio.pause(); return }
    const attempt = audio.play()
    if (attempt) {
      attempt.catch(() => setNeedsTap(true))
    }
    // Podcasts join at the broadcast offset; radio and station tracks start live/fresh.
    if (payload.src === 'podcast') {
      const offset = Math.max(0, (Date.now() - block.startAt) / 1000)
      const seek = () => { if (offset > 5) audio.currentTime = offset }
      audio.addEventListener('loadedmetadata', seek, { once: true })
      return () => audio.removeEventListener('loadedmetadata', seek)
    }
  }, [src, suspended, payload.src, block.startAt, block.id])

  const waiting = (payload.src === 'station' && stationQuery.isLoading) || (payload.src === 'live-radio' && liveQuery.isLoading)
  if (failed || (!waiting && !src)) {
    return <TvSlate channel={channel} headline={block.title} message={failed ? 'This audio source is not reachable right now.' : 'No audio source is available for this block yet.'} />
  }

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{ background: `radial-gradient(ellipse at bottom, ${channel.colorDark} 0%, black 80%)` }}
    >
      <div className="absolute inset-0 opacity-90">
        <AudioVisualizer variant="aurora" mode="full" getAnalyser={getAnalyser} palette={palette} active={!suspended} />
      </div>
      <div className="absolute inset-x-0 bottom-0 z-10 flex items-end gap-4 p-6 pb-[max(1.5rem,calc(var(--bottom-chrome,0px)+1rem))]">
        {block.art ? (
          <img src={block.art} alt="" decoding="async" className="size-24 rounded-card object-cover shadow-2xl sm:size-28" />
        ) : (
          <div
            className="flex size-24 items-center justify-center rounded-card shadow-2xl sm:size-28"
            style={{ background: `linear-gradient(135deg, ${channel.color}, ${channel.colorDark})` }}
          >
            <Glyph className="size-10 text-white" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-white/50">{channel.name}</p>
          <p className="truncate text-2xl font-extrabold text-white">{nowLine}</p>
          {subLine ? <p className="truncate text-sm text-white/60">{subLine}</p> : null}
        </div>
      </div>
      {needsTap ? (
        <button
          type="button"
          onClick={() => {
            const audio = audioRef.current
            if (audio) void audio.play()
            setNeedsTap(false)
          }}
          className="absolute left-1/2 top-6 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-sm font-semibold text-white backdrop-blur hover:bg-black/80"
        >
          <Volume2 className="size-4" />
          Tap to listen
        </button>
      ) : null}
      <audio
        ref={audioRef}
        src={src ?? undefined}
        onPlaying={() => { errorStreak.current = 0 }}
        onEnded={() => { if (payload.src === 'station') advanceTrack() }}
        onError={() => {
          if (payload.src !== 'station') { setFailed(true); return }
          // Skip broken tracks, but latch the failure slate after a full silent lap
          // around the queue so a dead stream endpoint cannot spin error->advance.
          errorStreak.current += 1
          if (errorStreak.current > Math.max(2, tracks.length)) setFailed(true)
          else setTimeout(advanceTrack, 1500)
        }}
      />
    </div>
  )
}
