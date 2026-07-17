import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Mic2, Play, Pause, SkipForward, RotateCcw, Plus, X, Search, Maximize2, Minimize2, Music2, GripVertical } from 'lucide-react'
import { cn } from '@/lib/cn'
import { proxyImgAuto } from '@/lib/img'
import { useRadio } from '@/context/RadioContext'
import { StemEngine } from '@/lib/music/stemEngine'
import { prepareKaraoke, getStudioTrack, getKaraokeSuggestions, getKaraokeReady, type StudioTrack, type KaraokeReadySong } from '@/lib/music/studioApi'
import { catalogSearchSongs, resolveSong, getLyrics } from '@/lib/music/catalogApi'
import { drainKaraokeSeeds, subscribeKaraoke } from '@/lib/music/karaokeQueue'
import { isYouTubeRef } from '@/lib/music/trackRef'
import { useArtPalette } from '@/lib/artPalette'
import { useAuth } from '@/context/AuthContext'
import { useUserPreferences, patchUserPreferencesCache } from '@/hooks/useUserPreferences'
import { KaraokeLyrics } from '@/components/music/KaraokeLyrics'
import { useLyricsTranslation, LyricsLanguageMenu } from '@/components/music/LyricsTranslation'
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

const VOCAL_KEY = 'music.karaokeVocalGuide'          // legacy per-device fallback
const VOCAL_PREF_KEY = 'music.karaokeVocalLevel'     // per-user, 0-100 (user_preferences)
const QUEUE_KEY = 'music.karaokeQueue.v1'
const uid = () => Math.random().toString(36).slice(2, 9)

// Restore the queue a refresh / app restart would otherwise wipe. prep state is never
// stored: restored items re-run prepare, which the server dedups to the already-separated
// track (instant - no re-download, no second Demucs run). Items still mid-resolve (no
// videoId yet) are dropped; they never got a playable source to come back to.
function loadStoredQueue(): { items: QueueItem[]; currentIdx: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? 'null') as
      { items?: Array<Partial<QueueItem>>; currentIdx?: number } | null
    const items: QueueItem[] = (raw?.items ?? [])
      .filter((it) => typeof it?.videoId === 'string' && it.videoId && typeof it.title === 'string')
      .map((it) => ({
        key: typeof it.key === 'string' ? it.key : uid(),
        videoId: it.videoId!, title: it.title!, artist: it.artist ?? '',
        durationSec: it.durationSec ?? null, cover: it.cover ?? null,
        singer: it.singer, studioId: it.studioId, prep: 'idle',
      }))
    const currentIdx = Math.min(Math.max(0, raw?.currentIdx ?? 0), Math.max(0, items.length - 1))
    return { items, currentIdx }
  } catch {
    return { items: [], currentIdx: 0 }
  }
}

// Vocal-guide presets: how much of the ORIGINAL singer is mixed back in. Off = pure karaoke
// (you sing every word); Guide = a quiet original vocal to follow (helps when you don't know
// it cold, and masks separation artifacts); Full = the original at full volume (sing along).
const GUIDE_PRESETS: { label: string; v: number; hint: string }[] = [
  { label: 'Off', v: 0, hint: 'No original vocals - you sing everything (true karaoke)' },
  { label: 'Guide', v: 0.18, hint: 'A quiet original vocal to follow along with' },
  { label: 'Full', v: 1, hint: 'Original vocals at full volume - sing along' },
]

