import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Mic2, Play, Pause, SkipForward, RotateCcw, Plus, X, Search, Maximize2, Music2, GripVertical } from 'lucide-react'
import { cn } from '@/lib/cn'
import { proxyImgAuto } from '@/lib/img'
import { useRadio } from '@/context/RadioContext'
import { StemEngine } from '@/lib/music/stemEngine'
import { prepareKaraoke, getStudioTrack, getKaraokeSuggestions, type StudioTrack } from '@/lib/music/studioApi'
import { catalogSearchSongs, resolveSong, getLyrics } from '@/lib/music/catalogApi'
import { drainKaraokeSeeds, subscribeKaraoke } from '@/lib/music/karaokeQueue'
import { useAlbumPalette } from '@/lib/music/albumColors'
import { KaraokeLyrics } from '@/components/music/KaraokeLyrics'
import { Spinner } from '@/components/ui/spinner'

interface QueueItem {
  key: string
  videoId: string
  title: string
  artist: string
  durationSec: number | null
  cover?: string | null
  singer?: string
  studioId?: string
  // resolving = finding a playable source (before we have a videoId); idle = ready to prepare.
  prep: 'resolving' | 'idle' | 'preparing' | 'ready' | 'failed'
}

const VOCAL_KEY = 'music.karaokeVocalGuide'
const uid = () => Math.random().toString(36).slice(2, 9)

// Vocal-guide presets (fraction of the vocal stem mixed back in). Off = pure karaoke;
// Guide = a quiet lead to follow (masks Demucs artifacts + helps shy/young singers); Full = original.
const GUIDE_PRESETS: { label: string; v: number }[] = [
  { label: 'Off', v: 0 },
  { label: 'Guide', v: 0.18 },
  { label: 'Full', v: 1 },
]

