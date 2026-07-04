// Deterministic album-cover generator - the last-resort art for albums with no real cover (live
// bootlegs / broadcasts that no cover source carries). Designed to read like ALBUM ART, not a
// podcast tile: the band photo (when available) under a designed colour treatment, the BAND name
// set large and the ALBUM title smaller, across many poster templates with varied fonts, palettes,
// placements, colour strips and a LIVE stamp. Everything is chosen by hashing the band+album (with
// independent hashes for template / palette / font, for lots of distinct combinations), so a given
// album always renders the same cover - and, unlike a fuzzy image match, it never shows the WRONG
// album.
//
// Band name is sized to fit ONE line (font shrinks to the width) and only wraps when even the
// smallest readable size can't fit. Album titles are sized down by length so they fit without a
// hard clamp - so nothing is cut off.

import { COVER_PALETTES } from '@/lib/coverArt'
import { proxyImg } from '@/lib/img'
import { cn } from '@/lib/cn'

function hashInt(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

// System font stacks that evoke different record-sleeve moods (no web fonts - CSP/offline).
const FONTS = [
  `'Arial Narrow','Helvetica Neue',sans-serif`,
  `Georgia,'Times New Roman',serif`,
  `Impact,'Haettenschweiler','Arial Black',sans-serif`,
  `'Courier New',monospace`,
  `'Trebuchet MS','Segoe UI',sans-serif`,
  `'Palatino Linotype','Book Antiqua',serif`,
]

const fs = (cqw: number) => `clamp(0.5rem, ${cqw}cqw, 2.2rem)`
// Roughly how wide N chars are at 1cqw (avg glyph ~0.55em) → the cqw that fits N chars on one line.
const fitOneLine = (chars: number, widthPct = 86) => widthPct / (0.55 * Math.max(chars, 1))
const albumCqw = (n: number) => (n <= 14 ? 7.5 : n <= 24 ? 6 : n <= 40 ? 4.8 : n <= 60 ? 4 : 3.4)

const LIVE_RE = /\b(live|broadcast|tour|in concert|concert|unplugged|bootleg|sessions?)\b/i
const TEMPLATES = 9

export function GeneratedAlbumCover({ band, album, photo, className }: {
  band?: string; album?: string; photo?: string | null; className?: string
}) {
  // Treat a missing/placeholder credit as no band, so a cover never literally reads "Unknown Artist".
  const rawBand = (band ?? '').trim()
  const bandName = /^unknown artist$/i.test(rawBand) ? '' : rawBand
  const albumName = (album ?? '').trim()
  const seed = `${bandName}~${albumName}` || 'album'

  // Independent hashes → template, palette and font vary independently for many combinations.
  const p = COVER_PALETTES[hashInt(`${seed}#p`) % COVER_PALETTES.length]!
  const font = FONTS[hashInt(`${seed}#f`) % FONTS.length]!
  const template = hashInt(seed) % TEMPLATES
  const angle = 90 + (hashInt(`${seed}#a`) % 6) * 25 // 90..215deg gradient variety
  const live = LIVE_RE.test(albumName)
  const upper = hashInt(`${seed}#u`) % 4 !== 0 // mostly uppercase, occasionally title-case
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

  // Band name: size to fit one line across `widthPct` of the tile; only wrap if that would be
  // smaller than a readable floor (then it wraps at the floor size instead of shrinking to nothing).
  const Band = ({ widthPct = 86, weight = 900, max = 17, align = 'left' as const }: { widthPct?: number; weight?: number; max?: number; align?: 'left' | 'center' }) => {
    if (!bandName) return null
    const fit = fitOneLine(bandName.length, widthPct)
    const oneLine = fit >= 6
    const cqw = Math.min(oneLine ? fit : 8, max)
    return (
      <span style={{
        ...text, fontSize: fs(cqw), fontWeight: weight, lineHeight: 0.95, letterSpacing: '-0.01em',
        whiteSpace: oneLine ? 'nowrap' : 'normal', textAlign: align, maxWidth: '100%',
      }}>{bandName}</span>
    )
  }
  const Album = ({ color = p.accent, weight = 600, align = 'left' as const }: { color?: string; weight?: number; align?: 'left' | 'center' }) =>
    albumName ? <span style={{ ...text, fontSize: albumFs, fontWeight: weight, lineHeight: 1.05, color, opacity: 0.95, textAlign: align }}>{albumName}</span> : null

  return (
    <div className={cn('relative size-full overflow-hidden [container-type:inline-size]', className)}
      style={{ background: `linear-gradient(${angle}deg, ${p.c1}, ${p.c2})` }}>

      {/* 0 - photo on top, solid colour bar across the bottom */}
      {template === 0 && (<>
        <Photo pos="top" />
        <div className="absolute inset-x-0 bottom-0" style={{ height: '42%', background: p.c1 }} />
        <div className="absolute inset-x-0 bottom-0 flex flex-col justify-end" style={{ height: '42%', padding: '7%', gap: '2%' }}>
          <Band /><Album />
        </div>
        <Live />
      </>)}

      {/* 1 - title stacked at the top over the photo, scrim behind */}
      {template === 1 && (<>
        <Photo pos="center" />
        <div className="absolute inset-0" style={{ background: `linear-gradient(to bottom, ${p.c1}f2 2%, ${p.c1}40 34%, transparent 58%)` }} />
        <div className="absolute inset-x-0 top-0 flex flex-col" style={{ padding: '7%', gap: '1.5%' }}>
          <Band /><Album />
        </div>
        <Live />
      </>)}

      {/* 2 - centered, colour wash + a thin accent rule between the lines */}
      {template === 2 && (<>
        <Photo pos="center" />
        <div className="absolute inset-0" style={{ background: `linear-gradient(${angle}deg, ${p.c1}d9, ${p.c2}d9)` }} />
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center" style={{ padding: '11%', gap: '3.5%' }}>
          <Band widthPct={78} weight={800} align="center" />
          <div style={{ width: '28%', height: '0.6cqw', background: p.accent }} />
          <Album color={p.fg} weight={500} align="center" />
        </div>
        <Live />
      </>)}

      {/* 3 - band name as a vertical spine on a colour strip; album along the bottom */}
      {template === 3 && (<>
        <Photo pos="center" />
        <div className="absolute inset-y-0 left-0" style={{ width: '30%', background: `linear-gradient(to right, ${p.c1}, ${p.c1}cc)` }} />
        {bandName && (
          <span className="absolute inset-y-0 left-0 flex items-center justify-center" style={{
            width: '30%', ...text, writingMode: 'vertical-rl', transform: 'rotate(180deg)', whiteSpace: 'nowrap',
            fontSize: fs(Math.min(fitOneLine(bandName.length, 84), 15)), fontWeight: 900, letterSpacing: '0.01em', padding: '8% 0', lineHeight: 1,
          }}>{bandName}</span>
        )}
        <div className="absolute inset-x-0 bottom-0" style={{ background: `linear-gradient(to top, ${p.c1}, transparent)`, padding: '6% 6% 6% 34%' }}>
          <Album weight={600} />
        </div>
      </>)}

      {/* 4 - colour block with a diagonal accent strip */}
      {template === 4 && (<>
        <Photo pos="center" />
        <div className="absolute inset-0" style={{ background: `linear-gradient(${angle}deg, ${p.c1}f2, ${p.c2}e0)`, mixBlendMode: photo ? 'multiply' : 'normal' }} />
        {photo && <div className="absolute inset-0" style={{ background: `linear-gradient(to top, ${p.c1}b3, transparent 55%)` }} />}
        <div className="absolute" style={{ left: '-15%', right: '-15%', top: '56%', height: '9%', background: p.accent, transform: 'rotate(-7deg)', opacity: 0.92 }} />
        <div className="absolute inset-x-0 bottom-0 flex flex-col" style={{ padding: '7%', gap: '1.5%' }}>
          <Band /><Album color={p.fg} />
        </div>
        <Live />
      </>)}

      {/* 5 - two-tone diagonal split; band top-left, album bottom */}
      {template === 5 && (<>
        <div className="absolute inset-0" style={{ background: p.c2 }} />
        <div className="absolute inset-0" style={{ background: p.c1, clipPath: 'polygon(0 0, 100% 0, 0 100%)' }} />
        <div className="absolute" style={{ top: '6%', left: '6%', right: '6%' }}><Band max={15} /></div>
        <div className="absolute" style={{ bottom: '6%', left: '6%', right: '6%', textAlign: 'right' }}><Album color={p.fg} align="center" /></div>
        <Live />
      </>)}

      {/* 6 - framed poster: inset accent border, band top / album bottom, centered */}
      {template === 6 && (<>
        <Photo pos="center" />
        <div className="absolute inset-0" style={{ background: `linear-gradient(${angle}deg, ${p.c1}e6, ${p.c2}cc)`, mixBlendMode: photo ? 'multiply' : 'normal' }} />
        <div className="absolute" style={{ inset: '6%', border: `0.9cqw solid ${p.accent}` }} />
        <div className="absolute inset-0 flex flex-col items-center justify-between text-center" style={{ padding: '14%' }}>
          <Band widthPct={70} weight={800} align="center" />
          <Album color={p.fg} weight={500} align="center" />
        </div>
        <Live />
      </>)}

      {/* 7 - oversized band monogram behind the text */}
      {template === 7 && (<>
        <div className="absolute inset-0" style={{ background: `linear-gradient(${angle}deg, ${p.c1}, ${p.c2})` }} />
        {photo && <div className="absolute inset-0 opacity-30" style={{ mixBlendMode: 'luminosity' }}><Photo pos="center" /></div>}
        <span className="absolute inset-0 flex items-center justify-center" aria-hidden style={{
          fontFamily: FONTS[2], color: p.fg, opacity: 0.14, fontSize: '92cqw', fontWeight: 900, lineHeight: 1,
        }}>{(bandName || albumName || '?').charAt(0).toUpperCase()}</span>
        <div className="absolute inset-x-0 bottom-0 flex flex-col" style={{ padding: '7%', gap: '1.5%' }}>
          <Band /><Album color={p.accent} />
        </div>
        <Live />
      </>)}

      {/* 8 - photo full-bleed with an offset solid "sticker" tag holding the text */}
      {template === 8 && (<>
        <Photo pos="top" />
        {!photo && <div className="absolute inset-0" style={{ background: `linear-gradient(${angle}deg, ${p.c1}, ${p.c2})` }} />}
        <div className="absolute" style={{ left: '7%', right: '14%', bottom: '9%', background: p.c1, padding: '5% 6%', transform: 'rotate(-2deg)', boxShadow: '0 2cqw 6cqw rgba(0,0,0,0.35)' }}>
          <Band max={14} /><Album color={p.accent} />
        </div>
        <Live />
      </>)}
    </div>
  )
}
