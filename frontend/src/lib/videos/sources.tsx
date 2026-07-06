// Single source of truth for per-source brand identity in the hub UI (pills, card
// badges, labels). Icons are generic Lucide glyphs (NOT trademarked brand logos), the
// same ones the rail uses, paired with brand-adjacent colors and the referential name.
// Tailwind can't see computed class names, so these are full strings.

import { Clapperboard, MessagesSquare, Music2, Play, type LucideIcon } from 'lucide-react'
import type { VideoSource } from '@/lib/videos/api'

export interface SourceMeta {
  label: string
  icon: LucideIcon
  /** Small identity dot (rows, legends). */
  dotClass: string
  /** Solid badge chip over thumbnails. */
  badgeClass: string
  /** Selected filter pill fill. */
  pillActiveClass: string
  /** Identity tile gradient for the source page header. */
  gradient: string
}

export const SOURCE_META: Record<VideoSource, SourceMeta> = {
  // design-ok(raw-palette-semantic): per-source brand identity colors (YouTube red, Reddit orange, TikTok black, Vimeo blue)
  // design-ok(hex-in-tsx): identity tile gradients for source page headers
  youtube: { label: 'YouTube', icon: Play, dotClass: 'bg-red-500', badgeClass: 'bg-red-600 text-white', pillActiveClass: 'bg-red-600 text-white', gradient: 'linear-gradient(135deg,#7f1d1d,#dc2626)' },
  // design-ok(raw-palette-semantic): per-source brand identity colors
  // design-ok(hex-in-tsx): identity tile gradients for source page headers
  reddit: { label: 'Reddit', icon: MessagesSquare, dotClass: 'bg-orange-500', badgeClass: 'bg-orange-600 text-white', pillActiveClass: 'bg-orange-600 text-white', gradient: 'linear-gradient(135deg,#7c2d12,#ea580c)' },
  // design-ok(hex-in-tsx): identity tile gradients for source page headers
  tiktok: { label: 'TikTok', icon: Music2, dotClass: 'bg-foreground', badgeClass: 'bg-black/80 text-white ring-1 ring-white/30', pillActiveClass: 'bg-foreground text-background', gradient: 'linear-gradient(135deg,#18181b,#52525b)' },
  // design-ok(raw-palette-semantic): per-source brand identity colors
  // design-ok(hex-in-tsx): identity tile gradients for source page headers
  vimeo: { label: 'Vimeo', icon: Clapperboard, dotClass: 'bg-sky-500', badgeClass: 'bg-sky-600 text-white', pillActiveClass: 'bg-sky-600 text-white', gradient: 'linear-gradient(135deg,#0c4a6e,#0ea5e9)' },
}
