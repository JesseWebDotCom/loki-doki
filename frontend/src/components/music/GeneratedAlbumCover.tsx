// Deterministic album-cover generator - the last-resort art for albums with no real cover (live
// bootlegs / broadcasts that no cover source carries). Designed to read like ALBUM ART, not a
// podcast tile: the band photo (when available) under a designed colour treatment, the BAND name
// set large and the ALBUM title smaller, across several poster templates (bottom bar, top title,
// centered, vertical spine, colour block) with varied fonts, placements, colour strips and a LIVE
// stamp. Everything is chosen by hashing the band+album, so a given album always renders the same
// cover - and, unlike a fuzzy image match, it can never show the WRONG album.
//
// Type is sized to FIT (font shrinks with length, no line-clamp), so titles are never cut off.

import { fallbackTheme, MUSIC_DEFAULT_THEME } from '@/lib/coverArt'
import { proxyImg } from '@/lib/img'
import { cn } from '@/lib/cn'

function hashInt(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

// A few system font stacks that evoke different record-sleeve moods (no web fonts - CSP/offline).
const FONTS = [
  `'Arial Narrow','Helvetica Neue',sans-serif`,
  `Georgia,'Times New Roman',serif`,
  `Impact,'Haettenschweiler','Arial Black',sans-serif`,
  `'Courier New',monospace`,
  `'Trebuchet MS','Segoe UI',sans-serif`,
]

// Container-query sizing (tiles vary in px). Band names are short → big; album titles can be long →
// scale down by length so the whole title fits without clamping. cqw = % of the tile's width.
const bandCqw = (n: number) => (n <= 10 ? 15 : n <= 16 ? 11.5 : n <= 24 ? 8.5 : 6.5)
const albumCqw = (n: number) => (n <= 14 ? 7.5 : n <= 24 ? 6 : n <= 40 ? 4.8 : n <= 60 ? 4 : 3.4)
const fs = (cqw: number) => `clamp(0.5rem, ${cqw}cqw, 2rem)`

const LIVE_RE = /\b(live|broadcast|tour|in concert|concert|unplugged|bootleg|sessions?)\b/i

export function GeneratedAlbumCover({ band, album, photo, className }: {
  band?: string; album?: string; photo?: string | null; className?: string
}) {
  // Treat a missing/placeholder credit as no band, so a cover never literally reads "Unknown Artist"
  // (MusicBrainz browse-by-artist omits artist-credits, which the catalog maps to that placeholder).
  const rawBand = (band ?? '').trim()
  const bandName = /^unknown artist$/i.test(rawBand) ? '' : rawBand
  const albumName = (album ?? '').trim()
  const seed = `${bandName}~${albumName}` || 'album'
  const h = hashInt(seed)
  const { palette: p } = fallbackTheme(albumName || bandName || 'album', `${albumName} ${bandName}`.trim() || 'music', MUSIC_DEFAULT_THEME)
  const font = FONTS[h % FONTS.length]
  const template = h % 5
  const live = LIVE_RE.test(albumName)
  const upper = h % 4 !== 0 // mostly uppercase, occasionally title-case
  const bandFs = fs(bandCqw(bandName.length || 1))
  const albumFs = fs(albumCqw(albumName.length || 1))

  const text = {
    fontFamily: font, color: p.fg,
    textTransform: upper ? ('uppercase' as const) : ('none' as const),
    overflowWrap: 'anywhere' as const, wordBreak: 'break-word' as const,
  }

  const Photo = ({ pos = 'center' }: { pos?: string }) =>
    photo ? (
      <img src={proxyImg(photo)} alt="" loading="lazy" className="absolute inset-0 size-full object-cover"
        style={{ objectPosition: pos }} onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
    ) : null

  const Live = () =>
    live ? (
      <span className="absolute" style={{
        top: '7%', right: '6%', transform: 'rotate(6deg)', border: `0.6cqw solid ${p.fg}`, color: p.fg,
        fontFamily: FONTS[2], fontWeight: 800, letterSpacing: '0.12em', padding: '0.4cqw 1.8cqw', fontSize: '5.5cqw', lineHeight: 1,
      }}>LIVE</span>
    ) : null

  const Band = ({ size = bandFs, weight = 900 }: { size?: string; weight?: number }) =>
    bandName ? <span style={{ ...text, fontSize: size, fontWeight: weight, lineHeight: 0.95, letterSpacing: '-0.01em' }}>{bandName}</span> : null
  const Album = ({ color = p.accent, weight = 600 }: { color?: string; weight?: number }) =>
    albumName ? <span style={{ ...text, fontSize: albumFs, fontWeight: weight, lineHeight: 1.05, color, opacity: 0.95 }}>{albumName}</span> : null

  return (
    <div className={cn('relative size-full overflow-hidden [container-type:inline-size]', className)}
      style={{ background: `linear-gradient(150deg, ${p.c1}, ${p.c2})` }}>

      {/* Template 0 - photo on top, solid colour bar across the bottom with band + album. */}
      {template === 0 && (<>
        <Photo pos="top" />
        <div className="absolute inset-x-0 bottom-0" style={{ height: '42%', background: p.c1 }} />
        <div className="absolute inset-x-0 bottom-0 flex flex-col justify-end" style={{ height: '42%', padding: '7%', gap: '2%' }}>
          <Band /><Album />
        </div>
        <Live />
      </>)}

      {/* Template 1 - title stacked at the top over the photo, scrim behind for legibility. */}
      {template === 1 && (<>
        <Photo pos="center" />
        <div className="absolute inset-0" style={{ background: `linear-gradient(to bottom, ${p.c1}f2 2%, ${p.c1}40 34%, transparent 58%)` }} />
        <div className="absolute inset-x-0 top-0 flex flex-col" style={{ padding: '7%', gap: '1.5%' }}>
          <Band /><Album />
        </div>
        <Live />
      </>)}

      {/* Template 2 - centered, framed by a colour wash and a thin accent rule between the two lines. */}
      {template === 2 && (<>
        <Photo pos="center" />
        <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${p.c1}d9, ${p.c2}d9)` }} />
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center" style={{ padding: '11%', gap: '3.5%' }}>
          <Band weight={800} />
          <div style={{ width: '28%', height: '0.6cqw', background: p.accent }} />
          <Album color={p.fg} weight={500} />
        </div>
        <Live />
      </>)}

      {/* Template 3 - band name as a vertical spine on a colour strip; album along the bottom. */}
      {template === 3 && (<>
        <Photo pos="center" />
        <div className="absolute inset-y-0 left-0" style={{ width: '30%', background: `linear-gradient(to right, ${p.c1}, ${p.c1}cc)` }} />
        {bandName && (
          <span className="absolute inset-y-0 left-0 flex items-center justify-center" style={{
            width: '30%', ...text, writingMode: 'vertical-rl', transform: 'rotate(180deg)',
            fontSize: bandFs, fontWeight: 900, letterSpacing: '0.01em', padding: '8% 0', lineHeight: 1,
          }}>{bandName}</span>
        )}
        <div className="absolute inset-x-0 bottom-0" style={{ background: `linear-gradient(to top, ${p.c1}, transparent)`, padding: '6% 6% 6% 34%' }}>
          <Album weight={600} />
        </div>
      </>)}

      {/* Template 4 - designed colour block with a diagonal accent strip (works with or without a photo). */}
      {template === 4 && (<>
        <Photo pos="center" />
        <div className="absolute inset-0" style={{ background: `linear-gradient(150deg, ${p.c1}f2, ${p.c2}e0)`, mixBlendMode: photo ? 'multiply' : 'normal' }} />
        {photo && <div className="absolute inset-0" style={{ background: `linear-gradient(to top, ${p.c1}b3, transparent 55%)` }} />}
        <div className="absolute" style={{ left: '-15%', right: '-15%', top: '56%', height: '9%', background: p.accent, transform: 'rotate(-7deg)', opacity: 0.92 }} />
        <div className="absolute inset-x-0 bottom-0 flex flex-col" style={{ padding: '7%', gap: '1.5%' }}>
          <Band /><Album color={p.fg} />
        </div>
        <Live />
      </>)}
    </div>
  )
}
