import { cn } from '@/lib/cn'
import type { Palette } from '@/lib/music/albumColors'

/**
 * Plexamp-style "UltraBlur" backdrop: the album cover massively blurred, under a field of
 * four hue-diverse colours extracted from the art and pinned to the corners as overlapping
 * radial washes. The wash layer breathes with a very slow drift (motion-safe only) so long
 * plays feel alive without pulling focus. Always renders a dark scrim on top so white
 * chrome stays readable regardless of how bright the cover is.
 *
 * Positioned absolute-inset; parents must be `relative` (or pass a fixed class).
 */
export function UltraBlur({ artUrl, palette, scrim = 'default', className }: {
  artUrl?: string | null
  palette: Palette
  /** How heavy the readability scrim is: overlay players want more, heroes less. */
  scrim?: 'default' | 'light' | 'heavy'
  className?: string
}) {
  const [c0, c1, c2, c3] = palette.corners
  const scrimBg = scrim === 'light'
    ? 'linear-gradient(180deg, rgba(0,0,0,0.25), rgba(0,0,0,0.6))'
    : scrim === 'heavy'
      ? 'linear-gradient(180deg, rgba(0,0,0,0.45), rgba(6,6,8,0.9))'
      : 'linear-gradient(180deg, rgba(0,0,0,0.35), rgba(6,6,8,0.78))'

  return (
    <div aria-hidden className={cn('pointer-events-none absolute inset-0 overflow-hidden bg-black', className)}>
      {artUrl && (
        <img src={artUrl} alt="" className="absolute inset-0 size-full scale-125 object-cover opacity-55"
          style={{ filter: 'blur(64px) saturate(1.45)' }} />
      )}
      {/* Corner colour field - four radial washes, one per extracted colour. */}
      <div
        className="absolute -inset-[12%] motion-safe:animate-[ultrablur-drift_36s_ease-in-out_infinite_alternate]"
        style={{
          background: [
            `radial-gradient(85% 75% at 12% 8%, ${c0}cc 0%, transparent 62%)`,
            `radial-gradient(85% 75% at 92% 6%, ${c1}b3 0%, transparent 60%)`,
            `radial-gradient(90% 80% at 8% 96%, ${c2}bb 0%, transparent 64%)`,
            `radial-gradient(90% 80% at 94% 94%, ${c3}a6 0%, transparent 62%)`,
          ].join(', '),
          mixBlendMode: artUrl ? 'hard-light' : 'normal',
        }}
      />
      <div className="absolute inset-0" style={{ background: scrimBg }} />
    </div>
  )
}
