// Dynamic per-item accent for the hub's sanctioned palette surfaces (watch page, channel
// pages, home billboard): retints the subtree's --yt-accent*/--brand vars to a palette
// extracted from the item's own art, so every already-tinted control (Subscribe, tab
// underlines, SegBtns, progress bars) follows the content with zero per-control edits.
// Art must be same-origin (proxied) or extraction silently falls back to the mode accent.

import type { CSSProperties, ReactNode } from 'react'
import { accentVars } from '@/components/shared/ArtAccentScope'
import { accentOf, readableOn, useArtPalette, type Palette } from '@/lib/artPalette'

/** The CSS-var override for one extracted palette (inline vars beat VideosLayout's).
 *  Composes the shared global override (accentVars) with the Videos-only --yt-accent*
 *  aliases that this app's chrome reads. */
export function videoAccentVars(palette: Palette): CSSProperties {
  const accent = accentOf(palette)
  return {
    ...accentVars(palette),
    '--yt-accent': accent,
    '--yt-accent-hover': accent,
    '--yt-accent-fg': accent,
    '--yt-accent-soft': `color-mix(in oklab, ${accent} 15%, transparent)`,
    '--yt-accent-contrast': readableOn(accent),
  } as CSSProperties
}

/** Wrap a creator/channel page so its chrome tints to the banner (or avatar) palette. */
export function CreatorAccentScope({ art, className, children }: {
  art: string | null
  className?: string
  children: ReactNode
}) {
  const palette = useArtPalette(art)
  return <div className={className} style={art ? videoAccentVars(palette) : undefined}>{children}</div>
}
