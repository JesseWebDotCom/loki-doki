// MP3/WAV export for a narration session — the slow, full-render path (contrast
// with live playback in the client, which streams turn-by-turn through the
// existing /api/tts/stream and never needs a finished file). Synthesis primitives
// live in ./multiVoiceRender.ts, shared with the Books app's EPUB→audiobook
// conversion (backend/src/lib/books/tts.ts).
//
// Exports are personal, per-session artifacts (not deduped across users like
// podcast episodes), so this skips the podcastDownloads-style per-user ref table:
// one mediaAssets row per (session, format), owned by the session itself.

import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { downloadJobs, mediaAssets, narrationSessions, narrationSpeakers, narrationTurns } from '@/db/schema'
import { contentTmpDir, markBlobLive, putBlobFromFile, withLock } from '@/lib/content/store'
import { bareVoiceId, buildWavBuffer, synthesizeTurnsToPcm, wavToMp3 } from './multiVoiceRender'
import { logger } from '@/lib/logger'

export interface NarrationRenderPayload { sessionId: string; format: 'mp3' | 'wav' }

const SOURCE = 'narration'
const lockKey = (sessionId: string) => `narration:${sessionId}:audio`

/** Get-or-create the (session, format) asset and its render job. Returns immediately
 *  with `jobId: null` if the asset is already ready. */
export async function enqueueNarrationRender(sessionId: string, format: 'mp3' | 'wav'): Promise<{ assetId: string; jobId: string | null }> {
  const [session] = await db.select().from(narrationSessions).where(eq(narrationSessions.id, sessionId)).limit(1)
  if (!session) throw new Error('Unknown narration session')
  if (session.status !== 'ready') throw new Error('Session is not ready for export')

  const now = new Date()
  return withLock(lockKey(sessionId), async () => {
    let [asset] = await db.select().from(mediaAssets).where(and(
      eq(mediaAssets.sourceType, SOURCE), eq(mediaAssets.sourceId, sessionId),
      eq(mediaAssets.kind, 'audio'), eq(mediaAssets.format, format),
    )).limit(1)
    if (!asset) {
      const values: typeof mediaAssets.$inferInsert = {
        id: crypto.randomUUID(), sourceType: SOURCE, sourceId: sessionId,
        kind: 'audio', format, status: 'pending', createdAt: now, updatedAt: now,
      }
      await db.insert(mediaAssets).values(values)
      asset = (await db.select().from(mediaAssets).where(eq(mediaAssets.id, values.id!)).limit(1))[0]!
    } else if (asset.status === 'failed') {
      await db.update(mediaAssets).set({ status: 'pending', error: null, updatedAt: now }).where(eq(mediaAssets.id, asset.id))
      asset = { ...asset, status: 'pending' }
    }
    if (asset.status === 'ready') return { assetId: asset.id, jobId: null }

    const refId = JSON.stringify({ sessionId, format } satisfies NarrationRenderPayload)
    const [existing] = await db.select().from(downloadJobs)
      .where(and(eq(downloadJobs.type, 'narration-render'), eq(downloadJobs.refId, refId))).limit(1)
    let jobId: string
    if (existing) {
      jobId = existing.id
      if (['failed', 'cancelled', 'completed'].includes(existing.status)) {
        await db.update(downloadJobs)
          .set({ status: 'pending', attempts: 0, nextEligibleAt: null, lastError: null, updatedAt: now })
          .where(eq(downloadJobs.id, existing.id))
      }
    } else {
      jobId = crypto.randomUUID()
      await db.insert(downloadJobs).values({
        id: jobId, type: 'narration-render', refId, variantKey: null,
        domain: 'narration', sizeClass: 'small', label: `Narration: ${session.title.slice(0, 100) || 'Untitled'}`,
        priority: 55, status: 'pending', attempts: 0, maxAttempts: 3,
        nextEligibleAt: null, lastError: null, progress: null, createdAt: now, updatedAt: now,
      })
    }
    return { assetId: asset.id, jobId }
  })
}

