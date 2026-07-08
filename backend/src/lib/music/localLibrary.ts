// Local music library: scans admin-configured folders (plus the managed uploads folder)
// into the music_local_tracks index. Scans are incremental — a file whose size+mtime match
// its row is skipped without opening it — so the boot/daily sweep is cheap after the first
// pass. Rows keep their id across retags (upsert by path), so `local:<id>` refs in
// playlists/favorites/history stay valid; a deleted file's row is pruned and playback of
// stale refs falls back to YouTube re-resolution by the denormalized title/artist.

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { parseFile, type IAudioMetadata } from 'music-metadata'
import { db } from '@/db'
import { musicLocalFolders, musicLocalTracks } from '@/db/schema'
import { norm } from '@/lib/music/resolve'
import { registerAudioSource } from '@/lib/music/trackRef'
import { resolveContentTypePath } from '@/lib/storage/contentRoots'
import { logger } from '@/lib/logger'

// Local tracks ARE on-disk files — the audio-source registry (loudness scan, feature
// analysis) resolves them straight to their path, with real codec facts from the index.
registerAudioSource('local', {
  async audioFilePath(parsed) {
    if (parsed.source !== 'local') return null
    const [row] = await db.select({ path: musicLocalTracks.path }).from(musicLocalTracks)
      .where(eq(musicLocalTracks.id, parsed.localId)).limit(1)
    return row?.path ?? null
  },
  async streamMeta(parsed) {
    if (parsed.source !== 'local') return null
    const [row] = await db.select({
      codec: musicLocalTracks.codec, bitrate: musicLocalTracks.bitrate,
      sampleRate: musicLocalTracks.sampleRate, bitDepth: musicLocalTracks.bitDepth,
    }).from(musicLocalTracks).where(eq(musicLocalTracks.id, parsed.localId)).limit(1)
    if (!row) return null
    return {
      codec: row.codec,
      bitrateKbps: row.bitrate ? Math.round(row.bitrate / 1000) : null,
      sampleRate: row.sampleRate,
      bitDepth: row.bitDepth,
    }
  },
})

// Extensions we index. WMA/APE/DSF are indexed but flagged browser_playable=0 (Chrome can't
// decode them); they still show in the library so the user understands what was found.
const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.m4a', '.m4b', '.aac', '.ogg', '.oga', '.opus', '.wav', '.aiff', '.aif', '.wma', '.ape', '.dsf',
])
const FOLDER_ART_NAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'folder.jpeg', 'folder.png', 'front.jpg', 'album.jpg']

// Codecs Chromium can actually decode in an <audio> element. ALAC ships in .m4a containers,
// so the container alone can't decide — the parsed codec string does.
function isBrowserPlayable(codec: string | null, ext: string): boolean {
  if (['.wma', '.ape', '.dsf'].includes(ext)) return false
  const c = (codec ?? '').toUpperCase()
  if (c.includes('ALAC')) return false
  if (c.includes('MONKEY') || c.includes('WMA') || c.includes('DSD')) return false
  return true
}

/** Parental advisory from native tags: iTunes MP4 `rtng` (1/4=explicit, 2=cleaned) or the
 *  ID3/Vorbis ITUNESADVISORY text tag. null = no tag present (unknown). */
function advisoryFromTags(meta: IAudioMetadata): number | null {
  for (const frames of Object.values(meta.native)) {
    for (const frame of frames) {
      const id = frame.id.toUpperCase()
      if (id === 'RTNG' || id.includes('ITUNESADVISORY')) {
        const v = typeof frame.value === 'object' && frame.value !== null && 'text' in (frame.value as object)
          ? Number((frame.value as { text?: unknown }).text)
          : Number(frame.value)
        if (Number.isFinite(v)) {
          if (v === 1 || v === 4) return 1  // explicit
          if (v === 2) return 2             // cleaned edit
          if (v === 0) return 0             // explicitly marked clean
        }
      }
    }
  }
  return null
}

interface WalkedFile { path: string; sizeBytes: number; mtimeMs: number; folderArtPath: string | null }

