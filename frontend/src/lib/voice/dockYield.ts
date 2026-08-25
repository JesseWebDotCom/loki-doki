// "Dock wins" voice arbitration - the server-backed sibling of voiceOwnership.ts.
//
// voiceOwnership's BroadcastChannel election only spans same-origin pages in ONE
// browser profile; the MaiPai Desktop desktop app runs on its own Electron partition, so
// a dock and a browser tab on the same machine each elect themselves and talk over
// each other. The server closes that gap: every /api/browser-session registration
// carries {dock, surface, ip}, and the server pushes a `voice` event telling each
// web tab whether a dock is connected from the same machine. Yielded tabs release
// the mic and mute TTS/lip-sync via the same chokepoints voiceOwnership gates.
//
// The dock itself never yields - the flag is force-cleared where window.maipaiDesktop
// exists, belt-and-suspenders on top of the server never sending yield:true to
// dock-flagged sessions.

import { useEffect, useState } from 'react'

let dockYield = false
const listeners = new Set<(y: boolean) => void>()

function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && !!(window as { maipaiDesktop?: unknown }).maipaiDesktop
}

/** Apply the server's `voice` event ({yield: boolean}) for this session. */
export function setDockYieldFromServer(y: boolean): void {
  const next = y && !isDesktopShell()
  if (dockYield === next) return
  dockYield = next
  listeners.forEach((fn) => fn(next))
}

export function getDockYield(): boolean {
  return dockYield
}

export function useDockYield(): boolean {
  const [y, setY] = useState(dockYield)
  useEffect(() => {
    listeners.add(setY)
    setY(dockYield)
    return () => { listeners.delete(setY) }
  }, [])
  return y
}

/** True in the MaiPai Desktop HUD island window - the desktop app's always-running,
 *  designated announcer surface. */
export function isDockHudSurface(): boolean {
  return isDesktopShell() && window.location.pathname === '/hud'
}

/** Gate for proactive speech (alarms, camera/monitoring announcements): false when this
 *  session yielded to a dock, and false in the dock's MAIN window - within the desktop
 *  app only the always-running HUD island announces, otherwise the two dock windows
 *  would speak the same line twice. (Both windows share the session, and the shell
 *  always creates the HUD, so the HUD is a safe sole announcer.) */
export function shouldSpeakProactively(): boolean {
  if (dockYield) return false
  if (isDesktopShell() && !isDockHudSurface()) return false
  return true
}
