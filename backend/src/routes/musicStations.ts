// Music stations API — generative AI radio stations. Build a queue from a seed, full CRUD for
// user-owned stations, family sharing (private ↔ shared), clone-a-shared-station, and the
// built-in default roster reconciled on every install.

import { Hono } from 'hono'
import { eq, or, isNull, desc } from 'drizzle-orm'
import { readFile } from 'node:fs/promises'
import { db } from '@/db'
import { musicStations, users } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { buildStationQueue, type StationSeed, type StationSeedType } from '@/lib/music/stationEngine'
import { enqueueVideoSave } from '@/lib/youtube/automation'
import { generateStationArt } from '@/lib/music/stationArt'
import { accentForSeed } from '@/lib/music/accents'
import { resolveUserPath } from '@/lib/storage/paths'
import { logger } from '@/lib/logger'
import type { AppEnv } from '@/types'

export const musicStations_route = new Hono<AppEnv>()
musicStations_route.use('*', requireAuth)
// Exported under the original name the index registers.
export { musicStations_route as musicStations }

type StationRow = typeof musicStations.$inferSelect

function serialize(row: StationRow, currentUserId: string, ownerName?: string | null) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    aiPrompt: row.aiPrompt,
    seedType: row.seedType,
    seedValue: row.seedValue,
    djMode: row.djMode,
    visibility: row.visibility,
    accent: row.accent,
    category: row.category,
    isBuiltin: row.isBuiltin,
    owned: row.userId === currentUserId,
    ownerName: row.userId === currentUserId ? null : (ownerName ?? null),
    iconUrl: row.iconPath ? `/api/music/stations/${row.id}/art/icon` : null,
    bannerUrl: row.bannerPath ? `/api/music/stations/${row.id}/art/banner` : null,
  }
}

