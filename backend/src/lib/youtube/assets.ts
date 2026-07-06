// Media-asset layer (Layer 2) over the content blob store.
//
// A media_assets row is one logical rendition of a video/song, keyed by
// (sourceType, sourceId, kind, format). It holds the single best-quality blob anyone in
// the household requested (store-the-max for video; audio is height-independent). The
// per-user yt_downloads rows are REFERENCES — many users share one asset, one blob.
//
// All mutation helpers run inside withLock(assetLockKey) so the height/refcount invariants
// hold under concurrent saves, swaps, and deletes (single process, but awaits interleave).

import { and, eq, inArray, ne } from 'drizzle-orm'
import { db } from '@/db'
import { mediaAssets, ytDownloads, downloadJobs } from '@/db/schema'
import { withLock, markBlobLive, blobAbsPath } from '@/lib/content/store'

export type Kind = 'audio' | 'video'
export type AudioFormat = 'm4a' | 'mp3'

const SOURCE = 'youtube'

/** Container that is part of an asset's identity (m4a vs mp3 are distinct bytes). */
export function assetFormat(kind: Kind, audioFormat?: AudioFormat): string {
  return kind === 'audio' ? (audioFormat === 'mp3' ? 'mp3' : 'm4a') : 'mp4'
}

export function assetLockKey(sourceId: string, kind: Kind, format: string): string {
  return `asset:${SOURCE}:${sourceId}:${kind}:${format}`
}

export function assetVariantKey(sourceId: string, kind: Kind, format: string): string {
  return `yt:${sourceId}:${kind}:${format}`
}

type Asset = typeof mediaAssets.$inferSelect

/** Find or create the asset row for this identity. Call inside withLock. */
export async function getOrCreateAsset(sourceId: string, kind: Kind, format: string): Promise<Asset> {
  const where = and(eq(mediaAssets.sourceType, SOURCE), eq(mediaAssets.sourceId, sourceId), eq(mediaAssets.kind, kind), eq(mediaAssets.format, format))
  const [found] = await db.select().from(mediaAssets).where(where).limit(1)
  if (found) return found
  const now = new Date()
  await db.insert(mediaAssets).values({
    id: crypto.randomUUID(), sourceType: SOURCE, sourceId, kind, format,
    height: null, blobHash: null, status: 'pending', sizeBytes: null, error: null,
    createdAt: now, updatedAt: now,
  }).onConflictDoNothing()
  const [row] = await db.select().from(mediaAssets).where(where).limit(1)
  return row!
}

/** Max requested height across the asset's live (non-failed) refs. Null for audio or none. */
export async function desiredHeight(assetId: string, kind: Kind): Promise<number | null> {
  if (kind === 'audio') return null
  const rows = await db.select({ h: ytDownloads.maxHeight }).from(ytDownloads)
    .where(and(eq(ytDownloads.assetId, assetId), ne(ytDownloads.status, 'failed')))
  let max = 0
  for (const r of rows) if (typeof r.h === 'number' && r.h > max) max = r.h
  return max > 0 ? max : null
}

/** Does this asset already satisfy a request for `reqHeight`? (ready, has bytes, tall enough). */
export function assetSatisfies(asset: Asset, kind: Kind, reqHeight: number | null): boolean {
  if (asset.status !== 'ready' || !asset.blobHash) return false
  if (kind === 'audio') return true
  return (asset.height ?? 0) >= (reqHeight ?? 0)
}

/** Coalesced enqueue of the download job for an asset. Idempotent per variantKey: an active
 *  (pending/running) job is reused; a finished/failed one is reset. Call inside withLock.
 *  `priority` is lower-is-more-urgent (saves 50, prefetch 80); coalescing only ever RAISES
 *  urgency (lowers the number), so a real save jumps ahead of a pending prefetch job. */
