// Music stations API — generative AI radio stations. Build a queue from a seed, full CRUD for
// user-owned stations, family sharing (private ↔ shared), clone-a-shared-station, and the
// built-in default roster reconciled on every install.

import { Hono } from 'hono'
import { eq, or, and, isNull, like, desc, inArray } from 'drizzle-orm'

import { db } from '@/db'
import { musicStations, musicOfflineStations, musicOfflineStationTracks, musicDjCache, musicFavorites, musicHistory, ytDownloads, users } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { buildStationQueue, type StationSeed, type StationSeedType } from '@/lib/music/stationEngine'
import { itunesSongArt } from '@/lib/music/catalog'
import { backfillCoverForStation } from '@/lib/music/coverBackfill'
import { enqueueVideoSave } from '@/lib/youtube/automation'
import { AUDIO_FORMATS, type AudioFormat } from '@/lib/youtube/assets'
import { getEffectiveCap, getUserPreference } from '@/lib/youtube/quality'
import { generateDjSegment, lookupFacts } from '@/routes/musicRadio'
import { generateTuningMessages, FALLBACK_TUNING_MESSAGES } from '@/lib/music/tuningMessages'
import { BUILTIN_TUNING_MESSAGES } from '@/lib/music/builtinTuning'
import { accentForSeed } from '@/lib/music/accents'
import { cleanAutoTitle } from '@/lib/cleanTitle'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveUserPath, getDataRoot } from '@/lib/storage/paths'
import { getOrFetchMediaImage } from '@/lib/titles/imageProxy'
import { filterTracksForUser } from '@/lib/music/advisory'
import { ensureLyricAdvisories } from '@/lib/music/lyricsAdvisory'
import { featureCount, searchFeatures, sonicAdventurePath } from '@/lib/music/similarity'
import {
  audioGateFor, familyEntrySetsFor, stationAllowed, filterTracksBySets, logFamilyAudioEvent,
} from '@/lib/family/audioPolicy'
import { logger } from '@/lib/logger'
import type { AppEnv } from '@/types'

export const musicStations_route = new Hono<AppEnv>()
musicStations_route.use('*', requireAuth)
// Exported under the original name the index registers.
export { musicStations_route as musicStations }

type StationRow = typeof musicStations.$inferSelect

function serialize(row: StationRow, currentUserId: string, ownerName?: string | null) {
  // Back-compat: very old rows stored their "source:movie:…" origin tag in `description`.
  // Surface it as `sourceRef` and keep it out of the human-facing description.
  const legacySource = row.description?.startsWith('source:') ? row.description : null
  return {
    id: row.id,
    name: row.name,
    description: legacySource ? null : row.description,
    sourceRef: row.sourceRef ?? legacySource,
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
    // Only expose real photo art (movie/show poster, album cover, etc.) — not the SVG placeholders
    // that the component now renders natively. SVG paths end in '.svg'.
    iconUrl: (row.iconPath && !row.iconPath.endsWith('.svg')) ? `/api/music/stations/${row.id}/art/icon` : null,
    bannerUrl: (row.bannerPath && !row.bannerPath.endsWith('.svg')) ? `/api/music/stations/${row.id}/art/banner` : null,
    coverTrack: parseCoverTrack(row.coverTrackJson),
  }
}

function parseCoverTrack(json: string | null): { videoId: string; title: string; artist: string | null } | null {
  if (!json) return null
  try {
    const p = JSON.parse(json) as { videoId?: string; title?: string; artist?: string | null }
    // Accept ART-ONLY stamps (empty videoId): built-in covers, the LLM backfill, and the
    // iTunes tune-in tier all carry title+artist with no videoId, and the frontend's
    // useSongArt resolves their album art via artist+title. Requiring a videoId here was
    // silently dropping every one of those covers (the vast majority of stations).
    if (!p.title) return null
    if (!p.videoId && !p.artist) return null
    return { videoId: p.videoId ?? '', title: p.title, artist: p.artist ?? null }
  } catch { return null }
}

// Name/description/category/seed search over the stations a user can see (built-ins +
// own + shared). Used by the music catalog search so stations surface alongside
// artists/albums/songs. Built-ins are reconciled first so a fresh install still matches.
export async function searchStations(query: string, userId: string, limit = 8) {
  const q = query.trim()
  if (!q) return []
  await reconcileBuiltins()
  const pattern = `%${q.replace(/[\\%_]/g, '')}%`
  const rows = await db
    .select({ s: musicStations, ownerName: users.firstName })
    .from(musicStations)
    .leftJoin(users, eq(musicStations.userId, users.id))
    .where(and(
      or(
        isNull(musicStations.userId),            // built-ins
        eq(musicStations.userId, userId),         // own
        eq(musicStations.visibility, 'shared'),   // shared by others
      ),
      or(
        like(musicStations.name, pattern),
        like(musicStations.description, pattern),
        like(musicStations.category, pattern),
        like(musicStations.seedValue, pattern),
      ),
    ))
    .limit(limit * 4)

  const ql = q.toLowerCase()
  return rows
    .map(r => serialize(r.s, userId, r.ownerName))
    // Name matches lead, then built-ins, so the most on-target stations come first.
    .sort((a, b) =>
      (a.name.toLowerCase().includes(ql) ? 0 : 1) - (b.name.toLowerCase().includes(ql) ? 0 : 1) ||
      Number(b.isBuiltin) - Number(a.isBuiltin))
    .slice(0, limit)
}

// ── Per-station "tuning in" loading lines ──────────────────────────────────────────
function parseMessages(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((m): m is string => typeof m === 'string') : []
  } catch { return [] }
}