// ── Built-in default roster (shipped on every install) ─────────────────────────────
interface BuiltinStation { id: string; name: string; description: string; aiPrompt: string; accent: string; djMode: 'full' | 'minimal' | 'silent' }
const DEFAULT_MUSIC_STATIONS: BuiltinStation[] = [
  // ── Charts & essentials ──────────────────────────────────────────────────────────
  { id: 'builtin:todays-hits', name: "Today's Hits", description: 'The biggest songs on the charts right now', aiPrompt: 'Current mainstream pop and hip-hop hits dominating the charts this year. High energy, recognizable, radio-friendly.', accent: 'fuchsia', djMode: 'full' },
  { id: 'builtin:viral-hits', name: 'Viral Hits', description: 'The songs blowing up on TikTok and socials', aiPrompt: 'Songs going viral on TikTok and social media right now, plus the catchy hooks everyone is using. Trendy, hooky, of-the-moment pop, hip-hop, and hyperpop.', accent: 'rose', djMode: 'full' },
  { id: 'builtin:feel-good-classics', name: 'Feel-Good Classics', description: 'Sing-along favorites that never get old', aiPrompt: 'Universally loved feel-good songs across decades: motown, classic pop, soft rock, and sing-along anthems everyone knows.', accent: 'blue', djMode: 'full' },
  { id: 'builtin:one-hit-wonders', name: 'One-Hit Wonders', description: 'The songs, not the artists, you remember', aiPrompt: 'Famous one-hit wonders from the 70s through the 2000s: the unforgettable singles from artists who never charted big again. Fun and nostalgic.', accent: 'amber', djMode: 'full' },
  { id: 'builtin:guilty-pleasures', name: 'Guilty Pleasures', description: 'Cheesy bangers you secretly love', aiPrompt: 'Cheesy, over-the-top pop and rock guilty pleasures: power ballads, bubblegum pop, and unapologetic earworms you sing in the car.', accent: 'fuchsia', djMode: 'full' },

  // ── Genres ───────────────────────────────────────────────────────────────────────
  { id: 'builtin:hip-hop-now', name: 'Hip-Hop Central', description: 'The best of rap, old school to new', aiPrompt: 'A broad mix of hip-hop and rap: current chart hits alongside 90s and 2000s classics. East coast, west coast, trap, and lyrical legends.', accent: 'slate', djMode: 'full' },
  { id: 'builtin:classic-rock', name: 'Classic Rock Highway', description: 'Timeless guitar anthems for the open road', aiPrompt: 'Classic rock staples from the 60s through the 80s: arena rock, blues rock, and driving anthems. Think the essential canon.', accent: 'amber', djMode: 'full' },
  { id: 'builtin:throwback-rnb', name: 'Throwback R&B', description: '90s and 2000s slow jams and grooves', aiPrompt: '90s and 2000s R&B and neo-soul: smooth grooves, slow jams, and feel-good throwbacks.', accent: 'rose', djMode: 'full' },
  { id: 'builtin:country-roads', name: 'Country Roads', description: 'Modern hits and timeless country', aiPrompt: 'Country music spanning modern country-pop hits and classic outlaw and honky-tonk legends. Storytelling, twang, and singalongs.', accent: 'amber', djMode: 'full' },
  { id: 'builtin:jazz-cafe', name: 'Jazz Café', description: 'Smooth standards and late-night jazz', aiPrompt: 'Classic jazz: smooth standards, bebop, cool jazz, and soulful late-night lounge. A mix of vocal standards and instrumentals.', accent: 'violet', djMode: 'full' },
  { id: 'builtin:classical', name: 'Classical Essentials', description: 'The great composers and iconic works', aiPrompt: 'Essential classical music: famous symphonies, concertos, and piano pieces from Bach, Beethoven, Mozart, Chopin, and the canon. Mostly recognizable masterworks.', accent: 'slate', djMode: 'silent' },
  { id: 'builtin:metal', name: 'Metal Mayhem', description: 'Heavy riffs and headbangers', aiPrompt: 'Heavy metal across eras: classic metal, thrash, and modern metal. Big riffs, fast solos, and headbanging anthems.', accent: 'slate', djMode: 'full' },
  { id: 'builtin:punk', name: 'Punk Rock', description: 'Fast, loud, and rebellious', aiPrompt: 'Punk and pop-punk: classic 70s/80s punk plus 90s and 2000s pop-punk anthems. Fast, loud, three chords and attitude.', accent: 'rose', djMode: 'full' },
  { id: 'builtin:funk-soul', name: 'Funk & Soul', description: 'Groovy basslines and Motown gold', aiPrompt: 'Funk and soul classics: Motown, James Brown-style funk, Stax soul, and disco-funk grooves. Tight horns, fat basslines, irresistible groove.', accent: 'amber', djMode: 'full' },
  { id: 'builtin:disco', name: 'Disco Fever', description: 'Mirrorball-ready dancefloor classics', aiPrompt: 'Disco and dance classics from the 70s and early 80s: four-on-the-floor, strings, and falsetto. Pure mirrorball joy.', accent: 'fuchsia', djMode: 'full' },
  { id: 'builtin:blues', name: 'Blues Bar', description: 'Smoky, soulful, electric blues', aiPrompt: 'Electric and acoustic blues: Delta blues, Chicago blues, and blues-rock legends. Soulful, guitar-driven, late-night barroom feel.', accent: 'blue', djMode: 'full' },
  { id: 'builtin:folk-acoustic', name: 'Folk & Acoustic', description: 'Storytellers and gentle strumming', aiPrompt: 'Folk and acoustic singer-songwriters across eras: gentle guitars, harmonies, and heartfelt lyrics. Both classic folk and modern acoustic.', accent: 'emerald', djMode: 'minimal' },
  { id: 'builtin:gospel', name: 'Gospel & Soul', description: 'Uplifting voices and spirit', aiPrompt: 'Gospel and inspirational soul: powerful vocals, choirs, and uplifting, spirited classics and contemporary worship.', accent: 'violet', djMode: 'full' },
  { id: 'builtin:reggae', name: 'Reggae Vibes', description: 'Island rhythms and good vibes', aiPrompt: 'Reggae, roots, and dub: classic reggae legends plus modern roots and lovers rock. Laid-back island grooves and positive vibes.', accent: 'emerald', djMode: 'full' },

  // ── Global ───────────────────────────────────────────────────────────────────────
  { id: 'builtin:latin', name: 'Latin Heat', description: 'Salsa, pop, and dancefloor fire', aiPrompt: 'Latin music: salsa, bachata, Latin pop, and cumbia classics and hits. Warm, danceable, and full of energy.', accent: 'rose', djMode: 'full' },
  { id: 'builtin:reggaeton', name: 'Reggaetón Party', description: 'Perreo and urban Latin bangers', aiPrompt: 'Reggaetón and urban Latin hits: current and classic perreo anthems, Latin trap, and dembow. High-energy party music.', accent: 'fuchsia', djMode: 'full' },
  { id: 'builtin:kpop', name: 'K-Pop Now', description: 'Polished hooks and group anthems', aiPrompt: 'K-pop hits: the biggest groups and soloists, current chart-toppers and beloved classics. Polished production, big hooks, dance anthems.', accent: 'cyan', djMode: 'full' },
  { id: 'builtin:afrobeats', name: 'Afrobeats', description: 'West African rhythm and global hits', aiPrompt: 'Afrobeats and Afropop: the global hits and stars driving the genre. Infectious rhythms, smooth vocals, and danceable grooves.', accent: 'amber', djMode: 'full' },

  // ── Electronic ─────────────────────────────────────────────────────────────────────
  { id: 'builtin:electronic-pulse', name: 'Electronic Pulse', description: 'House, techno, and EDM energy', aiPrompt: 'Energetic electronic music: house, techno, and melodic EDM. Driving, danceable, modern.', accent: 'cyan', djMode: 'full' },
  { id: 'builtin:synthwave', name: 'Synthwave Drive', description: 'Neon-soaked 80s retro-futurism', aiPrompt: 'Synthwave, retrowave, and outrun: neon, nostalgic, 80s-inspired electronic instrumentals and tracks. Moody, cinematic, late-night-drive energy.', accent: 'fuchsia', djMode: 'minimal' },

  // ── Indie & alternative ──────────────────────────────────────────────────────────
  { id: 'builtin:indie-discoveries', name: 'Indie Discoveries', description: 'Fresh indie rock and dream-pop finds', aiPrompt: 'Indie rock, dream pop, and bedroom pop: a mix of beloved indie staples and lesser-known gems worth discovering.', accent: 'emerald', djMode: 'full' },
  { id: 'builtin:alt-2000s', name: 'Alt Nation', description: 'Alternative anthems of the 2000s', aiPrompt: 'Alternative and emo rock from the 2000s: pop-punk, emo, post-hardcore, and indie crossover hits. Nostalgic alt-radio energy.', accent: 'violet', djMode: 'full' },

  // ── Decades ──────────────────────────────────────────────────────────────────────
  { id: 'builtin:golden-oldies', name: 'Golden Oldies', description: '50s and 60s sock-hop classics', aiPrompt: 'Oldies from the 1950s and 60s: doo-wop, early rock and roll, Motown, and sock-hop classics. Wholesome, timeless, singalong.', accent: 'amber', djMode: 'full' },
  { id: 'builtin:70s-gold', name: '70s Gold', description: 'Soft rock, funk, and disco of the 70s', aiPrompt: 'The biggest hits of the 1970s across rock, soft rock, funk, soul, and disco. Iconic, warm, and groovy.', accent: 'amber', djMode: 'full' },
  { id: 'builtin:80s-throwback', name: '80s Throwback', description: 'Synths, hair metal, and pop icons', aiPrompt: 'The 1980s: synth-pop, new wave, hair metal, and pop icons. Big drums, big hair, unforgettable hooks.', accent: 'cyan', djMode: 'full' },
  { id: 'builtin:90s-nostalgia', name: '90s Nostalgia', description: 'Grunge, boy bands, and 90s hip-hop', aiPrompt: 'The 1990s: grunge, alt-rock, boy bands, pop divas, and golden-age hip-hop. The decade in one mix.', accent: 'blue', djMode: 'full' },
  { id: 'builtin:2000s-throwback', name: '2000s Throwback', description: 'TRL-era pop, crunk, and pop-punk', aiPrompt: 'The 2000s: TRL pop, crunk and ringtone rap, pop-punk, and R&B. Peak millennium nostalgia.', accent: 'fuchsia', djMode: 'full' },

  // ── Moods & activities ────────────────────────────────────────────────────────────
  { id: 'builtin:workout', name: 'Workout Pump', description: 'High-energy fuel for the gym', aiPrompt: 'High-tempo, high-energy workout anthems: hype hip-hop, EDM, and rock to push through reps and cardio. Driving and motivating.', accent: 'rose', djMode: 'full' },
  { id: 'builtin:party', name: 'Party Anthems', description: 'Crowd-pleasers to get the room going', aiPrompt: 'Party anthems and dancefloor fillers across genres and decades: pop, hip-hop, and dance crowd-pleasers everyone knows.', accent: 'fuchsia', djMode: 'full' },
  { id: 'builtin:roadtrip', name: 'Road Trip', description: 'Windows-down singalong anthems', aiPrompt: 'Road trip singalong anthems: feel-good rock, pop, and country that everyone belts out with the windows down.', accent: 'amber', djMode: 'full' },
  { id: 'builtin:deep-focus', name: 'Deep Focus', description: 'Calm instrumentals for concentration', aiPrompt: 'Calm instrumental music for focus and concentration: ambient, minimal piano, and atmospheric electronica. No vocals, no distractions.', accent: 'slate', djMode: 'silent' },
  { id: 'builtin:lofi-focus', name: 'Lo-Fi Focus', description: 'Chilled beats to study and work to', aiPrompt: 'Mellow lo-fi hip-hop and chillhop instrumentals, jazzy and downtempo, great background music for focus. No vocals.', accent: 'slate', djMode: 'silent' },
  { id: 'builtin:chill', name: 'Chill Out', description: 'Laid-back vibes to unwind', aiPrompt: 'Laid-back chill music: downtempo, mellow indie, chillhop, and smooth electronic. Relaxed and easy, with some vocals.', accent: 'cyan', djMode: 'minimal' },
  { id: 'builtin:sleep', name: 'Sleep & Calm', description: 'Gentle sounds for winding down', aiPrompt: 'Gentle, slow, soothing music for sleep and winding down: ambient pads, soft piano, and quiet acoustic. Very calm, no vocals.', accent: 'violet', djMode: 'silent' },
  { id: 'builtin:meditation', name: 'Meditation & Yoga', description: 'Serene sounds for stillness', aiPrompt: 'Serene meditation and yoga music: ambient drones, nature-inspired textures, and calm instrumentals for stillness and breathwork.', accent: 'emerald', djMode: 'silent' },
  { id: 'builtin:rainy-day', name: 'Rainy Day', description: 'Cozy, melancholy, and warm', aiPrompt: 'Cozy rainy-day music: melancholy indie folk, soft piano, and mellow acoustic. Warm, contemplative, perfect with a window and tea.', accent: 'slate', djMode: 'minimal' },
  { id: 'builtin:morning-coffee', name: 'Morning Coffee', description: 'A gentle, bright start to the day', aiPrompt: 'Bright, gentle morning music: mellow acoustic, soft indie-pop, and light folk to ease into the day with a coffee.', accent: 'amber', djMode: 'minimal' },
  { id: 'builtin:coffeehouse', name: 'Coffeehouse Acoustic', description: 'Unplugged covers and singer-songwriters', aiPrompt: 'Coffeehouse acoustic: stripped-back singer-songwriters, unplugged versions, and gentle indie-folk. Intimate and warm.', accent: 'emerald', djMode: 'minimal' },
  { id: 'builtin:date-night', name: 'Date Night', description: 'Smooth, romantic, candlelit', aiPrompt: 'Romantic music for a date night: smooth R&B, soul ballads, and tender love songs across eras. Warm and intimate.', accent: 'rose', djMode: 'minimal' },
  { id: 'builtin:dinner-party', name: 'Dinner Party', description: 'Sophisticated background grooves', aiPrompt: 'Sophisticated dinner-party background music: bossa nova, soul, smooth jazz, and mellow grooves. Classy and conversational, never intrusive.', accent: 'violet', djMode: 'minimal' },

  // ── Fun & themed ──────────────────────────────────────────────────────────────────
  { id: 'builtin:retro-gaming', name: 'Retro Gaming', description: 'Chiptunes and classic game soundtracks', aiPrompt: 'Retro video game music: chiptune, 8-bit and 16-bit soundtracks, and iconic themes from classic NES, SNES, Sega, and arcade games. Nostalgic and energetic instrumentals.', accent: 'cyan', djMode: 'silent' },
  { id: 'builtin:8bit-chiptune', name: '8-Bit & Chiptune', description: 'The modern chiptune music scene', aiPrompt: 'The chiptune and 8-bit music scene: original tracks and artists making music with classic sound chips and trackers. Bleepy, energetic, and melodic.', accent: 'emerald', djMode: 'silent' },
  { id: 'builtin:vgm-remixes', name: 'Video Game Remixes', description: 'Epic remixes and arrangements of game music', aiPrompt: 'Remixes and arrangements of video game music: orchestral, rock, jazz, and electronic re-imaginings of classic game themes (think OverClocked ReMix and arrangement albums).', accent: 'fuchsia', djMode: 'minimal' },
  { id: 'builtin:game-soundtracks', name: 'Modern Game Soundtracks', description: 'Cinematic scores from today’s games', aiPrompt: 'Modern video game soundtracks: cinematic orchestral and atmospheric scores from contemporary AAA and indie games. Immersive instrumentals.', accent: 'slate', djMode: 'silent' },
  { id: 'builtin:vaporwave', name: 'Vaporwave', description: 'Slowed, dreamy retro-mall aesthetics', aiPrompt: 'Vaporwave and its offshoots: slowed, chopped, nostalgic samples of 80s and 90s muzak, lounge, and pop. Dreamy, surreal, retro-mall aesthetic.', accent: 'fuchsia', djMode: 'silent' },
  { id: 'builtin:movie-scores', name: 'Epic Movie Scores', description: 'Cinematic orchestral soundtracks', aiPrompt: 'Epic film score music: sweeping orchestral soundtracks and iconic themes from blockbuster movies. Cinematic, dramatic, instrumental.', accent: 'slate', djMode: 'silent' },
  { id: 'builtin:anime', name: 'Anime Hits', description: 'Openings, endings, and J-pop bangers', aiPrompt: 'Anime music: famous opening and ending themes, plus J-pop and J-rock from popular anime. High-energy and melodic.', accent: 'fuchsia', djMode: 'full' },
  { id: 'builtin:yacht-rock', name: 'Yacht Rock', description: 'Smooth, breezy soft rock of the 70s/80s', aiPrompt: 'Yacht rock and smooth soft rock from the late 70s and early 80s: silky production, mellow grooves, and breezy AOR. Smooth sailing.', accent: 'blue', djMode: 'full' },
  { id: 'builtin:halloween', name: 'Spooky Season', description: 'Eerie tunes and Halloween classics', aiPrompt: 'Halloween and spooky-season songs: classic monster-mash novelties, eerie themes, and dark, moody pop and rock that fit a haunted vibe.', accent: 'violet', djMode: 'full' },
  { id: 'builtin:holiday', name: 'Holiday Classics', description: 'Festive favorites for the season', aiPrompt: 'Holiday and Christmas classics: beloved festive standards and modern holiday pop hits. Warm, cheerful, and nostalgic.', accent: 'emerald', djMode: 'full' },

  // ── TV & nostalgia ─────────────────────────────────────────────────────────────────
  { id: 'builtin:80s-tv-themes', name: '80s TV Themes', description: 'Iconic theme songs from 80s television', aiPrompt: 'Theme songs from iconic 1980s TV shows: sitcoms, action dramas, and cartoons. The catchy, nostalgic openers everyone hums.', accent: 'cyan', djMode: 'full' },
  { id: 'builtin:90s-tv-themes', name: '90s TV Themes', description: 'Sitcom and cartoon openers of the 90s', aiPrompt: 'Theme songs from beloved 1990s TV shows: sitcoms, teen dramas, and Saturday cartoons. Pure 90s nostalgia in opening-credits form.', accent: 'blue', djMode: 'full' },
  { id: 'builtin:tv-greatest-themes', name: "TV's Greatest Themes", description: 'Unforgettable theme songs across the decades', aiPrompt: 'The most memorable TV theme songs of all time across every decade: sitcoms, dramas, and cult classics. Instantly recognizable openers.', accent: 'violet', djMode: 'full' },
  { id: 'builtin:saturday-cartoons', name: 'Saturday Morning Cartoons', description: 'Theme songs from classic cartoons', aiPrompt: 'Theme songs and tunes from classic Saturday-morning cartoons across the 80s, 90s, and 2000s. Fun, energetic, and nostalgic.', accent: 'fuchsia', djMode: 'full' },
  { id: 'builtin:disney-animated', name: 'Disney & Animated', description: 'Sing-along songs from animated movies', aiPrompt: 'Songs from Disney, Pixar, and animated movie soundtracks: beloved sing-along showstoppers and ballads across the decades.', accent: 'cyan', djMode: 'full' },
  { id: 'builtin:broadway', name: 'Broadway & Musicals', description: 'Showstoppers from stage and screen', aiPrompt: 'Showtunes from Broadway and movie musicals: big showstoppers, ballads, and ensemble numbers from classic and modern musicals.', accent: 'rose', djMode: 'full' },
  { id: 'builtin:90s-nick', name: '90s Nickelodeon', description: 'Theme songs from 90s Nick shows', aiPrompt: 'Theme songs and music from 1990s Nickelodeon shows: the cartoons, sitcoms, and game shows of the orange-splat era. Nostalgic and goofy.', accent: 'amber', djMode: 'full' },
  { id: 'builtin:2k-nick', name: '2000s Nickelodeon', description: 'Theme songs from 2000s Nick shows', aiPrompt: 'Theme songs and music from 2000s Nickelodeon shows: the live-action sitcoms and cartoons of the era. Catchy, nostalgic millennial-kid TV.', accent: 'fuchsia', djMode: 'full' },
  { id: 'builtin:disney-channel', name: 'Disney Channel', description: 'DCOM hits and theme songs', aiPrompt: 'Disney Channel music: Disney Channel Original Movie hits, show theme songs, and pop from its teen-star era. Bright, catchy, and nostalgic.', accent: 'blue', djMode: 'full' },
  { id: 'builtin:cartoon-network', name: 'Cartoon Network & Toonami', description: 'Themes from CN and Toonami', aiPrompt: 'Music and theme songs from Cartoon Network and the Toonami block: cartoon openers, bumpers, and anime-action themes. Nostalgic and energetic.', accent: 'cyan', djMode: 'full' },

  // ── More party & moods ──────────────────────────────────────────────────────────────
  { id: 'builtin:2010s-throwback', name: '2010s Throwback', description: 'EDM-pop and indie of the 2010s', aiPrompt: 'The 2010s: EDM-pop, festival anthems, indie crossover, and chart hip-hop and pop that defined the decade.', accent: 'fuchsia', djMode: 'full' },
  { id: 'builtin:summer-beach', name: 'Summer & Beach', description: 'Sunny, breezy warm-weather vibes', aiPrompt: 'Sunny summer and beach music: tropical house, breezy pop, surf rock, and feel-good warm-weather anthems.', accent: 'amber', djMode: 'full' },
  { id: 'builtin:motown-gold', name: 'Motown Gold', description: 'The sound of young America', aiPrompt: 'Classic Motown: the legendary 60s and 70s soul, pop, and R&B from the Motown labels. Joyful, timeless, irresistible.', accent: 'amber', djMode: 'full' },
  { id: 'builtin:karaoke', name: 'Karaoke Night', description: 'Belt-it-out crowd anthems', aiPrompt: 'The ultimate karaoke songs: big, fun, sing-at-the-top-of-your-lungs anthems across pop, rock, and power ballads that everyone knows the words to.', accent: 'fuchsia', djMode: 'full' },
  { id: 'builtin:wedding', name: 'Wedding Reception', description: 'Floor-fillers for the big day', aiPrompt: 'Wedding reception crowd-pleasers: timeless dancefloor fillers, slow-dance classics, and feel-good hits that get every generation up.', accent: 'rose', djMode: 'full' },
  { id: 'builtin:pride-anthems', name: 'Pride Anthems', description: 'Empowering dancefloor celebrations', aiPrompt: 'Pride and celebration anthems: empowering pop, disco, and dance classics and modern hits. Joyful, fierce, and full of love.', accent: 'violet', djMode: 'full' },
  { id: 'builtin:bollywood', name: 'Bollywood Hits', description: 'Vibrant songs from Indian cinema', aiPrompt: 'Bollywood music: vibrant, danceable songs from Indian film soundtracks, classic and modern. Colorful, energetic, and melodic.', accent: 'amber', djMode: 'full' },

  // ── Movies ───────────────────────────────────────────────────────────────────────
  { id: 'builtin:movie-soundtracks', name: 'Movie Soundtracks', description: 'Iconic songs featured in films', aiPrompt: 'Famous pop and rock songs featured in movies: the needle-drops and soundtrack hits everyone associates with iconic film moments.', accent: 'blue', djMode: 'full' },
  { id: 'builtin:80s-movies', name: '80s Movie Hits', description: 'Brat Pack and John Hughes-era anthems', aiPrompt: 'Songs from beloved 1980s movie soundtracks: John Hughes and Brat Pack-era new wave, synth-pop, and rock anthems from the decade of teen films.', accent: 'cyan', djMode: 'full' },
  { id: 'builtin:james-bond', name: 'James Bond Themes', description: 'Sweeping, sultry 007 title songs', aiPrompt: 'James Bond movie theme songs across the decades: dramatic, sultry, orchestral-pop title tracks from the 007 franchise.', accent: 'slate', djMode: 'full' },
  { id: 'builtin:tarantino', name: 'Tarantino Needle-Drops', description: 'Cool retro cuts from cult films', aiPrompt: 'The cool, eclectic retro tracks used in Quentin Tarantino-style films: surf rock, soul, funk, and forgotten 60s/70s gems with serious attitude.', accent: 'amber', djMode: 'full' },
  { id: 'builtin:spaghetti-western', name: 'Spaghetti Western', description: 'Dusty, cinematic frontier scores', aiPrompt: 'Spaghetti western and western film music: Ennio Morricone-style cinematic scores, whistling themes, and dusty frontier instrumentals.', accent: 'amber', djMode: 'silent' },
  { id: 'builtin:sci-fi-scores', name: 'Sci-Fi Scores', description: 'Otherworldly cinematic soundscapes', aiPrompt: 'Science-fiction film and TV scores: sweeping orchestral and synth soundscapes and iconic themes from classic and modern sci-fi. Instrumental and cinematic.', accent: 'cyan', djMode: 'silent' },
  { id: 'builtin:horror-scores', name: 'Horror Scores', description: 'Creeping, unsettling movie music', aiPrompt: 'Horror movie scores: eerie, creeping, unsettling instrumental themes and motifs from classic and modern horror films. Atmospheric and tense.', accent: 'slate', djMode: 'silent' },
  { id: 'builtin:rom-com', name: 'Rom-Com Soundtracks', description: 'Feel-good love songs from the movies', aiPrompt: 'Feel-good love songs and pop hits from romantic-comedy soundtracks: swoony, upbeat, and heartwarming tunes from your favorite rom-coms.', accent: 'rose', djMode: 'full' },
  { id: 'builtin:training-montage', name: 'Training Montage', description: 'Rocky-style hype to push through', aiPrompt: 'Epic training-montage and sports-movie anthems: Rocky-style hype, triumphant rock, and pump-up tracks built for pushing through.', accent: 'rose', djMode: 'full' },
  { id: 'builtin:superhero-themes', name: 'Superhero Themes', description: 'Heroic, blockbuster orchestral power', aiPrompt: 'Superhero and blockbuster movie themes: bold, heroic orchestral music from comic-book and action films. Triumphant and cinematic instrumentals.', accent: 'blue', djMode: 'silent' },

  // ── More nostalgia & popular ───────────────────────────────────────────────────────
  { id: 'builtin:british-invasion', name: 'British Invasion', description: '60s UK rock and pop that changed it all', aiPrompt: 'The 1960s British Invasion: the Beatles-era UK rock and pop bands that took over the charts. Jangly guitars, harmonies, and Merseybeat energy.', accent: 'rose', djMode: 'full' },
  { id: 'builtin:hair-metal', name: 'Hair Metal', description: 'Glam, spandex, and 80s shred', aiPrompt: 'Hair metal and glam metal from the 80s: anthemic choruses, screaming guitar solos, and power ballads. Sunset Strip excess in full effect.', accent: 'fuchsia', djMode: 'full' },
  { id: 'builtin:new-wave', name: 'New Wave', description: 'Synthy, arty 80s cool', aiPrompt: 'New wave and post-punk from the late 70s and 80s: synthy, arty, danceable alternative pop and rock. Quirky, stylish, and timeless.', accent: 'cyan', djMode: 'full' },
  { id: 'builtin:grunge', name: 'Grunge', description: 'Flannel-clad 90s Seattle rock', aiPrompt: 'Grunge and 90s alternative rock: the Seattle sound and its peers. Distorted guitars, raw vocals, and angsty energy.', accent: 'slate', djMode: 'full' },
  { id: 'builtin:golden-age-hiphop', name: 'Golden Age Hip-Hop', description: 'Boom-bap classics of the 90s', aiPrompt: 'Golden-age hip-hop from the late 80s and 90s: boom-bap beats, lyrical legends, and the era that defined the genre.', accent: 'amber', djMode: 'full' },
  { id: 'builtin:boy-bands-divas', name: 'Boy Bands & Divas', description: 'Late-90s and 2000s pop royalty', aiPrompt: 'Late-90s and 2000s pop: boy bands, girl groups, and pop divas. Glossy production, huge hooks, and choreographed nostalgia.', accent: 'fuchsia', djMode: 'full' },
  { id: 'builtin:power-ballads', name: 'Power Ballads', description: 'Lighters-up emotional anthems', aiPrompt: 'Power ballads from the 70s through the 90s: soaring vocals, big key changes, and lighters-up emotional rock and pop anthems.', accent: 'violet', djMode: 'full' },
  { id: 'builtin:stadium-anthems', name: 'Stadium Anthems', description: 'Fist-pumping, arena-sized rock', aiPrompt: 'Stadium rock anthems: fist-pumping, arena-sized singalongs from classic and modern rock built to fill a stadium.', accent: 'blue', djMode: 'full' },
  { id: 'builtin:outlaw-country', name: 'Outlaw Country', description: 'Rugged, rebellious country legends', aiPrompt: 'Outlaw and classic country: rugged, rebellious legends and honky-tonk heroes. Whiskey-soaked storytelling and timeless twang.', accent: 'amber', djMode: 'full' },
  { id: 'builtin:singer-songwriter-70s', name: '70s Singer-Songwriters', description: 'Intimate, confessional classics', aiPrompt: 'Intimate 1970s singer-songwriters: confessional, acoustic-driven classics from the golden age of the form. Warm, lyrical, and timeless.', accent: 'emerald', djMode: 'minimal' },
  { id: 'builtin:y2k-pop', name: 'Y2K Pop', description: 'Turn-of-the-millennium bubblegum', aiPrompt: 'Y2K and turn-of-the-millennium pop: bubblegum, teen pop, and dance-pop from around 1998 to 2004. Shiny, fun, and unapologetically catchy.', accent: 'cyan', djMode: 'full' },

  // ── Moods ────────────────────────────────────────────────────────────────────────
  { id: 'builtin:happy-vibes', name: 'Happy Vibes', description: 'Pure sunshine and good moods', aiPrompt: 'Upbeat, joyful, feel-good songs across pop, soul, and indie that instantly lift your mood. Sunny, bouncy, and smile-inducing.', accent: 'amber', djMode: 'full' },
  { id: 'builtin:in-my-feels', name: 'In My Feels', description: 'Emotional songs for big feelings', aiPrompt: 'Emotional, heart-tugging songs: tender ballads and introspective indie and pop for when you are deep in your feelings. Bittersweet and moving.', accent: 'violet', djMode: 'minimal' },
  { id: 'builtin:heartbreak', name: 'Heartbreak', description: 'Breakup ballads and good cries', aiPrompt: 'Breakup and heartbreak songs: aching ballads and anthems about lost love across pop, R&B, and rock. For a good cry and a clean release.', accent: 'blue', djMode: 'minimal' },
  { id: 'builtin:confidence', name: 'Confidence Boost', description: 'Boss-mode empowerment anthems', aiPrompt: 'Confident, empowering anthems: fierce, self-assured pop, hip-hop, and R&B that make you feel unstoppable. Boss-mode energy.', accent: 'fuchsia', djMode: 'full' },
  { id: 'builtin:rage', name: 'Rage Mode', description: 'Loud, angry energy to let it out', aiPrompt: 'Aggressive, cathartic music to let it all out: hard rock, metal, punk, and rap-rock with raw, angry energy. Loud and intense.', accent: 'rose', djMode: 'full' },
  { id: 'builtin:euphoric', name: 'Euphoric', description: 'Soaring, blissful dancefloor highs', aiPrompt: 'Euphoric, uplifting dance and electronic music: soaring melodies, big drops, and blissful festival highs. Pure joy on the dancefloor.', accent: 'cyan', djMode: 'full' },
  { id: 'builtin:dreamy', name: 'Dreamy', description: 'Ethereal, floating soundscapes', aiPrompt: 'Dreamy, ethereal music: shoegaze, dream pop, and ambient-leaning indie with washed-out, floating textures. Hazy and beautiful.', accent: 'violet', djMode: 'minimal' },
  { id: 'builtin:moody', name: 'Moody & Dark', description: 'Brooding, atmospheric after-hours', aiPrompt: 'Moody, brooding, atmospheric music: dark pop, trip-hop, alt-R&B, and noir indie. Late-night, smoky, and cinematic.', accent: 'slate', djMode: 'minimal' },
  { id: 'builtin:mellow-mood', name: 'Mellow Mood', description: 'Easygoing, low-key listening', aiPrompt: 'Mellow, easygoing songs for a low-key mood: soft indie, gentle soul, and laid-back acoustic. Relaxed without putting you to sleep.', accent: 'emerald', djMode: 'minimal' },
  { id: 'builtin:sensual', name: 'Sensual', description: 'Slow, sultry bedroom R&B', aiPrompt: 'Sultry, sensual slow jams: smooth, bedroom R&B and soul with intimate vocals and slow grooves. Romantic and after-dark.', accent: 'rose', djMode: 'minimal' },
  { id: 'builtin:motivation', name: 'Get It Done', description: 'Driving focus with a pulse', aiPrompt: 'Motivating, momentum-building music to get things done: driving pop, electronic, and upbeat hip-hop with a steady pulse. Productive energy.', accent: 'blue', djMode: 'full' },
  { id: 'builtin:good-times', name: 'Good Times', description: 'Carefree, breezy, no worries', aiPrompt: 'Carefree, breezy good-time music: feel-good funk, soul, reggae-pop, and sunny rock. No worries, just easy good vibes.', accent: 'amber', djMode: 'full' },

  // ── Eras (beyond the decades above) ────────────────────────────────────────────────
  { id: 'builtin:jazz-age', name: 'The Jazz Age', description: 'Roaring 20s ragtime and early jazz', aiPrompt: 'Music of the Roaring Twenties: ragtime, early jazz, dixieland, and vintage crooners. Speakeasy-era, crackly, and charming.', accent: 'amber', djMode: 'full' },
  { id: 'builtin:big-band', name: 'Big Band & Swing', description: 'The swing era of the 30s and 40s', aiPrompt: 'Big band and swing from the 1930s and 40s: brassy orchestras, jump blues, and crooner standards. Dancehall energy and golden-age glamour.', accent: 'violet', djMode: 'full' },
  { id: 'builtin:flower-power', name: 'Flower Power', description: '60s psychedelia and counterculture', aiPrompt: 'Late-1960s psychedelic rock and folk: Woodstock-era counterculture, jangly guitars, and trippy classics. Peace, love, and tie-dye.', accent: 'fuchsia', djMode: 'full' },
  { id: 'builtin:2020s-now', name: '2020s Now', description: 'The sound of this decade', aiPrompt: 'The defining music of the 2020s: current pop, hip-hop, hyperpop, and genre-blending hits shaping this decade right now.', accent: 'cyan', djMode: 'full' },

  // ── Classic genres & deep cuts ─────────────────────────────────────────────────────
  { id: 'builtin:southern-rock', name: 'Southern Rock', description: 'Twangy, boogie-fueled guitar jams', aiPrompt: 'Southern rock: twin-guitar boogie, jam-band workouts, and good-ol-boy anthems from the 70s and beyond. Twangy, gritty, and free-wheeling.', accent: 'amber', djMode: 'full' },
  { id: 'builtin:prog-rock', name: 'Prog Rock', description: 'Epic, ambitious concept-album rock', aiPrompt: 'Progressive rock: sprawling, ambitious, virtuosic suites and concept-album epics from the 70s and beyond. Complex, cinematic, and adventurous.', accent: 'violet', djMode: 'full' },
  { id: 'builtin:psychedelic-rock', name: 'Psychedelic Rock', description: 'Mind-bending 60s and 70s trips', aiPrompt: 'Psychedelic rock: swirling, mind-bending guitar freakouts and trippy 60s and 70s classics. Reverb, fuzz, and kaleidoscope vibes.', accent: 'fuchsia', djMode: 'full' },
  { id: 'builtin:surf-rock', name: 'Surf Rock', description: 'Reverb-drenched beach instrumentals', aiPrompt: 'Surf rock: reverb-soaked twangy guitar instrumentals and beach-party classics from the early 60s and their revival. Sunny and energetic.', accent: 'cyan', djMode: 'full' },
  { id: 'builtin:rockabilly', name: 'Rockabilly', description: 'Slap-bass 50s rock and roll', aiPrompt: 'Rockabilly and early rock and roll: slap-bass, twangy guitars, and hiccupping vocals from the 1950s and the rockabilly revival. Greaser cool.', accent: 'rose', djMode: 'full' },
  { id: 'builtin:glam-rock', name: 'Glam Rock', description: 'Glitter, swagger, and 70s stomp', aiPrompt: 'Glam rock from the 70s: glittery, theatrical, stomping rock with swagger and big choruses. Bowie-era flamboyance and attitude.', accent: 'fuchsia', djMode: 'full' },
  { id: 'builtin:britpop', name: 'Britpop', description: '90s UK guitar-pop swagger', aiPrompt: 'Britpop: 1990s UK guitar-pop and indie with cheeky swagger, big anthemic choruses, and Cool Britannia attitude.', accent: 'blue', djMode: 'full' },
  { id: 'builtin:ska', name: 'Ska & Rocksteady', description: 'Upstroke grooves and brass', aiPrompt: 'Ska, rocksteady, and ska-punk: bouncy upstroke guitars, punchy horns, and skanking rhythms from the originators through the third-wave revival.', accent: 'emerald', djMode: 'full' },
  { id: 'builtin:bluegrass', name: 'Bluegrass', description: 'Banjo-driven high lonesome string music', aiPrompt: 'Bluegrass and old-time string music: lightning banjo, fiddle, and high-lonesome harmonies. Traditional and newgrass alike.', accent: 'amber', djMode: 'full' },
  { id: 'builtin:nu-metal', name: 'Nu-Metal', description: 'Downtuned, angsty 2000s heaviness', aiPrompt: 'Nu-metal and rap-metal from the late 90s and 2000s: downtuned riffs, scratch-and-rap verses, and angsty, aggressive hooks.', accent: 'slate', djMode: 'full' },
  { id: 'builtin:new-jack-swing', name: 'New Jack Swing', description: 'Late-80s and early-90s R&B groove', aiPrompt: 'New jack swing: late-80s and early-90s R&B fused with hip-hop beats. Slick, danceable swingbeat grooves and smooth vocals.', accent: 'rose', djMode: 'full' },
  { id: 'builtin:smooth-jazz', name: 'Smooth Jazz', description: 'Silky, easygoing contemporary jazz', aiPrompt: 'Smooth jazz and contemporary jazz: silky saxophone, mellow grooves, and easygoing instrumentals. Relaxed and sophisticated.', accent: 'violet', djMode: 'silent' },
]

