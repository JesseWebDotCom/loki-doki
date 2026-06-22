import { useState } from 'react'
import { cn } from '@/lib/cn'
import { coverUrl } from '@/lib/podcast/api'
import { fallbackTheme, paletteBg, emojiUrl } from '@/lib/podcast/cover'

/**
 * The one cover primitive. Renders the show's uploaded/generated PNG; if none
 * exists (404) it falls back to instant CSS art — a themed gradient with the
 * show's topic OpenMoji glyph (small thumbs) or glyph + title (larger), keyed
 * deterministically off the show so every show looks intentional.
 *
 * Sizing: pass `size` (px) for a fixed square, or `fill` to fill a parent that
 * controls dimensions (e.g. `w-full aspect-square`). `size` still acts as the
 * scale hint in fill mode.
 */
export function ShowCover({ showId, title, size = 96, fill, rounded = 'rounded-2xl', className }: {
  showId: string
  title: string
  size?: number
  fill?: boolean
  rounded?: string
  className?: string
}) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const { palette, kicker, emojiHex } = fallbackTheme(showId || title, title)
  const showText = size >= 96
  const showKicker = size >= 140
  const fontSize = Math.max(11, Math.round(size * (title.length > 18 ? 0.11 : 0.15)))

  return (
    <div
      className={cn('relative shrink-0 overflow-hidden', rounded, fill && 'size-full', className)}
      style={fill ? undefined : { width: size, height: size }}
    >
      {/* CSS fallback art (base layer) */}
      {showText ? (
        <div className="absolute inset-0 flex flex-col justify-between" style={{ background: paletteBg(palette), padding: '9%' }}>
          <div className="flex items-center justify-between">
            {showKicker
              ? <span className="font-semibold uppercase" style={{ color: palette.accent, fontSize: Math.round(size * 0.05), letterSpacing: 1.5 }}>{kicker}</span>
              : <span />}
            <img src={emojiUrl(emojiHex)} alt="" style={{ width: '22%' }} />
          </div>
          <span
            className="font-black uppercase leading-none"
            style={{ color: palette.fg, fontSize, letterSpacing: -0.5, overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
          >
            {title}
          </span>
        </div>
      ) : (
        // Small thumbnail: centered topic glyph on the themed gradient.
        <div className="absolute inset-0 flex items-center justify-center" style={{ background: paletteBg(palette) }}>
          <img src={emojiUrl(emojiHex)} alt="" style={{ width: '58%' }} />
        </div>
      )}

      {/* Stored cover image overlays the fallback once loaded */}
      {showId && !failed && (
        <img
          src={coverUrl(showId)}
          alt=""
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn('absolute inset-0 size-full object-cover transition-opacity', loaded ? 'opacity-100' : 'opacity-0')}
        />
      )}
    </div>
  )
}
