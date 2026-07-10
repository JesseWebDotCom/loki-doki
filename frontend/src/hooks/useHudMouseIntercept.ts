import { useCallback, useEffect, useRef } from 'react'

// Mouse-interception management for the desktop HUD window. The Electron window
// is click-through by default (setIgnoreMouseEvents with forward: mousemove still
// reaches the renderer); painted regions opt back in while hovered, and surfaces
// like the menu or a typing session force-hold interception while open.
//
// A module-level ref count means any number of regions/holders can overlap:
// interception turns on at 0 to 1 and off at 1 to 0. No-ops outside the desktop
// shell (window.lokiDesktop absent), so web builds are unaffected.

let holds = 0

function acquire() {
  holds += 1
  if (holds === 1) window.lokiDesktop?.setMouseIntercept?.(true)
}

function release() {
  if (holds === 0) return
  holds -= 1
  if (holds === 0) window.lokiDesktop?.setMouseIntercept?.(false)
}

// Hard reset: on window blur (Cmd-Tab, space switch) pointerleave may never fire,
// which would leave an invisible click-blocking strip over the screen.
export function resetMouseIntercept() {
  if (holds > 0) window.lokiDesktop?.setMouseIntercept?.(false)
  holds = 0
}

/** Hover-driven interception for a painted region. Spread the returned handlers
 *  onto ONE wrapper element per region. Leaving mid-drag defers the release to
 *  pointerup so drags/text-selection that stray off the region don't drop it. */
export function useHoverIntercept() {
  const holding = useRef(false)
  const pointerDown = useRef(false)
  const leftWhileDown = useRef(false)

  const releaseNow = useCallback(() => {
    if (!holding.current) return
    holding.current = false
    release()
  }, [])

  const onPointerEnter = useCallback(() => {
    leftWhileDown.current = false
    if (holding.current) return
    holding.current = true
    acquire()
  }, [])

  const onPointerLeave = useCallback(() => {
    if (pointerDown.current) {
      leftWhileDown.current = true
      return
    }
    releaseNow()
  }, [releaseNow])

  const onPointerDown = useCallback(() => { pointerDown.current = true }, [])

  useEffect(() => {
    const onUp = () => {
      if (!pointerDown.current) return
      pointerDown.current = false
      if (leftWhileDown.current) {
        leftWhileDown.current = false
        releaseNow()
      }
    }
    window.addEventListener('pointerup', onUp)
    return () => window.removeEventListener('pointerup', onUp)
  }, [releaseNow])

  // Release on unmount so a region that disappears under the cursor (capsule
  // morph) doesn't leak a hold.
  useEffect(() => () => releaseNow(), [releaseNow])

  return { onPointerEnter, onPointerLeave, onPointerDown }
}

/** Force interception while `active` (menu open, hotkey typing session). */
export function useForceIntercept(active: boolean) {
  useEffect(() => {
    if (!active) return
    acquire()
    return () => release()
  }, [active])
}