// Lazily generate + persist a custom loading-message set for a station the first time it's
// needed. Guarded so concurrent tune-ins don't fire duplicate LLM calls. Fire-and-forget:
// callers serve the fallback pool immediately and pick up the custom set on the next play.
const tuningInFlight = new Set<string>()
async function ensureTuningMessages(row: StationRow): Promise<void> {
  if (parseMessages(row.loadingMessages).length || tuningInFlight.has(row.id)) return
  tuningInFlight.add(row.id)
  try {
    const msgs = await generateTuningMessages(row)
    if (msgs.length >= 3) {
      await db.update(musicStations).set({ loadingMessages: JSON.stringify(msgs) }).where(eq(musicStations.id, row.id))
    }
  } finally {
    tuningInFlight.delete(row.id)
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

// A known iconic cover song per built-in (artist, title). Its album art resolves via
// artist+title on iTunes (the same art-only mechanism the LLM backfill uses), so every
// built-in card + hero shows a real cover instantly on boot: deterministic, offline, and
// with none of the slow, boot-delayed, GPU-bound LLM backfill. Stamped only while unset
// (see reconcileBuiltins), so a real tune-in still wins. Songs are validated to resolve on
// iTunes; a station intentionally omitted here (e.g. cartoon-network) stays on the live
// StationArt look and remains eligible for the LLM backfill.
const BUILTIN_COVERS: Record<string, readonly [string, string]> = {
  'builtin:todays-hits': ['Harry Styles', 'As It Was'],
  'builtin:viral-hits': ['Doja Cat', 'Say So'],
  'builtin:feel-good-classics': ['Earth, Wind & Fire', 'September'],
  'builtin:one-hit-wonders': ['Dexys Midnight Runners', 'Come On Eileen'],
  'builtin:guilty-pleasures': ['Britney Spears', 'Toxic'],
  'builtin:hip-hop-now': ['Kendrick Lamar', 'HUMBLE.'],
  'builtin:classic-rock': ['AC/DC', 'Back In Black'],
  'builtin:throwback-rnb': ['TLC', 'No Scrubs'],
  'builtin:country-roads': ['John Denver', 'Take Me Home, Country Roads'],
  'builtin:jazz-cafe': ['The Dave Brubeck Quartet', 'Take Five'],
  'builtin:classical': ['Claude Debussy', 'Clair de Lune'],
  'builtin:metal': ['Metallica', 'Enter Sandman'],
  'builtin:punk': ['Ramones', 'Blitzkrieg Bop'],
  'builtin:funk-soul': ['Stevie Wonder', 'Superstition'],
  'builtin:disco': ['Bee Gees', "Stayin' Alive"],
  'builtin:blues': ['B.B. King', 'The Thrill Is Gone'],
  'builtin:folk-acoustic': ['Simon & Garfunkel', 'The Sound of Silence'],
  'builtin:gospel': ['Edwin Hawkins Singers', 'Oh Happy Day'],
  'builtin:reggae': ['Bob Marley & The Wailers', 'Three Little Birds'],
  'builtin:latin': ['Marc Anthony', 'Vivir Mi Vida'],
  'builtin:reggaeton': ['Daddy Yankee', 'Gasolina'],
  'builtin:kpop': ['BTS', 'Dynamite'],
  'builtin:afrobeats': ['WizKid', 'Essence'],
  'builtin:bollywood': ['A.R. Rahman', 'Jai Ho'],
  'builtin:electronic-pulse': ['Daft Punk', 'One More Time'],
  'builtin:synthwave': ['Kavinsky', 'Nightcall'],
  'builtin:indie-discoveries': ['Franz Ferdinand', 'Take Me Out'],
  'builtin:alt-2000s': ['The Killers', 'Mr. Brightside'],
  'builtin:golden-oldies': ['Chuck Berry', 'Johnny B. Goode'],
  'builtin:70s-gold': ['ABBA', 'Dancing Queen'],
  'builtin:80s-throwback': ['a-ha', 'Take On Me'],
  'builtin:90s-nostalgia': ['Nirvana', 'Smells Like Teen Spirit'],
  'builtin:2000s-throwback': ['OutKast', 'Hey Ya!'],
  'builtin:workout': ['Eminem', 'Till I Collapse'],
  'builtin:party': ['The Black Eyed Peas', 'I Gotta Feeling'],
  'builtin:roadtrip': ['Tom Cochrane', 'Life Is a Highway'],
  'builtin:deep-focus': ['Ludovico Einaudi', 'Nuvole Bianche'],
  'builtin:lofi-focus': ['Nujabes', 'Aruarian Dance'],
  'builtin:chill': ['MGMT', 'Electric Feel'],
  'builtin:sleep': ['Max Richter', 'On the Nature of Daylight'],
  'builtin:meditation': ['Marconi Union', 'Weightless'],
  'builtin:rainy-day': ['Bon Iver', 'Skinny Love'],
  'builtin:morning-coffee': ['Jack Johnson', 'Banana Pancakes'],
  'builtin:coffeehouse': ['Jeff Buckley', 'Hallelujah'],
  'builtin:date-night': ['Marvin Gaye', "Let's Get It On"],
  'builtin:dinner-party': ['Stan Getz', 'The Girl from Ipanema'],
  'builtin:retro-gaming': ['Koji Kondo', 'Super Mario Bros. Main Theme'],
  'builtin:8bit-chiptune': ['Anamanaguchi', 'Airbrushed'],
  'builtin:vgm-remixes': ['Lindsey Stirling', 'Crystallize'],
  'builtin:game-soundtracks': ['Gustavo Santaolalla', 'The Last of Us'],
  'builtin:vaporwave': ['HOME', 'Resonance'],
  'builtin:movie-scores': ['Hans Zimmer', 'Time'],
  'builtin:anime': ['Yoko Takahashi', "A Cruel Angel's Thesis"],
  'builtin:yacht-rock': ['Toto', 'Africa'],
  'builtin:halloween': ['Michael Jackson', 'Thriller'],
  'builtin:holiday': ['Mariah Carey', 'All I Want for Christmas Is You'],
  'builtin:80s-tv-themes': ['Jan Hammer', 'Miami Vice Theme'],
  'builtin:90s-tv-themes': ['The Rembrandts', "I'll Be There for You"],
  'builtin:tv-greatest-themes': ['Alabama 3', 'Woke Up This Morning'],
  'builtin:saturday-cartoons': ["The B-52's", '(Meet) The Flintstones'],
  'builtin:disney-animated': ['Idina Menzel', 'Let It Go'],
  'builtin:broadway': ['Original Broadway Cast of Hamilton', 'Alexander Hamilton'],
  'builtin:90s-nick': ['SpongeBob SquarePants', 'SpongeBob SquarePants Theme Song'],
  'builtin:2k-nick': ['Miranda Cosgrove', 'Leave It All to Me'],
  'builtin:disney-channel': ['Hannah Montana', 'The Best of Both Worlds'],
  'builtin:2010s-throwback': ['Mark Ronson', 'Uptown Funk'],
  'builtin:summer-beach': ['The Beach Boys', 'Kokomo'],
  'builtin:motown-gold': ['The Temptations', 'My Girl'],
  'builtin:karaoke': ['Journey', "Don't Stop Believin'"],
  'builtin:wedding': ['Whitney Houston', 'I Wanna Dance with Somebody (Who Loves Me)'],
  'builtin:pride-anthems': ['Lady Gaga', 'Born This Way'],
  'builtin:movie-soundtracks': ['Berlin', 'Take My Breath Away'],
  'builtin:80s-movies': ['Simple Minds', "Don't You (Forget About Me)"],
  'builtin:james-bond': ['Adele', 'Skyfall'],
  'builtin:tarantino': ['Dick Dale & His Del-Tones', 'Misirlou'],
  'builtin:spaghetti-western': ['Ennio Morricone', 'The Good, the Bad and the Ugly'],
  'builtin:sci-fi-scores': ['John Williams', 'Star Wars (Main Title)'],
  'builtin:horror-scores': ['Mike Oldfield', 'Tubular Bells'],
  'builtin:rom-com': ['Sixpence None the Richer', 'Kiss Me'],
  'builtin:training-montage': ['Survivor', 'Eye of the Tiger'],
  'builtin:superhero-themes': ['Alan Silvestri', 'The Avengers'],
  'builtin:british-invasion': ['The Beatles', 'I Want to Hold Your Hand'],
  'builtin:hair-metal': ['Def Leppard', 'Pour Some Sugar on Me'],
  'builtin:new-wave': ['New Order', 'Blue Monday'],
  'builtin:grunge': ['Soundgarden', 'Black Hole Sun'],
  'builtin:golden-age-hiphop': ['Wu-Tang Clan', 'C.R.E.A.M.'],
  'builtin:boy-bands-divas': ['Backstreet Boys', 'I Want It That Way'],
  'builtin:power-ballads': ['Foreigner', 'I Want to Know What Love Is'],
  'builtin:stadium-anthems': ['Queen', 'We Will Rock You'],
  'builtin:outlaw-country': ['Johnny Cash', 'Folsom Prison Blues'],
  'builtin:singer-songwriter-70s': ['James Taylor', 'Fire and Rain'],
  'builtin:y2k-pop': ['Britney Spears', '...Baby One More Time'],
  'builtin:happy-vibes': ['Pharrell Williams', 'Happy'],
  'builtin:in-my-feels': ['Adele', 'Someone Like You'],
  'builtin:heartbreak': ["Sinéad O'Connor", 'Nothing Compares 2 U'],
  'builtin:confidence': ['Beyoncé', 'Run the World (Girls)'],
  'builtin:rage': ['Rage Against the Machine', 'Killing In the Name'],
  'builtin:euphoric': ['David Guetta', 'Titanium'],
  'builtin:dreamy': ['Beach House', 'Space Song'],
  'builtin:moody': ['Massive Attack', 'Teardrop'],
  'builtin:mellow-mood': ['Corinne Bailey Rae', 'Put Your Records On'],
  'builtin:sensual': ["D'Angelo", 'Untitled (How Does It Feel)'],
  'builtin:motivation': ['Kanye West', 'Stronger'],
  'builtin:good-times': ['CHIC', 'Good Times'],
  'builtin:jazz-age': ['Scott Joplin', 'The Entertainer'],
  'builtin:big-band': ['Glenn Miller', 'In the Mood'],
  'builtin:flower-power': ['Jefferson Airplane', 'White Rabbit'],
  'builtin:2020s-now': ['The Weeknd', 'Blinding Lights'],
  'builtin:southern-rock': ['Lynyrd Skynyrd', 'Sweet Home Alabama'],
  'builtin:prog-rock': ['Yes', 'Roundabout'],
  'builtin:psychedelic-rock': ['Jimi Hendrix', 'Purple Haze'],
  'builtin:surf-rock': ['The Surfaris', 'Wipe Out'],
  'builtin:rockabilly': ['Elvis Presley', 'Jailhouse Rock'],
  'builtin:glam-rock': ['David Bowie', 'Ziggy Stardust'],
  'builtin:britpop': ['Oasis', 'Wonderwall'],
  'builtin:ska': ['The Mighty Mighty Bosstones', 'The Impression That I Get'],
  'builtin:bluegrass': ['The Soggy Bottom Boys', 'I Am a Man of Constant Sorrow'],
  'builtin:nu-metal': ['Linkin Park', 'In the End'],
  'builtin:new-jack-swing': ['Bell Biv DeVoe', 'Poison'],
  'builtin:smooth-jazz': ['Grover Washington, Jr.', 'Just the Two of Us'],
}

let reconciled = false
/** Insert any missing built-in stations (idempotent). Called lazily on first list. */
async function reconcileBuiltins(): Promise<void> {
  if (reconciled) return
  reconciled = true
  const now = new Date()
  try {
    for (const s of DEFAULT_MUSIC_STATIONS) {
      const tuning = BUILTIN_TUNING_MESSAGES[s.id]
      await db.insert(musicStations).values({
        id: s.id, userId: null, name: s.name, description: s.description, aiPrompt: s.aiPrompt,
        seedType: 'prompt', seedValue: null, accent: s.accent, category: categoryFor(s.id), djMode: s.djMode,
        loadingMessages: tuning?.length ? JSON.stringify(tuning) : null,
        visibility: 'shared', isBuiltin: true, isAdult: false, createdAt: now, updatedAt: now,
      }).onConflictDoNothing()
    }
  } catch (err) {
    reconciled = false
    logger.debug(`[stations] reconcile failed: ${String(err)}`)
  }
  // Keep built-in categories and shipped tuning lines in sync. Cover art is rendered on the
  // client now (see StationArt), so we don't generate cover files for built-ins. Re-applying the
  // static tuning lines here is what makes them survive an uninstall: they always come back from
  // BUILTIN_TUNING_MESSAGES on the next boot/reinstall.
  try {
    await Promise.all(DEFAULT_MUSIC_STATIONS.map(s => {
      const tuning = BUILTIN_TUNING_MESSAGES[s.id]
      return db.update(musicStations).set({
        category: categoryFor(s.id),
        ...(tuning?.length ? { loadingMessages: JSON.stringify(tuning) } : {}),
      }).where(eq(musicStations.id, s.id))
    }))
  } catch (err) { logger.debug(`[stations] category sync failed: ${String(err)}`) }

  // Stamp each built-in's known iconic cover song, but only while unset so a real tune-in
  // (which stamps from the actual queue) still wins. The art-only stamp (empty videoId)
  // resolves through the same artist+title iTunes lookup every consumer already uses, so
  // built-in cards and the home hero show real album covers immediately, no LLM backfill.
  try {
    await Promise.all(Object.entries(BUILTIN_COVERS).map(([id, [artist, title]]) =>
      db.update(musicStations)
        .set({ coverTrackJson: JSON.stringify({ videoId: '', title, artist }) })
        .where(and(eq(musicStations.id, id), isNull(musicStations.coverTrackJson)))))
  } catch (err) { logger.debug(`[stations] built-in cover stamp failed: ${String(err)}`) }
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

  let all = rows.map(r => serialize(r.s, user.id, r.ownerName))
  // Family audio: allowlist-only profiles see only their approved stations (built-in,
  // own, or family-shared alike); blocklisted stations disappear for anyone they apply to.
  const sets = await familyEntrySetsFor(user.id)
  if (sets.hasAny) all = all.filter(s => stationAllowed(sets, s.id))
  return c.json({
    builtin: all.filter(s => s.isBuiltin),
    mine: all.filter(s => !s.isBuiltin && s.owned),
    shared: all.filter(s => !s.isBuiltin && !s.owned),
    categories: STATION_CATEGORY_ORDER,
  })
})

// ── List saved-offline stations ─────────────────────────────────────────────────
// Drives the offline Stations page + offline-mode filtering. Returns the saved stations as
// station-shaped cards (live data when the source row still exists, else cached fields) plus
// each one's live download/DJ readiness. Registered before `/:id` so "offline" isn't a station id.
musicStations_route.get('/offline', async (c) => {
  const user = c.get('user')
  const rows = await db
    .select({ off: musicOfflineStations, s: musicStations, ownerName: users.firstName })
    .from(musicOfflineStations)
    .leftJoin(musicStations, eq(musicOfflineStations.stationId, musicStations.id))
    .leftJoin(users, eq(musicStations.userId, users.id))
    .where(eq(musicOfflineStations.userId, user.id))
    .orderBy(desc(musicOfflineStations.updatedAt))

  const stations = await Promise.all(rows.map(async (r) => {
    const off = r.off
    const base = r.s
      ? serialize(r.s, user.id, r.ownerName)
      : { // source station gone — render from the cached snapshot fields
          id: off.stationId, name: off.name, description: null, aiPrompt: '', seedType: 'prompt',
          seedValue: null, djMode: off.djMode, visibility: 'private', accent: off.accent, category: null,
          isBuiltin: false, owned: true, ownerName: null,
          iconUrl: (off.iconPath && !off.iconPath.endsWith('.svg')) ? `/api/music/stations/${off.stationId}/art/icon` : null,
          bannerUrl: (off.bannerPath && !off.bannerPath.endsWith('.svg')) ? `/api/music/stations/${off.stationId}/art/banner` : null,
        }
    const status = await offlineStatusFor(user.id, off.stationId, off.trackTotal, off.djMode as DjMode, off.media as OfflineMedia)
    return { ...base, offline: status }
  }))
  return c.json({ stations })
})

// ── Playful "tuning in" loading lines for the Now Playing spin-up screen ────────────
// Serves the station's stored set, or a generic fallback while a custom set is generated
// + persisted in the background (so the next tune-in shows the station's own lines).
musicStations_route.get('/:id/tuning', async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(musicStations).where(eq(musicStations.id, id))
  if (!row) return c.json({ messages: FALLBACK_TUNING_MESSAGES })

  const stored = parseMessages(row.loadingMessages)
  if (stored.length) return c.json({ messages: stored })

  void ensureTuningMessages(row).catch(() => {})
  return c.json({ messages: FALLBACK_TUNING_MESSAGES })
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
  const sets = await familyEntrySetsFor(user.id)
  if (sets.hasAny && !stationAllowed(sets, row.s.id)) {
    logFamilyAudioEvent(user.id, 'blocked_play', { label: row.s.name, medium: 'music', reason: 'station' })
    return c.json({ error: 'This station is not available on this profile', code: 'family_blocked' }, 403)
  }
  return c.json({ station: serialize(row.s, user.id, row.ownerName) })
})

