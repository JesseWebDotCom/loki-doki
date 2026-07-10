import { useLayoutEffect, useRef } from 'react'

// Measures the shell's bottom chrome stack (media bar slot + mobile dock) and
// publishes its height as --bottom-chrome on <html>. Scrollers and floating
// widgets clear whatever is actually rendered instead of guessing with fixed
// padding (the old pb-28 assumed exactly one bar; a media bar plus the dock
// plus the home-indicator inset can exceed it). The dock's pb-safe padding is
// inside the measured element, so the safe-area inset is included for free.
export function useBottomChrome<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const set = () =>
      document.documentElement.style.setProperty('--bottom-chrome', `${Math.round(el.offsetHeight)}px`)
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => {
      ro.disconnect()
      document.documentElement.style.setProperty('--bottom-chrome', '0px')
    }
  }, [])
  return ref
}
