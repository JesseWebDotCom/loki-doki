import type { ComponentType } from 'react'
import {
  IconDiscFilled, IconGuitarPickFilled, IconHeadphonesFilled, IconDeviceGamepad2Filled,
  IconPlayerPlayFilled, IconDeviceTvFilled, IconHeartFilled, IconMoonFilled, IconBarbellFilled,
  IconGiftFilled, IconGhostFilled, IconMugFilled, IconSparklesFilled, IconSunFilled, IconWorldFilled,
  IconFlameFilled, IconBoltFilled, IconStarFilled, IconConfettiFilled, IconMicrophoneFilled,
  IconCloudFilled, IconCarFilled, IconChristmasTreeFilled,
} from '@tabler/icons-react'
import { cn } from '@/lib/cn'
import { stationGradient } from '@/lib/music/stationColors'
import type { Station } from '@/lib/music/catalogApi'

// Filled (silhouette) Tabler icons — solid shapes that read boldly as large faint watermarks.
type Glyph = ComponentType<{ className?: string }>

const NAME_ICONS: [RegExp, Glyph][] = [
  [/8-?bit|chiptune|gaming|video game|vaporwave|arcade/, IconDeviceGamepad2Filled],
  [/metal|rage|mayhem/, IconFlameFilled],
  [/movie|cinema|film|tarantino|bond|western|sci-?fi|superhero|montage|rom-?com|soundtrack/, IconPlayerPlayFilled],
  [/horror|spooky|halloween/, IconGhostFilled],
  [/tv|nick|cartoon|disney|saturday|broadway|anime|theme/, IconDeviceTvFilled],
  [/hip-?hop|\brap\b|boom|new jack/, IconHeadphonesFilled],
  [/country|outlaw|honky|bluegrass|folk|acoustic|singer|campfire/, IconGuitarPickFilled],
  [/classical|orchestr|composer|symphony|score|jazz|swing|big band|bebop|smooth/, IconStarFilled],
  [/love|date|romance|sensual|heartbreak|feels|wedding|pride/, IconHeartFilled],
  [/sleep|calm|dream|moody/, IconMoonFilled],
  [/rain/, IconCloudFilled],
  [/workout|pump|training|gym|motivat|get it done|stadium|confidence|boss/, IconBarbellFilled],
  [/holiday|christmas|festive/, IconChristmasTreeFilled],
  [/coffee|morning|cafe|café|coffeehouse/, IconMugFilled],
  [/focus|study|lo-?fi|chill|mellow|meditat|yoga|zen/, IconSparklesFilled],
  [/disco|euphoric|party|club|festival|karaoke/, IconConfettiFilled],
  [/electronic|synth|house|techno|edm|pulse|nu-?metal/, IconBoltFilled],
  [/k-?pop|bollywood|latin|reggaeton|global|afro|reggae|island|tropical|ska/, IconWorldFilled],
  [/blues|soul|gospel|funk|motown|r&b|rnb/, IconMicrophoneFilled],
  [/rock|grunge|punk|britpop|glam|garage|psychedelic|prog|rockabilly|southern|hair|yacht/, IconGuitarPickFilled],
  [/roadtrip|road trip|driving/, IconCarFilled],
  [/summer|beach|surf|\bsun\b|good times|happy|feel-?good|vibes/, IconSunFilled],
  [/gift/, IconGiftFilled],
  [/decade|80s|90s|70s|60s|50s|2000s|2010s|2020s|nostalgia|throwback|oldies|era|invasion|jazz age|y2k|viral|hits|today|now/, IconDiscFilled],
]
const CAT_ICONS: Record<string, Glyph> = {
  Featured: IconStarFilled, Genres: IconDiscFilled, Decades: IconDiscFilled, Eras: IconDiscFilled,
  Moods: IconHeartFilled, Activities: IconBarbellFilled, Movies: IconPlayerPlayFilled,
  'TV & Cartoons': IconDeviceTvFilled, Gaming: IconDeviceGamepad2Filled, Global: IconWorldFilled,
  Classics: IconGuitarPickFilled, Themed: IconSparklesFilled,
}

function glyphFor(name: string, category: string | null): Glyph {
  const n = name.toLowerCase()
  for (const [re, Icon] of NAME_ICONS) if (re.test(n)) return Icon
  if (category && CAT_ICONS[category]) return CAT_ICONS[category]!
  return IconDiscFilled
}

/** A station tile: accent gradient with a large filled-icon silhouette. Resolution-independent and
 *  fully offline — used as the card art and as the station-page hero background. */
export function StationArt({ station, className }: {
  station: Pick<Station, 'name' | 'accent' | 'category'>; className?: string
}) {
  const Icon = glyphFor(station.name, station.category)
  return (
    <div className={cn('relative size-full overflow-hidden', className)} style={{ background: stationGradient(station.accent) }}>
      {/* Drifting ambient glow — slow, subtle life behind the silhouette. */}
      <div className="station-art-glow pointer-events-none absolute -inset-[25%] rounded-full bg-[radial-gradient(circle_at_30%_30%,rgba(255,255,255,0.28),transparent_62%)] blur-2xl" />
      <Icon className="station-art-float absolute -bottom-[14%] -right-[8%] h-[135%] w-auto text-white/[0.16]" />
      <Icon className="absolute left-3 top-3 size-5 text-white/80" />
      {/* Light sweep on hover (only animates inside a `group`, e.g. StationCard). */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-0 transition-opacity duration-300 group-hover:opacity-100">
        <div className="absolute inset-y-0 -left-1/3 w-1/3 -skew-x-12 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-[shimmer_1.8s_ease-in-out_infinite]" />
      </div>
    </div>
  )
}
