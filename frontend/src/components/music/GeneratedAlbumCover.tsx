// Deterministic album-cover generator - the last-resort art for albums with no real cover (live
// bootlegs / broadcasts that no cover source carries). Designed to read like ALBUM ART, not a
// podcast tile: the band photo is ALWAYS the base layer (when one is available), with a designed
// colour treatment layered over/around it, the BAND name set large and the ALBUM title smaller,
// across many poster templates with varied fonts, palettes, placements and colour strips. A LIVE
// stamp (varied style + placement) marks live/broadcast titles. Everything is chosen by hashing the
// band+album (independent hashes for template / palette / font / stamp), so a given album always
// renders the same cover - and, unlike a fuzzy image match, it never shows the WRONG album.
//
// Band name is sized to fit ONE line (only wraps when even the smallest readable size can't fit).
// Album titles shrink by length so they fit without a hard clamp - nothing is cut off.

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
// Roughly the cqw that fits N chars on one line (avg glyph ~0.55em) across `widthPct` of the tile.
const fitOneLine = (chars: number, widthPct = 86) => widthPct / (0.55 * Math.max(chars, 1))
const albumCqw = (n: number) => (n <= 14 ? 7.5 : n <= 24 ? 6 : n <= 40 ? 4.8 : n <= 60 ? 4 : 3.4)
const shadow = '0 1px 6px rgba(0,0,0,0.55)'

const LIVE_RE = /\b(live|broadcast|tour|in concert|concert|unplugged|bootleg|sessions?)\b/i
const TEMPLATES = 9
type Corner = 'tr' | 'tl' | 'br' | 'bl'

