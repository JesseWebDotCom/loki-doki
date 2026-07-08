// Plex music source: mirrors the admin-selected music sections' tracks into the
// music_plex_tracks index (see schema.ts for why a mirror beats live-proxying). The sync
// pages through each section with type=10 (Plex's id for audio tracks), normalizes the
// fields the Collection needs, and prunes rows that vanished server-side. Refs are
// `plex:<machineId>:<ratingKey>` (lib/music/trackRef.ts); playback goes through the
// same-origin stream proxy in routes/plex.ts using the mirrored partKey.

import { randomUUID } from 'node:crypto'
import { eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import { musicPlexTracks, toolGlobalConfig } from '@/db/schema'
import { getPlexConnection, machineId, plexGet, resetMachineIdCache, sections, type PlexConnection, type PlexSection } from '@/lib/plex'
import { norm } from '@/lib/music/resolve'
import { registerAudioSource } from '@/lib/music/trackRef'
import { logger } from '@/lib/logger'

const PAGE_SIZE = 200
const PAGE_TIMEOUT_MS = 20_000   // 200-row pages on a NAS-hosted Plex overrun the default 6s

// ── Section selection (admin-configured, tool_global_config music/plex_sections) ──

export async function getSelectedSectionKeys(): Promise<string[]> {
  const [row] = await db.select().from(toolGlobalConfig)
    .where(sql`${toolGlobalConfig.toolId} = 'music' AND ${toolGlobalConfig.key} = 'plex_sections'`)
    .limit(1)
  if (!row) return []
  try {
    const parsed = JSON.parse(row.value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch { return [] }
}

export async function setSelectedSectionKeys(keys: string[]): Promise<void> {
  const now = new Date()
  await db.insert(toolGlobalConfig)
    .values({ id: randomUUID(), toolId: 'music', key: 'plex_sections', value: JSON.stringify(keys), updatedAt: now })
    .onConflictDoUpdate({
      target: [toolGlobalConfig.toolId, toolGlobalConfig.key],
      set: { value: JSON.stringify(keys), updatedAt: now },
    })
}

/** The server's music ('artist'-type) sections. */
export async function musicSections(conn: PlexConnection): Promise<PlexSection[]> {
  return (await sections(conn)).filter((s) => s.type === 'artist')
}

// ── Track normalization ────────────────────────────────────────────────────────────

interface PlexTrackMeta {
  ratingKey?: string
  title?: string
  titleSort?: string
  grandparentTitle?: string
  parentTitle?: string
  parentRatingKey?: string
  grandparentRatingKey?: string
  index?: number
  parentIndex?: number
  parentYear?: number
  year?: number
  duration?: number       // ms
  thumb?: string
  parentThumb?: string
  grandparentThumb?: string
  Guid?: Array<{ id?: string }>
  Media?: Array<{
    audioCodec?: string
    container?: string
    bitrate?: number      // kbps
    Part?: Array<{ key?: string; file?: string }>
  }>
}

interface AlbumInfo { title: string | null; year: number | null }

// Real-server quirk (verified live): some Plex libraries return EMPTY `title` on tracks
// and albums, with the actual name only in `titleSort` — and the flat type=10 track
// listing may omit `parentTitle` (album) and `index` (track number) entirely. Fallback
// chain: title → the source file's basename (best: keeps leading "The" that titleSort
// strips) → titleSort. Track number falls back to the "04 " file-name prefix. Album name
// and year come from the type=9 album pre-pass keyed by parentRatingKey.

function fileTitleParts(file: string | undefined): { title: string | null; trackNo: number | null } {
  if (!file) return { title: null, trackNo: null }
  const base = file.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? ''
  const m = base.match(/^(\d{1,3})\s*[-. _]\s*(.+)$/)
  if (m) return { title: m[2]!.trim() || null, trackNo: Number(m[1]) }
  return { title: base.trim() || null, trackNo: null }
}

export function rowFromMeta(
  m: PlexTrackMeta, mid: string, sectionKey: string, now: Date,
  albums: Map<string, AlbumInfo>,
): typeof musicPlexTracks.$inferInsert | null {
  if (!m.ratingKey) return null
  const media = m.Media?.[0]
  const fromFile = fileTitleParts(media?.Part?.[0]?.file)
  const title = m.title?.trim() || fromFile.title || m.titleSort?.trim() || null
  if (!title) return null
  const albumInfo = m.parentRatingKey ? albums.get(String(m.parentRatingKey)) : undefined
  const mbid = m.Guid?.map((g) => g.id ?? '').find((id) => id.startsWith('mbid://'))?.slice('mbid://'.length) ?? null
  const artist = m.grandparentTitle?.trim() || null
  return {
    ratingKey: String(m.ratingKey),
    machineId: mid,
    sectionKey,
    title,
    artist,
    album: m.parentTitle?.trim() || albumInfo?.title || null,
    albumRatingKey: m.parentRatingKey ? String(m.parentRatingKey) : null,
    artistRatingKey: m.grandparentRatingKey ? String(m.grandparentRatingKey) : null,
    trackNo: m.index ?? fromFile.trackNo,
    discNo: m.parentIndex ?? null,
    year: albumInfo?.year ?? m.parentYear ?? m.year ?? null,
    durationSec: m.duration ? m.duration / 1000 : null,
    codec: media?.audioCodec ?? null,
    container: media?.container ?? null,
    bitrate: media?.bitrate ?? null,
    partKey: media?.Part?.[0]?.key ?? null,
    thumb: m.thumb ?? null,
    parentThumb: m.parentThumb ?? null,
    grandparentThumb: m.grandparentThumb ?? null,
    mbid,
    normTitle: norm(title),
    normArtist: norm(artist ?? ''),
    syncedAt: now,
  }
}

/** Pre-pass: map albumRatingKey → {title, year} for a section (type=9 = albums). Albums
 *  are ~10× fewer than tracks, so this is one or two pages. */
async function fetchAlbumInfo(conn: PlexConnection, sectionKey: string, signal: AbortSignal): Promise<Map<string, AlbumInfo>> {
  const map = new Map<string, AlbumInfo>()
  let start = 0
  for (;;) {
    if (signal.aborted) throw new Error('aborted')
    const page = await plexGet<{ MediaContainer?: { Metadata?: PlexTrackMeta[] } }>(
      conn,
      `/library/sections/${encodeURIComponent(sectionKey)}/all?type=9&X-Plex-Container-Size=${PAGE_SIZE}&X-Plex-Container-Start=${start}`,
      PAGE_TIMEOUT_MS,
    )
    const metas = page?.MediaContainer?.Metadata ?? []
    if (!metas.length) break
    for (const m of metas) {
      if (!m.ratingKey) continue
      map.set(String(m.ratingKey), { title: m.title?.trim() || m.titleSort?.trim() || null, year: m.year ?? null })
    }
    if (metas.length < PAGE_SIZE) break
    start += PAGE_SIZE
  }
  return map
}

// ── Sync ────────────────────────────────────────────────────────────────────────────

export interface PlexMusicSyncResult { upserted: number; pruned: number; sections: number }

export async function syncPlexMusic(
  onProgress: (done: number, total: number) => void,
  signal: AbortSignal,
): Promise<PlexMusicSyncResult> {
  const conn = await getPlexConnection()
  if (!conn) throw new Error('Plex is not configured')
  resetMachineIdCache()  // a server swap must be detected here, not served from the memo
  const mid = await machineId(conn)
  if (!mid) throw new Error('Could not read the Plex server identity')

  const selected = await getSelectedSectionKeys()
  if (!selected.length) {
    // Nothing selected = source off; an empty mirror keeps Collection results truthful.
    await db.delete(musicPlexTracks)
    return { upserted: 0, pruned: 0, sections: 0 }
  }

  // A different server than last sync → the whole mirror is foreign; start clean.
  const [existingRow] = await db.select({ machineId: musicPlexTracks.machineId }).from(musicPlexTracks).limit(1)
  if (existingRow && existingRow.machineId !== mid) {
    logger.warn(`[plex-music] server changed (${existingRow.machineId} → ${mid}) — clearing the mirror`)
    await db.delete(musicPlexTracks)
  }

  // Rough total for progress: sum of each section's leaf count (cheap HEAD-style page).
  let total = 0
  const sectionTotals = new Map<string, number>()
  for (const key of selected) {
    const head = await plexGet<{ MediaContainer?: { totalSize?: number; size?: number } }>(
      conn, `/library/sections/${encodeURIComponent(key)}/all?type=10&X-Plex-Container-Size=0&X-Plex-Container-Start=0`, PAGE_TIMEOUT_MS)
    const n = head?.MediaContainer?.totalSize ?? head?.MediaContainer?.size ?? 0
    sectionTotals.set(key, n)
    total += n
  }

  const now = new Date()
  const seen: string[] = []
  let upserted = 0
  let done = 0

  for (const key of selected) {
    // Album names/years first — the flat track listing may omit parentTitle (verified live).
    const albums = await fetchAlbumInfo(conn, key, signal)
    let start = 0
    for (;;) {
      if (signal.aborted) throw new Error('aborted')
      const page = await plexGet<{ MediaContainer?: { Metadata?: PlexTrackMeta[] } }>(
        conn,
        `/library/sections/${encodeURIComponent(key)}/all?type=10&X-Plex-Container-Size=${PAGE_SIZE}&X-Plex-Container-Start=${start}`,
        PAGE_TIMEOUT_MS,
      )
      const metas = page?.MediaContainer?.Metadata ?? []
      if (!metas.length) break
      for (const m of metas) {
        const row = rowFromMeta(m, mid, key, now, albums)
        if (!row) continue
        seen.push(row.ratingKey)
        await db.insert(musicPlexTracks).values(row)
          .onConflictDoUpdate({ target: musicPlexTracks.ratingKey, set: { ...row } })
        upserted++
      }
      done += metas.length
      onProgress(Math.min(done, total || done), total || done)
      if (metas.length < PAGE_SIZE) break
      start += PAGE_SIZE
    }
  }

  // Prune rows not seen this pass: deleted tracks AND tracks of now-deselected sections.
  let pruned = 0
  if (seen.length) {
    const seenSet = new Set(seen)
    const all = await db.select({ ratingKey: musicPlexTracks.ratingKey }).from(musicPlexTracks)
    const dead = all.filter((r) => !seenSet.has(r.ratingKey)).map((r) => r.ratingKey)
    for (let i = 0; i < dead.length; i += 200) {
      await db.delete(musicPlexTracks).where(inArray(musicPlexTracks.ratingKey, dead.slice(i, i + 200)))
    }
    pruned = dead.length
  } else {
    // Selected sections returned nothing — treat as truth and clear.
    const all = await db.select({ ratingKey: musicPlexTracks.ratingKey }).from(musicPlexTracks)
    pruned = all.length
    await db.delete(musicPlexTracks)
  }

  logger.info(`[plex-music] synced ${upserted} tracks across ${selected.length} section(s), pruned ${pruned}`)
  return { upserted, pruned, sections: selected.length }
}

/** Live fallback for a track the mirror doesn't have (played between syncs): fetch its
 *  metadata directly and return the stream facts. */
export interface PlexAudioMeta { partKey: string | null; container: string | null; codec: string | null; bitrate: number | null; durationSec: number | null }

export async function getAudioPlayback(conn: PlexConnection, ratingKey: string): Promise<PlexAudioMeta | null> {
  const data = await plexGet<{ MediaContainer?: { Metadata?: PlexTrackMeta[] } }>(conn, `/library/metadata/${encodeURIComponent(ratingKey)}`)
  const m = data?.MediaContainer?.Metadata?.[0]
  const media = m?.Media?.[0]
  if (!m || !media) return null
  return {
    partKey: media.Part?.[0]?.key ?? null,
    container: media.container ?? null,
    codec: media.audioCodec ?? null,
    bitrate: media.bitrate ?? null,
    durationSec: m.duration ? m.duration / 1000 : null,
  }
}

// Plex tracks live on the Plex server, not our disk — no audioFilePath (the later
// analysis phase fetches through the stream proxy on demand). streamMeta comes from
// the mirror so the Now Playing badge is free.
registerAudioSource('plex', {
  async audioFilePath() { return null },
  async streamMeta(parsed) {
    if (parsed.source !== 'plex') return null
    const [row] = await db.select({
      codec: musicPlexTracks.codec, bitrate: musicPlexTracks.bitrate,
    }).from(musicPlexTracks).where(eq(musicPlexTracks.ratingKey, parsed.ratingKey)).limit(1)
    if (!row) return null
    return { codec: row.codec, bitrateKbps: row.bitrate, sampleRate: null, bitDepth: null }
  },
})