export function KaraokePage() {
  const radio = useRadio()
  const [queue, setQueue] = useState<QueueItem[]>(() => loadStoredQueue().items)
  const [currentIdx, setCurrentIdx] = useState(() => loadStoredQueue().currentIdx)
  // Vocal level (0-1). Pure instrumental (0) is the default; the saved per-user preference
  // wins once loaded, with the old per-device localStorage value as a legacy fallback.
  const [vocalGuide, setVocalGuide] = useState(() => {
    const raw = parseFloat(localStorage.getItem(VOCAL_KEY) ?? '')
    return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0
  })
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const prefsQuery = useUserPreferences()
  const vocalPrefLoaded = useRef(false)
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

  // Seed the vocal level from the per-user preference once it resolves (survives devices,
  // unlike the old localStorage-only value). Applied to the engine too, in case stems
  // finished loading before the preference arrived.
  useEffect(() => {
    if (vocalPrefLoaded.current) return
    if (prefsQuery.data === undefined && !prefsQuery.isError) return // still loading
    const saved = (prefsQuery.data ?? {})[VOCAL_PREF_KEY]
    if (typeof saved === 'number' && Number.isFinite(saved)) {
      const v = Math.max(0, Math.min(1, saved / 100))
      setVocalGuide(v)
      engine.setStemVolume('vocals', v)
    }
    vocalPrefLoaded.current = true
  }, [prefsQuery.data, prefsQuery.isError, engine])

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
  // are ready by the time the singer's turn comes). The prepare fires OUTSIDE the setQueue
  // updater, guarded by an in-flight ref: React runs updaters/effects twice (StrictMode,
  // re-renders), and the old fire-inside-the-updater version launched TWO prepares for one
  // song - each kicking a full download + Demucs run before the server could dedup.
  const queueRef = useRef(queue)
  queueRef.current = queue
  const inFlightPrepare = useRef(new Set<string>())
  const ensurePrepared = useCallback((idx: number) => {
    const it = queueRef.current[idx]
    if (!it || it.prep !== 'idle' || !it.videoId || inFlightPrepare.current.has(it.key)) return
    inFlightPrepare.current.add(it.key)
    setQueue((q) => q.map((x) => (x.key === it.key ? { ...x, prep: 'preparing' } : x)))
    prepareKaraoke({ videoId: it.videoId, title: it.title, artist: it.artist, durationSec: it.durationSec })
      // The poll may have already flipped a reused track to 'ready' - don't downgrade it.
      .then((studioId) => setQueue((qq) => qq.map((x) => x.key === it.key ? { ...x, studioId, prep: x.prep === 'ready' ? 'ready' : 'preparing' } : x)))
      .catch((e) => {
        toast.error(e instanceof Error && /not installed/i.test(e.message) ? 'Karaoke needs the Music Studio component installed.' : 'Could not prepare that song')
        setQueue((qq) => qq.map((x) => (x.key === it.key ? { ...x, prep: 'failed' } : x)))
      })
      .finally(() => inFlightPrepare.current.delete(it.key))
  }, [])

  useEffect(() => { if (queue[currentIdx]) ensurePrepared(currentIdx) }, [currentIdx, queue, ensurePrepared])
  useEffect(() => { if (queue[currentIdx + 1]) ensurePrepared(currentIdx + 1) }, [currentIdx, queue, ensurePrepared])

  // Persist the queue so a refresh or app restart doesn't lose the party (see loadStoredQueue).
  useEffect(() => {
    const items = queue.map(({ key, videoId, title, artist, durationSec, cover, singer, studioId }) =>
      ({ key, videoId, title, artist, durationSec, cover, singer, studioId }))
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify({ items, currentIdx })) } catch { /* quota */ }
  }, [queue, currentIdx])

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

  // Safari refuses to start an AudioContext first created outside a user gesture (our load
  // effect). Unlock it on the first pointer/key interaction anywhere on the page so playback
  // works when the singer hits Play.
  useEffect(() => {
    const unlock = () => engine.unlock()
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock) }
  }, [engine])

  // Lyrics: prefer the track's OWN forced-aligned lines (timed to this exact audio, zero
  // offset) once ready; otherwise fall back to raw LRCLIB shifted by the measured vocal onset.
  const aligned = curTrack?.lyricsAlignStatus === 'ready' && curTrack.lyrics.length > 0 ? curTrack.lyrics : null
  const { data: lyricsData } = useQuery({
    queryKey: ['music-lyrics', current?.artist ?? '', current?.title ?? '', current?.durationSec ?? undefined],
    queryFn: () => getLyrics(current!.artist, current!.title, current!.durationSec ?? undefined),
    enabled: !!current?.title && !aligned, staleTime: Infinity,
  })
  const lyricLines = aligned ?? lyricsData?.synced ?? null
  // Translation + pronunciation overlay for the lyric lines (per-user language pref).
  const translation = useLyricsTranslation(current?.artist ?? '', current?.title ?? '', lyricLines)
  const offsetSec = useMemo(() => {
    if (aligned) return 0
    if (vocalOnset == null) return 0
    const first = lyricsData?.synced?.find((l) => l.text.trim())
    if (!first) return 0
    const d = vocalOnset - first.sec
    return d >= -5 && d <= 60 ? d : 0
  }, [aligned, vocalOnset, lyricsData])

  // Cover: the studio track's own art first (works for any source incl. owned Plex/local),
  // then the suggestion cover, then a YouTube thumbnail only for real YouTube refs (a plex:/
  // local: ref would make a broken i.ytimg URL - that was the "no images" bug).
  const artUrl = curTrack?.coverUrl
    ? curTrack.coverUrl
    : current?.cover
      ? proxyImgAuto(current.cover)
      : current?.videoId && isYouTubeRef(current.videoId)
        ? proxyImgAuto(`https://i.ytimg.com/vi/${current.videoId}/mqdefault.jpg`)
        : ''
  const palette = useArtPalette(artUrl || null)

  const advance = useCallback(() => {
    loadedKeyRef.current = ''
    setPos(0); setVocalOnset(null); setSemitones(0); setTempoPct(100)
    setCurrentIdx((i) => i + 1)
  }, [])
  advanceRef.current = advance
  // Persist per user (0-100 in user_preferences) so the level follows the singer across
  // devices; localStorage stays as a first-paint fallback for signed-out edge cases.
  const setGuide = (v: number) => {
    setVocalGuide(v)
    localStorage.setItem(VOCAL_KEY, String(v))
    engine.setStemVolume('vocals', v)
    vocalPrefLoaded.current = true // a manual change always wins over a late pref load
    if (user?.id) {
      const pct = Math.round(v * 100)
      patchUserPreferencesCache(queryClient, user.id, { [VOCAL_PREF_KEY]: pct })
      void fetch(`/api/users/${user.id}/preferences`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [VOCAL_PREF_KEY]: pct }),
      }).catch(() => {})
    }
  }
  const setKey = (n: number) => { const s = Math.max(-6, Math.min(6, n)); setSemitones(s); engine.setSemitones(s) }
  const setTempo = (pct: number) => { const p = Math.max(60, Math.min(120, Math.round(pct / 5) * 5)); setTempoPct(p); engine.setTempoRatio(p / 100) }
  // The Play button is the user gesture that unlocks the AudioContext (browsers block autoplay).
  const togglePlay = () => { startedRef.current = true; engine.unlock(); engine.toggle() }
  const restart = () => { startedRef.current = true; engine.unlock(); engine.seek(0); void engine.play() }

  const addSong = useCallback((s: QueueItem) => setQueue((q) => [...q, s]), [])
  const removeAt = (key: string) => setQueue((q) => q.filter((x) => x.key !== key))

  // One tap for an already-separated song: its stems are on the server, so queueing it is
  // instant (prepare re-finds the existing track - no download, no second Demucs run).
  const addReady = useCallback((s: KaraokeReadySong) => {
    addSong({
      key: uid(), videoId: s.videoId ?? '', title: s.title, artist: s.artist ?? '',
      durationSec: s.durationSec, cover: s.coverUrl, studioId: s.id,
      // No stored source ref (old row) → prepare can't run; the poll on studioId still
      // drives it to 'ready' once it's the current song.
      prep: s.videoId ? 'idle' : 'preparing',
    })
  }, [addSong])

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

  const [isFullscreen, setIsFullscreen] = useState(false)
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else rootRef.current?.requestFullscreen?.().catch(() => {})
  }

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
          <LyricsLanguageMenu state={translation} tone="stage" />
          <AddSongPopover onPick={pickSong} onPickReady={addReady} onSeedNowPlaying={seedFromNowPlaying} accent={palette.vibrant} />
          <button onClick={toggleFullscreen} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'} className="grid size-9 place-items-center rounded-full bg-white/10 hover:bg-white/20">
            {isFullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
        </div>
      </div>

      {/* Stage */}
      <div className="flex min-h-0 flex-1 gap-4 px-6 pb-6">
        {/* Lyrics focal area */}
        <div className="relative flex min-w-0 flex-1 flex-col rounded-3xl bg-black/20 p-4">
          {!current ? (
            // min-h-0 + overflow-y-auto: the ready rail + suggestions can be taller than the
            // stage, and un-clipped flex content just paints on under the control bar. The
            // m-auto wrapper (not justify-center) keeps the group centered when it fits while
            // still letting the top scroll into view when it doesn't.
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 text-center">
              <div className="m-auto flex w-full flex-col items-center gap-6 py-4">
                <div className="flex flex-col items-center gap-3">
                  <Mic2 className="size-14 text-white/20" />
                  <p className="text-2xl font-semibold text-white/50">Add songs to start the show</p>
                  <p className="max-w-md text-sm text-white/30">Vocals are removed with AI so you can sing lead. Lyrics scroll big; the queue keeps the party moving.</p>
                </div>
                <KaraokeReadyRail onPick={addReady} />
                <KaraokeSuggestions onPick={pickSong} />
              </div>
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
              </div>
              <KaraokeLyrics lines={lyricLines} position={pos} offsetSec={offsetSec} accent={palette.vibrant} className="flex-1"
                secondary={translation.secondary} showRoman={translation.showRoman} />
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
                <img src={it.cover ? proxyImgAuto(it.cover) : (it.videoId && isYouTubeRef(it.videoId) ? proxyImgAuto(`https://i.ytimg.com/vi/${it.videoId}/mqdefault.jpg`) : '')}
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

          {/* Vocal guide: how much of the original singer to mix back in (off = pure karaoke) */}
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-white/50"
              title="How much of the original singer you hear. Off = sing it all yourself; Guide = a quiet lead to follow; Full = sing along to the original.">Vocal guide</span>
            <div className="flex overflow-hidden rounded-full bg-white/10">
              {GUIDE_PRESETS.map((p) => (
                <button key={p.label} onClick={() => setGuide(p.v)} title={p.hint}
                  className={cn('px-3 py-1.5 text-xs font-medium transition', Math.abs(vocalGuide - p.v) < 0.02 ? 'text-black' : 'text-white/60 hover:text-white')}
                  style={Math.abs(vocalGuide - p.v) < 0.02 ? { background: palette.vibrant } : undefined}>{p.label}</button>
              ))}
            </div>
            <input type="range" min={0} max={1} step={0.01} value={vocalGuide} onChange={(e) => setGuide(Number(e.target.value))}
              aria-label="Vocal level" title="Fine-tune how loud the original vocal is (0% = pure instrumental)" className="h-1 w-24 cursor-pointer" style={{ accentColor: palette.vibrant }} />
            <span className="w-9 text-right text-xs tabular-nums text-white/60">{Math.round(vocalGuide * 100)}%</span>
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

// Songs already stem-separated on the server (they survive restarts and refreshes) - one
// tap re-queues them and they're ready to sing immediately.
function KaraokeReadyRail({ onPick }: { onPick: (s: KaraokeReadySong) => void }) {
  const { data } = useQuery({ queryKey: ['karaoke-ready'], queryFn: getKaraokeReady, staleTime: 60_000 })
  if (!data?.length) return null

  return (
    <div className="w-full max-w-4xl">
      <div className="mb-2 text-left text-xs font-semibold uppercase tracking-wider text-white/40">Sing again - already prepared, starts instantly</div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {data.map((s) => (
          <button key={s.id} onClick={() => onPick(s)} className="group relative w-28 shrink-0 text-left">
            <div className="relative aspect-square w-28 overflow-hidden rounded-xl bg-white/5">
              {s.coverUrl
                ? <img src={s.coverUrl} alt="" className="size-full object-cover transition group-hover:scale-105" />
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
function AddSongPopover({ onPick, onPickReady, onSeedNowPlaying, accent }: { onPick: (c: { title: string; artist: string; mbid?: string; durationSec?: number | null }) => void; onPickReady: (s: KaraokeReadySong) => void; onSeedNowPlaying: () => void; accent: string }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [artist, setArtist] = useState('')
  const { data, isFetching } = useQuery({
    queryKey: ['karaoke-search', q, artist],
    queryFn: () => catalogSearchSongs(q, artist || undefined),
    enabled: q.trim().length >= 2,
  })
  const { data: ready } = useQuery({ queryKey: ['karaoke-ready'], queryFn: getKaraokeReady, staleTime: 60_000 })

  const pick = (s: { title: string; artistName: string; mbid: string; durationSec: number | null }) => {
    onPick({ title: s.title, artist: s.artistName, mbid: s.mbid || undefined, durationSec: s.durationSec })
    setQ(''); setOpen(false)
  }
  const pickReady = (s: KaraokeReadySong) => { onPickReady(s); setOpen(false) }

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
          {!!ready?.length && (
            <div className="mb-2">
              <div className="mb-1 px-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/40">Ready to sing - starts instantly</div>
              <div className="max-h-40 overflow-y-auto">
                {ready.map((s) => (
                  <button key={s.id} onClick={() => pickReady(s)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/10">
                    {s.coverUrl
                      ? <img src={s.coverUrl} alt="" className="size-7 shrink-0 rounded-md object-cover" />
                      : <div className="grid size-7 shrink-0 place-items-center rounded-md bg-white/5"><Music2 className="size-3.5 text-white/30" /></div>}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{s.title}</div>
                      <div className="truncate text-xs text-white/50">{s.artist}</div>
                    </div>
                    <span className="shrink-0 text-[10px] font-semibold uppercase" style={{ color: accent }}>Ready</span>
                  </button>
                ))}
              </div>
            </div>
          )}
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
