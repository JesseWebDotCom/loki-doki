// Live AnalyserNode for a media element, for the EQ visualizer - the watch-page counterpart
// of the radio engines' analyser tap (radioEngine.ts / liveRadioEngine.ts). Rides the shared
// per-element graph (lib/mediaAudioGraph.ts) so it composes with useAudioBoost. The graph is
// built on the element's first 'play'/'playing' event - a gesture-adjacent moment, so the
// shared AudioContext isn't born suspended (a suspended context would SILENCE a tapped
// element). Bytes must be same-origin (our proxied/file streams are), else the tap reads
// silence - see radioEngine.ts for the cross-origin history.
import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { ensureMediaGraph } from '@/lib/mediaAudioGraph'

export function useMediaAnalyser(mediaElRef: RefObject<HTMLMediaElement | null>, enabled: boolean): () => AnalyserNode | null {
  const analyserRef = useRef<AnalyserNode | null>(null)

  useEffect(() => {
    if (!enabled) { analyserRef.current = null; return }
    const el = mediaElRef.current
    if (!el) return
    const tap = () => { analyserRef.current = ensureMediaGraph(el)?.analyser ?? null }
    el.addEventListener('play', tap)
    el.addEventListener('playing', tap)
    if (!el.paused) tap()
    return () => {
      el.removeEventListener('play', tap)
      el.removeEventListener('playing', tap)
      analyserRef.current = null
    }
  }, [mediaElRef, enabled])

  return useCallback(() => analyserRef.current, [])
}
