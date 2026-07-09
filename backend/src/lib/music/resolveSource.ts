// Prefer-library resolution: given a song identity, hand back the user's OWN copy
// (local file or Plex track) when they have one, else fall through to the YouTube
// resolver. This is what makes owning a lossless rip matter - stations, search plays,
// and playlists ride the FLAC instead of a lossy stream.
//
// Matching runs against the norm_title/norm_artist columns the scanners stamped with
// resolve.ts's norm() (the schema comments bind the two - do not fork the normalizer).
// resolve.ts itself stays pure YouTube; this module composes on top of it.

import { db } from '@/db'
import { musicLocalTracks, musicPlexTracks, toolGlobalConfig } from '@/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { norm, resolveTrack, type ResolveInput, type ResolvedTrack } from '@/lib/music/resolve'
import { localRef, plexRef } from '@/lib/music/trackRef'
import { logger } from '@/lib/logger'

export interface PlayableResolution {
  /** The unified track ref: `local:<id>`, `plex:<machineId>:<ratingKey>`, or a bare YouTube id. */
  ref: string
  source: 'local' | 'plex' | 'youtube'
  title: string
  artist: string
  durationSec: number | null
  codec: string | null
  bitrate: number | null
}

// ── Global preference (Admin → Music → "Prefer my library") ─────────────────────────

export async function preferLibraryEnabled(): Promise<boolean> {
  try {
    const [row] = await db.select({ value: toolGlobalConfig.value }).from(toolGlobalConfig)
      .where(sql`${toolGlobalConfig.toolId} = 'music' AND ${toolGlobalConfig.key} = 'prefer_library'`)
      .limit(1)
    if (!row) return true   // default ON: owning the song should mean playing your copy
    return JSON.parse(row.value) !== false
  } catch {
    return true
  }
}

// The library is empty for most installs - make the no-library case a cached no-op so
// the per-queue batch pass costs nothing until someone actually adds sources.
let libCountCache: { count: number; at: number } | null = null
async function libraryTrackCount(): Promise<number> {
  if (libCountCache && Date.now() - libCountCache.at < 60_000) return libCountCache.count
  const [l] = await db.select({ n: sql<number>`count(*)` }).from(musicLocalTracks)
  const [p] = await db.select({ n: sql<number>`count(*)` }).from(musicPlexTracks)
  const count = (l?.n ?? 0) + (p?.n ?? 0)
  libCountCache = { count, at: Date.now() }
  return count
}
/** Test hook / cache-bust after scans and syncs. */
export function resetLibraryCountCache(): void { libCountCache = null }

// ── Matching ─────────────────────────────────────────────────────────────────────────

const DURATION_SLACK_SEC = 5

function durationOk(want: number | null | undefined, have: number | null): boolean {
  if (!want || !have) return true   // unknown on either side → don't block the match
  return Math.abs(want - have) <= DURATION_SLACK_SEC
}

type LocalRow = typeof musicLocalTracks.$inferSelect
type PlexRow = typeof musicPlexTracks.$inferSelect

async function findLocal(input: ResolveInput): Promise<LocalRow | null> {
  // 1. MBID exact (Picard-tagged libraries) - identity, not text.
  if (input.mbid) {
    const [row] = await db.select().from(musicLocalTracks)
      .where(and(eq(musicLocalTracks.mbid, input.mbid), eq(musicLocalTracks.browserPlayable, true)))
      .limit(1)
    if (row) return row
  }
  // 2. Normalized exact artist+title (the common case for untagged identities).
  const na = norm(input.artist)
  const nt = norm(input.title)
  if (!na || !nt) return null
  const rows = await db.select().from(musicLocalTracks)
    .where(and(
      eq(musicLocalTracks.normArtist, na),
      eq(musicLocalTracks.normTitle, nt),
      eq(musicLocalTracks.browserPlayable, true),
    ))
    .limit(4)
  const exact = rows.find(r => durationOk(input.durationSec, r.durationSec))
  if (exact) return exact
  // 3. Conservative near match: same artist, our title is a prefix of theirs (their tag
  //    carries " (Remastered 2011)" etc.), duration agrees when both known.
  const near = await db.select().from(musicLocalTracks)
    .where(and(
      eq(musicLocalTracks.normArtist, na),
      sql`${musicLocalTracks.normTitle} LIKE ${nt + ' %'}`,
      eq(musicLocalTracks.browserPlayable, true),
    ))
    .limit(4)
  return near.find(r => durationOk(input.durationSec, r.durationSec)) ?? null
}

