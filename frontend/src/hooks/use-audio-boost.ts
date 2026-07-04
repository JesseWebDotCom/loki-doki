// Lets a quiet <video>/<audio> element be amplified past its native 100% volume — useful for
// phone-recorded clips that were captured too soft. Builds source → GainNode → destination on
// top of Web Audio.
//
// createMediaElementSource can only be called ONCE per media element, ever, across every
// AudioContext — a second call throws — so the element is tapped at most once (guarded by a
// WeakSet) and the graph is never torn down, exactly like radioEngine.ts's analyser tap. The
// AudioContext itself must be created/resumed inside a user gesture (autoplay policy), so
// nothing here runs until the caller's setBoost is first invoked from one (e.g. touching the
// boost control), never on mount.
import { useCallback, useRef, useState, type RefObject } from 'react'

const MAX_BOOST = 4

const tapped = new WeakSet<HTMLMediaElement>()

export function useAudioBoost(mediaElRef: RefObject<HTMLMediaElement | null>) {
  const [boost, setBoostState] = useState(1)
  const actxRef = useRef<AudioContext | null>(null)
  const gainRef = useRef<GainNode | null>(null)

  const ensureGraph = useCallback(() => {
    const el = mediaElRef.current
    if (!el || gainRef.current) return
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      const actx = actxRef.current ?? new Ctor()
      actxRef.current = actx
      void actx.resume?.()
      if (tapped.has(el)) return // already sourced by something else (or a prior mount) — can't re-tap
      const source = actx.createMediaElementSource(el)
      const gain = actx.createGain()
      source.connect(gain)
      gain.connect(actx.destination)
      tapped.add(el)
      gainRef.current = gain
    } catch {
      // Already sourced elsewhere, or Web Audio unsupported — boost silently unavailable.
    }
  }, [mediaElRef])

  const setBoost = useCallback((value: number) => {
    const clamped = Math.max(1, Math.min(MAX_BOOST, value))
    ensureGraph()
    void actxRef.current?.resume?.()
    if (gainRef.current) gainRef.current.gain.value = clamped
    setBoostState(clamped)
  }, [ensureGraph])

  return { boost, setBoost }
}