// ── Create ──────────────────────────────────────────────────────────────────────

/** Everything needed to add a station, from any caller. */
export interface NewStationInput {
  userId: string | null
  name?: string | null
  description?: string | null
  /** Origin tag for auto-built stations ("source:movie:Title"). Its presence also marks the
   *  title as machine-generated, so it gets em-dash/emoji scrubbed. */
  sourceRef?: string | null
  aiPrompt?: string | null
  seedType?: StationSeedType
  seedValue?: string | null
  djMode?: StationRow['djMode']
  accent?: string | null
  visibility?: StationRow['visibility']
  isAdult?: boolean
  /** Photo to use as cover art (movie/show poster, channel avatar…). Ignored if iconPath given. */
  coverImageUrl?: string | null
  /** Pre-existing art to reuse instead of generating (e.g. when cloning). */
  iconPath?: string | null
  bannerPath?: string | null
  /** Pre-resolved cover song to inherit (clone) so it matches the source exactly instead of
   *  the create-path backfill picking a fresh guess. */
  coverTrackJson?: string | null
}

/**
 * The one and only path for adding a user station. Every caller (the create route, clone,
 * future server-side builders) funnels through here so titles, descriptions, art, and the
 * "tuning in" lines are all produced the same way. Throws `Error('name required')` on a
 * blank name. Returns the inserted row.
 */