export function GeneratedAlbumCover({ band, album, photo, className }: {
  band?: string; album?: string; photo?: string | null; className?: string
}) {
  // Treat a missing/placeholder credit as no band, so a cover never literally reads "Unknown Artist".
  const rawBand = (band ?? '').trim()
  const bandName = /^unknown artist$/i.test(rawBand) ? '' : rawBand
  const albumName = (album ?? '').trim()
  const seed = `${bandName}~${albumName}` || 'album'

  // Independent hashes → template, palette, font and stamp vary independently for many combinations.
  const p = COVER_PALETTES[hashInt(`${seed}#p`) % COVER_PALETTES.length]!
  const font = FONTS[hashInt(`${seed}#f`) % FONTS.length]!
  const template = hashInt(seed) % TEMPLATES
  const angle = 90 + (hashInt(`${seed}#a`) % 6) * 25 // 90..215deg gradient variety
  const live = LIVE_RE.test(albumName)
  const stampStyle = hashInt(`${seed}#s`) % 4
  const upper = hashInt(`${seed}#u`) % 4 !== 0 // mostly uppercase, occasionally title-case
  const albumFs = fs(albumCqw(albumName.length || 1))

  const text = {
    fontFamily: font, color: p.fg, textShadow: shadow,
    textTransform: upper ? ('uppercase' as const) : ('none' as const),
    overflowWrap: 'anywhere' as const, wordBreak: 'break-word' as const,
  }

  // The band photo - always the base layer when we have one.
  const Photo = ({ pos = 'center' }: { pos?: string }) =>
    photo ? (
      <img src={proxyImg(photo)} alt="" loading="lazy" className="absolute inset-0 size-full object-cover"
        style={{ objectPosition: pos }} onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
    ) : <div className="absolute inset-0" style={{ background: `linear-gradient(${angle}deg, ${p.c1}, ${p.c2})` }} />

  // LIVE stamp - style varies by hash, placement by the free corner the template passes in.
  const Live = ({ corners }: { corners: Corner[] }) => {
    if (!live) return null
    const corner = corners[hashInt(`${seed}#c`) % corners.length]!
    const vy = corner[0] === 't' ? { top: '7%' } : { bottom: '7%' }
    const vx = corner[1] === 'r' ? { right: '7%' } : { left: '7%' }
    if (stampStyle === 0) // outlined box, tilted
      return <span className="absolute" style={{ ...vy, ...vx, transform: 'rotate(6deg)', border: `0.6cqw solid ${p.fg}`, color: p.fg, fontFamily: FONTS[2], fontWeight: 800, letterSpacing: '0.12em', padding: '0.4cqw 1.8cqw', fontSize: '5.5cqw', lineHeight: 1, textShadow: shadow }}>LIVE</span>
    if (stampStyle === 1) // solid pill
      return <span className="absolute" style={{ ...vy, ...vx, background: p.accent, color: p.c1, fontFamily: FONTS[4], fontWeight: 800, letterSpacing: '0.14em', padding: '0.9cqw 2.4cqw', borderRadius: '999px', fontSize: '5cqw', lineHeight: 1 }}>LIVE</span>
    if (stampStyle === 2) // round seal
      return <span className="absolute grid place-items-center" style={{ ...vy, ...vx, width: '20cqw', height: '20cqw', borderRadius: '999px', border: `0.7cqw solid ${p.fg}`, color: p.fg, fontFamily: FONTS[0], fontWeight: 800, letterSpacing: '0.08em', fontSize: '4.6cqw', textShadow: shadow }}>LIVE</span>
    // corner ribbon banner (diagonal across the corner)
    const ribbon = {
      tr: { top: '9%', right: '-24%', rotate: '45deg' }, tl: { top: '9%', left: '-24%', rotate: '-45deg' },
      br: { bottom: '9%', right: '-24%', rotate: '-45deg' }, bl: { bottom: '9%', left: '-24%', rotate: '45deg' },
    }[corner]
    return <span className="absolute grid place-items-center" style={{ top: (ribbon as any).top, bottom: (ribbon as any).bottom, left: (ribbon as any).left, right: (ribbon as any).right, width: '62%', transform: `rotate(${ribbon.rotate})`, background: p.accent, color: p.c1, fontFamily: FONTS[4], fontWeight: 800, letterSpacing: '0.18em', padding: '1.2cqw 0', fontSize: '4.6cqw', boxShadow: '0 1cqw 3cqw rgba(0,0,0,0.35)' }}>LIVE</span>
  }

  // Band name: fit one line across `widthPct`; only wrap if that would be smaller than a readable
  // floor (then it wraps at the floor size rather than shrinking to nothing).
  const Band = ({ widthPct = 86, weight = 900, max = 17, align = 'left' as const }: { widthPct?: number; weight?: number; max?: number; align?: 'left' | 'center' }) => {
    if (!bandName) return null
    const fit = fitOneLine(bandName.length, widthPct)
    const oneLine = fit >= 6
    const cqw = Math.min(oneLine ? fit : 8, max)
    return <span style={{ ...text, fontSize: fs(cqw), fontWeight: weight, lineHeight: 0.95, letterSpacing: '-0.01em', whiteSpace: oneLine ? 'nowrap' : 'normal', textAlign: align, maxWidth: '100%' }}>{bandName}</span>
  }
  const Album = ({ color = p.accent, weight = 600, align = 'left' as const }: { color?: string; weight?: number; align?: 'left' | 'center' }) =>
    albumName ? <span style={{ ...text, fontSize: albumFs, fontWeight: weight, lineHeight: 1.05, color, opacity: 0.98, textAlign: align }}>{albumName}</span> : null

  return (
    <div className={cn('relative size-full overflow-hidden [container-type:inline-size]', className)}
      style={{ background: `linear-gradient(${angle}deg, ${p.c1}, ${p.c2})` }}>

      {/* 0 - photo, solid colour bar across the bottom */}
      {template === 0 && (<>
        <Photo pos="top" />
        <div className="absolute inset-x-0 bottom-0" style={{ height: '42%', background: p.c1 }} />
        <div className="absolute inset-x-0 bottom-0 flex flex-col justify-end" style={{ height: '42%', padding: '7%', gap: '2%' }}>
          <Band /><Album />
        </div>
        <Live corners={['tr', 'tl']} />
      </>)}

      {/* 1 - title at the top over the photo, scrim behind */}
      {template === 1 && (<>
        <Photo pos="center" />
        <div className="absolute inset-0" style={{ background: `linear-gradient(to bottom, ${p.c1}f0 2%, ${p.c1}40 34%, transparent 58%)` }} />
        <div className="absolute inset-x-0 top-0 flex flex-col" style={{ padding: '7%', gap: '1.5%' }}>
          <Band /><Album />
        </div>
        <Live corners={['br', 'bl']} />
      </>)}

      {/* 2 - centered over the photo, vignette + thin accent rule */}
      {template === 2 && (<>
        <Photo pos="center" />
        <div className="absolute inset-0" style={{ background: `radial-gradient(ellipse at center, ${p.c1}33 8%, ${p.c1}cc 96%)` }} />
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center" style={{ padding: '11%', gap: '3.5%' }}>
          <Band widthPct={78} weight={800} align="center" />
          <div style={{ width: '28%', height: '0.6cqw', background: p.accent }} />
          <Album color={p.fg} weight={500} align="center" />
        </div>
        <Live corners={['tr', 'tl', 'br', 'bl']} />
      </>)}

      {/* 3 - band name as a vertical spine on a colour strip; album along the bottom */}
      {template === 3 && (<>
        <Photo pos="center" />
        <div className="absolute inset-y-0 left-0" style={{ width: '30%', background: `linear-gradient(to right, ${p.c1}, ${p.c1}b3)` }} />
        {bandName && (
          <span className="absolute inset-y-0 left-0 flex items-center justify-center" style={{
            width: '30%', ...text, writingMode: 'vertical-rl', transform: 'rotate(180deg)', whiteSpace: 'nowrap',
            fontSize: fs(Math.min(fitOneLine(bandName.length, 84), 15)), fontWeight: 900, letterSpacing: '0.01em', padding: '8% 0', lineHeight: 1,
          }}>{bandName}</span>
        )}
        <div className="absolute inset-x-0 bottom-0" style={{ background: `linear-gradient(to top, ${p.c1}, transparent)`, padding: '6% 6% 6% 34%' }}>
          <Album weight={600} />
        </div>
        <Live corners={['tr']} />
      </>)}

      {/* 4 - photo with a diagonal accent strip + bottom colour fade */}
      {template === 4 && (<>
        <Photo pos="center" />
        <div className="absolute inset-0" style={{ background: `linear-gradient(to top, ${p.c1}f2 6%, ${p.c1}66 40%, transparent 66%)` }} />
        <div className="absolute" style={{ left: '-15%', right: '-15%', top: '56%', height: '9%', background: p.accent, transform: 'rotate(-7deg)', opacity: 0.92 }} />
        <div className="absolute inset-x-0 bottom-0 flex flex-col" style={{ padding: '7%', gap: '1.5%' }}>
          <Band /><Album color={p.fg} />
        </div>
        <Live corners={['tr', 'tl']} />
      </>)}

      {/* 5 - photo base, colour triangle over the top-left half; band on it, album over the photo */}
      {template === 5 && (<>
        <Photo pos="center" />
        <div className="absolute inset-0" style={{ background: p.c1, opacity: 0.86, clipPath: 'polygon(0 0, 100% 0, 0 100%)' }} />
        <div className="absolute inset-0" style={{ background: `linear-gradient(to top, ${p.c2}d9, transparent 46%)` }} />
        <div className="absolute" style={{ top: '6%', left: '6%', right: '30%' }}><Band max={15} /></div>
        <div className="absolute" style={{ bottom: '6%', left: '6%', right: '6%' }}><Album color={p.fg} /></div>
        <Live corners={['tr']} />
      </>)}

      {/* 6 - framed poster: inset accent border over the photo, band top / album bottom */}
      {template === 6 && (<>
        <Photo pos="center" />
        <div className="absolute inset-0" style={{ background: `linear-gradient(to bottom, ${p.c1}c0 0%, transparent 32%, transparent 66%, ${p.c1}d9 100%)` }} />
        <div className="absolute" style={{ inset: '6%', border: `0.9cqw solid ${p.accent}` }} />
        <div className="absolute inset-0 flex flex-col items-center justify-between text-center" style={{ padding: '13%' }}>
          <Band widthPct={70} weight={800} align="center" />
          <Album color={p.fg} weight={500} align="center" />
        </div>
        {/* band is top-center → keep the stamp off it (bottom corners only) */}
        <Live corners={['br', 'bl']} />
      </>)}

      {/* 7 - photo with an oversized band-initial monogram, text at the bottom */}
      {template === 7 && (<>
        <Photo pos="center" />
        <div className="absolute inset-0" style={{ background: `linear-gradient(to top, ${p.c1}f0 4%, ${p.c1}59 44%, ${p.c1}26 100%)` }} />
        <span className="absolute inset-0 flex items-center justify-center" aria-hidden style={{ fontFamily: FONTS[2], color: p.fg, opacity: 0.16, fontSize: '90cqw', fontWeight: 900, lineHeight: 1 }}>
          {(bandName || albumName || '?').charAt(0).toUpperCase()}
        </span>
        <div className="absolute inset-x-0 bottom-0 flex flex-col" style={{ padding: '7%', gap: '1.5%' }}>
          <Band /><Album color={p.accent} />
        </div>
        <Live corners={['tr', 'tl']} />
      </>)}

      {/* 8 - photo full-bleed with an offset solid "sticker" tag holding the text */}
      {template === 8 && (<>
        <Photo pos="top" />
        <div className="absolute inset-0" style={{ background: `linear-gradient(to top, ${p.c1}59, transparent 60%)` }} />
        <div className="absolute" style={{ left: '7%', right: '14%', bottom: '9%', background: p.c1, padding: '5% 6%', transform: 'rotate(-2deg)', boxShadow: '0 2cqw 6cqw rgba(0,0,0,0.4)' }}>
          <Band max={14} /><Album color={p.accent} />
        </div>
        {/* text sticker sits bottom-left → stamp stays top-right */}
        <Live corners={['tr']} />
      </>)}
    </div>
  )
}