// Browse categories for the built-in roster, in display order. Each station id maps to one.
const STATION_CATEGORIES: Array<[string, string[]]> = [
  ['Featured', ['todays-hits', 'viral-hits', 'feel-good-classics', 'one-hit-wonders', 'guilty-pleasures']],
  ['Genres', ['hip-hop-now', 'classic-rock', 'throwback-rnb', 'country-roads', 'jazz-cafe', 'classical', 'metal', 'punk', 'funk-soul', 'disco', 'blues', 'folk-acoustic', 'gospel', 'reggae', 'electronic-pulse', 'synthwave', 'indie-discoveries', 'alt-2000s']],
  ['Decades', ['golden-oldies', '70s-gold', '80s-throwback', '90s-nostalgia', '2000s-throwback', '2010s-throwback']],
  ['Eras', ['jazz-age', 'big-band', 'flower-power', 'british-invasion', '2020s-now']],
  ['Moods', ['happy-vibes', 'in-my-feels', 'heartbreak', 'confidence', 'rage', 'euphoric', 'dreamy', 'moody', 'mellow-mood', 'sensual', 'motivation', 'good-times', 'chill']],
  ['Activities', ['workout', 'party', 'roadtrip', 'deep-focus', 'lofi-focus', 'sleep', 'meditation', 'rainy-day', 'morning-coffee', 'coffeehouse', 'date-night', 'dinner-party', 'karaoke', 'wedding', 'summer-beach']],
  ['Movies', ['movie-soundtracks', 'movie-scores', '80s-movies', 'james-bond', 'tarantino', 'spaghetti-western', 'sci-fi-scores', 'horror-scores', 'rom-com', 'training-montage', 'superhero-themes']],
  ['TV & Cartoons', ['80s-tv-themes', '90s-tv-themes', 'tv-greatest-themes', 'saturday-cartoons', 'disney-animated', 'broadway', 'anime', '90s-nick', '2k-nick', 'disney-channel', 'cartoon-network']],
  ['Gaming', ['retro-gaming', '8bit-chiptune', 'vgm-remixes', 'game-soundtracks', 'vaporwave']],
  ['Global', ['latin', 'reggaeton', 'kpop', 'afrobeats', 'bollywood']],
  ['Classics', ['southern-rock', 'prog-rock', 'psychedelic-rock', 'surf-rock', 'rockabilly', 'glam-rock', 'britpop', 'ska', 'bluegrass', 'nu-metal', 'new-jack-swing', 'smooth-jazz', 'hair-metal', 'new-wave', 'grunge', 'golden-age-hiphop', 'boy-bands-divas', 'power-ballads', 'stadium-anthems', 'outlaw-country', 'singer-songwriter-70s', 'y2k-pop', 'motown-gold', 'yacht-rock']],
  ['Themed', ['pride-anthems', 'halloween', 'holiday']],
]
export const STATION_CATEGORY_ORDER = STATION_CATEGORIES.map(([c]) => c)
const CATEGORY_OF: Record<string, string> = {}
for (const [cat, ids] of STATION_CATEGORIES) for (const id of ids) CATEGORY_OF[`builtin:${id}`] = cat
const categoryFor = (id: string) => CATEGORY_OF[id] ?? 'More'