export async function createStationRecord(input: NewStationInput): Promise<StationRow> {
  const sourceRef = input.sourceRef?.trim() || null
  // Auto-built stations (those with a sourceRef) get em dashes & emoji scrubbed from their
  // title; user-typed names are left exactly as entered.
  const name = (sourceRef ? cleanAutoTitle(input.name) : input.name?.trim()) || ''
  if (!name) throw new Error('name required')

  const id = crypto.randomUUID()
  const accent = input.accent ?? accentForSeed(name)
  const description = input.description?.trim() || null
  const now = new Date()

  await db.insert(musicStations).values({
    id, userId: input.userId, name, description, sourceRef,
    aiPrompt: input.aiPrompt?.trim() || '',
    seedType: input.seedType ?? 'prompt',
    seedValue: input.seedValue?.trim() || null,
    djMode: input.djMode ?? 'full',
    accent,
    iconPath: input.iconPath ?? null,
    bannerPath: input.bannerPath ?? null,
    coverTrackJson: input.coverTrackJson ?? null,
    visibility: input.visibility === 'shared' ? 'shared' : 'private',
    isBuiltin: false, isAdult: input.isAdult ?? false, createdAt: now, updatedAt: now,
  })

  // Art in the background — unless the caller supplied art to reuse (clone). Prefer the
  // provided cover image (movie/show poster), fall back to a generated SVG.
  if (!input.iconPath) {
    const coverImageUrl = input.coverImageUrl?.trim() || null
    void (async () => {
      let iconPath: string | null = null
      let bannerPath: string | null = null
      if (coverImageUrl) {
        try {
          const img = await getOrFetchMediaImage(coverImageUrl)
          if (img) {
            const ext = img.contentType.includes('png') ? 'png' : img.contentType.includes('webp') ? 'webp' : 'jpg'
            const root = await getDataRoot()
            const dir = join(root, '_shared/music-stations', id)
            await mkdir(dir, { recursive: true })
            await writeFile(join(dir, `icon.${ext}`), img.data)
            await writeFile(join(dir, `banner.${ext}`), img.data)
            iconPath = `_shared/music-stations/${id}/icon.${ext}`
            bannerPath = `_shared/music-stations/${id}/banner.${ext}`
          }
        } catch (err) {
          logger.debug(`[stationCreate] cover image download failed: ${String(err)}`)
        }
      }
      // No generated SVG placeholder anymore — a station with no real photo art keeps a null
      // iconPath and renders via the live StationArt look (accent gradient + watermark).
      if (iconPath) {
        await db.update(musicStations)
          .set({ iconPath, bannerPath, updatedAt: new Date() })
          .where(eq(musicStations.id, id))
      }
    })().catch(() => {})
  }

  const [row] = await db.select().from(musicStations).where(eq(musicStations.id, id))
  // Pre-generate this station's playful loading lines in the background, like the art.
  void ensureTuningMessages(row!).catch(() => {})
  // A never-played station has no cover song yet, so its card + hero would sit on the plain
  // gradient+glyph until the next boot backfill. Stamp real album art now (fire-and-forget;
  // no-ops if the user tunes in first, whose real queue always wins the isNull re-check).
  void backfillCoverForStation(id).catch(() => {})
  return row!
}

musicStations_route.post('/', async (c) => {
  const user = c.get('user')
  type CreateBody = {
    name?: string; description?: string; sourceRef?: string; aiPrompt?: string
    seedType?: StationSeedType; seedValue?: string; djMode?: StationRow['djMode']
    accent?: string; visibility?: StationRow['visibility']
    coverImageUrl?: string
  }
  const body = await c.req.json<CreateBody>().catch(() => ({} as CreateBody))
  try {
    const row = await createStationRecord({ ...body, userId: user.id })
    return c.json({ station: serialize(row, user.id) })
  } catch (err) {
    if (err instanceof Error && err.message === 'name required') return c.json({ error: 'name required' }, 400)
    throw err
  }
})