/** Recursively enumerate audio files under `root`, remembering per-directory folder art. */
async function walkFolder(root: string, signal: AbortSignal): Promise<WalkedFile[]> {
  const out: WalkedFile[] = []
  const artByDir = new Map<string, string | null>()

  async function dirArt(dir: string): Promise<string | null> {
    const cached = artByDir.get(dir)
    if (cached !== undefined) return cached
    let art: string | null = null
    try {
      const entries = await fs.readdir(dir)
      const lower = new Map(entries.map((e) => [e.toLowerCase(), e]))
      for (const name of FOLDER_ART_NAMES) {
        const hit = lower.get(name)
        if (hit) { art = join(dir, hit); break }
      }
    } catch { /* unreadable dir — no art */ }
    artByDir.set(dir, art)
    return art
  }

  async function walk(dir: string): Promise<void> {
    if (signal.aborted) throw new Error('aborted')
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      logger.debug(`[music-scan] unreadable dir ${dir}: ${String(err)}`)
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '@eaDir') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      if (!entry.isFile()) continue
      if (!AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
      try {
        const stat = await fs.stat(full)
        out.push({ path: full, sizeBytes: stat.size, mtimeMs: Math.round(stat.mtimeMs), folderArtPath: await dirArt(dir) })
      } catch { /* vanished mid-walk */ }
    }
  }

  await walk(root)
  return out
}

/** Parse one file's tags into a music_local_tracks row shape (without id/folderId). */
async function parseTrackFile(file: WalkedFile): Promise<Omit<typeof musicLocalTracks.$inferInsert, 'id' | 'folderId'>> {
  const ext = extname(file.path).toLowerCase()
  let meta: IAudioMetadata | null = null
  try {
    meta = await parseFile(file.path)
  } catch (err) {
    logger.debug(`[music-scan] tag parse failed for ${file.path}: ${String(err)}`)
  }

  const c = meta?.common
  const f = meta?.format
  const title = c?.title?.trim() || basename(file.path, extname(file.path))
  const artist = c?.artist?.trim() || null
  const albumArtist = c?.albumartist?.trim() || null
  // Untagged files: parent directory name is a usable album fallback (typical rip layout).
  const album = c?.album?.trim() || (c?.title ? null : basename(dirname(file.path))) || null
  const codec = f?.codec ?? null

  return {
    path: file.path,
    title,
    artist,
    albumArtist,
    album,
    trackNo: c?.track?.no ?? null,
    discNo: c?.disk?.no ?? null,
    year: c?.year ?? null,
    genre: c?.genre?.[0] ?? null,
    durationSec: f?.duration ?? null,
    codec,
    container: f?.container ?? null,
    bitrate: f?.bitrate ? Math.round(f.bitrate) : null,
    sampleRate: f?.sampleRate ?? null,
    bitDepth: f?.bitsPerSample ?? null,
    channels: f?.numberOfChannels ?? null,
    browserPlayable: isBrowserPlayable(codec, ext),
    hasEmbeddedArt: (c?.picture?.length ?? 0) > 0,
    folderArtPath: file.folderArtPath,
    mbid: c?.musicbrainz_recordingid ?? null,
    mbAlbumId: c?.musicbrainz_albumid ?? null,
    mbArtistId: c?.musicbrainz_artistid?.[0] ?? null,
    advisory: meta ? advisoryFromTags(meta) : null,
    normTitle: norm(title),
    normArtist: norm(albumArtist && !artist ? albumArtist : artist ?? ''),
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    scannedAt: new Date(),
  }
}

export interface ScanResult { added: number; updated: number; removed: number; total: number }

/** Scan one folder into the index. Incremental: unchanged (size+mtime) files are skipped;
 *  changed files re-parse in place (keeping their row id / refs); rows whose file vanished
 *  are pruned. Progress counts enumerated files. */
export async function scanLocalFolder(
  folderId: string,
  onProgress: (done: number, total: number) => void,
  signal: AbortSignal,
): Promise<ScanResult> {
  const [folder] = await db.select().from(musicLocalFolders).where(eq(musicLocalFolders.id, folderId)).limit(1)
  if (!folder) throw new Error('folder not found')
  const now = new Date()
  await db.update(musicLocalFolders)
    .set({ lastScanStatus: 'scanning', lastScanError: null })
    .where(eq(musicLocalFolders.id, folderId))

  try {
    const files = await walkFolder(folder.path, signal)
    const existing = await db.select({
      id: musicLocalTracks.id, path: musicLocalTracks.path,
      sizeBytes: musicLocalTracks.sizeBytes, mtimeMs: musicLocalTracks.mtimeMs,
    }).from(musicLocalTracks).where(eq(musicLocalTracks.folderId, folderId))
    const byPath = new Map(existing.map((r) => [r.path, r]))

    let added = 0
    let updated = 0
    let done = 0
    const seen = new Set<string>()

    for (const file of files) {
      if (signal.aborted) throw new Error('aborted')
      seen.add(file.path)
      const prior = byPath.get(file.path)
      if (prior && prior.sizeBytes === file.sizeBytes && prior.mtimeMs === file.mtimeMs) {
        done++
        continue // unchanged — the whole point of the incremental scan
      }
      const row = await parseTrackFile(file)
      if (prior) {
        await db.update(musicLocalTracks).set(row).where(eq(musicLocalTracks.id, prior.id))
        updated++
      } else {
        await db.insert(musicLocalTracks).values({ id: randomUUID(), folderId, ...row })
        added++
      }
      done++
      if (done % 20 === 0 || done === files.length) onProgress(done, files.length)
    }

    // Prune rows whose file is gone (chunked — a big cleanup shouldn't build one giant IN()).
    const deadIds = existing.filter((r) => !seen.has(r.path)).map((r) => r.id)
    for (let i = 0; i < deadIds.length; i += 200) {
      await db.delete(musicLocalTracks).where(inArray(musicLocalTracks.id, deadIds.slice(i, i + 200)))
    }

    await db.update(musicLocalFolders).set({
      lastScanAt: now, lastScanStatus: 'ok', lastScanError: null, trackCount: files.length,
    }).where(eq(musicLocalFolders.id, folderId))

    return { added, updated, removed: deadIds.length, total: files.length }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.update(musicLocalFolders).set({
      lastScanAt: now, lastScanStatus: 'failed', lastScanError: msg.slice(0, 300),
    }).where(eq(musicLocalFolders.id, folderId))
    throw err
  }
}

