// media-enhance job runner: produces a derived, denoise+sharpen-enhanced rendition of a ready
// base video asset. Source-agnostic — keyed on a plain media_assets.id, so it serves YouTube
// saves now and the clipper (TikTok/etc.) later with no changes. Structurally mirrors
// runPlexCutJob (lib/plex/cut/run.ts): derive a sibling rendition, commit it through the blob
// store's atomic-swap primitives, never touch the original. Playback prefers this rendition when
// the user opted in (see resolvePlaybackBlob); a failed enhance just leaves the original serving.

import { and, eq } from 'drizzle-orm'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { db } from '@/db'
import { mediaAssets } from '@/db/schema'
import { blobAbsPath, putBlobFromFile, markBlobLive, contentTmpDir } from '@/lib/content/store'
import { getContentTypeStorageLocationId } from '@/lib/storage/contentRoots'
import type { DownloadProgress } from '@/lib/download'
import { enhanceVideo } from './enhance'
import { logger } from '@/lib/logger'

export interface MediaEnhanceJobPayload { assetId: string }

/** Format of the derived enhanced rendition (a sibling of the base 'mp4' asset). */
export const ENHANCED_FORMAT = 'mp4:enhanced'

export async function runEnhanceJob(
  payload: MediaEnhanceJobPayload,
  signal?: AbortSignal,
  onProgress?: (p: DownloadProgress & { note?: string }) => void,
): Promise<void> {
  const { assetId } = payload
  const [base] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1)
  if (!base) { logger.info(`[enhance] base asset ${assetId} gone — skipping`); return }
  if (base.kind !== 'video' || !base.blobHash || base.status !== 'ready') {
    logger.info(`[enhance] asset ${assetId} is not an enhanceable ready video — skipping`)
    return
  }

  const where = and(
    eq(mediaAssets.sourceType, base.sourceType), eq(mediaAssets.sourceId, base.sourceId),
    eq(mediaAssets.kind, 'video'), eq(mediaAssets.format, ENHANCED_FORMAT),
  )
  let [enhanced] = await db.select().from(mediaAssets).where(where).limit(1)

  // Freshness proxy: store-the-max only ever RAISES a video's height, so a ready enhanced
  // rendition whose height matches the current base was derived from these same bytes — done.
  // (A base upgrade leaves height mismatched, so we re-derive.)
  if (enhanced?.status === 'ready' && enhanced.blobHash && enhanced.height === base.height) {
    logger.info(`[enhance] ${base.sourceId}: already enhanced at height ${base.height ?? '?'} — skipping`)
    return
  }

  const now = new Date()
  if (!enhanced) {
    await db.insert(mediaAssets).values({
      id: crypto.randomUUID(), sourceType: base.sourceType, sourceId: base.sourceId,
      kind: 'video', format: ENHANCED_FORMAT, height: base.height, blobHash: null,
      status: 'downloading', sizeBytes: null, error: null, createdAt: now, updatedAt: now,
    }).onConflictDoNothing()
    ;[enhanced] = await db.select().from(mediaAssets).where(where).limit(1)
  } else {
    await db.update(mediaAssets).set({ status: 'downloading', height: base.height, updatedAt: now }).where(eq(mediaAssets.id, enhanced.id))
  }
  if (!enhanced) throw new Error(`[enhance] could not create enhanced rendition for ${assetId}`)

  const sourceAbsPath = await blobAbsPath(base.blobHash)
  const tmpDir = await contentTmpDir()
  const outPath = join(tmpDir, `enhance-${base.sourceId}-${Date.now()}.mp4`)
  try {
    await enhanceVideo(sourceAbsPath, outPath, signal, onProgress
      ? (fraction, etaSeconds) => onProgress({ completed: Math.round(fraction * 100), total: 100, speedBps: 0, etaSeconds, note: 'Enhancing…' })
      : undefined)
    const storageLocationId = await getContentTypeStorageLocationId(base.sourceType)
    const put = await putBlobFromFile(outPath, { mime: 'video/mp4', storageLocationId })
    await markBlobLive(put.hash)
    await db.update(mediaAssets)
      .set({ blobHash: put.hash, sizeBytes: put.sizeBytes, height: base.height, status: 'ready', error: null, updatedAt: new Date() })
      .where(eq(mediaAssets.id, enhanced.id))
    logger.info(`[enhance] ${base.sourceId}: enhanced rendition ready (height ${base.height ?? '?'})`)
  } catch (err) {
    await db.update(mediaAssets).set({ status: 'failed', error: String(err), updatedAt: new Date() }).where(eq(mediaAssets.id, enhanced.id))
    throw err
  } finally {
    await rm(outPath, { force: true }).catch(() => {})
  }
}