export async function enqueueAssetJob(asset: Asset, label: string, priority = 50): Promise<void> {
  const vk = assetVariantKey(asset.sourceId, asset.kind, asset.format)
  const refId = JSON.stringify({ assetId: asset.id })
  const now = new Date()
  const [existing] = await db.select({ id: downloadJobs.id, status: downloadJobs.status, priority: downloadJobs.priority }).from(downloadJobs)
    .where(and(eq(downloadJobs.type, 'yt-media'), eq(downloadJobs.variantKey, vk)))
    .limit(1)
  if (existing) {
    // The variantKey survives a delete+recreate of the underlying asset (it's keyed on
    // sourceId/kind/format, not asset.id) — always repoint refId at the CURRENT asset.id
    // when reusing a job. Otherwise a "clear then resave" leaves this job referencing the
    // old, now-deleted asset row; the runner's correct "asset was deleted before the job
    // ran" guard (download.ts) then treats it as an already-finished no-op, silently
    // completing without ever downloading the new asset. Confirmed live: exactly this
    // sequence left resaved videos stuck at 'pending' forever with a "completed" job.
    if (existing.status === 'pending' || existing.status === 'running') {
      const patch: Partial<typeof downloadJobs.$inferInsert> = { refId, updatedAt: now }
      if (priority < (existing.priority ?? 100)) patch.priority = priority
      await db.update(downloadJobs).set(patch).where(eq(downloadJobs.id, existing.id))
      return  // coalesce
    }
    await db.update(downloadJobs)
      .set({ refId, status: 'pending', priority, attempts: 0, nextEligibleAt: null, lastError: null, progress: null, updatedAt: now })
      .where(eq(downloadJobs.id, existing.id))
    return
  }
  await db.insert(downloadJobs).values({
    id: crypto.randomUUID(), type: 'yt-media', refId,
    variantKey: vk, domain: 'youtube', sizeClass: 'large', label,
    status: 'pending', priority, attempts: 0, maxAttempts: 3,
    nextEligibleAt: null, lastError: null, progress: null, createdAt: now, updatedAt: now,
  })
}

/** Mark the asset + its waiting refs as downloading (worker start). Call inside withLock. */
export async function markAssetDownloading(assetId: string): Promise<void> {
  const now = new Date()
  await db.update(mediaAssets).set({ status: 'downloading', updatedAt: now }).where(eq(mediaAssets.id, assetId))
  await db.update(ytDownloads).set({ status: 'downloading', updatedAt: now })
    .where(and(eq(ytDownloads.assetId, assetId), eq(ytDownloads.status, 'pending')))
}

export interface CompleteResult { adopted: boolean; needsHigher: boolean }

/** Adopt a freshly-downloaded blob into the asset using store-the-max, and fan the asset's
 *  waiting refs out to `ready`. Monotonic: a lower-res result than what we already hold is
 *  discarded (its blob is marked live so GC reclaims it). Returns whether we should re-enqueue
 *  to chase a still-higher requested height. Call inside withLock. */
export async function completeAsset(
  assetId: string,
  blobHash: string,
  newHeight: number | null,
  sizeBytes: number,
): Promise<CompleteResult> {
  const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1)
  if (!asset) { await markBlobLive(blobHash); return { adopted: false, needsHigher: false } }

  const adopt = !asset.blobHash || (asset.kind === 'video' && (newHeight ?? 0) > (asset.height ?? 0))
  // Either way the new blob must leave `staging` or GC could never reclaim it if unadopted.
  await markBlobLive(blobHash)

  const now = new Date()
  if (adopt) {
    await db.update(mediaAssets)
      .set({ blobHash, height: asset.kind === 'video' ? newHeight : null, sizeBytes, status: 'ready', error: null, updatedAt: now })
      .where(eq(mediaAssets.id, assetId))
  } else if (asset.status !== 'ready') {
    await db.update(mediaAssets).set({ status: 'ready', updatedAt: now }).where(eq(mediaAssets.id, assetId))
  }

  // Fan out: every still-waiting ref for this asset is now satisfied.
  const effSize = adopt ? sizeBytes : asset.sizeBytes
  const waitingRefs = await db.select({ userId: ytDownloads.userId, videoId: ytDownloads.videoId }).from(ytDownloads)
    .where(and(eq(ytDownloads.assetId, assetId), inArray(ytDownloads.status, ['pending', 'downloading'])))
  await db.update(ytDownloads).set({ status: 'ready', sizeBytes: effSize ?? sizeBytes, error: null, updatedAt: now })
    .where(and(eq(ytDownloads.assetId, assetId), inArray(ytDownloads.status, ['pending', 'downloading'])))

  // Each newly-satisfied user, if they have a Plex library, gets this video placed into it.
  // Video only — audio-only saves have nothing to show in a "show" library. Best-effort: a
  // Plex-export hiccup must never affect the actual download/save the user asked for.
  if (asset.kind === 'video') {
    const { enqueuePlexSync } = await import('@/lib/downloadJobs')
    for (const ref of waitingRefs) void enqueuePlexSync(ref.userId, ref.videoId, 'add').catch(() => {})
  }

  // If any referring user opted into enhancement, kick a background enhance of this base video.
  // Fire-and-forget (like the Plex sync above) so it never blocks or fails the save; coalesced
  // per asset by the queue. Only the base 'mp4' rendition — the derived 'mp4:enhanced' rendition
  // is written directly by the enhance job and never flows through completeAsset. Re-runs on a
  // store-the-max height upgrade (enqueueMediaEnhance resets a finished job).
  if (asset.kind === 'video' && asset.format === assetFormat('video')) {
    void maybeEnqueueEnhance(assetId).catch(() => {})
  }

  // Chase a higher tier only when we actually improved this round (prevents looping when the
  // source simply can't deliver the requested height — the next attempt won't improve).
  const desired = await desiredHeight(assetId, asset.kind)
  const heightNow = adopt && asset.kind === 'video' ? (newHeight ?? 0) : (asset.height ?? 0)
  const needsHigher = adopt && asset.kind === 'video' && desired != null && heightNow < desired
  return { adopted: adopt, needsHigher }
}