export function KaraokePage() {
  const radio = useRadio()
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [currentIdx, setCurrentIdx] = useState(0)
  const [vocalGuide, setVocalGuide] = useState(() => {
    const raw = parseFloat(localStorage.getItem(VOCAL_KEY) ?? '')
    return Number.isFinite(raw) ? raw : 0.18
  })
  const [semitones, setSemitones] = useState(0)
  const [tempoPct, setTempoPct] = useState(100)   // 100 = original; lower = slower (pitch preserved)
  const [pos, setPos] = useState(0)
  const [, force] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  const engineRef = useRef<StemEngine | null>(null)
  if (!engineRef.current || engineRef.current.isDisposed()) engineRef.current = new StemEngine()
  const engine = engineRef.current
  const loadedKeyRef = useRef('')
  const [vocalOnset, setVocalOnset] = useState<number | null>(null)

  const current = queue[currentIdx] ?? null
  const upNext = queue.slice(currentIdx + 1)

  // Poll the current item's studio track until stems are ready.
  const { data: curTrackData } = useQuery({
    queryKey: ['karaoke-track', current?.studioId],
    queryFn: () => getStudioTrack(current!.studioId!),
    enabled: !!current?.studioId,
    refetchInterval: (q) => {
      const t = (q.state.data as { track: StudioTrack } | undefined)?.track
      if (!t) return 2000
      // Stop polling once the source failed (nothing more will happen) or stems finished AND
      // lyric alignment settled (so the view can swap to the forced-aligned lines).
      if (t.sourceStatus === 'failed' || t.stemStatus === 'failed') return false
      const stemsBusy = t.stemStatus !== 'ready'
      const alignBusy = t.lyricsAlignStatus === 'pending' || t.lyricsAlignStatus === 'aligning'
      return stemsBusy || alignBusy ? 2000 : false
    },
  })
  const curTrack = curTrackData?.track ?? null

  // Pre-prepare the current + next song (the queue is a natural prefetch buffer, so stems
  // are ready by the time the singer's turn comes).
  const ensurePrepared = useCallback(async (idx: number) => {
    setQueue((q) => {
      const it = q[idx]
      if (!it || it.prep !== 'idle' || !it.videoId) return q
      const next = [...q]; next[idx] = { ...it, prep: 'preparing' }
      // Fire the prepare outside setState.
      void prepareKaraoke({ videoId: it.videoId, title: it.title, artist: it.artist, durationSec: it.durationSec })
        .then((studioId) => setQueue((qq) => qq.map((x) => x.key === it.key ? { ...x, studioId, prep: 'preparing' } : x)))
        .catch((e) => {
          toast.error(e instanceof Error && /not installed/i.test(e.message) ? 'Karaoke needs the Music Studio component installed.' : 'Could not prepare that song')
          setQueue((qq) => qq.map((x) => x.key === it.key ? { ...x, prep: 'failed' } : x))
        })
      return next
    })
  }, [])

  useEffect(() => { if (queue[currentIdx]) void ensurePrepared(currentIdx) }, [currentIdx, queue, ensurePrepared])
  useEffect(() => { if (queue[currentIdx + 1]) void ensurePrepared(currentIdx + 1) }, [currentIdx, queue, ensurePrepared])

  // Reflect the polled stem-ready state back onto the queue item.
  useEffect(() => {
    if (!current?.studioId || !curTrack) return
    const prep = curTrack.stemStatus === 'ready' ? 'ready'
      : (curTrack.stemStatus === 'failed' || curTrack.sourceStatus === 'failed') ? 'failed'
      : 'preparing'
    if (prep !== current.prep) setQueue((q) => q.map((x) => x.key === current.key ? { ...x, prep } : x))
  }, [curTrack, current])

  // Load stems into the engine once ready. Auto-play only AFTER the user has started once -
  // the browser blocks the AudioContext from starting outside a user gesture, so the very
  // first song waits for the big Play button (which resumes the context); later songs
  // auto-advance because the context is already running.
  const startedRef = useRef(false)
  useEffect(() => {
    if (!curTrack || curTrack.stemStatus !== 'ready' || curTrack.stems.length === 0) return
    const key = 'k|' + curTrack.stems.map((s) => s.url).join('|')
    if (loadedKeyRef.current === key) return
    loadedKeyRef.current = key
    void engine.load(curTrack.stems)
      .then(() => {
        setVocalOnset(engine.getVocalOnsetSec())
        engine.setStemVolume('vocals', vocalGuide)
        engine.setSemitones(semitones)
        engine.setTempoRatio(tempoPct / 100)
        if (startedRef.current) void engine.play()
      })
      .catch(() => toast.error('Could not load the karaoke track'))
  }, [curTrack, engine, vocalGuide, semitones, tempoPct])

  // Position ticker + auto-advance at end of song. `advance` is held in a ref so the long-
  // lived rAF always calls the latest version (avoids a stale queue-length closure).
  const advanceRef = useRef<() => void>(() => {})
  useEffect(() => {
    let raf = 0
    let ended = false
    const tick = () => {
      if (engine.isPlaying()) {
        const p = engine.getPosition()
        setPos(p)
        const dur = engine.getDuration()
        if (dur > 0 && p >= dur - 0.4 && !ended) { ended = true; engine.pause(); advanceRef.current() }
        else if (p < dur - 0.4) ended = false
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    const off = engine.onChange(() => force((n) => n + 1))
    return () => { cancelAnimationFrame(raf); off() }
  }, [engine])

  useEffect(() => () => { engineRef.current?.dispose() }, [])

  // Lyrics: prefer the track's OWN forced-aligned lines (timed to this exact audio, zero
  // offset) once ready; otherwise fall back to raw LRCLIB shifted by the measured vocal onset.
  const aligned = curTrack?.lyricsAlignStatus === 'ready' && curTrack.lyrics.length > 0 ? curTrack.lyrics : null
  const { data: lyricsData } = useQuery({
    queryKey: ['music-lyrics', current?.artist ?? '', current?.title ?? '', current?.durationSec ?? undefined],
    queryFn: () => getLyrics(current!.artist, current!.title, current!.durationSec ?? undefined),
    enabled: !!current?.title && !aligned, staleTime: Infinity,
  })
  const lyricLines = aligned ?? lyricsData?.synced ?? null
  const offsetSec = useMemo(() => {
    if (aligned) return 0
    if (vocalOnset == null) return 0
    const first = lyricsData?.synced?.find((l) => l.text.trim())
    if (!first) return 0
    const d = vocalOnset - first.sec
    return d >= -5 && d <= 60 ? d : 0
  }, [aligned, vocalOnset, lyricsData])

  const artUrl = current?.videoId ? proxyImgAuto(`https://i.ytimg.com/vi/${current.videoId}/mqdefault.jpg`) : ''
  const palette = useAlbumPalette(artUrl || null)

  const advance = useCallback(() => {
    loadedKeyRef.current = ''
    setPos(0); setVocalOnset(null); setSemitones(0); setTempoPct(100)
    setCurrentIdx((i) => i + 1)
  }, [])
  advanceRef.current = advance
  const setGuide = (v: number) => { setVocalGuide(v); localStorage.setItem(VOCAL_KEY, String(v)); engine.setStemVolume('vocals', v) }
  const setKey = (n: number) => { const s = Math.max(-6, Math.min(6, n)); setSemitones(s); engine.setSemitones(s) }
  const setTempo = (pct: number) => { const p = Math.max(60, Math.min(120, Math.round(pct / 5) * 5)); setTempoPct(p); engine.setTempoRatio(p / 100) }
  // The Play button is the user gesture that unlocks the AudioContext (browsers block autoplay).
  const togglePlay = () => { startedRef.current = true; engine.toggle() }
  const restart = () => { startedRef.current = true; engine.seek(0); void engine.play() }

  const addSong = useCallback((s: QueueItem) => setQueue((q) => [...q, s]), [])
  const removeAt = (key: string) => setQueue((q) => q.filter((x) => x.key !== key))

  // Add a picked catalog song to the queue INSTANTLY (prep 'resolving'), then resolve it to a
  // playable ref in the background - so the song shows up the moment you tap it instead of after
  // a multi-second resolve. Once resolved, prep flips to 'idle' and ensurePrepared kicks in.
  const pickSong = useCallback((c: { title: string; artist: string; mbid?: string; durationSec?: number | null; cover?: string | null }) => {
    const key = uid()
    setQueue((q) => [...q, { key, videoId: '', title: c.title, artist: c.artist, durationSec: c.durationSec ?? null, cover: c.cover ?? null, prep: 'resolving' }])
    void resolveSong({ mbid: c.mbid ?? null, title: c.title, artist: c.artist, durationSec: c.durationSec ?? null })
      .then((r) => setQueue((q) => q.map((x) => x.key === key
        ? (r?.videoId ? { ...x, videoId: r.videoId, durationSec: r.durationSec ?? x.durationSec, prep: 'idle' as const } : { ...x, prep: 'failed' as const })
        : x)))
      .catch(() => setQueue((q) => q.map((x) => x.key === key ? { ...x, prep: 'failed' as const } : x)))
  }, [])

  // Seed from the currently-playing radio track, if any.
  const seedFromNowPlaying = () => {
    const t = radio.currentTrack
    if (!t) { toast.info('Nothing is playing to add'); return }
    addSong({ key: uid(), videoId: t.videoId, title: t.title, artist: t.author ?? '', durationSec: radio.durationSec || null, prep: 'idle' })
    toast.success('Added to the karaoke queue')
  }

  // Drain songs sent here from elsewhere in the app (mini player, Now Playing "Sing" button),
  // on mount and whenever another one arrives while this page is open.
  useEffect(() => {
    const pull = () => {
      const seeds = drainKaraokeSeeds()
      if (seeds.length) setQueue((q) => [...q, ...seeds.map((s) => ({ key: uid(), ...s, prep: 'idle' as const }))])
    }
    pull()
    return subscribeKaraoke(pull)
  }, [])

  const enterFullscreen = () => { rootRef.current?.requestFullscreen?.().catch(() => {}) }

  const playing = engine.isPlaying()
  const duration = engine.getDuration() || current?.durationSec || 0
  const preparing = current && current.prep !== 'ready' && current.prep !== 'failed'

  return (
    <div ref={rootRef} data-theme="dark" className="relative flex h-full min-h-0 flex-col overflow-hidden text-white"
      style={{ background: `radial-gradient(120% 100% at 50% 0%, ${palette.dark} 0%, #08080c 70%)` }}>
      {/* UltraBlur backdrop from the current cover */}
      {artUrl && (
        <div className="absolute inset-0 -z-10" aria-hidden>
          <img src={artUrl} alt="" className="size-full scale-125 object-cover opacity-30 blur-3xl saturate-150" />
          <div className="absolute inset-0" style={{ background: `linear-gradient(180deg, rgba(8,8,12,0.6), rgba(8,8,12,0.9))` }} />
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-6 py-4">
        <div className="flex items-center gap-2 text-lg font-bold"><Mic2 className="size-5" style={{ color: palette.vibrant }} /> Karaoke</div>
        <div className="flex items-center gap-2">
          <AddSongPopover onPick={pickSong} onSeedNowPlaying={seedFromNowPlaying} accent={palette.vibrant} />
          <button onClick={enterFullscreen} title="Fullscreen" className="grid size-9 place-items-center rounded-full bg-white/10 hover:bg-white/20"><Maximize2 className="size-4" /></button>
        </div>
      </div>

      {/* Stage */}
      <div className="flex min-h-0 flex-1 gap-4 px-6 pb-6">
        {/* Lyrics focal area */}
        <div className="relative flex min-w-0 flex-1 flex-col rounded-3xl bg-black/20 p-4">
          {!current ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 text-center">
              <div className="flex flex-col items-center gap-3">
                <Mic2 className="size-14 text-white/20" />
                <p className="text-2xl font-semibold text-white/50">Add songs to start the show</p>
                <p className="max-w-md text-sm text-white/30">Vocals are removed with AI so you can sing lead. Lyrics scroll big; the queue keeps the party moving.</p>
              </div>
              <KaraokeSuggestions onPick={pickSong} />
            </div>
          ) : preparing ? (() => {
            // Report the actual pipeline stage (fetch → separate → align) with its own progress,
            // instead of flip-flopping between two generic lines.
            const stage = (() => {
              if (current.prep === 'resolving') return { label: 'Finding the song', pct: null }
              if (!curTrack || curTrack.sourceStatus === 'fetching') return { label: 'Finding and downloading the track', pct: curTrack?.sourceProgress?.pct ?? null }
              if (curTrack.stemStatus === 'pending') return { label: 'Queued to remove the vocals', pct: null }
              if (curTrack.stemStatus === 'separating') return { label: 'Removing the vocals with AI', pct: curTrack.stemProgress?.pct ?? null }
              if (curTrack.lyricsAlignStatus === 'pending' || curTrack.lyricsAlignStatus === 'aligning') return { label: 'Syncing the lyrics to the vocals', pct: null }
              return { label: 'Getting things ready', pct: null }
            })()
            return (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
                <Spinner size="lg" className="text-white/70" />
                <p className="text-2xl font-semibold">Preparing “{current.title}”</p>
                <p className="text-sm text-white/60">{stage.label}{stage.pct != null ? `… ${stage.pct}%` : '…'}</p>
                {stage.pct != null && (
                  <div className="h-1.5 w-64 max-w-full overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full transition-all" style={{ width: `${stage.pct}%`, background: palette.vibrant }} />
                  </div>
                )}
                <p className="mt-2 max-w-sm text-xs text-white/35">The first time a song is prepared takes a minute or two. Add more songs now - they’ll prepare in the background so the party keeps moving.</p>
              </div>
            )
          })() : current.prep === 'failed' ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-xl font-semibold text-white/70">Couldn’t prepare “{current.title}”</p>
              <p className="max-w-sm text-sm text-white/40">
                {curTrack?.sourceError ? 'Could not get this song’s audio.' : curTrack?.stemError ? 'Vocal removal failed for this track.' : 'We couldn’t find a playable source.'}
              </p>
              <button onClick={advance} className="mt-1 rounded-full bg-white/15 px-4 py-2 text-sm hover:bg-white/25">Skip to next</button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-4 px-2">
                {artUrl
                  ? <img src={artUrl} alt="" className="size-16 rounded-xl object-cover shadow-lg ring-1 ring-white/10" />
                  : <div className="grid size-16 place-items-center rounded-xl bg-white/5"><Music2 className="size-7 text-white/30" /></div>}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xl font-bold">{current.title}</div>
                  <div className="truncate text-sm text-white/60">{current.artist}{current.singer ? ` · 🎤 ${current.singer}` : ''}</div>
                </div>
                {curTrack?.bpm ? (
                  <div className="shrink-0 rounded-xl bg-white/5 px-3 py-1.5 text-center">
                    <div className="text-lg font-bold tabular-nums" style={{ color: palette.vibrant }}>{Math.round(curTrack.bpm * (tempoPct / 100))}</div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-white/40">BPM{tempoPct !== 100 ? ` · ${tempoPct}%` : ''}</div>
                  </div>
                ) : null}
              </div>
              <KaraokeLyrics lines={lyricLines} position={pos} offsetSec={offsetSec} accent={palette.vibrant} className="flex-1" />
            </>
          )}
        </div>

        {/* Up Next rail */}
        <div className="hidden w-72 shrink-0 flex-col rounded-3xl bg-black/20 p-4 lg:flex">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-white/50">Up Next</span>
            <span className="text-xs text-white/40">{upNext.length}</span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
            {upNext.length === 0 && <p className="mt-6 text-center text-sm text-white/30">Queue is empty</p>}
            {upNext.map((it) => (
              <div key={it.key} className="group flex items-center gap-2 rounded-xl bg-white/5 p-2">
                <GripVertical className="size-4 shrink-0 text-white/20" />
                <img src={it.videoId ? proxyImgAuto(`https://i.ytimg.com/vi/${it.videoId}/mqdefault.jpg`) : proxyImgAuto(it.cover ?? '')}
                  alt="" className="size-9 shrink-0 rounded-md bg-white/5 object-cover" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{it.title}</div>
                  <div className="truncate text-xs text-white/50">{it.artist}</div>
                </div>
                {it.prep === 'ready' && <span className="shrink-0 text-[10px] font-semibold uppercase" style={{ color: palette.vibrant }}>Ready</span>}
                {it.prep === 'failed' && <span className="shrink-0 text-[10px] font-semibold uppercase text-white/40">Failed</span>}
                {(it.prep === 'resolving' || it.prep === 'preparing') && <Spinner className="size-3.5 shrink-0 text-white/40" />}
                <button onClick={() => removeAt(it.key)} className="shrink-0 text-white/30 opacity-0 transition group-hover:opacity-100 hover:text-white"><X className="size-4" /></button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Control bar */}
      <div className="flex flex-col gap-3 border-t border-white/10 bg-black/30 px-6 py-4">
        {/* Progress */}
        <div className="flex items-center gap-3 text-xs tabular-nums text-white/50">
          <span>{fmt(pos)}</span>
          <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-white/15">
            <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${duration ? Math.min(100, (pos / duration) * 100) : 0}%`, background: palette.vibrant }} />
          </div>
          <span>{duration ? fmt(duration) : '--:--'}</span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* Transport */}
          <div className="flex items-center gap-3">
            <button onClick={restart} disabled={!current || current.prep !== 'ready'} title="Restart" className="grid size-10 place-items-center rounded-full text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-30"><RotateCcw className="size-5" /></button>
            <button onClick={togglePlay} disabled={!current || current.prep !== 'ready'}
              className="grid size-14 place-items-center rounded-full bg-white text-black shadow-xl transition hover:scale-105 disabled:opacity-40" title={playing ? 'Pause' : 'Play'}>
              {playing ? <Pause className="size-6" /> : <Play className="size-6 translate-x-0.5" />}
            </button>
            <button onClick={advance} disabled={upNext.length === 0} title="Next singer" className="grid size-10 place-items-center rounded-full text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-30"><SkipForward className="size-5" /></button>
          </div>

          {/* Vocal guide */}
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-white/50">Vocal guide</span>
            <div className="flex overflow-hidden rounded-full bg-white/10">
              {GUIDE_PRESETS.map((p) => (
                <button key={p.label} onClick={() => setGuide(p.v)}
                  className={cn('px-3 py-1.5 text-xs font-medium transition', Math.abs(vocalGuide - p.v) < 0.02 ? 'text-black' : 'text-white/60 hover:text-white')}
                  style={Math.abs(vocalGuide - p.v) < 0.02 ? { background: palette.vibrant } : undefined}>{p.label}</button>
              ))}
            </div>
            <input type="range" min={0} max={1} step={0.02} value={vocalGuide} onChange={(e) => setGuide(Number(e.target.value))}
              aria-label="Vocal guide level" className="h-1 w-24 cursor-pointer" style={{ accentColor: palette.vibrant }} />
          </div>

          {/* Tempo (pitch-preserved; slow a fast rap down to keep up) */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-white/50">Tempo</span>
            <button onClick={() => setTempo(tempoPct - 5)} className="grid size-8 place-items-center rounded-full bg-white/10 text-lg hover:bg-white/20">−</button>
            <span className="w-12 text-center text-sm tabular-nums">{tempoPct}%</span>
            <button onClick={() => setTempo(tempoPct + 5)} className="grid size-8 place-items-center rounded-full bg-white/10 text-lg hover:bg-white/20">+</button>
          </div>

          {/* Key transpose */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-white/50">Key</span>
            <button onClick={() => setKey(semitones - 1)} className="grid size-8 place-items-center rounded-full bg-white/10 text-lg hover:bg-white/20">−</button>
            <span className="w-8 text-center text-sm tabular-nums">{semitones > 0 ? `+${semitones}` : semitones}</span>
            <button onClick={() => setKey(semitones + 1)} className="grid size-8 place-items-center rounded-full bg-white/10 text-lg hover:bg-white/20">+</button>
          </div>
        </div>
      </div>
    </div>
  )
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.floor(s % 60))).padStart(2, '0')}`

// Curated popular-karaoke row shown on the empty stage. Clicking a card queues it instantly.
function KaraokeSuggestions({ onPick }: { onPick: (c: { title: string; artist: string; cover?: string | null }) => void }) {
  const { data } = useQuery({ queryKey: ['karaoke-suggestions'], queryFn: getKaraokeSuggestions, staleTime: Infinity })
  if (!data?.length) return null

  return (
    <div className="w-full max-w-4xl">
      <div className="mb-2 text-left text-xs font-semibold uppercase tracking-wider text-white/40">Popular karaoke tracks</div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {data.map((s) => (
          <button key={`${s.artist}~${s.title}`} onClick={() => onPick(s)}
            className="group relative w-28 shrink-0 text-left">
            <div className="relative aspect-square w-28 overflow-hidden rounded-xl bg-white/5">
              {s.cover
                ? <img src={proxyImgAuto(s.cover)} alt="" className="size-full object-cover transition group-hover:scale-105" />
                : <div className="grid size-full place-items-center"><Music2 className="size-8 text-white/20" /></div>}
              <div className="absolute inset-0 grid place-items-center bg-black/40 opacity-0 transition group-hover:opacity-100">
                <Plus className="size-7 text-white" />
              </div>
            </div>
            <div className="mt-1.5 truncate text-xs font-medium text-white/90">{s.title}</div>
            <div className="truncate text-[11px] text-white/50">{s.artist}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

// Search-and-add popover: picking a song queues it INSTANTLY (resolve happens in the queue).
// An optional artist field scopes the search (like the Studio picker) so covers don't bury the
// real recording.
function AddSongPopover({ onPick, onSeedNowPlaying, accent }: { onPick: (c: { title: string; artist: string; mbid?: string; durationSec?: number | null }) => void; onSeedNowPlaying: () => void; accent: string }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [artist, setArtist] = useState('')
  const { data, isFetching } = useQuery({
    queryKey: ['karaoke-search', q, artist],
    queryFn: () => catalogSearchSongs(q, artist || undefined),
    enabled: q.trim().length >= 2,
  })

  const pick = (s: { title: string; artistName: string; mbid: string; durationSec: number | null }) => {
    onPick({ title: s.title, artist: s.artistName, mbid: s.mbid || undefined, durationSec: s.durationSec })
    setQ(''); setOpen(false)
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium text-black" style={{ background: accent }}>
        <Plus className="size-4" /> Add songs
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-20 w-80 rounded-2xl border border-white/10 bg-[#14141a] p-3 shadow-2xl">
          <button onClick={() => { onSeedNowPlaying(); }} className="mb-2 flex w-full items-center gap-2 rounded-lg bg-white/5 px-3 py-2 text-sm hover:bg-white/10">
            <Music2 className="size-4" /> Add what’s playing now
          </button>
          <div className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2">
            <Search className="size-4 text-white/40" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a song…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-white/30" />
            {isFetching && <Spinner className="size-3.5 text-white/40" />}
          </div>
          <div className="mt-1.5 flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2">
            <Mic2 className="size-4 text-white/40" />
            <input value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="Artist / band (optional)"
              className="w-full bg-transparent text-sm outline-none placeholder:text-white/30" />
          </div>
          <div className="mt-2 max-h-72 overflow-y-auto">
            {(data ?? []).map((s, i) => (
              <button key={s.mbid || `${s.artistName}-${s.title}-${i}`} onClick={() => pick(s)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/10">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{s.title}</div>
                  <div className="truncate text-xs text-white/50">{s.artistName}</div>
                </div>
                <Plus className="size-4 text-white/40" />
              </button>
            ))}
            {q.trim().length >= 2 && !isFetching && (data ?? []).length === 0 && (
              <p className="py-4 text-center text-sm text-white/40">No songs found</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
