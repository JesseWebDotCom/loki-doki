// Touch gestures for video surfaces, matching the YouTube/TikTok muscle memory:
//   - double-tap the left/right third: seek -/+ 10s (center double-tap is left alone,
//     it stays the play/pause toggle surface)
//   - press-and-hold anywhere: 2x speed while held, restoring the prior rate on release
// Pointer-event based and TOUCH-ONLY: mouse users have the scrubber and keyboard.
// Returns handlers to spread on the player wrapper plus a transient `indicator` to render.

import { useCallback, useRef, useState } from 'react'

export interface VideoGestureTarget {
  seekBy: (deltaSec: number) => void
  /** Enter/leave hold-to-fast-forward. Implementations remember and restore the rate. */
  setHold: (on: boolean) => void
}

export interface GestureIndicator {
  kind: 'back' | 'forward' | 'speed'
  /** Monotonic id so repeated gestures re-trigger the fade animation. */
  id: number
}

const DOUBLE_TAP_MS = 300
const HOLD_MS = 400

export function useVideoGestures(target: VideoGestureTarget, enabled = true) {
  const [indicator, setIndicator] = useState<GestureIndicator | null>(null)
  const lastTap = useRef<{ at: number; zone: 'left' | 'center' | 'right' } | null>(null)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holding = useRef(false)
  const indicatorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)

  const flash = useCallback((kind: GestureIndicator['kind']) => {
    seq.current += 1
    setIndicator({ kind, id: seq.current })
    if (indicatorTimer.current) clearTimeout(indicatorTimer.current)
    indicatorTimer.current = setTimeout(() => setIndicator(null), kind === 'speed' ? 10_000 : 700)
  }, [])

  const clearFlash = useCallback(() => {
    if (indicatorTimer.current) clearTimeout(indicatorTimer.current)
    setIndicator(null)
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!enabled || e.pointerType !== 'touch') return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const zone = x < 0.33 ? 'left' : x > 0.67 ? 'right' : 'center'

    // Arm hold-to-2x. Fires only if the finger stays down past the threshold.
    if (holdTimer.current) clearTimeout(holdTimer.current)
    holdTimer.current = setTimeout(() => {
      holding.current = true
      target.setHold(true)
      flash('speed')
    }, HOLD_MS)

    // Double-tap seek on the side thirds.
    const now = Date.now()
    const prev = lastTap.current
    lastTap.current = { at: now, zone }
    if (prev && now - prev.at < DOUBLE_TAP_MS && prev.zone === zone && zone !== 'center') {
      lastTap.current = null
      if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null }
      target.seekBy(zone === 'left' ? -10 : 10)
      flash(zone === 'left' ? 'back' : 'forward')
    }
  }, [enabled, target, flash])

  const endHold = useCallback(() => {
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null }
    if (holding.current) {
      holding.current = false
      target.setHold(false)
      clearFlash()
    }
  }, [target, clearFlash])

  return {
    indicator,
    /** True while hold-to-2x is engaged, so click-to-toggle surfaces can swallow the tap. */
    isHolding: () => holding.current,
    handlers: {
      onPointerDown,
      onPointerUp: endHold,
      onPointerCancel: endHold,
      onPointerLeave: endHold,
    },
  }
}

/** The floating gesture feedback chip ("-10s", "2x speed"). Render inside a relative wrapper. */
export function gestureIndicatorText(ind: GestureIndicator): string {
  return ind.kind === 'back' ? '-10s' : ind.kind === 'forward' ? '+10s' : '2× speed'
}