/** Mark an asset + its waiting refs failed (terminal download failure). Call inside withLock. */
export async function failAsset(assetId: string, error: string): Promise<void> {
  const now = new Date()
  await db.update(mediaAssets).set({ status: 'failed', error, updatedAt: now }).where(eq(mediaAssets.id, assetId))
  await db.update(ytDownloads).set({ status: 'failed', error, updatedAt: now })
    .where(and(eq(ytDownloads.assetId, assetId), inArray(ytDownloads.status, ['pending', 'downloading'])))
}

/** Terminal-failure fan-out keyed off a yt-media job's refId (`{ assetId }`). Loads the asset,
 *  takes its lock, and flips it + every waiting ref to `failed` so no one hangs on `pending`. */
export async function failAssetByJobRefId(refId: string, error: string): Promise<void> {
  let assetId: string | undefined
  try { assetId = (JSON.parse(refId) as { assetId?: string })?.assetId } catch { /* not an asset job */ }
  if (!assetId) return
  const [a] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1)
  if (!a) return
  await withLock(assetLockKey(a.sourceId, a.kind, a.format), () => failAsset(assetId!, error))
}

/** Resolve the blob a ready ref should stream from: { hash, absPath, mime } or null. Prefers
 *  the shared asset; falls back to null so the caller can use a legacy relPath. */
export async function resolveRefBlob(
  ref: { assetId: string | null; status: string },
): Promise<{ hash: string; absPath: string; mime: string } | null> {
  if (ref.status !== 'ready' || !ref.assetId) return null
  const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, ref.assetId)).limit(1)
  if (!asset || asset.status !== 'ready' || !asset.blobHash) return null
  const mime = asset.format === 'mp3' ? 'audio/mpeg' : asset.kind === 'audio' ? 'audio/mp4' : 'video/mp4'
  return { hash: asset.blobHash, absPath: await blobAbsPath(asset.blobHash), mime }
}

/** Format of the derived enhanced rendition (kept in sync with lib/media/enhanceJob's
 *  ENHANCED_FORMAT; inlined to avoid pulling the ffmpeg/encoder module graph into this
 *  widely-imported file). */
const ENHANCED_FORMAT = 'mp4:enhanced'

/** If any user referencing this base video asset opted into enhancement, enqueue a background
 *  enhance. Best-effort helper for completeAsset — coalesced per asset by the queue. */
async function maybeEnqueueEnhance(assetId: string): Promise<void> {
  const { shouldEnhance } = await import('@/lib/media/enhancePolicy')
  const refs = await db.select({ userId: ytDownloads.userId }).from(ytDownloads)
    .where(and(eq(ytDownloads.assetId, assetId), ne(ytDownloads.status, 'failed')))
  const userIds = [...new Set(refs.map((r) => r.userId))]
  let wanted = false
  for (const uid of userIds) { if (await shouldEnhance(uid)) { wanted = true; break } }
  if (!wanted) return
  const { enqueueMediaEnhance } = await import('@/lib/downloadJobs')
  await enqueueMediaEnhance(assetId)
}

