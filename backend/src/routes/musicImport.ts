// Playlist import: resolve a pasted/exported track list against the catalog and land
// it as a normal playlist. Parsing (Exportify CSV / JSON / "Artist - Title" lines)
// happens client-side; this router does the two server-side steps:
//   POST /resolve  — run each entry through the prefer-library + YouTube resolver and
//                    classify it matched / ambiguous / unmatched (honest confidence)
//   POST /create   — persist the reviewed list as a manual playlist in one call

import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { musicPlaylists, musicPlaylistTracks } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { findOwned } from '@/lib/music/resolveSource'
import { resolveTrack } from '@/lib/music/resolve'
import type { AppEnv } from '@/types'

export const musicImport = new Hono<AppEnv>()
musicImport.use('*', requireAuth)

interface ImportEntry { title?: string; artist?: string; durationSec?: number | null }
interface ResolvedEntry {
  index: number
  status: 'matched' | 'ambiguous' | 'unmatched'
  track: { videoId: string; title: string; artist: string; durationSec: number | null } | null
  score: number | null
  source: 'local' | 'plex' | 'youtube' | null
}

const MAX_ENTRIES = 300
// resolve.ts accepts candidates at score >= 4; below this margin over the floor the
// match is real but shaky enough that a human should glance at it.
const CONFIDENT_SCORE = 6

// POST /api/music/import/resolve { entries: [{title, artist, durationSec?}] }
musicImport.post('/resolve', async (c) => {
  const body = await c.req.json<{ entries?: ImportEntry[] }>().catch(() => ({} as { entries?: undefined }))
  const entries = (body.entries ?? []).slice(0, MAX_ENTRIES)
  if (!entries.length) return c.json({ error: 'entries required' }, 400)

  const results: ResolvedEntry[] = new Array(entries.length)
  let cursor = 0
  const CONCURRENCY = 4

  async function worker(): Promise<void> {
    while (cursor < entries.length) {
      const i = cursor++
      const e = entries[i]!
      const title = e.title?.trim() ?? ''
      const artist = e.artist?.trim() ?? ''
      if (!title) {
        results[i] = { index: i, status: 'unmatched', track: null, score: null, source: null }
        continue
      }
      const input = { title, artist, durationSec: e.durationSec ?? null }
      try {
        // Owned copies are identity matches (normalized artist+title, duration-checked):
        // always confident.
        const owned = await findOwned(input)
        if (owned) {
          results[i] = {
            index: i, status: 'matched',
            track: { videoId: owned.ref, title: owned.title, artist: owned.artist, durationSec: owned.durationSec },
            score: null, source: owned.source,
          }
          continue
        }
        const yt = await resolveTrack(input)
        if (yt) {
          results[i] = {
            index: i,
            status: yt.score >= CONFIDENT_SCORE ? 'matched' : 'ambiguous',
            track: { videoId: yt.videoId, title: yt.title, artist: yt.artist, durationSec: yt.durationSec },
            score: yt.score, source: 'youtube',
          }
        } else {
          results[i] = { index: i, status: 'unmatched', track: null, score: null, source: null }
        }
      } catch {
        results[i] = { index: i, status: 'unmatched', track: null, score: null, source: null }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, () => worker()))

  return c.json({ results })
})

// POST /api/music/import/create { name, tracks: [{videoId, title, artist?, durationSec?, mbid?}] }
musicImport.post('/create', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{
    name?: string
    tracks?: Array<{ videoId?: string; title?: string; artist?: string | null; durationSec?: number | null; mbid?: string | null }>
  }>().catch(() => ({} as Record<string, never>))

  const name = body.name?.trim().slice(0, 120)
  const tracks = (body.tracks ?? [])
    .filter(t => t.videoId?.trim() && t.title?.trim())
    .slice(0, MAX_ENTRIES)
  if (!name) return c.json({ error: 'name required' }, 400)
  if (!tracks.length) return c.json({ error: 'at least one resolved track required' }, 400)

  const id = crypto.randomUUID()
  const now = new Date()
  await db.insert(musicPlaylists).values({
    id, userId: user.id, name, description: 'Imported playlist',
    visibility: 'private', kind: 'manual', createdAt: now, updatedAt: now,
  })
  for (let i = 0; i < tracks.length; i += 100) {
    await db.insert(musicPlaylistTracks).values(tracks.slice(i, i + 100).map((t, j) => ({
      id: crypto.randomUUID(), playlistId: id,
      videoId: t.videoId!.trim(), title: t.title!.trim(),
      artist: t.artist?.trim() || null, mbid: t.mbid || null,
      durationSec: t.durationSec ?? null, position: i + j, addedAt: now,
    })))
  }
  const [row] = await db.select().from(musicPlaylists).where(eq(musicPlaylists.id, id))
  return c.json({ playlist: { id: row!.id, name: row!.name, trackCount: tracks.length } })
})
