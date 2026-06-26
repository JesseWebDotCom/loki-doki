// One-time background migration: fold the pre-dedup per-user offline library into the shared
// content store. For every legacy yt_downloads row (assetId IS NULL) it hashes the file into a
// blob (deduping identical bytes across users), links the row to a media_assets rendition
// keeping the MAX height, then — once the asset is proven to serve — reclaims the original
// per-user file.
//
// Crash-safe + idempotent: progress is the `assetId` column (the commit marker), so a re-run
// only reprocesses rows that haven't been linked. Files are COPIED (not moved) into the store
// until cleanup, so an interrupted run leaves dual-read serving from the original relPath.

import { and, eq, isNull, isNotNull } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { db } from '@/db'
import { ytDownloads } from '@/db/schema'
import { resolveUserPath } from '@/lib/storage/paths'
import { withLock, putBlobFromFile } from '@/lib/content/store'
import { assetFormat, assetLockKey, getOrCreateAsset, completeAsset, resolveRefBlob, type Kind } from '@/lib/youtube/assets'
import { logger } from '@/lib/logger'

/** Derive (kind, format) for a legacy row from its kind + stored file extension. */
function kindFormat(kind: Kind, relPath: string): { kind: Kind; format: string } {
  if (kind === 'audio') return { kind, format: relPath.endsWith('.mp3') ? 'mp3' : 'm4a' }
  return { kind, format: 'mp4' }
}

async function migrateOne(row: typeof ytDownloads.$inferSelect): Promise<boolean> {
  if (!row.relPath) return false
  const abs = await resolveUserPath(row.relPath)
  if (!existsSync(abs)) return false   // file already gone — leave the row for manual cleanup
  const { kind, format } = kindFormat(row.kind, row.relPath)
  const mime = kind === 'audio' ? (format === 'mp3' ? 'audio/mpeg' : 'audio/mp4') : 'video/mp4'

  return withLock(assetLockKey(row.videoId, kind, format), async () => {
    const asset = await getOrCreateAsset(row.videoId, kind, format)
    // Copy (keepSource) so a crash before we link leaves the original serving via dual-read.
    const { hash, sizeBytes } = await putBlobFromFile(abs, { mime, keepSource: true })
    await completeAsset(asset.id, hash, kind === 'video' ? row.maxHeight : null, sizeBytes)
    await db.update(ytDownloads).set({ assetId: asset.id, updatedAt: new Date() }).where(eq(ytDownloads.id, row.id))
    return true
  })
}

/** Reclaim legacy per-user files for refs that are now linked to an asset that demonstrably
 *  serves (asset ready + blob live + on disk). Nulls relPath so dual-read uses the asset only. */
async function cleanupMigratedFiles(): Promise<number> {
  const rows = await db.select().from(ytDownloads)
    .where(and(isNotNull(ytDownloads.assetId), isNotNull(ytDownloads.relPath)))
  let cleaned = 0
  for (const row of rows) {
    const blob = await resolveRefBlob(row)
    if (!blob || !existsSync(blob.absPath)) continue   // asset can't serve yet — keep the original
    if (row.relPath) { try { await unlink(await resolveUserPath(row.relPath)) } catch { /* already gone */ } }
    await db.update(ytDownloads).set({ relPath: null }).where(eq(ytDownloads.id, row.id))
    cleaned++
  }
  return cleaned
}

let _ran = false
/** Run the migration in the background (idempotent; safe to call every boot). */
export async function migrateLegacyOfflineLibrary(): Promise<void> {
  if (_ran) return
  _ran = true
  try {
    const legacy = await db.select().from(ytDownloads)
      .where(and(isNull(ytDownloads.assetId), eq(ytDownloads.status, 'ready'), isNotNull(ytDownloads.relPath)))
    if (legacy.length) {
      logger.info(`[content] migrating ${legacy.length} legacy offline item(s) into the content store…`)
      let ok = 0
      for (const row of legacy) {
        try { if (await migrateOne(row)) ok++ }
        catch (err) { logger.warn(`[content] migrate failed for ${row.videoId}: ${err}`) }
      }
      logger.info(`[content] linked ${ok}/${legacy.length} offline item(s) to shared assets`)
    }
    const cleaned = await cleanupMigratedFiles()
    if (cleaned) logger.info(`[content] reclaimed ${cleaned} legacy per-user file(s) post-migration`)
  } catch (err) {
    logger.warn(`[content] offline migration error: ${err}`)
  }
}