/** Resolve the blob a ready ref should stream from, preferring the user's enhanced rendition
 *  when they've opted in and it's current. Falls back to the base blob otherwise. The enhanced
 *  rendition is only preferred when its height matches the base's current height (the freshness
 *  proxy — see enhanceJob): after a store-the-max upgrade, a stale lower-res enhanced rendition
 *  is skipped in favor of the taller base until the re-enhance completes. */
export async function resolvePlaybackBlob(
  ref: { assetId: string | null; status: string; userId: string },
): Promise<{ hash: string; absPath: string; mime: string } | null> {
  const base = await resolveRefBlob(ref)
  if (!base || !ref.assetId) return base
  const { shouldEnhance } = await import('@/lib/media/enhancePolicy')
  if (!(await shouldEnhance(ref.userId))) return base
  const [baseAsset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, ref.assetId)).limit(1)
  if (!baseAsset || baseAsset.kind !== 'video') return base
  const [enh] = await db.select().from(mediaAssets).where(and(
    eq(mediaAssets.sourceType, baseAsset.sourceType), eq(mediaAssets.sourceId, baseAsset.sourceId),
    eq(mediaAssets.kind, 'video'), eq(mediaAssets.format, ENHANCED_FORMAT), eq(mediaAssets.status, 'ready'),
  )).limit(1)
  if (enh?.blobHash && enh.height === baseAsset.height) {
    return { hash: enh.blobHash, absPath: await blobAbsPath(enh.blobHash), mime: 'video/mp4' }
  }
  return base
}

export type EnhanceStatus = 'enhancing' | 'enhanced'

/** Enhanced-rendition status for many base video assets at once (the Saved list is polled
 *  frequently, so this batches instead of per-row queries). Maps base assetId →
 *  'enhancing' (job in flight) | 'enhanced' (ready & current). Absent = none/stale/failed. */
export async function enhancedStatusForAssets(baseAssetIds: string[]): Promise<Map<string, EnhanceStatus>> {
  const out = new Map<string, EnhanceStatus>()
  const ids = [...new Set(baseAssetIds)]
  if (!ids.length) return out
  const bases = await db.select({ id: mediaAssets.id, sourceType: mediaAssets.sourceType, sourceId: mediaAssets.sourceId, height: mediaAssets.height })
    .from(mediaAssets).where(and(inArray(mediaAssets.id, ids), eq(mediaAssets.kind, 'video')))
  if (!bases.length) return out
  const enhanced = await db.select({ sourceType: mediaAssets.sourceType, sourceId: mediaAssets.sourceId, height: mediaAssets.height, blobHash: mediaAssets.blobHash, status: mediaAssets.status })
    .from(mediaAssets)
    .where(and(
      eq(mediaAssets.kind, 'video'), eq(mediaAssets.format, ENHANCED_FORMAT),
      inArray(mediaAssets.sourceId, [...new Set(bases.map((b) => b.sourceId))]),
    ))
  const enhByKey = new Map(enhanced.map((e) => [`${e.sourceType}:${e.sourceId}`, e]))
  for (const b of bases) {
    const e = enhByKey.get(`${b.sourceType}:${b.sourceId}`)
    if (!e) continue
    if (e.status === 'ready' && e.blobHash && e.height === b.height) out.set(b.id, 'enhanced')
    else if (e.status === 'pending' || e.status === 'downloading') out.set(b.id, 'enhancing')
  }
  return out
}

/** After deleting ref rows, drop any asset that now has zero references so its blob becomes
 *  unreferenced and GC reclaims it. Never unlinks (the blob may still be shared). */
export async function releaseAssetsIfOrphaned(assetIds: Array<string | null | undefined>): Promise<void> {
  for (const id of new Set(assetIds.filter((x): x is string => !!x))) {
    await withLock(`assetid:${id}`, async () => {
      const [stillReferenced] = await db.select({ id: ytDownloads.id }).from(ytDownloads)
        .where(eq(ytDownloads.assetId, id)).limit(1)
      if (!stillReferenced) await db.delete(mediaAssets).where(eq(mediaAssets.id, id))
    })
  }
}
