// Doki TV app shell: the always-dark cinema surface (same posture as MusicLayout /
// VideosLayout). The watch route owns the full pane with no scroller; hub routes get
// the standard scrolling column.

import { useEffect, useRef, type CSSProperties } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { usePublishUIContext } from '@/context/UIContextProvider'

// design-ok(hex-in-tsx): the app-tile identity hues, mirrored from appCategories.ts
const TV_RED = '#e11d48'
const TV_RED_HOVER = '#f43f5e' // design-ok(hex-in-tsx): app-tile identity hue

const accentVars = {
  '--brand': TV_RED,
  '--brand-hover': TV_RED_HOVER,
  '--brand-foreground': '#ffffff',
  '--ring': TV_RED,
  backgroundImage: `linear-gradient(${`color-mix(in oklab, ${TV_RED} 4%, transparent)`}, ${`color-mix(in oklab, ${TV_RED} 4%, transparent)`})`,
} as CSSProperties

export function DokiTvLayout() {
  const { pathname } = useLocation()
  const isWatch = pathname.includes('/watch/')
  usePublishUIContext({ label: 'Doki TV', description: 'User is watching the Doki TV linear channels app.' })

  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => { scrollRef.current?.scrollTo(0, 0) }, [pathname])

  return (
    <div data-theme="dark" className="flex min-h-0 flex-1 overflow-hidden bg-black text-foreground" style={accentVars}>
      {isWatch ? (
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <Outlet />
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none pb-[max(7rem,calc(var(--bottom-chrome,0px)+1.5rem))] md:pb-[max(8rem,calc(var(--bottom-chrome,0px)+2rem))]"
        >
          <Outlet />
        </div>
      )}
    </div>
  )
}
