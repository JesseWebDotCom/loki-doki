import type { ComponentType } from 'react'
import {
  IconDiscFilled, IconGuitarPickFilled, IconHeadphonesFilled, IconDeviceGamepad2Filled,
  IconPlayerPlayFilled, IconDeviceTvFilled, IconHeartFilled, IconHeartBrokenFilled,
  IconMoonFilled, IconBarbellFilled, IconGhostFilled, IconMugFilled, IconSparklesFilled,
  IconSunFilled, IconWorldFilled, IconGlobeFilled, IconFlameFilled, IconBoltFilled,
  IconStarFilled, IconConfettiFilled, IconMicrophoneFilled, IconCloudFilled, IconCarFilled,
  IconChristmasTreeFilled, IconGiftFilled, IconTrophyFilled, IconAwardFilled, IconCrownFilled,
  IconDiamondFilled, IconSpeedboatFilled, IconFlowerFilled, IconCampfireFilled,
  IconFeatherFilled, IconGlassFullFilled, IconBeerFilled, IconUfoFilled, IconAlienFilled,
  IconChefHatFilled, IconMountainFilled,
} from '@tabler/icons-react'
import { cn } from '@/lib/cn'
import { stationGradient } from '@/lib/music/stationColors'
import type { Station } from '@/lib/music/catalogApi'

type Glyph = ComponentType<{ className?: string }>

