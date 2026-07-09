// The editorial hero backdrop: real artwork anchored to the RIGHT edge, its left side
// dissolving into the surface's accent color (mask fade + tint bleed), with a left scrim
// for text contrast. The Apple-Music/Spotify billboard pattern - artwork as atmosphere,
// not a pasted-on tile. Drop inside any `relative overflow-hidden` container; the caller
// keeps full control of the foreground content.

import type { ReactNode } from 'react'

export function BlendedHeroBackdrop({ art, color, colorDark, fallback }: {
  /** Right-anchored artwork URL (already proxied/same-origin), or null to show `fallback`. */
  art: string | null
  color: string
  colorDark: string
  /** Full-bleed layer when no artwork resolved (e.g. generated station banner art). */
  fallback?: ReactNode
}) {
  return (
    <>
      <div aria-hidden className="absolute inset-0"
        // design-ok(hex-in-tsx): black anchor of the accent gradient (canvas-style literal)
        style={{ background: `linear-gradient(110deg, #000 0%, ${color}55 55%, ${colorDark}77 100%)` }} />
      {art ? (
        <>
          {/* Cover anchored right, its left edge dissolving into the hero color. */}
          <img src={art} alt="" aria-hidden
            className="absolute inset-y-0 right-0 h-full w-[52%] object-cover sm:w-[42%]"
            style={{ maskImage: 'linear-gradient(to left, black 55%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to left, black 55%, transparent 100%)' }} />
          {/* Accent tint bleeding over the cover so it belongs to the hero, not pasted on. */}
          <div aria-hidden className="pointer-events-none absolute inset-0"
            style={{ background: `linear-gradient(to right, transparent 45%, ${color}26 100%)` }} />
        </>
      ) : fallback}
      {/* Left scrim: guarantees text contrast whatever the artwork brings. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-r from-black/85 via-black/40 to-transparent" />
    </>
  )
}