// ── Update (owner only) ────────────────────────────────────────────────────────
musicStations_route.patch('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(musicStations).where(eq(musicStations.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId !== user.id) return c.json({ error: 'not your station' }, 403)

  type StationPatch = Partial<Pick<StationRow, 'name' | 'description' | 'sourceRef' | 'aiPrompt' | 'seedType' | 'seedValue' | 'djMode' | 'accent' | 'visibility'>>
  const body = await c.req.json<StationPatch>().catch(() => ({} as StationPatch))
  await db.update(musicStations).set({
    name: body.name?.trim() || row.name,
    description: body.description !== undefined ? (body.description?.trim() || null) : row.description,
    sourceRef: body.sourceRef !== undefined ? (body.sourceRef?.trim() || null) : row.sourceRef,
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

  const created = await createStationRecord({
    userId: user.id,
    name: `${row.name} (copy)`,
    description: row.description,
    sourceRef: row.sourceRef,
    aiPrompt: row.aiPrompt,
    seedType: row.seedType,
    seedValue: row.seedValue,
    djMode: row.djMode,
    accent: row.accent,
    isAdult: row.isAdult,
    // Reuse the source station's art + cover song rather than regenerating them.
    iconPath: row.iconPath,
    bannerPath: row.bannerPath,
    coverTrackJson: row.coverTrackJson,
  })
  return c.json({ station: serialize(created, user.id) })
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
    const ext = rel.split('.').pop()?.toLowerCase() ?? 'svg'
    const contentType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'jpg' ? 'image/jpeg' : 'image/svg+xml'
    const data = await readFile(abs)
    const headers = { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' }
    if (contentType === 'image/svg+xml') return c.body(data.toString('utf8'), 200, headers)
    // Return binary image as an ArrayBuffer so Hono/Bun serialises it correctly.
    return new Response(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), { status: 200, headers })
  } catch {
    return c.json({ error: 'no art' }, 404)
  }
})

// ── Personal stations (Plexamp-style) ────────────────────────────────────────────
// Library Radio / Deep Cuts / Time Travel Radio are seeded by the LISTENER's own history
// and favorites instead of a prompt. Library Radio plays the actual tracks they know;
// the other two use the listening profile to steer the normal station engine.
export type PersonalStationKind = 'library' | 'deep-cuts' | 'time-travel'

async function buildPersonalQueue(
  userId: string, kind: PersonalStationKind, count: number | undefined,
  excludeVideoIds: string[], fast: boolean,
): Promise<{ tracks: Array<{ videoId: string; title: string; artist: string }>; source: string }> {
  // Listening profile: play counts per track + per artist, favorites boosted.
  const hist = await db.select().from(musicHistory)
    .where(eq(musicHistory.userId, userId)).orderBy(desc(musicHistory.playedAt)).limit(1500)
  const favs = await db.select().from(musicFavorites)
    .where(and(eq(musicFavorites.userId, userId), eq(musicFavorites.kind, 'song')))

  type Cand = { videoId: string; title: string; artist: string; score: number }
  const byRef = new Map<string, Cand>()
  const artistPlays = new Map<string, number>()
  for (const h of hist) {
    const cur = byRef.get(h.videoId) ?? { videoId: h.videoId, title: h.title, artist: h.artist ?? '', score: 0 }
    cur.score += 1
    byRef.set(h.videoId, cur)
    if (h.artist) artistPlays.set(h.artist, (artistPlays.get(h.artist) ?? 0) + 1)
  }
  for (const f of favs) {
    const cur = byRef.get(f.refId) ?? { videoId: f.refId, title: f.title ?? '', artist: f.artist ?? '', score: 0 }
    cur.score += 3
    if (!cur.title && f.title) cur.title = f.title
    if (!cur.artist && f.artist) cur.artist = f.artist
    byRef.set(f.refId, cur)
    if (f.artist) artistPlays.set(f.artist, (artistPlays.get(f.artist) ?? 0) + 1)
  }
  const topArtists = [...artistPlays.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a)
  const want = fast ? Math.min(Math.max(count ?? 3, 1), 4) : Math.min(Math.max(count ?? 24, 6), 100)
  const excluded = new Set(excludeVideoIds)

  if (kind === 'library' && byRef.size >= 5) {
    // Weighted shuffle (exponential-sort: key = U^(1/w)), then a greedy pass so the same
    // artist never plays back-to-back - Plexamp's "smart shuffle of what you listen to".
    const pool = [...byRef.values()]
      .filter(t => t.title && !excluded.has(t.videoId))
      .map(t => ({ t, key: Math.pow(Math.random(), 1 / Math.max(1, t.score)) }))
      .sort((a, b) => b.key - a.key)
      .map(x => x.t)
    const out: Cand[] = []
    while (pool.length && out.length < want) {
      const prev = out[out.length - 1]?.artist
      const idx = pool.findIndex(t => !prev || t.artist !== prev)
      out.push(pool.splice(idx < 0 ? 0 : idx, 1)[0]!)
    }
    if (out.length) return { tracks: out.map(({ videoId, title, artist }) => ({ videoId, title, artist })), source: 'personal-library' }
  }

  // Deep Cuts / Time Travel (and a thin library) steer the normal engine off the profile.
  // Deep cuts also excludes everything they've already played so only unknowns surface.
  const artists = topArtists.slice(0, kind === 'time-travel' ? 8 : 6)
  const played = kind === 'deep-cuts' ? [...byRef.keys()].slice(0, 200) : []
  const prompt = !artists.length
    ? 'An eclectic mix of beloved songs across eras and genres'
    : kind === 'deep-cuts'
      ? `Lesser-known album tracks, B-sides and deep cuts (strictly no hit singles or radio staples) by artists like: ${artists.join(', ')}`
      : kind === 'time-travel'
        ? `A chronological journey through the eras spanned by artists like ${artists.join(', ')}: start with the oldest recordings and progress steadily toward the newest`
        : `A shuffle of songs by ${artists.join(', ')} and close neighbours`
  const result = await buildStationQueue(
    { name: PERSONAL_STATION_NAMES[kind], aiPrompt: prompt, seedType: 'prompt', count, excludeVideoIds: [...excluded, ...played].slice(0, 200) },
    { fast },
  )
  return { tracks: result.tracks.map(t => ({ videoId: t.videoId, title: t.title, artist: t.artist })), source: `personal-${kind}` }
}

const PERSONAL_STATION_NAMES: Record<PersonalStationKind, string> = {
  library: 'Library Radio', 'deep-cuts': 'Deep Cuts', 'time-travel': 'Time Travel Radio',
}

// ── Sonic Adventure (Plexamp) ─────────────────────────────────────────────────────
// A finite path of analyzed tracks that gradually transitions from one song's sound to
// another's. Both endpoints must be in the analyzed library (music_track_features), so
// the picker searches that library and /status reports coverage for the gate copy.
musicStations_route.get('/adventure/status', async (c) => {
  return c.json({ analyzed: await featureCount() })
})

musicStations_route.get('/adventure/search', async (c) => {
  const q = c.req.query('q') ?? ''
  const rows = await searchFeatures(q, 12)
  return c.json({ results: rows.map(r => ({ ref: r.ref, title: r.title, artist: r.artist })) })
})

