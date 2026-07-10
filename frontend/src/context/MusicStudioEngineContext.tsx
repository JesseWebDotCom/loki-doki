// Lifts the StemEngine + Metronome for one Studio project above the Mixer/Tab/Tutorials
// sub-routes (see MusicStudioLayout.tsx), so switching between them doesn't tear down and
// re-decode every stem - the same lifted-shared-player pattern as YoutubePlaybackContext, just
// scoped to /music/studio/:id/* instead of the whole app. Consumers read the engine's position
// by polling `engine.getPosition()` themselves (the same "injected getter" idiom Metronome and
// ChordTimeline already use) rather than this context re-rendering on every frame - most
// consumers (Tutorials, the layout header) don't need per-frame updates at all.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { registerMediaStop } from '@/lib/mediaCoordinator'
import { toast } from '@/lib/toast'
import { getStudioTrack, type StudioTrack } from '@/lib/music/studioApi'
import { StemEngine } from '@/lib/music/stemEngine'
import { Metronome } from '@/lib/music/metronome'

interface MusicStudioEngineCtx {
  trackId: string
  track: StudioTrack | undefined
  installed: boolean
  guitarEnhanced?: boolean
  engine: StemEngine
  metro: Metronome
  invalidate: () => Promise<void>
  /** Whether the engine has finished loading the separated stems, the original-mix preview,
   *  or neither yet - distinguishes "loading" from "engine has stale stems from a prior track"
   *  since the load is async and `engine.getStems()` alone can't tell the difference. */
  loadedMode: 'stems' | 'preview' | null
  /** Detected start of the vocals stem (once loaded) - used to line up LRCLIB lyric timing,
   *  which is timed to whatever recording it matched, not necessarily this exact audio. */
  vocalsOnsetSec: number | null
}

const Ctx = createContext<MusicStudioEngineCtx | null>(null)

export function MusicStudioEngineProvider({ trackId, children }: { trackId: string; children: ReactNode }) {
  const qc = useQueryClient()
  const loadedKeyRef = useRef<string>('')
  // StrictMode dev-mounts twice (mount → dispose → remount). The dispose-on-unmount effect
  // kills the engine, so on remount we must build a FRESH one and reset the load key.
  const engineRef = useRef<StemEngine>()
  if (!engineRef.current || engineRef.current.isDisposed()) { engineRef.current = new StemEngine(); loadedKeyRef.current = '' }
  const engine = engineRef.current

  const metroRef = useRef<Metronome>()
  if (!metroRef.current || metroRef.current.isDisposed()) metroRef.current = new Metronome(() => engineRef.current!.getPosition(), () => engineRef.current!.isPlaying())
  const metro = metroRef.current

  const { data } = useQuery({
    queryKey: ['studio-track', trackId],
    queryFn: () => getStudioTrack(trackId),
    refetchInterval: (q) => {
      const t = q.state.data?.track
      const busy = t && (t.sourceStatus === 'fetching'
        || t.analysisStatus === 'pending' || t.analysisStatus === 'analyzing'
        || t.stemStatus === 'pending' || t.stemStatus === 'separating'
        || t.lyricsAlignStatus === 'pending' || t.lyricsAlignStatus === 'aligning')
      return busy ? 3000 : false
    },
  })
  const track = data?.track
  const [loadedMode, setLoadedMode] = useState<'stems' | 'preview' | null>(null)
  const [vocalsOnsetSec, setVocalsOnsetSec] = useState<number | null>(null)

  // Tear the engine + metronome down when leaving this Studio project entirely (unmounting
  // the provider, which only happens on route change away from /music/studio/:id/*).
  useEffect(() => () => { engineRef.current?.dispose(); metroRef.current?.dispose() }, [])

  // Let a docked tutorial video (played from the Tutorials tab, same live session) pause the
  // stems automatically, and vice versa - both sides go through the shared exclusive-audio
  // registry rather than special-casing each other directly.
  useEffect(() => registerMediaStop('studio', () => engineRef.current?.pause()), [])

  // Push the analysed beat grid into the metronome.
  useEffect(() => { if (track?.beats) metro.setBeats(track.beats) }, [track?.beats, metro])

  // Feed the engine: prefer the separated stems once ready; otherwise load the original
  // source mix so the user can still press play and check the track before generating stems.
  // Guarded by a key so the same set isn't reloaded on every poll.
  useEffect(() => {
    if (!track) return
    if (track.stemStatus === 'ready' && track.stems.length > 0) {
      const key = 'stems|' + track.stems.map((s) => s.url).join('|')
      if (loadedKeyRef.current === key) return
      loadedKeyRef.current = key
      void engine.load(track.stems)
        .then(() => { setLoadedMode('stems'); setVocalsOnsetSec(engine.getVocalOnsetSec()) })
        .catch(() => toast.error('Could not load stems'))
    } else if (track.sourceStatus === 'ready') {
      const url = `/api/music/studio/${track.id}/source`
      const key = 'preview|' + url
      if (loadedKeyRef.current === key) return
      loadedKeyRef.current = key
      // No separated vocals in preview mode (single mixed "original" stem) - nothing to
      // calibrate lyrics against yet, so make sure a stale onset from a prior track is cleared.
      void engine.load([{ name: 'original', url }])
        .then(() => { setLoadedMode('preview'); setVocalsOnsetSec(null) })
        .catch(() => toast.error('Could not load audio'))
    }
  }, [track, engine])

  const invalidate = useMemo(() => () => qc.invalidateQueries({ queryKey: ['studio-track', trackId] }), [qc, trackId])

  const value = useMemo<MusicStudioEngineCtx>(() => ({
    trackId, track, installed: !!data?.installed, guitarEnhanced: data?.guitarEnhanced, engine, metro, invalidate,
    loadedMode, vocalsOnsetSec,
  }), [trackId, track, data?.installed, data?.guitarEnhanced, engine, metro, invalidate, loadedMode, vocalsOnsetSec])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStudioEngine() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useStudioEngine must be inside MusicStudioEngineProvider')
  return ctx
}
