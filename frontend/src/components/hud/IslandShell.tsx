import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Music } from 'lucide-react'
import { cn } from '@/lib/cn'
import { CompanionMenu } from '@/components/companion/CompanionMenu'
import { useCompanionEngine } from '@/components/shell/CompanionEngineContext'
import { useCompanionState } from '@/lib/companionState'
import { resetMouseIntercept, useForceIntercept, useHoverIntercept } from '@/hooks/useHudMouseIntercept'
import { useIslandState, type IslandTier } from './useIslandState'
import { IslandCompact, NOTCH_CORE_W, WING_L, WING_R } from './IslandCompact'
import { IslandExpanded } from './IslandExpanded'
import { IslandFullExpanded } from './IslandFullExpanded'
import { useNowPlaying } from './useNowPlaying'
import { useResourceReporter } from './useResourceReporter'
import type { IslandTab } from './IslandTopBar'

// The island itself: one black container pinned to the top of the transparent
// click-through window, morphing between SuperIsland's three tiers with a
// single spring (.island-spring in index.css). Owns the geometry math, the
// bridge effects (hotkey/tray listening, state reporting), and the menu portal.

const MENU_W = 240
const PEEK_W = 408
const PEEK_H = 88
const FULL_W = 660

// Display menu choice (Mini/Docked/Max) picks the tier the island settles to.
const IDLE_TIER: Record<string, IslandTier> = { pill: 'compact', collapsed: 'peek', expanded: 'full' }