// ── Build a queue from a seed (no persistence required) ──────────────────────────
musicStations_route.post('/queue', async (c) => {
  type QueueBody = Partial<StationSeed> & {
    stationId?: string; fast?: boolean; personal?: PersonalStationKind
    adventure?: { from: string; to: string }
  }
  const body = await c.req.json<QueueBody>().catch(() => ({} as QueueBody))

  // Family audio: every queue build is a playback start, so gate the time budget and
  // quiet hours here, and hold allowlist-only profiles to their approved stations.
  const gateUser = c.get('user')
  const familyGate = await audioGateFor(gateUser.id)
  if (!familyGate.allowed) {
    logFamilyAudioEvent(gateUser.id, familyGate.reason === 'quiet_hours' ? 'quiet_hours_block' : 'budget_exhausted', { medium: 'music' })
    return c.json({ error: familyGate.reason === 'quiet_hours' ? 'Audio is paused during quiet hours' : 'Audio time is done for today', code: 'family_time' }, 403)
  }
  const familySets = await familyEntrySetsFor(gateUser.id)
  const stationApproved = !!body.stationId && stationAllowed(familySets, body.stationId)
  if (familySets.allowlistOnly && !stationApproved) {
    logFamilyAudioEvent(gateUser.id, 'blocked_play', { label: body.stationId ?? body.aiPrompt ?? body.personal ?? 'station', medium: 'music', reason: 'station' })
    return c.json({ error: 'This station is not available on this profile', code: 'family_blocked' }, 403)
  }
  if (body.stationId && !stationAllowed(familySets, body.stationId)) {
    logFamilyAudioEvent(gateUser.id, 'blocked_play', { label: body.stationId, medium: 'music', reason: 'station' })
    return c.json({ error: 'This station is not available on this profile', code: 'family_blocked' }, 403)
  }

  // Sonic Adventure: the path is cheap to compute and finite, so both the fast and the
  // full build return the whole thing (the engine's head-dedup keeps the order stable).
  if (body.adventure?.from && body.adventure?.to) {
    const path = await sonicAdventurePath(body.adventure.from, body.adventure.to, 12)
    if (!path) return c.json({ error: 'Both songs need sonic analysis first' }, 400)
    const listener = c.get('user')
    let tracks = path.map(t => ({ videoId: t.ref, title: t.title ?? t.ref, artist: t.artist ?? '' }))
    if (listener) {
      tracks = filterTracksBySets(familySets, tracks)
      tracks = await filterTracksForUser(listener.id, tracks)
    }
    return c.json({ tracks, source: 'sonic-adventure' })
  }

  // Personal stations: seeded by the listener's own history/favorites, no prompt needed.
  if (body.personal === 'library' || body.personal === 'deep-cuts' || body.personal === 'time-travel') {
    const listener = c.get('user')
    const exclude = Array.isArray(body.excludeVideoIds) ? body.excludeVideoIds.slice(0, 200) : []
    const personal = await buildPersonalQueue(listener.id, body.personal, body.count, exclude, body.fast === true)
    personal.tracks = filterTracksBySets(familySets, personal.tracks)
    personal.tracks = await filterTracksForUser(listener.id, personal.tracks)
    return c.json(personal)
  }

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

  const result = await buildStationQueue(seed, { fast: body.fast === true })

  // Stamp the station's "cover song" so cards + hero show real album art. Fire-and-forget.
  if (body.stationId) void stampStationCoverIfEmpty(body.stationId, result.tracks ?? [])

  // Content protections: drop explicit tracks (and unknowns, when the profile is strict)
  // for the listening user. Unknowns get background-checked so the picture sharpens.
  const listener = c.get('user')
  if (listener) {
    // Family audio: blocklisted artists never surface; an approved station is the
    // parent's unit of approval, so its tracks aren't re-vetted artist-by-artist.
    result.tracks = filterTracksBySets(familySets, result.tracks, stationApproved)
    result.tracks = await filterTracksForUser(listener.id, result.tracks)
    // Warm lyric-derived advisories for tracks the catalog couldn't rate, so the unknown
    // population shrinks and teen-tier filtering sharpens over time (background).
    ensureLyricAdvisories(result.tracks)
  }

  return c.json(result)
})

/** Stamp a station's cover song ONCE (only while unset — station art must be stable, not
 *  churn with every tune-in, or the card you clicked stops matching the hero it opens).
 *  Prefers the first queue track whose album art actually resolves (iTunes, cached), so
 *  covers are never blurry video-thumbnail fallbacks; plain lead track as last resort. */
export async function stampStationCoverIfEmpty(
  stationId: string,
  tracks: Array<{ videoId: string; title: string; artist?: string | null }>,
): Promise<void> {
  try {
    if (!tracks.length) return
    const [row] = await db.select({ coverTrackJson: musicStations.coverTrackJson })
      .from(musicStations).where(eq(musicStations.id, stationId)).limit(1)
    if (!row || row.coverTrackJson) return
    let pick = tracks[0]!
    for (const t of tracks.slice(0, 5)) {
      if (!t.videoId || !t.title || !t.artist) continue
      if (await itunesSongArt(t.artist, t.title)) { pick = t; break }
    }
    if (!pick.videoId || !pick.title) return
    await db.update(musicStations)
      .set({ coverTrackJson: JSON.stringify({ videoId: pick.videoId, title: pick.title, artist: pick.artist ?? null }) })
      .where(eq(musicStations.id, stationId))
  } catch { /* cosmetic metadata — losing a stamp is fine */ }
}

// ── Offline stations ───────────────────────────────────────────────────────────────
// Saving a station offline freezes its generative queue into a fixed tracklist, downloads each
// track's audio (reusing the YouTube offline-save pipeline), and pre-renders the AI DJ — so the
// whole station plays end to end with no internet. Each user gets their own copy.

type DjMode = 'full' | 'minimal' | 'silent'
type OfflineMedia = 'audio' | 'video' | 'both'

/** Expected number of pre-rendered DJ segments for a frozen tracklist: intro + one transition
 *  per adjacent pair + outro. Zero when the DJ is silent or there are no tracks. */
function expectedDjCount(djMode: DjMode, trackTotal: number): number {
  if (djMode === 'silent' || trackTotal < 1) return 0
  return trackTotal + 1 // intro(1) + transitions(trackTotal-1) + outro(1)
}

/** Count frozen tracks of `stationId` whose `kind` download is ready. */
async function readyCount(userId: string, ids: string[], kind: 'audio' | 'video'): Promise<number> {
  if (!ids.length) return 0
  const ready = await db.select({ videoId: ytDownloads.videoId }).from(ytDownloads)
    .where(and(eq(ytDownloads.userId, userId), eq(ytDownloads.kind, kind), eq(ytDownloads.status, 'ready'), inArray(ytDownloads.videoId, ids)))
  return new Set(ready.map(r => r.videoId)).size
}

/** Live readiness for an offline station: audio + video downloads ready and DJ context cached,
 *  plus an effective coarse status that respects the chosen media. Source of truth for progress. */