let reconciled = false
/** Insert any missing built-in stations (idempotent). Called lazily on first list. */
async function reconcileBuiltins(): Promise<void> {
  if (reconciled) return
  reconciled = true
  const now = new Date()
  try {
    for (const s of DEFAULT_MUSIC_STATIONS) {
      await db.insert(musicStations).values({
        id: s.id, userId: null, name: s.name, description: s.description, aiPrompt: s.aiPrompt,
        seedType: 'prompt', seedValue: null, accent: s.accent, category: categoryFor(s.id), djMode: s.djMode,
        visibility: 'shared', isBuiltin: true, isAdult: false, createdAt: now, updatedAt: now,
      }).onConflictDoNothing()
    }
  } catch (err) {
    reconciled = false
    logger.debug(`[stations] reconcile failed: ${String(err)}`)
  }
  // Keep built-in categories in sync. Cover art is rendered on the client now (see StationArt),
  // so we don't generate cover files for built-ins.
  try {
    await Promise.all(DEFAULT_MUSIC_STATIONS.map(s =>
      db.update(musicStations).set({ category: categoryFor(s.id) }).where(eq(musicStations.id, s.id)),
    ))
  } catch (err) { logger.debug(`[stations] category sync failed: ${String(err)}`) }
}

// ── List ────────────────────────────────────────────────────────────────────────
// Returns built-ins, the user's own stations, and stations shared by other family members.
musicStations_route.get('/', async (c) => {
  const user = c.get('user')
  await reconcileBuiltins()
  const rows = await db
    .select({ s: musicStations, ownerName: users.firstName })
    .from(musicStations)
    .leftJoin(users, eq(musicStations.userId, users.id))
    .where(or(
      isNull(musicStations.userId),                 // built-ins
      eq(musicStations.userId, user.id),            // own
      eq(musicStations.visibility, 'shared'),       // shared by others
    ))
    .orderBy(desc(musicStations.isBuiltin), desc(musicStations.updatedAt))

  const all = rows.map(r => serialize(r.s, user.id, r.ownerName))
  return c.json({
    builtin: all.filter(s => s.isBuiltin),
    mine: all.filter(s => !s.isBuiltin && s.owned),
    shared: all.filter(s => !s.isBuiltin && !s.owned),
    categories: STATION_CATEGORY_ORDER,
  })
})

