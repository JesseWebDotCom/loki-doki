import { useEffect } from 'react'
import { useAuth } from '@/context/AuthContext'
import { CompanionEngineProvider } from '@/components/shell/CompanionEngineContext'
import { IslandShell } from '@/components/hud/IslandShell'
import { useHoverIntercept } from '@/hooks/useHudMouseIntercept'
import { useBrowserSession } from '@/hooks/useBrowserSession'

// Desktop HUD: a SuperIsland-style Dynamic Island pinned over the notch by the
// Electron shell (desktop/). The window is one fixed size, transparent, and
// click-through by default; everything visual lives in components/hud/. This
// page only strips the app background, gates on auth, and mounts the island
// inside the companion engine.

export function HudPage() {
  const { user, configured, firstRunComplete, loading } = useAuth()

  // The window is transparent; the app theme normally paints html/body. Strip it
  // while mounted so only the island itself is visible.
  useEffect(() => {
    const html = document.documentElement.style
    const body = document.body.style
    const prev = { htmlBg: html.background, bodyBg: body.background, htmlOv: html.overflow, bodyOv: body.overflow }
    html.background = 'transparent'
    body.background = 'transparent'
    html.overflow = 'hidden'
    body.overflow = 'hidden'
    return () => {
      html.background = prev.htmlBg
      body.background = prev.bodyBg
      html.overflow = prev.htmlOv
      body.overflow = prev.bodyOv
    }
  }, [])

  if (loading) return null

  // The transparent window must never render the full profile picker or setup
  // wizard; an unauthenticated HUD shows a small hand-off island instead. The
  // main window (opened by the click) is where sign-in happens.
  if (!configured || !firstRunComplete || !user) return <SignedOutIsland />

  return (
    <CompanionEngineProvider>
      <HudSessionRegistration />
      <IslandShell />
    </CompanionEngineProvider>
  )
}

// The HUD's browser-session registration IS the dock's presence signal: while this
// stream is connected the server tells same-machine web tabs to yield companion voice
// to the dock, and routes companion file-op requests here. Mounted only when authed -
// a signed-out dock must not silence anyone. (Hooks can't be conditional, hence the
// tiny component instead of a call in HudPage itself.)
function HudSessionRegistration() {
  useBrowserSession({ surface: 'hud' })
  return null
}

function SignedOutIsland() {
  const hover = useHoverIntercept()
  return (
    <div className="flex h-screen items-start justify-center">
      <button
        type="button"
        {...hover}
        onClick={() => window.lokiDesktop?.openMainWindow('/login')}
        className="pointer-events-auto bg-black px-5 py-2 text-sm text-white/90 shadow-2xl hover:bg-black/80"
        // SuperIsland compact treatment: squared top flush with the notch strip.
        style={{ borderRadius: '0 0 12px 12px' }}
      >
        Sign in to Loki Doki…
      </button>
    </div>
  )
}
