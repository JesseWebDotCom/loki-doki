// Single source of truth for per-source brand identity in the hub UI (pills, card
// badges, labels). Icons are generic Lucide glyphs (NOT trademarked brand logos) — the
// same ones the rail uses — paired with brand-adjacent colors and the referential name.
// Tailwind can't see computed class names, so these are full strings.

import { Clapperboard, MessagesSquare, Music2, Play, type LucideIcon } from 'lucide-react'
import type { VideoSource } from '@/lib/videos/api'

export interface SourceMeta {
  label: string
  icon: LucideIcon
  /** Small identity dot (pills, rows). */
  dotClass: string
  /** Solid badge chip over thumbnails. */
  badgeClass: string
}

export const SOURCE_META: Record<VideoSource, SourceMeta> = {
  // design-ok(raw-palette-semantic): per-source brand identity colors (YouTube red, Reddit orange, TikTok black, Vimeo blue)
  youtube: { label: 'YouTube', icon: Play, dotClass: 'bg-red-500', badgeClass: 'bg-red-600/90 text-white' },
  // design-ok(raw-palette-semantic): per-source brand identity colors
  reddit: { label: 'Reddit', icon: MessagesSquare, dotClass: 'bg-orange-500', badgeClass: 'bg-orange-600/90 text-white' },
  tiktok: { label: 'TikTok', icon: Music2, dotClass: 'bg-foreground', badgeClass: 'bg-black/80 text-white ring-1 ring-white/30' },
  // design-ok(raw-palette-semantic): per-source brand identity colors
  vimeo: { label: 'Vimeo', icon: Clapperboard, dotClass: 'bg-sky-500', badgeClass: 'bg-sky-600/90 text-white' },
}
