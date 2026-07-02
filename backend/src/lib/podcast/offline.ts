// Offline podcast episodes over the shared blob store (download-jobs type 'podcast-download').
//
// The ytDownloads-as-refs pattern: one media_assets rendition per episode
// (sourceType='podcast', sourceId=episodeId, kind='audio'), per-user podcast_downloads
// rows as refs. Two household users offlining the same episode share ONE blob — the
// second user's "download" just links the existing ready asset and costs zero bytes.
// gcSweep() counts podcast_downloads as pins; deleting the ref is what releases space.

import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { downloadJobs, mediaAssets, podcastDownloads, podcastEpisodes } from '@/db/schema'
import { contentTmpDir, markBlobLive, putBlobFromFile, withLock } from '@/lib/content/store'
import { safeFetch } from '@/lib/ssrfGuard'
import type { DownloadProgress } from '@/lib/download'
import { logger } from '@/lib/logger'

export interface PodcastDownloadPayload { episodeId: string }

const SOURCE = 'podcast'
const lockKey = (episodeId: string) => `podcast:${episodeId}:audio`

/** Container format from the enclosure MIME/URL — part of the asset identity and what
 *  the stream route derives its Content-Type from. */
export function enclosureFormat(enclosureType: string | null, enclosureUrl: string): string {
  const m = (enclosureType ?? '').toLowerCase()
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a'
  if (m.includes('ogg') || m.includes('opus')) return 'ogg'
  const ext = enclosureUrl.match(/\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac)(\?|$)/i)?.[1]?.toLowerCase()
  if (ext === 'mp3') return 'mp3'
  if (ext === 'm4a' || ext === 'm4b' || ext === 'aac') return 'm4a'
  if (ext === 'ogg' || ext === 'oga' || ext === 'opus') return 'ogg'
  return ext ?? 'mp3'
}

export function formatContentType(format: string | null): string {
  switch (format) {
    case 'm4a': return 'audio/mp4'
    case 'ogg': return 'audio/ogg'
    case 'wav': return 'audio/wav'
    case 'flac': return 'audio/flac'
    default: return 'audio/mpeg'
  }
}

/** Create (or reuse) the user's download ref and make sure a download job exists for the
 *  asset. When the shared asset is already ready, the ref links instantly — no job. */
export async function enqueueEpisodeDownload(userId: string, episodeId: string, opts: { auto?: boolean } = {}): Promise<void> {
  const [episode] = await db.select({
    id: podcastEpisodes.id, enclosureUrl: podcastEpisodes.enclosureUrl,
    enclosureType: podcastEpisodes.enclosureType, title: podcastEpisodes.title,
    audioRelPath: podcastEpisodes.audioRelPath,
  }).from(podcastEpisodes).where(eq(podcastEpisodes.id, episodeId)).limit(1)
  if (!episode) throw new Error('Unknown episode')
  if (!episode.enclosureUrl || episode.audioRelPath) throw new Error('Episode has no remote audio to download')

  const format = enclosureFormat(episode.enclosureType, episode.enclosureUrl)
  const now = new Date()

  await withLock(lockKey(episodeId), async () => {
    // Get-or-create the shared asset.
    let [asset] = await db.select().from(mediaAssets).where(and(
      eq(mediaAssets.sourceType, SOURCE), eq(mediaAssets.sourceId, episodeId),
      eq(mediaAssets.kind, 'audio'), eq(mediaAssets.format, format),
    )).limit(1)
    if (!asset) {
      const values: typeof mediaAssets.$inferInsert = {
        id: crypto.randomUUID(), sourceType: SOURCE, sourceId: episodeId,
        kind: 'audio', format, status: 'pending', createdAt: now, updatedAt: now,
      }
      await db.insert(mediaAssets).values(values)
      asset = (await db.select().from(mediaAssets).where(eq(mediaAssets.id, values.id!)).limit(1))[0]!
    } else if (asset.status === 'failed') {
      // A previous terminal failure shouldn't poison future attempts.
      await db.update(mediaAssets).set({ status: 'pending', error: null, updatedAt: now }).where(eq(mediaAssets.id, asset.id))
      asset = { ...asset, status: 'pending' }
    }

    // Upsert the user's ref (re-downloading a failed one resets it).
    const refStatus = asset.status === 'ready' ? 'ready' : 'pending'
    await db.insert(podcastDownloads).values({
      id: crypto.randomUUID(), userId, episodeId, assetId: asset.id,
      status: refStatus, auto: opts.auto ?? false, createdAt: now, updatedAt: now,
    }).onConflictDoUpdate({
      target: [podcastDownloads.userId, podcastDownloads.episodeId],
      set: { assetId: asset.id, status: refStatus, error: null, updatedAt: now },
    })
    if (asset.status === 'ready') {
      await db.update(podcastEpisodes).set({ assetId: asset.id }).where(eq(podcastEpisodes.id, episodeId))
      return
    }

    // One job per asset; a pending/running job is reused, a failed/cancelled one resets.
    const refId = JSON.stringify({ episodeId } satisfies PodcastDownloadPayload)
    const [existing] = await db.select().from(downloadJobs)
      .where(and(eq(downloadJobs.type, 'podcast-download'), eq(downloadJobs.refId, refId))).limit(1)
    if (existing) {
      if (existing.status === 'failed' || existing.status === 'cancelled' || existing.status === 'completed') {
        await db.update(downloadJobs)
          .set({ status: 'pending', attempts: 0, nextEligibleAt: null, lastError: null, updatedAt: now })
          .where(eq(downloadJobs.id, existing.id))
      }
    } else {
      await db.insert(downloadJobs).values({
        id: crypto.randomUUID(), type: 'podcast-download', refId, variantKey: null,
        domain: 'podcast', sizeClass: 'small', label: `Podcast: ${episode.title.slice(0, 100)}`,
        priority: 55, status: 'pending', attempts: 0, maxAttempts: 3,
        nextEligibleAt: null, lastError: null, progress: null, createdAt: now, updatedAt: now,
      })
    }
  })
  // No explicit scheduler kick — the download scheduler's 5s tick picks the row up
  // (same contract as youtube/assets.enqueueAssetJob).
}

