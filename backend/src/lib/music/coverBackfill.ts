// Station cover backfill. Covers are normally stamped from the first built
// queue on tune-in (stampStationCoverIfEmpty), which left every never-played
// station (118 of the 121 shipped ones at the time of writing) without art in
// both the Music app and the Doki Dock island. For each coverless station the
// local LLM names a handful of REAL iconic songs matching the station's vibe;
// the first whose album art actually resolves on iTunes is stamped as the
// cover. videoId stays empty: the cover is art metadata only, every consumer
// resolves it through useSongArt's artist+title lookup, and stamps only apply
// while unset so a real tune-in never fights the backfill.

import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { musicStations } from '@/db/schema'
import { itunesSongArt } from '@/lib/music/catalog'
import { ytmusicSearch } from '@/lib/youtube/ytmusic'
import { ollamaChat } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import { logger } from '@/lib/logger'

const BOOT_DELAY_MS = 3 * 60 * 1000   // stay out of the way of boot warmup
const PACE_MS = 1500                  // one station at a time; the GPU serves chat first

const SCHEMA = {
  type: 'object',
  properties: {
    songs: {
      type: 'array',
      items: {
        type: 'object',
        properties: { artist: { type: 'string' }, title: { type: 'string' } },
        required: ['artist', 'title'],
      },
    },
  },
  required: ['songs'],
} as const

interface Candidate { artist: string; title: string }

interface CoverlessStation { id: string; name: string; description: string | null; aiPrompt: string; seedValue: string | null }

async function candidateSongs(station: { name: string; description: string | null; aiPrompt: string; seedValue: string | null }): Promise<Candidate[]> {
  const model = await getModel()
  const sys = 'You pick real, famous songs that best represent a radio station. ' +
    'Rules: (1) Exactly 5 songs. (2) Every song must be a REAL released recording by a REAL artist, ' +
    'no inventions. (3) Each should be iconic and instantly recognizable for this station\'s theme. ' +
    '(4) Most famous first. (5) Use the primary artist name only.'
  const brief = [
    `Name: ${station.name}`,
    station.description && `About: ${station.description}`,
    station.aiPrompt && `Vibe: ${station.aiPrompt}`,
    station.seedValue && `Seed: ${station.seedValue}`,
  ].filter(Boolean).join('\n')
  const chat = await ollamaChat(
    model,
    [{ role: 'system', content: sys }, { role: 'user', content: `Pick 5 songs for this station:\n${brief}\nReturn JSON.` }],
    [],
    { temperature: 0.4, num_predict: 300 },
    SCHEMA,
  )
  const raw = chat.message?.content?.trim()
  if (!raw) return []
  const parsed = JSON.parse(raw) as { songs?: unknown }
  const songs = Array.isArray(parsed.songs) ? parsed.songs : []
  return songs
    .filter((s): s is Candidate =>
      !!s && typeof s === 'object' &&
      typeof (s as Candidate).artist === 'string' && typeof (s as Candidate).title === 'string')
    .map((s) => ({ artist: s.artist.trim(), title: s.title.trim() }))
    .filter((s) => s.artist.length > 1 && s.title.length > 0)
    .slice(0, 5)
}

/** Stamp ONE coverless station from an LLM-picked iconic song. Returns true if a cover
 *  was written. The final UPDATE re-checks `isNull` so a concurrent tune-in stamp (which
 *  carries the station's real queue) always wins over this guess and never gets clobbered. */
async function stampCoverForStation(row: CoverlessStation): Promise<boolean> {
  const candidates = await candidateSongs(row)
  let cover: { videoId: string; title: string; artist: string | null } | null = null

  // Tier 1: iTunes album art for an LLM-picked iconic song. Art-only stamp
  // (empty videoId); only stamped when the art actually exists, so tiles
  // never regress from the silhouette fallback to a broken image.
  for (const song of candidates) {
    if (!(await itunesSongArt(song.artist, song.title))) continue
    cover = { videoId: '', title: song.title, artist: song.artist }
    break
  }

  // Tier 2: YouTube Music (instrumental/theme stations often miss on
  // iTunes). A real videoId means the frontend resolver still tries iTunes
  // with YT Music's cleaner metadata first, then falls back to the video
  // thumbnail, so a stamp here always renders something.
  if (!cover) {
    const queries = [...candidates.slice(0, 2).map((c) => `${c.artist} ${c.title}`), row.name]
    for (const q of queries) {
      const [hit] = await ytmusicSearch(q, 1)
      if (!hit?.videoId || !hit.title) continue
      cover = { videoId: hit.videoId, title: hit.title, artist: hit.author ?? null }
      break
    }
  }

  if (!cover) return false
  // Tier-2 stamps (videoId set): the frontend's useSongArt still tries iTunes first with
  // this artist+title, so warm that exact lookup now. Usually a miss, and a cached miss
  // is the point: the first visitor's tile resolves with zero live external calls.
  if (cover.videoId && cover.artist) void itunesSongArt(cover.artist, cover.title).catch(() => {})
  await db.update(musicStations)
    .set({ coverTrackJson: JSON.stringify(cover) })
    .where(and(eq(musicStations.id, row.id), isNull(musicStations.coverTrackJson)))
  return true
}

/** Stamp covers for every station that has none. One-time per station (stamps
 *  persist), resumable (each run only sees what is still null). */
export async function backfillStationCovers(limit?: number): Promise<void> {
  let query = db
    .select({
      id: musicStations.id,
      name: musicStations.name,
      description: musicStations.description,
      aiPrompt: musicStations.aiPrompt,
      seedValue: musicStations.seedValue,
    })
    .from(musicStations)
    .where(isNull(musicStations.coverTrackJson))
    .$dynamic()
  if (limit) query = query.limit(limit)
  const rows = await query
  if (rows.length === 0) return

  logger.info(`[station-covers] backfilling ${rows.length} coverless stations`)
  let stamped = 0
  for (const row of rows) {
    try {
      if (await stampCoverForStation(row)) stamped++
    } catch (err) {
      logger.debug(`[station-covers] ${row.name}: ${String(err)}`)
    }
    await new Promise((r) => setTimeout(r, PACE_MS))
  }
  logger.info(`[station-covers] stamped ${stamped}/${rows.length}`)
}

/** Stamp one just-created station's cover immediately (fire-and-forget from the create path),
 *  so a never-played custom station gets real album art within seconds instead of sitting on
 *  the plain gradient+glyph until the next boot backfill. No-ops if a cover is already set. */
export async function backfillCoverForStation(stationId: string): Promise<void> {
  try {
    const [row] = await db
      .select({
        id: musicStations.id,
        name: musicStations.name,
        description: musicStations.description,
        aiPrompt: musicStations.aiPrompt,
        seedValue: musicStations.seedValue,
      })
      .from(musicStations)
      .where(and(eq(musicStations.id, stationId), isNull(musicStations.coverTrackJson)))
      .limit(1)
    if (!row) return
    await stampCoverForStation(row)
  } catch (err) {
    logger.debug(`[station-covers] ${stationId}: ${String(err)}`)
  }
}

let started = false

/** Boot hook: run the backfill once per process, delayed past warmup. */
export function startStationCoverBackfill(): void {
  if (started) return
  started = true
  setTimeout(() => { void backfillStationCovers() }, BOOT_DELAY_MS)
}
