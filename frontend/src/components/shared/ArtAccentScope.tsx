// App-neutral "retint this subtree from artwork" mechanism, generalized from the Videos
// AccentScope. accentVars() writes only the GLOBAL chrome vars (--brand*, --ring) that
// every app's controls already read, so any page can scope an art-derived accent without
// inventing app-specific var names. Art must be same-origin (proxied) or extraction
// silently falls back to DEFAULT_PALETTE; pass null art to leave the surrounding accent
// untouched. Use only on sanctioned palette surfaces (heroes, players, detail pages),
// never per-card in grids.

import type { CSSProperties, ReactNode } from 'react'
import { accentOf, DEFAULT_PALETTE, readableOn, useArtPalette, type Palette } from '@/lib/artPalette'

/** Global accent override for one extracted palette (inline vars beat any layout's). */
export function accentVars(palette: Palette): CSSProperties {
  const accent = accentOf(palette)
  return {
    '--brand': accent,
    '--brand-hover': `color-mix(in oklab, ${accent} 85%, white)`,
    '--brand-foreground': readableOn(accent),
    // --primary is declared as var(--brand) at the root, so it resolves THERE and
    // inherits the resolved value; scoped --brand overrides never reach it. Set it
    // explicitly so filled Buttons (bg-primary) follow the artwork too.
    '--primary': accent,
    '--primary-foreground': readableOn(accent),
    '--ring': accent,
    '--accent-soft': `color-mix(in oklab, ${accent} 15%, transparent)`,
  } as CSSProperties
}

/** Wrap a hero/player/detail surface so its chrome tints to the artwork's palette.
 *  While extraction is pending, and when it fails (404 cover, tainted canvas), the
 *  surrounding accent is left untouched instead of flashing the fallback palette. */
export function ArtAccentScope({ art, className, style, children }: {
  art: string | null
  className?: string
  style?: CSSProperties
  children: ReactNode
}) {
  const palette = useArtPalette(art)
  const active = !!art && palette !== DEFAULT_PALETTE
  return (
    <div className={className} style={active ? { ...accentVars(palette), ...style } : style}>
      {children}
    </div>
  )
}