// ── Get one station (built-in, own, or shared) ────────────────────────────────────
musicStations_route.get('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db
    .select({ s: musicStations, ownerName: users.firstName })
    .from(musicStations)
    .leftJoin(users, eq(musicStations.userId, users.id))
    .where(eq(musicStations.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.s.userId && row.s.userId !== user.id && row.s.visibility !== 'shared') return c.json({ error: 'not available' }, 403)
  return c.json({ station: serialize(row.s, user.id, row.ownerName) })
})

// ── Create ──────────────────────────────────────────────────────────────────────
musicStations_route.post('/', async (c) => {
  const user = c.get('user')
  type CreateBody = {
    name?: string; description?: string; aiPrompt?: string
    seedType?: StationSeedType; seedValue?: string; djMode?: StationRow['djMode']
    accent?: string; visibility?: StationRow['visibility']
  }
  const body = await c.req.json<CreateBody>().catch(() => ({} as CreateBody))

  const name = body.name?.trim()
  if (!name) return c.json({ error: 'name required' }, 400)
  const id = crypto.randomUUID()
  const accent = body.accent ?? accentForSeed(name)
  const now = new Date()

  await db.insert(musicStations).values({
    id, userId: user.id, name,
    description: body.description?.trim() || null,
    aiPrompt: body.aiPrompt?.trim() || '',
    seedType: body.seedType ?? 'prompt',
    seedValue: body.seedValue?.trim() || null,
    djMode: body.djMode ?? 'full',
    accent,
    visibility: body.visibility === 'shared' ? 'shared' : 'private',
    isBuiltin: false, isAdult: false, createdAt: now, updatedAt: now,
  })

  // Generate art in the background so create returns instantly; patch the row when ready.
  void generateStationArt(id, name, body.description?.trim() || null, accent).then(async (art) => {
    if (art.iconPath || art.bannerPath) {
      await db.update(musicStations)
        .set({ iconPath: art.iconPath, bannerPath: art.bannerPath, updatedAt: new Date() })
        .where(eq(musicStations.id, id))
    }
  }).catch(() => {})

  const [row] = await db.select().from(musicStations).where(eq(musicStations.id, id))
  return c.json({ station: serialize(row!, user.id) })
})