/** Index one just-written file immediately (browser uploads) — no full scan needed. */
export async function indexUploadedFile(absPath: string): Promise<string> {
  const folder = await ensureUploadsFolder()
  const stat = await fs.stat(absPath)
  const art = null // uploads land in a flat managed dir; embedded art covers the common case
  const row = await parseTrackFile({ path: absPath, sizeBytes: stat.size, mtimeMs: Math.round(stat.mtimeMs), folderArtPath: art })
  const [prior] = await db.select({ id: musicLocalTracks.id }).from(musicLocalTracks)
    .where(eq(musicLocalTracks.path, absPath)).limit(1)
  if (prior) {
    await db.update(musicLocalTracks).set(row).where(eq(musicLocalTracks.id, prior.id))
    return prior.id
  }
  const id = randomUUID()
  await db.insert(musicLocalTracks).values({ id, folderId: folder.id, ...row })
  await bumpFolderCount(folder.id)
  return id
}

async function bumpFolderCount(folderId: string): Promise<void> {
  const rows = await db.select({ id: musicLocalTracks.id }).from(musicLocalTracks).where(eq(musicLocalTracks.folderId, folderId))
  await db.update(musicLocalFolders).set({ trackCount: rows.length }).where(eq(musicLocalFolders.id, folderId))
}

/** The system-managed uploads folder row (created + mkdir'd on first use). */
export async function ensureUploadsFolder(): Promise<typeof musicLocalFolders.$inferSelect> {
  const [existing] = await db.select().from(musicLocalFolders).where(eq(musicLocalFolders.kind, 'uploads')).limit(1)
  if (existing) {
    await fs.mkdir(existing.path, { recursive: true })
    return existing
  }
  const path = await resolveContentTypePath('music', 'uploads')
  await fs.mkdir(path, { recursive: true })
  const row: typeof musicLocalFolders.$inferInsert = {
    id: randomUUID(), path, kind: 'uploads', enabled: true,
    lastScanAt: null, lastScanStatus: 'idle', lastScanError: null, trackCount: 0, createdAt: new Date(),
  }
  await db.insert(musicLocalFolders).values(row)
  const [created] = await db.select().from(musicLocalFolders).where(eq(musicLocalFolders.id, row.id!)).limit(1)
  return created!
}

// ── Boot + daily sweep ─────────────────────────────────────────────────────────
// Incremental scans make this cheap; the first boot after adding a big folder does the
// heavy pass in the compute lane where it can't starve user downloads.

let sweepStarted = false

export function startLocalLibrarySweep(): void {
  if (sweepStarted) return
  sweepStarted = true
  const run = async () => {
    try {
      // All enabled folders — a previously failed scan (unmounted NAS…) self-heals here.
      const folders = await db.select({ id: musicLocalFolders.id, path: musicLocalFolders.path })
        .from(musicLocalFolders)
        .where(eq(musicLocalFolders.enabled, true))
      const { enqueueMusicScan } = await import('@/lib/downloadJobs')
      for (const f of folders) await enqueueMusicScan(f.id, `Rescan music folder ${basename(f.path)}`)
    } catch (err) {
      logger.debug(`[music-scan] sweep failed: ${String(err)}`)
    }
  }
  setTimeout(run, 90_000)                    // post-boot, after the queue has settled
  setInterval(run, 24 * 60 * 60 * 1000)      // daily
}