// Specific patterns first — first match wins, so sub-genres must precede their parent genre.
const NAME_ICONS: [RegExp, Glyph][] = [
  // ── Gaming ───────────────────────────────────────────────────────────────────
  [/retro gaming|classic game/, IconDiscFilled],
  [/8-?bit|chiptune/, IconBoltFilled],
  [/video game remix|game remix/, IconHeadphonesFilled],
  [/modern game soundtrack|cinematic game/, IconStarFilled],
  [/vaporwave/, IconMoonFilled],
  [/video game|gaming|jrpg|rpg|nintendo|playstation|arcade/, IconDeviceGamepad2Filled],

  // ── Film / Movies ─────────────────────────────────────────────────────────────
  [/bond\b|james bond|spy thriller/, IconDiamondFilled],
  [/tarantino|needle.?drop|cult film|exploitation/, IconFlameFilled],
  [/western|spaghetti western|outlaw film/, IconGuitarPickFilled],
  [/horror|spooky|halloween|scary|slasher/, IconGhostFilled],
  [/sci-?fi|space opera|extraterrestrial|alien invasion/, IconUfoFilled],
  [/superhero|marvel|dc comics|action movie/, IconBoltFilled],
  [/rom-?com|romcom|romantic comedy/, IconHeartFilled],
  [/training montage|sports film/, IconBarbellFilled],
  [/80s.*movie|movie.*80s/, IconDiscFilled],
  [/epic.*score|film score|movie score|cinema score|hans zimmer|john williams/, IconStarFilled],
  [/movie|cinema|film|soundtrack|montage/, IconPlayerPlayFilled],

  // ── TV & Cartoons ─────────────────────────────────────────────────────────────
  [/anime|studio ghibli|shonen/, IconWorldFilled],
  [/broadway|musical|showstopper|stage show|cabaret/, IconMicrophoneFilled],
  [/disney channel|dcom/, IconSparklesFilled],
  [/disney|pixar|dreamworks|animated film|animated movie/, IconSparklesFilled],
  [/nickelodeon|rugrats|spongebob|hey arnold/, IconConfettiFilled],
  [/cartoon network|toonami|adult swim/, IconBoltFilled],
  [/saturday morning|after school cartoon/, IconSunFilled],
  [/sitcom|comedy show|sketch/, IconConfettiFilled],
  [/tv theme|television theme|theme song|show theme/, IconDiscFilled],
  [/tv|cartoon|nick\b/, IconDeviceTvFilled],

  // ── Hip-Hop & R&B ─────────────────────────────────────────────────────────────
  [/hip-?hop|boom bap|golden age hip/, IconHeadphonesFilled],
  [/trap|\brap\b|drill|mumble/, IconHeadphonesFilled],
  [/new jack swing/, IconDiscFilled],
  [/motown|neo-?soul/, IconMicrophoneFilled],
  [/gospel|spiritual|choir/, IconMicrophoneFilled],
  [/r&b|rnb|contemporary r/, IconHeartFilled],

  // ── Blues, Soul, Funk ─────────────────────────────────────────────────────────
  [/blues|delta blues|chicago blues/, IconMicrophoneFilled],
  [/funk|p-?funk|parliament/, IconMicrophoneFilled],
  [/soul\b|soul music/, IconMicrophoneFilled],

  // ── Jazz ──────────────────────────────────────────────────────────────────────
  [/jazz age|roaring 20s|ragtime/, IconGlassFullFilled],    // speakeasy cocktail vibe
  [/big band|swing|dixieland/, IconConfettiFilled],         // ballroom dancing
  [/bebop|hard bop|cool jazz|jazz fusion|free jazz/, IconMicrophoneFilled],
  [/smooth jazz|lounge jazz|cocktail jazz|dinner jazz/, IconGlassFullFilled],
  [/bossa nova|latin jazz|afro-?cuban jazz/, IconWorldFilled],
  [/jazz/, IconGlassFullFilled],                            // jazz club atmosphere

  // ── Classical ─────────────────────────────────────────────────────────────────
  [/opera|aria|bel canto/, IconMicrophoneFilled],
  [/baroque|renaissance music|early music/, IconCrownFilled],
  [/classical|orchestr|composer|symphony|concerto|chamber/, IconStarFilled],

  // ── Country / Folk / Americana ───────────────────────────────────────────────
  [/bluegrass|banjo|appalachian|string band/, IconGuitarPickFilled],
  [/outlaw country|country|honky|tonk|americana/, IconGuitarPickFilled],
  [/campfire|coffeehouse|camp songs/, IconCampfireFilled],
  [/folk|acoustic/, IconCampfireFilled],
  [/singer-?songwriter|indie folk/, IconFeatherFilled],     // songwriter's quill

  // ── Rock ──────────────────────────────────────────────────────────────────────
  [/psychedelic rock|acid rock|space rock|krautrock/, IconAlienFilled],  // trippy/mind-bending
  [/prog(ressive)? rock|art rock|math rock|concept album/, IconBoltFilled],
  [/glam rock|glam metal|hair metal/, IconDiamondFilled],
  [/surf rock|beach rock/, IconSunFilled],
  [/yacht rock/, IconSpeedboatFilled],                      // literal boat
  [/rockabilly|doo-?wop|50s rock|sock hop/, IconDiscFilled],
  [/nu-?metal|djent|post-?metal/, IconFlameFilled],
  [/punk rock|hardcore punk|emo|post-?punk/, IconFlameFilled],
  [/grunge|noise rock|shoegaze/, IconFlameFilled],
  [/garage rock/, IconFlameFilled],
  [/britpop|indie pop|jangle pop|dream pop/, IconHeadphonesFilled],
  [/ska\b|rocksteady/, IconWorldFilled],
  [/southern rock|swamp rock|bayou/, IconGuitarPickFilled],
  [/stadium|arena rock|power ballad/, IconBarbellFilled],
  [/heavy metal|thrash|death metal|black metal/, IconFlameFilled],
  [/metal|rage|mayhem|headbang/, IconFlameFilled],
  [/alternative rock|alt-?rock/, IconGuitarPickFilled],
  [/indie rock|college rock/, IconHeadphonesFilled],
  [/rock\b/, IconGuitarPickFilled],

  // ── Electronic & Dance ───────────────────────────────────────────────────────
  [/ambient|drone|new age|soundscape|atmospheric/, IconMoonFilled],
  [/trance|psy-?trance|goa/, IconAlienFilled],              // otherworldly/trippy
  [/drum.?and.?bass|dnb|jungle|breakbeat/, IconBoltFilled],
  [/deep house|tech house|house music|garage house/, IconConfettiFilled],
  [/techno|industrial techno|ebm/, IconBoltFilled],
  [/synthwave|retrowave|outrun/, IconBoltFilled],
  [/synth-?pop|electropop|new wave/, IconBoltFilled],
  [/edm|electronic dance|big room|festival edm/, IconConfettiFilled],
  [/electronic|synth|pulse/, IconBoltFilled],
  [/disco fever|disco ball|glitter/, IconGlobeFilled],      // disco ball = globe shape
  [/disco|dancefloor|boogie|funky house/, IconConfettiFilled],
  [/party|club night|festival/, IconConfettiFilled],
  [/karaoke|pub night|sing.?along/, IconBeerFilled],

  // ── Global ────────────────────────────────────────────────────────────────────
  [/k-?pop|kpop/, IconStarFilled],
  [/j-?pop|city pop|japanese pop/, IconWorldFilled],
  [/reggaeton|reggaetón|salsa|cumbia|merengue|bachata/, IconConfettiFilled],
  [/latin.*party|latin.*dance|party.*latin/, IconConfettiFilled],
  [/latin heat|latin fire/, IconFlameFilled],
  [/latin\b|latin pop|latin rock/, IconWorldFilled],
  [/bollywood|desi|bhangra|hindi film/, IconSparklesFilled],
  [/afrobeats|afropop|highlife|juju/, IconSunFilled],
  [/reggae|dancehall|dub|caribbean/, IconSunFilled],
  [/celtic|irish|scottish|welsh/, IconGuitarPickFilled],
  [/tropical|island vibes/, IconSunFilled],
  [/global|world music/, IconWorldFilled],

  // ── Mood ─────────────────────────────────────────────────────────────────────
  [/dinner party|dinner music|supper club|cocktail hour|wine and/, IconGlassFullFilled],
  [/love song|date night|romance|sensual|wedding|valentines/, IconHeartFilled],
  [/heartbreak|breakup|sad songs|melancholy|crying/, IconHeartBrokenFilled],
  [/pride|empowerment|feminist|girl power/, IconStarFilled],
  [/sleep|lullaby|bedtime/, IconMoonFilled],
  [/calm|meditat|yoga|zen|mindful/, IconSparklesFilled],
  [/rain|rainy|storm/, IconCloudFilled],
  [/feels|emotional|introspective/, IconMoonFilled],
  [/happy|joy|upbeat|cheerful/, IconSunFilled],
  [/good times|feel-?good|vibes|positive/, IconSunFilled],

  // ── Activity ─────────────────────────────────────────────────────────────────
  [/workout|pump up|gym|run\b|running|sport/, IconBarbellFilled],
  [/hiking|mountain|outdoor|trail/, IconMountainFilled],
  [/confidence|boss|hustle|grind|motivat/, IconBarbellFilled],
  [/focus|deep work|study|productivity|coding/, IconSparklesFilled],
  [/lo-?fi|chill study|study beats/, IconMoonFilled],
  [/relax|chill out|mellow/, IconMoonFilled],
  [/cooking|chef|kitchen|baking|foodie/, IconChefHatFilled],
  [/coffee|morning routine|wake up|sunrise|cafe|café/, IconMugFilled],
  [/road ?trip|driving|highway/, IconCarFilled],
  [/summer|beach|\bsun\b|sunshine|surf/, IconSunFilled],
  [/dream|dreamy/, IconMoonFilled],

  // ── Holiday / Seasonal ───────────────────────────────────────────────────────
  [/christmas|xmas/, IconChristmasTreeFilled],
  [/holiday|festive|gift|winter holiday/, IconGiftFilled],

  // ── Eras ──────────────────────────────────────────────────────────────────────
  [/british invasion/, IconGuitarPickFilled],
  [/flower power|hippie/, IconFlowerFilled],                // literal flower
  [/psychedelic 60|summer of love/, IconFlowerFilled],

  // ── Decades ───────────────────────────────────────────────────────────────────
  [/golden oldi|50s gold/, IconCrownFilled],
  [/\b40s\b/, IconCrownFilled],
  [/\b50s\b/, IconCrownFilled],
  [/\b60s\b|sixties/, IconFlowerFilled],                   // flower power era
  [/\b70s\b|seventies/, IconGlobeFilled],                  // disco ball era
  [/\b80s\b|eighties/, IconBoltFilled],                    // synth & new wave
  [/\b90s\b|nineties/, IconGuitarPickFilled],              // grunge & alternative
  [/\b2000s\b|y2k|noughties/, IconHeadphonesFilled],       // iPod/digital era
  [/\b2010s\b/, IconBoltFilled],                           // EDM era
  [/nostalgia|throwback|oldies|golden age|classic era|retro|vintage pop/, IconDiscFilled],

  // ── Superlatives / Compilations ──────────────────────────────────────────────
  [/greatest hits|best of|essential|definitive|ultimate|all-?time/, IconAwardFilled],
  [/classic\b|timeless|legendary|iconic/, IconCrownFilled],
  [/viral|trending|top songs|top 40|charts|today|now|fresh|new music/, IconDiscFilled],
  [/hits\b/, IconDiscFilled],
]

