import { useCallback, useEffect, useRef, useState } from 'react'

// Island tier state machine, modeled on SuperIsland's interaction spec:
// compact -> (hover 300ms) -> peek -> (click) -> full, with auto-dismiss after
// the pointer leaves (1.5s from peek, 4s from full). The effective tier is the
// MAX of three inputs, so interactions and activity can only raise the island
// above the user's chosen idle tier, and dismissal settles back to it:
//   - idleTier: the Display menu choice (Mini/Docked/Max)
//   - activityTier: conversation state (listening/speaking >= peek, composer session = full)
//   - pointerTier: hover/click, owned here
// `holdOpen` (menu open, composer focused, engine busy) freezes dismissal.

export type IslandTier = 'compact' | 'peek' | 'full'

const TIER_RANK: Record<IslandTier, number> = { compact: 0, peek: 1, full: 2 }

export const HOVER_PEEK_MS = 300
export const DISMISS_PEEK_MS = 1500
export const DISMISS_FULL_MS = 4000

export function maxTier(...tiers: IslandTier[]): IslandTier {
  return tiers.reduce((a, b) => (TIER_RANK[b] > TIER_RANK[a] ? b : a), 'compact')
}

export function useIslandState({ idleTier, activityTier, holdOpen }: {
  idleTier: IslandTier
  activityTier: IslandTier
  holdOpen: boolean
}) {
  const [pointerTier, setPointerTier] = useState<IslandTier>('compact')
  const pointerTierRef = useRef(pointerTier)
  pointerTierRef.current = pointerTier
  const hoveringRef = useRef(false)
  const holdRef = useRef(holdOpen)
  holdRef.current = holdOpen
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearPeekTimer = useCallback(() => {
    if (peekTimer.current) { clearTimeout(peekTimer.current); peekTimer.current = null }
  }, [])
  const clearDismissTimer = useCallback(() => {
    if (dismissTimer.current) { clearTimeout(dismissTimer.current); dismissTimer.current = null }
  }, [])

  const scheduleDismiss = useCallback(() => {
    clearDismissTimer()
    if (holdRef.current || hoveringRef.current) return
    if (pointerTierRef.current === 'compact') return
    const delay = pointerTierRef.current === 'full' ? DISMISS_FULL_MS : DISMISS_PEEK_MS
    dismissTimer.current = setTimeout(() => setPointerTier('compact'), delay)
  }, [clearDismissTimer])

  const onPointerEnter = useCallback(() => {
    hoveringRef.current = true
    clearDismissTimer()
    if (pointerTierRef.current === 'compact' && !peekTimer.current) {
      peekTimer.current = setTimeout(() => {
        peekTimer.current = null
        setPointerTier((t) => (t === 'compact' ? 'peek' : t))
      }, HOVER_PEEK_MS)
    }
  }, [clearDismissTimer])

  const onPointerLeave = useCallback(() => {
    hoveringRef.current = false
    clearPeekTimer()
    scheduleDismiss()
  }, [clearPeekTimer, scheduleDismiss])

  /** Click on a non-interactive island area promotes straight to full. */
  const raiseToFull = useCallback(() => {
    clearPeekTimer()
    clearDismissTimer()
    setPointerTier('full')
  }, [clearPeekTimer, clearDismissTimer])

  /** Escape / window blur: drop the pointer contribution immediately. */
  const collapse = useCallback(() => {
    clearPeekTimer()
    clearDismissTimer()
    hoveringRef.current = false
    setPointerTier('compact')
  }, [clearPeekTimer, clearDismissTimer])

  // A hold ending (menu closed, composer blurred, turn finished) with the
  // pointer already gone starts the dismissal countdown.
  useEffect(() => {
    if (!holdOpen) scheduleDismiss()
    else clearDismissTimer()
  }, [holdOpen, scheduleDismiss, clearDismissTimer])

  useEffect(() => () => { clearPeekTimer(); clearDismissTimer() }, [clearPeekTimer, clearDismissTimer])

  return {
    tier: maxTier(idleTier, activityTier, pointerTier),
    pointerTier,
    onPointerEnter,
    onPointerLeave,
    raiseToFull,
    collapse,
  }
}
