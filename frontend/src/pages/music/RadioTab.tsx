import { useCallback, useRef, useState } from 'react'
import { Play, Pause, SkipForward, Mic, Volume2, VolumeX, Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { search as ytSearch, ytImageProxy } from '@/lib/youtube/api'
import { fetchDjSegment, base64WavToBlob } from '@/lib/music/radio'

interface DjStation {
  id: string
  label: string
  genre: string
  ytQuery: string
  emoji: string
  color: string
  colorDark: string
}

const DJ_STATIONS: DjStation[] = [
  { id: 'pop',       label: 'Pop Hits',      genre: 'pop',       ytQuery: 'pop hits 2024 official music video',          emoji: '🎤', color: '#ec4899', colorDark: '#db2777' },
  { id: 'rock',      label: 'Rock Classics', genre: 'rock',      ytQuery: 'classic rock hits official music video',       emoji: '🎸', color: '#f97316', colorDark: '#dc2626' },
  { id: 'hiphop',    label: 'Hip-Hop',       genre: 'hip-hop',   ytQuery: 'hip hop rap official video 2024',             emoji: '🎧', color: '#a855f7', colorDark: '#7c3aed' },
  { id: 'jazz',      label: 'Jazz Café',     genre: 'jazz',      ytQuery: 'jazz music live performance classics',         emoji: '🎷', color: '#3b82f6', colorDark: '#1d4ed8' },
  { id: 'electronic',label: 'Electronic',    genre: 'electronic',ytQuery: 'electronic dance music official video',        emoji: '🎛️', color: '#06b6d4', colorDark: '#0284c7' },
  { id: 'country',   label: 'Country',       genre: 'country',   ytQuery: 'country music official video hits',           emoji: '🤠', color: '#84cc16', colorDark: '#16a34a' },
  { id: 'rnb',       label: 'R&B Soul',      genre: 'r&b',       ytQuery: 'r&b soul music official video',               emoji: '🎵', color: '#f43f5e', colorDark: '#be123c' },
  { id: 'metal',     label: 'Heavy Metal',   genre: 'metal',     ytQuery: 'heavy metal rock official music video',        emoji: '⚡', color: '#6b7280', colorDark: '#374151' },
]

interface QueuedTrack {
  videoId: string
  title: string
  author: string | null
  thumbnail: string
}

type PlayerState = 'idle' | 'loading_tracks' | 'dj_intro' | 'playing' | 'dj_transition' | 'dj_outro'

function WaveBar({ active, color }: { active: boolean; color: string }) {
  return (
    <div className={cn('flex items-end gap-[2px] transition-opacity', active ? 'opacity-100' : 'opacity-0')}>
      {[3, 5, 4, 6, 3, 5, 3].map((h, i) => (
        <div key={i} className="w-[2.5px] rounded-full"
          style={{ height: `${h * 2}px`, background: color,
            animation: active ? `wave 0.8s ease-in-out ${i * 0.1}s infinite alternate` : 'none' }} />
      ))}
      <style>{`@keyframes wave{from{transform:scaleY(0.3)}to{transform:scaleY(1)}}`}</style>
    </div>
  )
}

export function RadioTab() {
  const [station, setStation] = useState<DjStation | null>(null)
  const [queue, setQueue] = useState<QueuedTrack[]>([])
  const [queueIndex, setQueueIndex] = useState(0)
  const [playerState, setPlayerState] = useState<PlayerState>('idle')
  const [djText, setDjText] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const djAudioRef = useRef<HTMLAudioElement | null>(null)
  const trackAudioRef = useRef<HTMLAudioElement | null>(null)

  const currentTrack = queue[queueIndex] ?? null
  const nextTrack = queue[queueIndex + 1] ?? null

  async function loadQueue(st: DjStation) {
    setPlayerState('loading_tracks')
    setQueue([]); setQueueIndex(0); setDjText(null)
    try {
      const data = await ytSearch(st.ytQuery, null, 'videos')
      const tracks: QueuedTrack[] = (data.results ?? []).slice(0, 10).map(v => ({
        videoId: v.videoId,
        title: v.title,
        author: v.author ?? null,
        thumbnail: ytImageProxy(`https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`),
      }))
      setQueue(tracks)
      return tracks
    } catch { setPlayerState('idle'); return [] }
  }

  async function playDjSegment(params: Parameters<typeof fetchDjSegment>[0]): Promise<void> {
    const seg = await fetchDjSegment(params)
    if (!seg) return
    setDjText(seg.text)
    if (seg.audio && djAudioRef.current) {
      const blob = base64WavToBlob(seg.audio, seg.audioMime)
      const url = URL.createObjectURL(blob)
      const el = djAudioRef.current
      el.src = url; el.volume = volume; el.muted = muted
      await new Promise<void>((resolve) => {
        el.onended = () => { URL.revokeObjectURL(url); resolve() }
        el.onerror = () => { URL.revokeObjectURL(url); resolve() }
        el.play().catch(resolve)
      })
    } else if (seg.text && 'speechSynthesis' in window) {
      await new Promise<void>((resolve) => {
        const utt = new SpeechSynthesisUtterance(seg.text)
        utt.onend = () => resolve(); utt.onerror = () => resolve()
        window.speechSynthesis.speak(utt)
      })
    } else {
      await new Promise((r) => setTimeout(r, 3000))
    }
  }

  const playTrack = useCallback((track: QueuedTrack, vol: number, mut: boolean) => {
    return new Promise<void>((resolve) => {
      const el = trackAudioRef.current
      if (!el) { resolve(); return }
      el.src = `/api/youtube/stream/${track.videoId}?kind=audio`
      el.volume = vol; el.muted = mut; el.load()
      const cleanup = () => { el.onended = null; el.onerror = null; resolve() }
      el.onended = cleanup; el.onerror = cleanup
      el.play().catch(cleanup)
    })
  }, [])

  async function startStation(st: DjStation) {
    setStation(st)
    const tracks = await loadQueue(st)
    if (!tracks.length) return
    setPlayerState('dj_intro')
    await playDjSegment({ genre: st.genre, trackName: tracks[0].title, artistName: tracks[0].author ?? undefined, position: 'intro' })
    let idx = 0
    while (idx < tracks.length) {
      const track = tracks[idx]!
      setQueueIndex(idx); setDjText(null); setPlayerState('playing')
      await playTrack(track, volume, muted)
      const next = tracks[idx + 1]
      if (next) {
        setPlayerState('dj_transition')
        await playDjSegment({ genre: st.genre, trackName: track.title, artistName: track.author ?? undefined, nextTrackName: next.title, nextArtistName: next.author ?? undefined, position: 'transition' })
      }
      idx++
    }
    setPlayerState('dj_outro')
    const last = tracks[tracks.length - 1]
    await playDjSegment({ genre: st.genre, trackName: last?.title, artistName: last?.author ?? undefined, position: 'outro' })
    setPlayerState('idle'); setDjText(null)
  }

  function stop() {
    djAudioRef.current?.pause(); trackAudioRef.current?.pause()
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    setStation(null); setQueue([]); setQueueIndex(0); setPlayerState('idle'); setDjText(null)
  }

  function skip() {
    const el = trackAudioRef.current
    if (el) { el.src = ''; el.load() }
  }

  function onVolumeChange(v: number) {
    setVolume(v)
    if (djAudioRef.current) djAudioRef.current.volume = v
    if (trackAudioRef.current) trackAudioRef.current.volume = v
    if (v > 0 && muted) setMuted(false)
  }

  function toggleMute() {
    const next = !muted; setMuted(next)
    if (djAudioRef.current) djAudioRef.current.muted = next
    if (trackAudioRef.current) trackAudioRef.current.muted = next
  }

  const isDjSpeaking = playerState === 'dj_intro' || playerState === 'dj_transition' || playerState === 'dj_outro'
  const isActive = station !== null && playerState !== 'idle'

  return (
    <div className="space-y-6">
      <audio ref={djAudioRef} />
      <audio ref={trackAudioRef} />

      {/* Station grid (idle state) */}
      {!isActive && (
        <div className="space-y-4">
          <div>
            <p className="text-sm font-semibold tracking-tight">AI Radio Stations</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Your companion hosts — introduces songs and shares news between tracks.</p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {DJ_STATIONS.map((st) => (
              <button key={st.id} type="button"
                onClick={() => void startStation(st)}
                disabled={playerState === 'loading_tracks'}
                className="group relative flex aspect-square flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl p-4 transition-transform hover:scale-[1.03] active:scale-[0.98] disabled:opacity-60"
                style={{ background: `linear-gradient(135deg, ${st.color}, ${st.colorDark})` }}>
                <div className="absolute inset-0 bg-black/10 opacity-0 group-hover:opacity-100 transition-opacity" />
                <span className="relative text-4xl drop-shadow-sm">{st.emoji}</span>
                <span className="relative font-bold text-white text-sm drop-shadow">{st.label}</span>
                {playerState === 'loading_tracks' && station?.id === st.id && (
                  <Loader2 className="absolute bottom-3 right-3 size-4 animate-spin text-white/70" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Active station player */}
      {isActive && station && (
        <div className="space-y-4">
          {/* Hero card */}
          <div className="relative overflow-hidden rounded-2xl"
            style={{ background: `linear-gradient(135deg, ${station.color}, ${station.colorDark})` }}>
            <div className="absolute inset-0 bg-black/20" />

            {/* On Air bar */}
            <div className="relative flex items-center justify-between px-4 pt-4">
              <div className="flex items-center gap-2">
                <span className="inline-flex size-2 animate-pulse rounded-full bg-white" />
                <span className="text-xs font-bold uppercase tracking-widest text-white/80">On Air</span>
              </div>
              <button type="button" onClick={stop}
                className="rounded-full border border-white/25 px-3 py-1 text-xs font-medium text-white/80 hover:bg-white/10 hover:text-white transition-colors">
                Stop
              </button>
            </div>

            {/* Main content */}
            <div className="relative flex items-center gap-4 p-4">
              <div className="flex size-20 shrink-0 items-center justify-center rounded-2xl bg-white/15 text-5xl">
                {station.emoji}
              </div>
              <div className="min-w-0 flex-1 text-white">
                <p className="text-xl font-bold leading-tight">{station.label}</p>
                <p className="text-sm capitalize text-white/60">{station.genre}</p>
                {playerState === 'loading_tracks' && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-white/70">
                    <Loader2 className="size-3.5 animate-spin" /> Loading tracks…
                  </div>
                )}
                {playerState === 'playing' && <WaveBar active color="rgba(255,255,255,0.9)" />}
              </div>
            </div>

            {/* DJ speaking */}
            {isDjSpeaking && (
              <div className="relative mx-4 mb-4 rounded-xl bg-black/20 p-3">
                <div className="mb-1.5 flex items-center gap-2">
                  <Mic className="size-3.5 text-white/80" />
                  <span className="text-xs font-bold text-white/80">DJ Speaking…</span>
                </div>
                {djText && <p className="text-xs italic leading-relaxed text-white/70">&ldquo;{djText}&rdquo;</p>}
              </div>
            )}

            {/* Current track */}
            {currentTrack && playerState === 'playing' && (
              <div className="relative mx-4 mb-4 flex items-center gap-3 rounded-xl bg-black/20 p-3">
                <img src={currentTrack.thumbnail} alt={currentTrack.title}
                  className="h-14 w-[88px] shrink-0 rounded-lg object-cover" />
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-white/50 mb-0.5">Now Playing</p>
                  <p className="truncate text-sm font-semibold text-white">{currentTrack.title}</p>
                  {currentTrack.author && <p className="truncate text-xs text-white/60">{currentTrack.author}</p>}
                </div>
              </div>
            )}

            {/* Controls */}
            <div className="relative flex items-center gap-3 px-4 pb-4">
              <button type="button" onClick={toggleMute} className="text-white/70 hover:text-white transition-colors">
                {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
              </button>
              <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume}
                onChange={(e) => onVolumeChange(Number(e.target.value))}
                className="h-1 flex-1 accent-white opacity-80" />
              <button type="button" onClick={skip} disabled={playerState !== 'playing'}
                className="flex items-center gap-1.5 rounded-full border border-white/25 px-3 py-1 text-xs font-medium text-white/80 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-40">
                <SkipForward className="size-3.5" /> Skip
              </button>
            </div>
          </div>

          {/* Queue */}
          {queue.length > 0 && (
            <div className="rounded-2xl border border-border bg-card/40 overflow-hidden">
              <p className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">Up Next</p>
              <div className="max-h-52 overflow-y-auto">
                {queue.slice(queueIndex + 1, queueIndex + 6).map((t, i) => (
                  <div key={t.videoId} className="flex items-center gap-3 border-t border-border/40 px-4 py-2.5">
                    <span className="w-4 shrink-0 text-center text-xs text-muted-foreground/60">{i + 1}</span>
                    <img src={t.thumbnail} alt="" className="h-9 w-[56px] shrink-0 rounded-lg object-cover" />
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium">{t.title}</p>
                      {t.author && <p className="truncate text-[11px] text-muted-foreground">{t.author}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Change station */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Change Station</p>
            <div className="flex flex-wrap gap-2">
              {DJ_STATIONS.filter(s => s.id !== station.id).map((st) => (
                <button key={st.id} type="button" onClick={() => void startStation(st)}
                  className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-all hover:border-transparent hover:text-white"
                  style={{ ['--hover-bg' as string]: st.color }}>
                  <span>{st.emoji}</span> {st.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