/** Remove the user's offline copy: delete the ref; gcSweep reclaims the blob once no
 *  other user references the asset. */
export async function removeEpisodeDownload(userId: string, episodeId: string): Promise<void> {
  await db.delete(podcastDownloads)
    .where(and(eq(podcastDownloads.userId, userId), eq(podcastDownloads.episodeId, episodeId)))
}

/** Terminal-failure/cancel hook (called from the job queue): fail the asset and every
 *  ref still waiting on it, so nobody sits on 'pending' forever. */
export async function failPodcastDownloadByJobRefId(refId: string, error: string): Promise<void> {
  let episodeId: string
  try { episodeId = (JSON.parse(refId) as PodcastDownloadPayload).episodeId } catch { return }
  await withLock(lockKey(episodeId), async () => {
    const now = new Date()
    const assets = await db.select({ id: mediaAssets.id }).from(mediaAssets).where(and(
      eq(mediaAssets.sourceType, SOURCE), eq(mediaAssets.sourceId, episodeId), eq(mediaAssets.kind, 'audio'),
    ))
    for (const a of assets) {
      await db.update(mediaAssets).set({ status: 'failed', error: error.slice(0, 300), updatedAt: now })
        .where(and(eq(mediaAssets.id, a.id), inArray(mediaAssets.status, ['pending', 'downloading'])))
    }
    await db.update(podcastDownloads).set({ status: 'failed', error: error.slice(0, 300), updatedAt: now })
      .where(and(eq(podcastDownloads.episodeId, episodeId), inArray(podcastDownloads.status, ['pending', 'downloading'])))
  })
}

/** The job runner: fetch the enclosure to a temp file, land it in the blob store, flip
 *  the asset + all waiting refs ready. Safe to re-run — a ready asset just links. */