// ── Update (owner only) ────────────────────────────────────────────────────────
musicStations_route.patch('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(musicStations).where(eq(musicStations.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId !== user.id) return c.json({ error: 'not your station' }, 403)

  type StationPatch = Partial<Pick<StationRow, 'name' | 'description' | 'aiPrompt' | 'seedType' | 'seedValue' | 'djMode' | 'accent' | 'visibility'>>
  const body = await c.req.json<StationPatch>().catch(() => ({} as StationPatch))
  await db.update(musicStations).set({
    name: body.name?.trim() || row.name,
    description: body.description !== undefined ? (body.description?.trim() || null) : row.description,
    aiPrompt: body.aiPrompt !== undefined ? (body.aiPrompt?.trim() || '') : row.aiPrompt,
    seedType: body.seedType ?? row.seedType,
    seedValue: body.seedValue !== undefined ? (body.seedValue?.trim() || null) : row.seedValue,
    djMode: body.djMode ?? row.djMode,
    accent: body.accent ?? row.accent,
    visibility: body.visibility ?? row.visibility,
    updatedAt: new Date(),
  }).where(eq(musicStations.id, id))
  const [updated] = await db.select().from(musicStations).where(eq(musicStations.id, id))
  return c.json({ station: serialize(updated!, user.id) })
})

