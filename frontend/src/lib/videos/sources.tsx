// Single source of truth for per-source brand identity in the hub UI (pills, card
// badges, labels). Icons are generic Lucide glyphs (NOT trademarked brand logos), the
// same ones the rail uses, paired with brand-adjacent colors and the referential name.
// Tailwind can't see computed class names, so these are full strings.

import { Clapperboard, Globe, MessagesSquare, Music2, Play, Video, type LucideIcon } from 'lucide-react'
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
  /** Blended-hero accent pair (bright + deep), derived from the gradient stops. Used by
   *  the source dashboards' identity strips and art-less channel heroes. */
  heroColor: string
  heroColorDark: string
}

export const SOURCE_META: Record<VideoSource, SourceMeta> = {
  // design-ok(raw-palette-semantic): per-source brand identity colors (YouTube red, Reddit orange, TikTok black, Vimeo blue)
  // design-ok(hex-in-tsx): identity tile gradients for source page headers
  youtube: { label: 'YouTube', icon: Play, dotClass: 'bg-red-500', badgeClass: 'bg-red-600 text-white', pillActiveClass: 'bg-red-600 text-white', gradient: 'linear-gradient(135deg,#7f1d1d,#dc2626)', heroColor: '#dc2626', heroColorDark: '#450a0a' },
  // design-ok(raw-palette-semantic): per-source brand identity colors
  // design-ok(hex-in-tsx): identity tile gradients for source page headers
  reddit: { label: 'Reddit', icon: MessagesSquare, dotClass: 'bg-orange-500', badgeClass: 'bg-orange-600 text-white', pillActiveClass: 'bg-orange-600 text-white', gradient: 'linear-gradient(135deg,#7c2d12,#ea580c)', heroColor: '#ea580c', heroColorDark: '#431407' },
  // design-ok(hex-in-tsx): identity tile gradients for source page headers
  tiktok: { label: 'TikTok', icon: Music2, dotClass: 'bg-foreground', badgeClass: 'bg-black/80 text-white ring-1 ring-white/30', pillActiveClass: 'bg-foreground text-background', gradient: 'linear-gradient(135deg,#18181b,#52525b)', heroColor: '#52525b', heroColorDark: '#09090b' },
  // design-ok(raw-palette-semantic): per-source brand identity colors
  // design-ok(hex-in-tsx): identity tile gradients for source page headers
  vimeo: { label: 'Vimeo', icon: Clapperboard, dotClass: 'bg-sky-500', badgeClass: 'bg-sky-600 text-white', pillActiveClass: 'bg-sky-600 text-white', gradient: 'linear-gradient(135deg,#0c4a6e,#0ea5e9)', heroColor: '#0ea5e9', heroColorDark: '#082f49' },
  // design-ok(hex-in-tsx): identity tile gradient for the source page header
  // Universal paste-any-URL source: a neutral slate identity, not a brand.
  link: { label: 'Other sites', icon: Globe, dotClass: 'bg-slate-500', badgeClass: 'bg-slate-700 text-white', pillActiveClass: 'bg-slate-700 text-white', gradient: 'linear-gradient(135deg,#334155,#64748b)', heroColor: '#64748b', heroColorDark: '#0f172a' },
}

// 'Mine' isn't a VideoSource — it's Studio bin content (exports/uploads/recordings/AI
// clips), which has no provider/browse surface of its own. Kept separate from SOURCE_META
// (which every generic `item.source` lookup indexes into) so it can't silently satisfy a
// VideoSource-keyed lookup as if it were a real playable hub source.
// design-ok(hex-in-tsx): Mine identity gradient, matches MyVideosPage's header tile
// design-ok(raw-palette-semantic): Mine identity color (amber), distinct from every real source's brand color
export const MINE_META: SourceMeta = {
  label: 'Mine', icon: Video, dotClass: 'bg-amber-500', badgeClass: 'bg-amber-600 text-white',
  pillActiveClass: 'bg-amber-600 text-white', gradient: 'linear-gradient(135deg,#78350f,#f59e0b)', heroColor: '#f59e0b', heroColorDark: '#451a03',
}
