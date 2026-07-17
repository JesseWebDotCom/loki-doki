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
      for (const song of await candidateSongs(row)) {
        // Only stamp when the art actually exists, so tiles never regress from
        // the silhouette fallback to a broken image.
        if (!(await itunesSongArt(song.artist, song.title))) continue
        await db.update(musicStations)
          .set({ coverTrackJson: JSON.stringify({ videoId: '', title: song.title, artist: song.artist }) })
          .where(and(eq(musicStations.id, row.id), isNull(musicStations.coverTrackJson)))
        stamped++
        break
      }
    } catch (err) {
      logger.debug(`[station-covers] ${row.name}: ${String(err)}`)
    }
    await new Promise((r) => setTimeout(r, PACE_MS))
  }
  logger.info(`[station-covers] stamped ${stamped}/${rows.length}`)
}

let started = false

/** Boot hook: run the backfill once per process, delayed past warmup. */
export function startStationCoverBackfill(): void {
  if (started) return
  started = true
  setTimeout(() => { void backfillStationCovers() }, BOOT_DELAY_MS)
}