/** Terminal-failure hook (called from the job queue after retries are exhausted). */
export async function failNarrationRenderByJobRefId(refId: string, error: string): Promise<void> {
  let payload: NarrationRenderPayload
  try { payload = JSON.parse(refId) as NarrationRenderPayload } catch { return }
  await withLock(lockKey(payload.sessionId), async () => {
    await db.update(mediaAssets).set({ status: 'failed', error: error.slice(0, 300), updatedAt: new Date() })
      .where(and(
        eq(mediaAssets.sourceType, SOURCE), eq(mediaAssets.sourceId, payload.sessionId),
        eq(mediaAssets.kind, 'audio'), eq(mediaAssets.format, payload.format),
      ))
  })
}

export async function runNarrationRenderJob(
  payload: NarrationRenderPayload,
  onProgress: (p: { completed: number; total: number; speedBps: number; etaSeconds: number; note?: string }) => void,
  signal: AbortSignal,
): Promise<void> {
  const { sessionId, format } = payload
  const [session] = await db.select().from(narrationSessions).where(eq(narrationSessions.id, sessionId)).limit(1)
  if (!session) throw new Error(`Unknown narration session ${sessionId}`)

  const speakers = await db.select().from(narrationSpeakers)
    .where(eq(narrationSpeakers.sessionId, sessionId)).orderBy(asc(narrationSpeakers.orderIndex))
  const turns = await db.select().from(narrationTurns)
    .where(eq(narrationTurns.sessionId, sessionId)).orderBy(asc(narrationTurns.turnIndex))
  if (!turns.length) throw new Error('Session has no turns to render')

  const voiceBySpeaker = new Map(speakers.map((s) => [s.id, { voice: bareVoiceId(s.voiceId), speed: s.speechRate }]))

  const asset = await withLock(lockKey(sessionId), async () => {
    const [a] = await db.select().from(mediaAssets).where(and(
      eq(mediaAssets.sourceType, SOURCE), eq(mediaAssets.sourceId, sessionId),
      eq(mediaAssets.kind, 'audio'), eq(mediaAssets.format, format),
    )).limit(1)
    if (!a) throw new Error('Asset row missing (enqueue creates it)')
    if (a.status === 'ready') return a
    await db.update(mediaAssets).set({ status: 'downloading', updatedAt: new Date() }).where(eq(mediaAssets.id, a.id))
    return a
  })
  if (asset.status === 'ready') return

  const renderTurns = turns.map((t) => {
    const v = voiceBySpeaker.get(t.speakerId) ?? { voice: 'af_heart', speed: 1.0 }
    return { voice: v.voice, speed: v.speed, text: t.text }
  })
  const { pcm, spoken } = await synthesizeTurnsToPcm(renderTurns, (i, total) => {
    onProgress({ completed: i, total, speedBps: 0, etaSeconds: 0, note: `Synthesizing turn ${i + 1}/${total}…` })
  }, signal)
  if (spoken === 0) throw new Error('Voice synthesis produced no speech — check that the voice server is running')

  const outDir = await contentTmpDir()
  const wavBuf = buildWavBuffer(pcm)
  const stamp = Date.now()
  const wavPath = join(outDir, `narration-${sessionId}-${stamp}.wav`)
  await writeFile(wavPath, wavBuf)

  let finalPath = wavPath
  let mime = 'audio/wav'
  if (format === 'mp3') {
    onProgress({ completed: turns.length, total: turns.length, speedBps: 0, etaSeconds: 0, note: 'Converting to MP3…' })
    const mp3Path = join(outDir, `narration-${sessionId}-${stamp}.mp3`)
    try {
      await wavToMp3(wavPath, mp3Path, session.title || 'Narration')
    } finally {
      await unlink(wavPath).catch(() => {})
    }
    finalPath = mp3Path
    mime = 'audio/mpeg'
  }

  const put = await putBlobFromFile(finalPath, { mime })
  await withLock(lockKey(sessionId), async () => {
    await db.update(mediaAssets).set({
      blobHash: put.hash, sizeBytes: put.sizeBytes, status: 'ready', error: null, updatedAt: new Date(),
    }).where(eq(mediaAssets.id, asset.id))
    await markBlobLive(put.hash)
  })
  logger.info(`[narration] rendered "${session.title}" → ${format} (${(put.sizeBytes / 1e6).toFixed(1)} MB${put.deduped ? ', deduped' : ''})`)
}
