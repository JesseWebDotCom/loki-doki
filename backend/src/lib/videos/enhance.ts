// Hub-side enhance trigger — the video_saves twin of lib/youtube/assets.ts's
// maybeEnqueueEnhance: when a shared video asset finishes downloading, kick a background
// enhance if ANY user referencing it opted in for its source (per-source policy, see
// lib/media/enhancePolicy.ts). Coalesced per asset by the job queue.

import { and, eq, ne } from 'drizzle-orm'
import { db } from '@/db'
import { mediaAssets, videoSaves } from '@/db/schema'
import { shouldEnhanceFor } from '@/lib/media/enhancePolicy'

export async function maybeEnqueueEnhanceGeneric(assetId: string): Promise<void> {
  const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1)
  if (!asset || asset.kind !== 'video') return
  const refs = await db.select({ userId: videoSaves.userId }).from(videoSaves)
    .where(and(eq(videoSaves.assetId, assetId), ne(videoSaves.status, 'failed')))
  const userIds = [...new Set(refs.map(r => r.userId))]
  let wanted = false
  for (const uid of userIds) { if (await shouldEnhanceFor(uid, asset.sourceType)) { wanted = true; break } }
  if (!wanted) return
  const { enqueueMediaEnhance } = await import('@/lib/downloadJobs')
  await enqueueMediaEnhance(assetId)
}