const CAT_ICONS: Record<string, Glyph> = {
  Featured: IconStarFilled, Genres: IconDiscFilled, Decades: IconDiscFilled, Eras: IconDiscFilled,
  Moods: IconHeartFilled, Activities: IconBarbellFilled, Movies: IconPlayerPlayFilled,
  'TV & Cartoons': IconDeviceTvFilled, Gaming: IconDeviceGamepad2Filled, Global: IconWorldFilled,
  Classics: IconCrownFilled, Themed: IconSparklesFilled,
}

function glyphFor(name: string, category: string | null): Glyph {
  const n = name.toLowerCase()
  for (const [re, Icon] of NAME_ICONS) if (re.test(n)) return Icon
  if (category && CAT_ICONS[category]) return CAT_ICONS[category]!
  return IconDiscFilled
}

/**
 * Single unified station cover tile — rich gradient + bold name + large watermark icon.
 * For stations with real photo art (movie/show/YT poster), the photo fills the tile with a
 * gradient scrim so the name stays legible.
 * showName=false for hero contexts where an h1 already carries the name.
 */
export function StationArt({ station, className, showName = true }: {
  station: Pick<Station, 'name' | 'accent' | 'category' | 'iconUrl'>
  className?: string
  showName?: boolean
}) {
  const Icon = glyphFor(station.name, station.category)

  return (
    <div
      className={cn('relative size-full overflow-hidden', className)}
      style={{ background: stationGradient(station.accent) }}
    >
      {/* Photo fill — real art only (movie/show/YT poster). SVG placeholders are excluded
          by the backend serializer so iconUrl is null for those stations. */}
      {station.iconUrl && (
        <img
          src={station.iconUrl}
          alt=""
          className="absolute inset-0 size-full object-cover"
          onError={e => { e.currentTarget.style.display = 'none' }}
        />
      )}

      {/* Large watermark icon — oversized, anchored bottom-right, bleeds off card edges */}
      {!station.iconUrl && (
        <Icon className="pointer-events-none absolute -bottom-[14%] -right-[8%] h-[130%] w-auto text-white/[0.13]" />
      )}

      {/* Bottom scrim — always present for legibility */}
      <div className="absolute inset-x-0 bottom-0 h-4/5 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />

      {/* Name wordmark */}
      {showName && (
        <div className="absolute bottom-0 left-0 right-0 p-4 pr-12">
          <p className="line-clamp-2 text-base font-black leading-tight tracking-tight text-white [text-shadow:0_1px_4px_rgba(0,0,0,0.4)]">
            {station.name}
          </p>
        </div>
      )}

      {/* Shimmer on hover */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-0 transition-opacity duration-300 group-hover:opacity-100">
        <div className="absolute inset-y-0 -left-1/3 w-1/3 -skew-x-12 animate-[shimmer_1.8s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/20 to-transparent" />
      </div>
    </div>
  )
}