// ── Delete (owner only) ──────────────────────────────────────────────────────────
musicStations_route.delete('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(musicStations).where(eq(musicStations.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId !== user.id) return c.json({ error: 'not your station' }, 403)
  await db.delete(musicStations).where(eq(musicStations.id, id))
  return c.json({ ok: true })
})

// ── Share toggle (owner only) ────────────────────────────────────────────────────
musicStations_route.post('/:id/share', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json<{ shared?: boolean }>().catch(() => ({} as { shared?: boolean }))
  const [row] = await db.select().from(musicStations).where(eq(musicStations.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId !== user.id) return c.json({ error: 'not your station' }, 403)
  const visibility = body.shared === false ? 'private' : 'shared'
  await db.update(musicStations).set({ visibility, updatedAt: new Date() }).where(eq(musicStations.id, id))
  return c.json({ visibility })
})

// ── Clone a built-in or shared station into your own (editable) copy ───────────────
musicStations_route.post('/:id/clone', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(musicStations).where(eq(musicStations.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  // Must be visible to this user (built-in, own, or shared).
  if (row.userId && row.userId !== user.id && row.visibility !== 'shared') return c.json({ error: 'not available' }, 403)

  const newId = crypto.randomUUID()
  const now = new Date()
  const name = `${row.name} (copy)`
  await db.insert(musicStations).values({
    id: newId, userId: user.id, name, description: row.description, aiPrompt: row.aiPrompt,
    seedType: row.seedType, seedValue: row.seedValue, djMode: row.djMode, accent: row.accent,
    iconPath: row.iconPath, bannerPath: row.bannerPath,
    visibility: 'private', isBuiltin: false, isAdult: row.isAdult, createdAt: now, updatedAt: now,
  })
  const [created] = await db.select().from(musicStations).where(eq(musicStations.id, newId))
  return c.json({ station: serialize(created!, user.id) })
})

// ── Regenerate art (owner only) ──────────────────────────────────────────────────
musicStations_route.post('/:id/regenerate-art', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(musicStations).where(eq(musicStations.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId !== user.id) return c.json({ error: 'not your station' }, 403)
  const art = await generateStationArt(id, row.name, row.description, row.accent)
  await db.update(musicStations).set({ iconPath: art.iconPath, bannerPath: art.bannerPath, updatedAt: new Date() }).where(eq(musicStations.id, id))
  return c.json({ iconUrl: art.iconPath ? `/api/music/stations/${id}/art/icon` : null, bannerUrl: art.bannerPath ? `/api/music/stations/${id}/art/banner` : null })
})

// ── Serve station art ────────────────────────────────────────────────────────────
musicStations_route.get('/:id/art/:which', async (c) => {
  const id = c.req.param('id')
  const which = c.req.param('which')
  const [row] = await db.select().from(musicStations).where(eq(musicStations.id, id))
  const rel = which === 'banner' ? row?.bannerPath : row?.iconPath
  if (!rel) return c.json({ error: 'no art' }, 404)
  try {
    const abs = await resolveUserPath(rel)
    const svg = await readFile(abs, 'utf8')
    return c.body(svg, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' })
  } catch {
    return c.json({ error: 'no art' }, 404)
  }
})

// ── Build a queue from a seed (no persistence required) ──────────────────────────
musicStations_route.post('/queue', async (c) => {
  type QueueBody = Partial<StationSeed> & { stationId?: string }
  const body = await c.req.json<QueueBody>().catch(() => ({} as QueueBody))

  // If a saved station id is given, build from its stored config.
  let seed: StationSeed | null = null
  if (body.stationId) {
    const [row] = await db.select().from(musicStations).where(eq(musicStations.id, body.stationId))
    if (!row) return c.json({ error: 'station not found' }, 404)
    seed = {
      name: row.name, aiPrompt: row.aiPrompt, seedType: row.seedType, seedValue: row.seedValue ?? undefined,
      count: body.count, excludeVideoIds: Array.isArray(body.excludeVideoIds) ? body.excludeVideoIds.slice(0, 200) : [],
    }
  } else {
    const aiPrompt = body.aiPrompt?.trim()
    if (!aiPrompt && !body.seedValue && !body.seedVideoId) return c.json({ error: 'aiPrompt, seedValue, seedVideoId, or stationId required' }, 400)
    seed = {
      name: body.name, aiPrompt: aiPrompt ?? body.seedValue ?? '',
      seedType: body.seedType as StationSeedType | undefined, seedValue: body.seedValue, seedVideoId: body.seedVideoId,
      count: body.count, excludeVideoIds: Array.isArray(body.excludeVideoIds) ? body.excludeVideoIds.slice(0, 200) : [],
    }
  }

  const result = await buildStationQueue(seed)
  return c.json(result)
})

// ── Snapshot: materialize a station's current queue as offline audio ───────────────
// "Make this station available offline" — builds the queue and enqueues an audio save for the
// first N tracks (reusing the YouTube offline-save pipeline). Each user gets their own copy.
musicStations_route.post('/:id/snapshot', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json<{ count?: number }>().catch(() => ({} as { count?: number }))
  const count = Math.min(Math.max(body.count ?? 15, 1), 40)

  const [row] = await db.select().from(musicStations).where(eq(musicStations.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId && row.userId !== user.id && row.visibility !== 'shared') return c.json({ error: 'not available' }, 403)

  const { tracks } = await buildStationQueue({
    name: row.name, aiPrompt: row.aiPrompt, seedType: row.seedType, seedValue: row.seedValue ?? undefined, count,
  })
  let queued = 0
  for (const t of tracks.slice(0, count)) {
    try {
      await enqueueVideoSave({ userId: user.id, videoId: t.videoId, title: t.title, kind: 'audio', maxHeight: null, firstName: user.firstName, audioFormat: 'm4a' })
      queued++
    } catch { /* skip individual failures */ }
  }
  return c.json({ queued, total: tracks.length })
})
