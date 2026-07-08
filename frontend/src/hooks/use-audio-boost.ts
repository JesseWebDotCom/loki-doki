// Lets a quiet <video>/<audio> element be amplified past its native 100% volume - useful for
// phone-recorded clips that were captured too soft. Rides the shared per-element Web-Audio
// graph (lib/mediaAudioGraph.ts: source → gain → destination + analyser tap) so it composes
// with the EQ visualizer instead of fighting it for the element's single allowed
// createMediaElementSource. Nothing is built until setBoost is first invoked from a user
// gesture (autoplay policy), never on mount.
import { useCallback, useState, type RefObject } from 'react'
import { ensureMediaGraph } from '@/lib/mediaAudioGraph'

const MAX_BOOST = 4

export function useAudioBoost(mediaElRef: RefObject<HTMLMediaElement | null>) {
  const [boost, setBoostState] = useState(1)

  const setBoost = useCallback((value: number) => {
    const clamped = Math.max(1, Math.min(MAX_BOOST, value))
    const el = mediaElRef.current
    const graph = el ? ensureMediaGraph(el) : null
    if (graph) graph.gain.gain.value = clamped
    setBoostState(clamped)
  }, [mediaElRef])

  return { boost, setBoost }
}