export function IslandShell() {
  const engine = useCompanionEngine()
  const { size } = useCompanionState()
  const nowPlaying = useNowPlaying()
  // Forward local machine stats + threshold alerts to the server (independent of
  // which island tab is open; no-op outside the desktop shell).
  useResourceReporter()

  const [topInset, setTopInset] = useState(36)
  const [tab, setTab] = useState<IslandTab>('home')
  const [forcedComposer, setForcedComposer] = useState(false)
  const [islandFocused, setIslandFocused] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const hover = useHoverIntercept()

  const speaking = engine.thinking || engine.streaming || engine.talkActive || !!engine.captionText || engine.lookingAtScreen || !!engine.pendingAction
  const listening = engine.listeningState === 'on-active' || engine.listeningState === 'on-followup' || !!engine.handsFreePartial
  // The tab effect below collapses this back to 'home' whenever the panel closes.
  const isShelfHold = tab === 'shelf'

  const island = useIslandState({
    idleTier: IDLE_TIER[size] ?? 'compact',
    // A transient event peek (engine.capsuleEvent) raises to peek below conversation priority.
    activityTier: forcedComposer ? 'full' : speaking || listening ? 'peek' : engine.capsuleEvent ? 'peek' : 'compact',
    // Shelf holds the panel open: an OS file drag keeps the pointer "outside"
    // the window as far as hover events go, and dismissal mid-drag would drop
    // the interception the drop needs.
    holdOpen: menuOpen || islandFocused || engine.busy || isShelfHold,
  })
  const { tier } = island

  // First caller for the event-peek (#1): when the track changes while the dock is idle,
  // briefly bloom the capsule to announce it (the Dynamic Island music behavior). The ref
  // starts undefined so the currently-playing track on mount does not trigger a pulse.
  const lastTrackRef = useRef<string | null | undefined>(undefined)
  const pulseEvent = engine.pulseEvent
  useEffect(() => {
    const title = nowPlaying?.title ?? null
    if (lastTrackRef.current === undefined) { lastTrackRef.current = title; return }
    if (title && title !== lastTrackRef.current) pulseEvent({ icon: Music, text: `Now playing: ${title}` })
    lastTrackRef.current = title
  }, [nowPlaying?.title, pulseEvent])

  // Reset to home when the panel closes; also bounds the shelf hold.
  useEffect(() => {
    if (tier !== 'full' && tab !== 'home') setTab('home')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier])

  // Menu and keyboard sessions must keep the window intercepting even if the
  // pointer wanders off the painted island.
  useForceIntercept(menuOpen || forcedComposer || islandFocused)

  // ── Bridge effects (shell <-> page) ──────────────────────────────────────

  useEffect(() => {
    let cancelled = false
    void window.lokiDesktop?.getHudInsets?.().then(({ topInset: v }) => {
      if (!cancelled && v > 0) setTopInset(v)
      if (!cancelled && v === 0) setTopInset(0)
    })
    return () => { cancelled = true }
  }, [])

  // Always-on posture: arm the wake word on mount when the shell says so.
  useEffect(() => {
    let cancelled = false
    void window.lokiDesktop?.getStartupPrefs().then((prefs) => {
      if (cancelled || !prefs?.alwaysListening) return
      engine.setHandsFree(true)
      engine.setVoice(true)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Hotkey summon (window was hidden): arm listening AND open the composer.
  useEffect(() => {
    return window.lokiDesktop?.onSetListening((on) => {
      engine.setHandsFree(on)
      if (on) {
        engine.setVoice(true)
        setForcedComposer(true)
        window.focus()
        engine.focusComposer()
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.setHandsFree, engine.setVoice, engine.focusComposer])

  // Hotkey while visible: toggle the composer session (full tier).
  useEffect(() => {
    return window.lokiDesktop?.onToggleExpand(() => {
      setForcedComposer((prev) => {
        const next = !prev
        if (next) {
          window.focus()
          engine.focusComposer()
        }
        return next
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.focusComposer])

  // Tray "Drop a File…": open the shelf in the full panel so a file can be dropped straight
  // onto the dock (the shelf owns its own mouse interception + hold).
  useEffect(() => {
    return window.lokiDesktop?.onOpenShelf(() => {
      setTab('shelf')
      island.raiseToFull()
      window.focus()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [island.raiseToFull])

  // Keep the shell's tray label and hide rules accurate.
  useEffect(() => {
    window.lokiDesktop?.reportState({
      listening: engine.listeningState !== 'off',
      busy: engine.busy,
      sleeping: engine.sleeping,
      handsFreeOn: engine.handsFreeOn,
    })
  }, [engine.listeningState, engine.busy, engine.sleeping, engine.handsFreeOn])

  // Escape collapses everything.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setMenuOpen(false)
      setForcedComposer(false)
      island.collapse()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [island.collapse]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cmd-Tab / space switch: pointerleave may never fire, so drop everything
  // that holds interception and reset the window to click-through.
  useEffect(() => {
    const onBlur = () => {
      setMenuOpen(false)
      setForcedComposer(false)
      island.collapse()
      resetMouseIntercept()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [island.collapse]) // eslint-disable-line react-hooks/exhaustive-deps

  // Focus within the island (composer typing) freezes dismissal.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onFocusIn = () => setIslandFocused(true)
    const onFocusOut = (e: FocusEvent) => {
      if (!el.contains(e.relatedTarget as Node)) setIslandFocused(false)
    }
    el.addEventListener('focusin', onFocusIn)
    el.addEventListener('focusout', onFocusOut)
    return () => {
      el.removeEventListener('focusin', onFocusIn)
      el.removeEventListener('focusout', onFocusOut)
    }
  }, [])

  // ── Geometry ──────────────────────────────────────────────────────────────

  const notched = topInset > 0
  // Right wing is content-driven only (now-playing). A standing chip would
  // permanently sit over menu-bar status items next to the notch.
  const wingR = nowPlaying ? WING_R : 0

  let style: React.CSSProperties
  if (tier === 'compact') {
    style = notched
      ? {
          width: WING_L + NOTCH_CORE_W + wingR,
          height: topInset,
          // Keep the notch core centered under the physical notch while the
          // wings grow asymmetrically.
          transform: `translateX(${(wingR - WING_L) / 2}px)`,
          // SuperIsland compact: squared top merging with the notch, 12px bottom.
          borderRadius: '0 0 12px 12px',
        }
      : { width: 220, height: 28, transform: 'none', borderRadius: 9999 }
  } else if (tier === 'peek') {
    style = {
      width: PEEK_W,
      // The notch strip is dead space in expanded states (content sits below
      // the physical cutout), so the row height rides on top of it.
      height: PEEK_H + (notched ? topInset : 0),
      transform: 'none',
      borderRadius: notched ? '0 0 24px 24px' : 24,
    }
  } else {
    style = {
      width: FULL_W,
      height: 'auto',
      minHeight: 120,
      transform: 'none',
      // 40px: SuperIsland fullExpanded corner radius.
      borderRadius: notched ? '0 0 40px 40px' : 40,
    }
  }

  const openMenu = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect()
    setMenuPos(rect
      ? {
          top: Math.round(Math.min(rect.bottom + 8, window.innerHeight - 380)),
          left: Math.round(Math.max(8, rect.left + rect.width / 2 - MENU_W / 2)),
        }
      : { top: 72, left: (window.innerWidth - MENU_W) / 2 })
    setMenuOpen(true)
  }, [])

  const onIslandClick = useCallback((e: React.MouseEvent) => {
    // Clicks on real controls do their own thing; bare island clicks expand.
    if ((e.target as HTMLElement).closest('button, input, textarea, select, a, [role="menuitem"]')) return
    island.raiseToFull()
  }, [island.raiseToFull]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-screen flex-col items-center">
      <div
        ref={containerRef}
        onPointerEnter={() => { hover.onPointerEnter(); island.onPointerEnter() }}
        onPointerLeave={() => { hover.onPointerLeave(); island.onPointerLeave() }}
        onPointerDown={hover.onPointerDown}
        onClick={onIslandClick}
        onContextMenu={(e) => { e.preventDefault(); openMenu() }}
        className={cn(
          'island-spring pointer-events-auto overflow-hidden bg-black',
          tier !== 'compact' && 'shadow-2xl',
        )}
        style={style}
      >
        {/* Keyed so tier changes crossfade (island-swap, 220ms). */}
        <div key={tier} className="island-swap h-full">
          {tier === 'compact' && (
            <IslandCompact notched={notched} topInset={topInset} nowPlaying={nowPlaying} />
          )}
          {tier === 'peek' && <IslandExpanded nowPlaying={nowPlaying} topInset={notched ? topInset : 0} />}
          {tier === 'full' && <IslandFullExpanded nowPlaying={nowPlaying} tab={tab} setTab={setTab} onOpenMenu={openMenu} topInset={notched ? topInset : 0} />}
        </div>
      </div>

      {/* Companion menu, grows DOWNWARD below the island (top-anchored window) */}
      {menuOpen && menuPos && createPortal(
        <CompanionMenu
          onClose={() => setMenuOpen(false)}
          style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, zIndex: 10001 }}
          onBrowseCompanions={() => window.lokiDesktop?.openMainWindow('/companions')}
          showDisplaySection
        />,
        document.body,
      )}
    </div>
  )
}