export async function runPodcastDownloadJob(
  payload: PodcastDownloadPayload,
  onProgress: (p: DownloadProgress & { note?: string }) => void,
  signal: AbortSignal,
): Promise<void> {
  const { episodeId } = payload
  const [episode] = await db.select().from(podcastEpisodes).where(eq(podcastEpisodes.id, episodeId)).limit(1)
  if (!episode) throw new Error(`Unknown episode ${episodeId}`)
  if (!episode.enclosureUrl) throw new Error('Episode has no enclosure URL')
  const format = enclosureFormat(episode.enclosureType, episode.enclosureUrl)

  // Resolve the asset + short-circuit when another user's download already landed it.
  const asset = await withLock(lockKey(episodeId), async () => {
    const [a] = await db.select().from(mediaAssets).where(and(
      eq(mediaAssets.sourceType, SOURCE), eq(mediaAssets.sourceId, episodeId),
      eq(mediaAssets.kind, 'audio'), eq(mediaAssets.format, format),
    )).limit(1)
    if (!a) throw new Error('Asset row missing (enqueue creates it)')
    if (a.status === 'ready') return a
    const now = new Date()
    await db.update(mediaAssets).set({ status: 'downloading', updatedAt: now }).where(eq(mediaAssets.id, a.id))
    await db.update(podcastDownloads).set({ status: 'downloading', updatedAt: now })
      .where(and(eq(podcastDownloads.assetId, a.id), eq(podcastDownloads.status, 'pending')))
    return a
  })
  if (asset.status === 'ready') {
    await linkReady(episodeId, asset.id)
    return
  }

  // Stream the enclosure to a temp file. identity encoding: a gzip Content-Length would
  // otherwise make byte progress lie (the install-pipeline gotcha).
  const tmpPath = join(await contentTmpDir(), `podcast-${episodeId}-${Date.now()}.${format}`)
  try {
    const res = await safeFetch(episode.enclosureUrl, {
      headers: { 'User-Agent': 'LokiDoki/3.0 podcast', Accept: '*/*', 'Accept-Encoding': 'identity' },
    }, { timeoutMs: 30_000, maxRedirects: 8 })
    if (!res.ok || !res.body) {
      res.body?.cancel().catch(() => {})
      throw new Error(`Enclosure responded ${res.status}`)
    }
    const totalHeader = Number.parseInt(res.headers.get('content-length') ?? '', 10)
    const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : (episode.enclosureBytes ?? 0)

    const out = createWriteStream(tmpPath)
    const reader = res.body.getReader()
    let completed = 0
    let lastTick = Date.now()
    let lastBytes = 0
    try {
      for (;;) {
        if (signal.aborted) throw new Error('Aborted')
        const { done, value } = await reader.read()
        if (done) break
        completed += value.byteLength
        await new Promise<void>((resolve, reject) => out.write(value, err => err ? reject(err) : resolve()))
        const nowMs = Date.now()
        if (nowMs - lastTick >= 1000) {
          const speedBps = (completed - lastBytes) / ((nowMs - lastTick) / 1000)
          onProgress({
            completed, total: Math.max(total, completed), speedBps,
            etaSeconds: speedBps > 0 && total > completed ? Math.round((total - completed) / speedBps) : 0,
            status: 'downloading',
          })
          lastTick = nowMs; lastBytes = completed
        }
      }
    } finally {
      reader.releaseLock?.()
      await new Promise<void>(resolve => out.end(() => resolve()))
    }
    if (completed === 0) throw new Error('Enclosure returned no data')

    // Land the file (moves it into the blob store) and commit everything under the lock.
    const put = await putBlobFromFile(tmpPath, { mime: formatContentType(format) })
    await withLock(lockKey(episodeId), async () => {
      const now = new Date()
      await db.update(mediaAssets).set({
        blobHash: put.hash, sizeBytes: put.sizeBytes, status: 'ready', error: null, updatedAt: now,
      }).where(eq(mediaAssets.id, asset.id))
      await markBlobLive(put.hash)
      await linkReady(episodeId, asset.id)
    })
    logger.info(`[podcast-rss] downloaded "${episode.title}" (${(put.sizeBytes / 1e6).toFixed(1)} MB${put.deduped ? ', deduped' : ''})`)
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    throw err
  }
}

/** Flip all waiting refs for this asset to ready and stamp the episode's assetId. */
async function linkReady(episodeId: string, assetId: string): Promise<void> {
  const now = new Date()
  await db.update(podcastDownloads).set({ status: 'ready', error: null, updatedAt: now })
    .where(and(eq(podcastDownloads.assetId, assetId), inArray(podcastDownloads.status, ['pending', 'downloading'])))
  await db.update(podcastEpisodes).set({ assetId }).where(eq(podcastEpisodes.id, episodeId))
}