async function offlineStatusFor(userId: string, stationId: string, trackTotal: number, djMode: DjMode, media: OfflineMedia) {
  const frozen = await db.select({ videoId: musicOfflineStationTracks.videoId })
    .from(musicOfflineStationTracks)
    .where(and(eq(musicOfflineStationTracks.userId, userId), eq(musicOfflineStationTracks.stationId, stationId)))
  const ids = frozen.map(f => f.videoId)
  const wantAudio = media === 'audio' || media === 'both'
  const wantVideo = media === 'video' || media === 'both'
  const tracksReady = wantAudio ? await readyCount(userId, ids, 'audio') : 0
  const videoReady = wantVideo ? await readyCount(userId, ids, 'video') : 0

  const djRows = await db.select({ id: musicDjCache.id }).from(musicDjCache)
    .where(and(eq(musicDjCache.userId, userId), eq(musicDjCache.stationId, stationId)))
  const djReady = djRows.length
  const djTotal = wantAudio ? expectedDjCount(djMode, trackTotal) : 0

  const audioDone = !wantAudio || (tracksReady >= trackTotal && djReady >= djTotal)
  const videoDone = !wantVideo || videoReady >= trackTotal
  const anyReady = tracksReady > 0 || videoReady > 0
  const status: 'pending' | 'partial' | 'ready' | 'failed' =
    !anyReady ? 'pending' : (audioDone && videoDone) ? 'ready' : 'partial'
  return { status, tracksReady, trackTotal, djReady, djTotal, videoReady, media }
}

/** Background pass: cache the Wikipedia facts for each DJ segment at snapshot time.
 *  At playback the LLM + TTS run on demand, so pronunciation rules and voice changes
 *  always apply. Best-effort — a failed segment just means no trivia for that transition. */
async function generateDjContext(user: { id: string }, station: StationRow, tracks: { videoId: string; title: string; artist: string }[]) {
  const djMode = station.djMode as DjMode
  if (djMode === 'silent' || !tracks.length) return
  const style = djMode === 'minimal' ? 'minimal' : 'full'
  const genre = station.seedValue || station.name

  type Seg = { position: 'intro' | 'transition' | 'outro'; from: string; to: string | null; trackName: string; artistName: string; nextTrackName?: string; nextArtistName?: string }
  const segs: Seg[] = []
  const first = tracks[0]!
  segs.push({ position: 'intro', from: first.videoId, to: null, trackName: first.title, artistName: first.artist })
  for (let i = 0; i < tracks.length - 1; i++) {
    const cur = tracks[i]!, next = tracks[i + 1]!
    segs.push({ position: 'transition', from: cur.videoId, to: next.videoId, trackName: cur.title, artistName: cur.artist, nextTrackName: next.title, nextArtistName: next.artist })
  }
  const last = tracks[tracks.length - 1]!
  segs.push({ position: 'outro', from: last.videoId, to: null, trackName: last.title, artistName: last.artist })

  for (const seg of segs) {
    try {
      // Only transitions in full mode benefit from Wikipedia facts; others get empty string.
      const facts = seg.position === 'transition' && style !== 'minimal'
        ? await lookupFacts(seg.artistName, seg.trackName).catch(() => '')
        : ''
      await db.insert(musicDjCache).values({
        id: crypto.randomUUID(), userId: user.id, stationId: station.id,
        position: seg.position, fromVideoId: seg.from, toVideoId: seg.to,
        genre, stationName: station.name, trackName: seg.trackName, artistName: seg.artistName,
        nextTrackName: seg.nextTrackName ?? null, nextArtistName: seg.nextArtistName ?? null,
        style, facts: facts || null, createdAt: new Date(),
      })
    } catch (err) { logger.warn({ err, stationId: station.id, position: seg.position }, 'offline DJ context cache failed') }
  }
}

// POST /:id/snapshot — "Make this station available offline".
musicStations_route.post('/:id/snapshot', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json<{ count?: number; media?: OfflineMedia; maxHeight?: number; audioFormat?: string }>().catch(() => ({} as { count?: number; media?: OfflineMedia; maxHeight?: number; audioFormat?: string }))
  const count = Math.min(Math.max(body.count ?? 20, 1), 100)
  const media: OfflineMedia = body.media === 'video' || body.media === 'both' ? body.media : 'audio'
  const wantAudio = media === 'audio' || media === 'both'
  const wantVideo = media === 'video' || media === 'both'
  // Audio quality for the snapshot's songs (same options as single-song downloads).
  const audioFormat: AudioFormat = (AUDIO_FORMATS as readonly string[]).includes(body.audioFormat ?? '') ? body.audioFormat as AudioFormat : 'm4a'
  // Resolve the video resolution under the shared YouTube quality governance (admin cap wins).
  let videoHeight: number | null = null
  if (wantVideo) {
    const cap = await getEffectiveCap(user.id)
    const pref = await getUserPreference(user.id)
    videoHeight = Math.min(body.maxHeight ?? pref ?? cap, cap)
  }

  const [row] = await db.select().from(musicStations).where(eq(musicStations.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId && row.userId !== user.id && row.visibility !== 'shared') return c.json({ error: 'not available' }, 403)

  const { tracks: built } = await buildStationQueue({
    name: row.name, aiPrompt: row.aiPrompt, seedType: row.seedType, seedValue: row.seedValue ?? undefined, count,
  })
  const tracks = built.slice(0, count).map(t => ({ videoId: t.videoId, title: t.title, artist: t.artist ?? '' }))
  if (!tracks.length) return c.json({ error: 'no tracks to save' }, 422)

  const now = new Date()
  // Upsert the offline-station record (caches display fields for offline rendering).
  const [existing] = await db.select({ id: musicOfflineStations.id }).from(musicOfflineStations)
    .where(and(eq(musicOfflineStations.userId, user.id), eq(musicOfflineStations.stationId, id)))
  const offlineStationId = existing?.id ?? crypto.randomUUID()
  const fields = {
    name: row.name, accent: row.accent, djMode: row.djMode, media, iconPath: row.iconPath, bannerPath: row.bannerPath,
    status: 'pending' as const, trackTotal: tracks.length, updatedAt: now,
  }
  if (existing) {
    await db.update(musicOfflineStations).set(fields).where(eq(musicOfflineStations.id, offlineStationId))
  } else {
    await db.insert(musicOfflineStations).values({ id: offlineStationId, userId: user.id, stationId: id, createdAt: now, ...fields })
  }

  // Replace the frozen tracklist, and clear any stale DJ cache rows for a fresh render.
  await db.delete(musicOfflineStationTracks).where(and(eq(musicOfflineStationTracks.userId, user.id), eq(musicOfflineStationTracks.stationId, id)))
  await db.delete(musicDjCache).where(and(eq(musicDjCache.userId, user.id), eq(musicDjCache.stationId, id)))
  await db.insert(musicOfflineStationTracks).values(tracks.map((t, i) => ({
    id: crypto.randomUUID(), userId: user.id, stationId: id, videoId: t.videoId, title: t.title, artist: t.artist, position: i, createdAt: now,
  })))

  // Enqueue the chosen media downloads (reuses the durable YouTube save pipeline).
  let queued = 0
  for (const t of tracks) {
    try {
      if (wantAudio) await enqueueVideoSave({ userId: user.id, videoId: t.videoId, title: t.title, kind: 'audio', maxHeight: null, firstName: user.firstName, audioFormat, origin: 'music' })
      if (wantVideo) await enqueueVideoSave({ userId: user.id, videoId: t.videoId, title: t.title, kind: 'video', maxHeight: videoHeight, firstName: user.firstName, origin: 'music' })
      queued++
    } catch { /* skip individual failures */ }
  }

  // Persist a coarse status after the (quick) DJ-context cache; live progress is recomputed by
  // the status endpoint. DJ only applies when audio is included (DJ talks over the audio deck).
  const finalize = () => offlineStatusFor(user.id, id, tracks.length, row.djMode as DjMode, media)
    .then(s => db.update(musicOfflineStations).set({ status: s.status, updatedAt: new Date() }).where(eq(musicOfflineStations.id, offlineStationId)))
    .catch(err => logger.warn({ err, stationId: id }, 'offline snapshot background pass failed'))
  if (wantAudio) void generateDjContext({ id: user.id }, row, tracks).then(finalize).catch(() => void finalize())
  else void finalize()

  return c.json({ offlineStationId, queued, total: tracks.length })
})

