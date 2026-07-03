// The book equivalent of Podcast's ShowCover, using the same generative
// fallback-art engine (lib/coverArt.ts) so a book with no cover art still looks
// intentional (themed gradient + a book/topic-matched OpenMoji glyph + the
// title), not a blank tile. Differs from ShowCover only in how the real cover
// image URL is resolved: shows always have one predictable /cover endpoint keyed
// by id, but a book's cover can come from three different places (EPUB-extracted,
// LibriVox/Internet Archive, or none at all), so the caller resolves that URL and
// passes it in directly.

import { useState } from 'react'
import { cn } from '@/lib/cn'
import { fallbackTheme, paletteBg, emojiUrl, BOOKS_DEFAULT_THEME } from '@/lib/coverArt'

export function BookCover({ bookId, title, author, coverSrc, size = 96, fill, rounded = 'rounded-card', className }: {
  bookId: string
  title: string
  author?: string | null
  coverSrc?: string | null
  size?: number
  fill?: boolean
  rounded?: string
  className?: string
}) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const { palette, kicker, emojiHex } = fallbackTheme(bookId || title, `${title} ${author ?? ''}`, BOOKS_DEFAULT_THEME)
  const showText = size >= 96
  const showKicker = size >= 140
  const fontSize = Math.max(11, Math.round(size * (title.length > 18 ? 0.11 : 0.15)))

  return (
    <div
      className={cn('relative shrink-0 overflow-hidden', rounded, fill && 'size-full', className)}
      style={fill ? undefined : { width: size, height: size }}
    >
      {showText ? (
        <div className="absolute inset-0 flex flex-col justify-between" style={{ background: paletteBg(palette), padding: '9%' }}>
          <div className="flex items-center justify-between">
            {showKicker
              ? <span className="font-semibold uppercase" style={{ color: palette.accent, fontSize: Math.round(size * 0.05), letterSpacing: 1.5 }}>{kicker}</span>
              : <span />}
            <img src={emojiUrl(emojiHex)} alt="" style={{ width: '22%' }} />
          </div>
          <span
            className="font-bold uppercase leading-none"
            style={{ color: palette.fg, fontSize, letterSpacing: -0.5, overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
          >
            {title}
          </span>
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center" style={{ background: paletteBg(palette) }}>
          <img src={emojiUrl(emojiHex)} alt="" style={{ width: '58%' }} />
        </div>
      )}

      {coverSrc && !failed && (
        <img
          src={coverSrc}
          alt=""
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn('absolute inset-0 size-full object-cover transition-opacity', loaded ? 'opacity-100' : 'opacity-0')}
        />
      )}
    </div>
  )
}