async function findPlex(input: ResolveInput): Promise<PlexRow | null> {
  if (input.mbid) {
    const [row] = await db.select().from(musicPlexTracks)
      .where(eq(musicPlexTracks.mbid, input.mbid)).limit(1)
    if (row) return row
  }
  const na = norm(input.artist)
  const nt = norm(input.title)
  if (!na || !nt) return null
  const rows = await db.select().from(musicPlexTracks)
    .where(and(eq(musicPlexTracks.normArtist, na), eq(musicPlexTracks.normTitle, nt)))
    .limit(4)
  const exact = rows.find(r => durationOk(input.durationSec, r.durationSec))
  if (exact) return exact
  const near = await db.select().from(musicPlexTracks)
    .where(and(eq(musicPlexTracks.normArtist, na), sql`${musicPlexTracks.normTitle} LIKE ${nt + ' %'}`))
    .limit(4)
  return near.find(r => durationOk(input.durationSec, r.durationSec)) ?? null
}

function fromLocal(row: LocalRow): PlayableResolution {
  return {
    ref: localRef(row.id), source: 'local',
    title: row.title, artist: row.artist ?? '',
    durationSec: row.durationSec, codec: row.codec, bitrate: row.bitrate ? Math.round(row.bitrate / 1000) : null,
  }
}

function fromPlex(row: PlexRow): PlayableResolution {
  return {
    ref: plexRef(row.machineId, row.ratingKey), source: 'plex',
    title: row.title, artist: row.artist ?? '',
    durationSec: row.durationSec, codec: row.codec, bitrate: row.bitrate,
  }
}

/** Find the user's own copy of a song, without any YouTube fallback. Null = not owned. */
export async function findOwned(input: ResolveInput): Promise<PlayableResolution | null> {
  if (await libraryTrackCount() === 0) return null
  const local = await findLocal(input)
  if (local) return fromLocal(local)     // local beats plex: no server round-trip to play
  const plex = await findPlex(input)
  return plex ? fromPlex(plex) : null
}

/**
 * Resolve a song identity to something playable, preferring the user's library when the
 * global setting allows, falling back to the YouTube resolver.
 */
export async function resolvePlayable(input: ResolveInput): Promise<PlayableResolution | null> {
  if (await preferLibraryEnabled()) {
    const owned = await findOwned(input)
    if (owned) return owned
  }
  const yt = await resolveTrack(input)
  if (!yt) return null
  return { ref: yt.videoId, source: 'youtube', title: yt.title, artist: yt.artist, durationSec: yt.durationSec, codec: null, bitrate: null }
}

/**
 * Batch pass for station queues / playlists: swap YouTube refs for owned copies where the
 * library has a match. `videoId` stays the ref carrier (frontend convention) - only the
 * ref and the (cleaner) library tags change. No-op when the library is empty or the
 * preference is off.
 */
export async function preferLibrary(tracks: ResolvedTrack[]): Promise<ResolvedTrack[]> {
  try {
    if (!tracks.length) return tracks
    if (!(await preferLibraryEnabled())) return tracks
    if (await libraryTrackCount() === 0) return tracks
    let swapped = 0
    const out: ResolvedTrack[] = []
    for (const t of tracks) {
      if (t.videoId.includes(':')) { out.push(t); continue }   // already an owned ref
      const owned = await findOwned({ title: t.title, artist: t.artist, durationSec: t.durationSec })
      if (owned) {
        swapped++
        out.push({ ...t, videoId: owned.ref, title: owned.title, artist: owned.artist, durationSec: owned.durationSec ?? t.durationSec })
      } else {
        out.push(t)
      }
    }
    if (swapped) logger.debug(`[resolveSource] prefer-library swapped ${swapped}/${tracks.length} tracks to owned copies`)
    return out
  } catch (err) {
    logger.debug(`[resolveSource] preferLibrary failed (kept originals): ${String(err)}`)
    return tracks
  }
}