// GET /:id/offline-status — live download + DJ-render progress (polled by the station page).
musicStations_route.get('/:id/offline-status', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [off] = await db.select().from(musicOfflineStations)
    .where(and(eq(musicOfflineStations.userId, user.id), eq(musicOfflineStations.stationId, id)))
  if (!off) return c.json({ saved: false })
  const s = await offlineStatusFor(user.id, id, off.trackTotal, off.djMode as DjMode, off.media as OfflineMedia)
  return c.json({ saved: true, ...s })
})

// GET /:id/offline-tracks — the full frozen tracklist with each track's audio + video download
// status, so the station page can show exactly what was saved (not a fresh sample).
musicStations_route.get('/:id/offline-tracks', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const frozen = await db.select().from(musicOfflineStationTracks)
    .where(and(eq(musicOfflineStationTracks.userId, user.id), eq(musicOfflineStationTracks.stationId, id)))
    .orderBy(musicOfflineStationTracks.position)
  if (!frozen.length) return c.json({ tracks: [] })
  const dls = await db.select({ videoId: ytDownloads.videoId, kind: ytDownloads.kind, status: ytDownloads.status }).from(ytDownloads)
    .where(and(eq(ytDownloads.userId, user.id), inArray(ytDownloads.videoId, frozen.map(f => f.videoId))))
  const audioStatus = new Map(dls.filter(d => d.kind === 'audio').map(d => [d.videoId, d.status]))
  const videoStatus = new Map(dls.filter(d => d.kind === 'video').map(d => [d.videoId, d.status]))
  return c.json({ tracks: frozen.map(t => ({
    videoId: t.videoId, title: t.title, artist: t.artist, position: t.position,
    status: audioStatus.get(t.videoId) ?? 'pending',
    videoStatus: videoStatus.get(t.videoId) ?? null,
  })) })
})

// GET /:id/offline-video-queue — frozen tracklist filtered to tracks whose VIDEO is downloaded,
// for the offline Watch player (it plays the local video files; no DJ in video mode).
musicStations_route.get('/:id/offline-video-queue', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const frozen = await db.select().from(musicOfflineStationTracks)
    .where(and(eq(musicOfflineStationTracks.userId, user.id), eq(musicOfflineStationTracks.stationId, id)))
    .orderBy(musicOfflineStationTracks.position)
  if (!frozen.length) return c.json({ tracks: [] })
  const ready = await db.select({ videoId: ytDownloads.videoId }).from(ytDownloads)
    .where(and(eq(ytDownloads.userId, user.id), eq(ytDownloads.kind, 'video'), eq(ytDownloads.status, 'ready'), inArray(ytDownloads.videoId, frozen.map(f => f.videoId))))
  const readySet = new Set(ready.map(r => r.videoId))
  return c.json({ tracks: frozen.filter(t => readySet.has(t.videoId)).map(t => ({ videoId: t.videoId, title: t.title, author: t.artist ?? '' })) })
})

// GET /:id/offline-queue — frozen tracklist filtered to downloaded tracks, plus DJ segment IDs.
// The RadioEngine calls /:id/dj/:cacheId/audio on demand for each segment.
musicStations_route.get('/:id/offline-queue', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const frozen = await db.select().from(musicOfflineStationTracks)
    .where(and(eq(musicOfflineStationTracks.userId, user.id), eq(musicOfflineStationTracks.stationId, id)))
    .orderBy(musicOfflineStationTracks.position)
  if (!frozen.length) return c.json({ tracks: [], dj: { intro: null, outro: null, transitions: {} } })

  const ids = frozen.map(f => f.videoId)
  const ready = await db.select({ videoId: ytDownloads.videoId }).from(ytDownloads)
    .where(and(eq(ytDownloads.userId, user.id), eq(ytDownloads.kind, 'audio'), eq(ytDownloads.status, 'ready'), inArray(ytDownloads.videoId, ids)))
  const readySet = new Set(ready.map(r => r.videoId))
  const tracks = frozen.filter(t => readySet.has(t.videoId)).map(t => ({
    videoId: t.videoId, title: t.title, author: t.artist ?? '', audioUrl: `/api/youtube/file/${t.videoId}/audio`,
  }))

  const djRows = await db.select().from(musicDjCache)
    .where(and(eq(musicDjCache.userId, user.id), eq(musicDjCache.stationId, id)))
  const seg = (r: typeof djRows[number]) => ({ audioUrl: `/api/music/stations/${id}/dj/${r.id}/audio` })
  const intro = djRows.find(r => r.position === 'intro')
  const outro = djRows.find(r => r.position === 'outro')
  const transitions: Record<string, { audioUrl: string }> = {}
  for (const r of djRows) if (r.position === 'transition' && r.fromVideoId) transitions[r.fromVideoId] = seg(r)

  return c.json({ tracks, dj: { intro: intro ? seg(intro) : null, outro: outro ? seg(outro) : null, transitions } })
})

// GET /:id/dj/:cacheId/audio — synthesize DJ speech on demand from cached context.
// Running LLM + TTS at playback ensures current pronunciation rules and voice always apply.
musicStations_route.get('/:id/dj/:cacheId/audio', async (c) => {
  const user = c.get('user')
  const cacheId = c.req.param('cacheId')
  const [row] = await db.select().from(musicDjCache)
    .where(and(eq(musicDjCache.id, cacheId), eq(musicDjCache.userId, user.id)))
  if (!row) return c.json({ error: 'not found' }, 404)
  const { wav } = await generateDjSegment({
    genre: row.genre ?? undefined,
    stationName: row.stationName ?? undefined,
    sayStation: row.position === 'intro',
    trackName: row.trackName ?? undefined,
    artistName: row.artistName ?? undefined,
    nextTrackName: row.nextTrackName ?? undefined,
    nextArtistName: row.nextArtistName ?? undefined,
    position: row.position,
    style: (row.style as 'full' | 'minimal') ?? 'full',
    facts: row.facts ?? '',
  })
  if (!wav) return c.json({ error: 'synthesis unavailable' }, 503)
  return new Response(wav.buffer as ArrayBuffer, { status: 200, headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' } })
})

// DELETE /:id/offline — forget an offline station (its frozen tracks + DJ context). Leaves the
// shared ytDownloads audio in place, so the Offline *songs* library is unaffected.
musicStations_route.delete('/:id/offline', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  await db.delete(musicDjCache).where(and(eq(musicDjCache.userId, user.id), eq(musicDjCache.stationId, id)))
  await db.delete(musicOfflineStationTracks).where(and(eq(musicOfflineStationTracks.userId, user.id), eq(musicOfflineStationTracks.stationId, id)))
  await db.delete(musicOfflineStations).where(and(eq(musicOfflineStations.userId, user.id), eq(musicOfflineStations.stationId, id)))
  return c.json({ ok: true })
})
