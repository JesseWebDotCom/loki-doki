// EPUB → audiobook conversion, consuming the narration engine's speaker-detection
// and audio-synthesis primitives (backend/src/lib/narration/{detect,voicePool,
// multiVoiceRender}.ts) rather than duplicating them. Deliberately does NOT create
// a narrationSessions row per chapter — that table is for the standalone
// "Cast voices" feature; a book's per-chapter speaker detection is transient,
// used once to render audio and then discarded.

import { randomUUID } from 'node:crypto'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { books, bookChapters, downloadJobs, mediaAssets } from '@/db/schema'
import { contentTmpDir, markBlobLive, putBlobFromFile, withLock, acquireRead, releaseRead, blobAbsPath } from '@/lib/content/store'
import { openEpub, readChapterText, readSpineChapters } from '@/lib/epub/parse'
import { detectTurns, normalizeSpeakers } from '@/lib/narration/detect'
import { assignVoices, NARRATOR_VOICE } from '@/lib/narration/voicePool'
import { bareVoiceId, buildSilencePcm, buildWavBuffer, synthesizeTurnsToPcm, wavToMp3 } from '@/lib/narration/multiVoiceRender'
import { getReadyAssetBlobHash } from './library'
import { logger } from '@/lib/logger'

export interface BookTtsRenderPayload { bookId: string }

const SOURCE = 'book'
const lockKey = (bookId: string) => `book:${bookId}:tts`
const CHAPTER_GAP_SEC = 0.6

/** Get-or-create the book's audiobook asset + render job. Only EPUBs are
 *  supported — there's no clean text-extraction path for PDF/CBZ in v1. */
export async function enqueueBookTtsRender(bookId: string): Promise<{ assetId: string; jobId: string | null }> {
  const [book] = await db.select().from(books).where(eq(books.id, bookId)).limit(1)
  if (!book) throw new Error('Unknown book')
  const ebook = await getReadyAssetBlobHash(bookId, 'ebook')
  if (!ebook || ebook.format !== 'epub') throw new Error('Audiobook conversion currently requires an EPUB')

  const now = new Date()
  return withLock(lockKey(bookId), async () => {
    let [asset] = await db.select().from(mediaAssets).where(and(
      eq(mediaAssets.sourceType, SOURCE), eq(mediaAssets.sourceId, bookId),
      eq(mediaAssets.kind, 'audio'), eq(mediaAssets.format, 'mp3'),
    )).limit(1)
    if (!asset) {
      const values: typeof mediaAssets.$inferInsert = {
        id: randomUUID(), sourceType: SOURCE, sourceId: bookId, kind: 'audio', format: 'mp3',
        status: 'pending', createdAt: now, updatedAt: now,
      }
      await db.insert(mediaAssets).values(values)
      asset = (await db.select().from(mediaAssets).where(eq(mediaAssets.id, values.id!)).limit(1))[0]!
    } else if (asset.status === 'failed') {
      await db.update(mediaAssets).set({ status: 'pending', error: null, updatedAt: now }).where(eq(mediaAssets.id, asset.id))
      asset = { ...asset, status: 'pending' }
    }
    if (asset.status === 'ready') return { assetId: asset.id, jobId: null }

    const refId = JSON.stringify({ bookId } satisfies BookTtsRenderPayload)
    const [existing] = await db.select().from(downloadJobs)
      .where(and(eq(downloadJobs.type, 'book-tts-render'), eq(downloadJobs.refId, refId))).limit(1)
    let jobId: string
    if (existing) {
      jobId = existing.id
      if (['failed', 'cancelled', 'completed'].includes(existing.status)) {
        await db.update(downloadJobs)
          .set({ status: 'pending', attempts: 0, nextEligibleAt: null, lastError: null, updatedAt: now })
          .where(eq(downloadJobs.id, existing.id))
      }
    } else {
      jobId = randomUUID()
      await db.insert(downloadJobs).values({
        id: jobId, type: 'book-tts-render', refId, variantKey: null,
        domain: 'narration', sizeClass: 'small', label: `Audiobook: ${book.title.slice(0, 100)}`,
        priority: 50, status: 'pending', attempts: 0, maxAttempts: 2,
        nextEligibleAt: null, lastError: null, progress: null, createdAt: now, updatedAt: now,
      })
    }
    return { assetId: asset.id, jobId }
  })
}

export async function failBookTtsRenderByJobRefId(refId: string, error: string): Promise<void> {
  let payload: BookTtsRenderPayload
  try { payload = JSON.parse(refId) as BookTtsRenderPayload } catch { return }
  await withLock(lockKey(payload.bookId), async () => {
    await db.update(mediaAssets).set({ status: 'failed', error: error.slice(0, 300), updatedAt: new Date() })
      .where(and(eq(mediaAssets.sourceType, SOURCE), eq(mediaAssets.sourceId, payload.bookId), eq(mediaAssets.kind, 'audio'), eq(mediaAssets.format, 'mp3')))
  })
}

export async function runBookTtsRenderJob(
  payload: BookTtsRenderPayload,
  onProgress: (p: { completed: number; total: number; speedBps: number; etaSeconds: number; note?: string }) => void,
  signal: AbortSignal,
): Promise<void> {
  const { bookId } = payload
  const [book] = await db.select().from(books).where(eq(books.id, bookId)).limit(1)
  if (!book) throw new Error(`Unknown book ${bookId}`)

  const ebook = await getReadyAssetBlobHash(bookId, 'ebook')
  if (!ebook || ebook.format !== 'epub') throw new Error('Audiobook conversion currently requires an EPUB')

  const asset = await withLock(lockKey(bookId), async () => {
    const [a] = await db.select().from(mediaAssets).where(and(
      eq(mediaAssets.sourceType, SOURCE), eq(mediaAssets.sourceId, bookId),
      eq(mediaAssets.kind, 'audio'), eq(mediaAssets.format, 'mp3'),
    )).limit(1)
    if (!a) throw new Error('Asset row missing (enqueue creates it)')
    if (a.status === 'ready') return a
    await db.update(mediaAssets).set({ status: 'downloading', updatedAt: new Date() }).where(eq(mediaAssets.id, a.id))
    return a
  })
  if (asset.status === 'ready') return

  const absPath = await blobAbsPath(ebook.hash)
  acquireRead(ebook.hash)
  let handle
  try {
    handle = await openEpub(absPath)
  } finally {
    releaseRead(ebook.hash)
  }

  let chapters = await db.select().from(bookChapters).where(eq(bookChapters.bookId, bookId)).orderBy(bookChapters.idx)
  if (!chapters.length) {
    for (const [i, ch] of readSpineChapters(handle).entries()) {
      await db.insert(bookChapters).values({ id: randomUUID(), bookId, idx: i, title: ch.title, epubHref: ch.href })
    }
    chapters = await db.select().from(bookChapters).where(eq(bookChapters.bookId, bookId)).orderBy(bookChapters.idx)
  }
  if (!chapters.length) throw new Error('No chapters found in this EPUB')

  const outDir = await contentTmpDir()
  const pcmChunks: Buffer[] = []
  const gapPcm = buildSilencePcm(CHAPTER_GAP_SEC)
  const chapterOffsets: { id: string; startSec: number; endSec: number }[] = []
  let cumulativeSec = 0
  let totalSpoken = 0

  for (let ci = 0; ci < chapters.length; ci++) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const chapter = chapters[ci]!
    onProgress({ completed: ci, total: chapters.length, speedBps: 0, etaSeconds: 0, note: `Reading "${chapter.title}"…` })
    if (!chapter.epubHref) { chapterOffsets.push({ id: chapter.id, startSec: cumulativeSec, endSec: cumulativeSec }); continue }

    const text = readChapterText(handle, chapter.epubHref)
    if (!text.trim()) { chapterOffsets.push({ id: chapter.id, startSec: cumulativeSec, endSec: cumulativeSec }); continue }

    const detection = await detectTurns(text)
    const { speakers, turns } = normalizeSpeakers(detection.turns)
    const voiceByKey = assignVoices(speakers)
    const renderTurns = turns.map((t) => ({ voice: bareVoiceId(voiceByKey.get(t.normalizedKey) ?? NARRATOR_VOICE), speed: 1.0, text: t.text }))

    const startSec = cumulativeSec
    const { pcm, durationSec, spoken } = await synthesizeTurnsToPcm(renderTurns, (i, total) => {
      onProgress({ completed: ci, total: chapters.length, speedBps: 0, etaSeconds: 0, note: `"${chapter.title}" — ${i + 1}/${total}…` })
    }, signal)
    totalSpoken += spoken

    if (pcm.length > 0) {
      pcmChunks.push(pcm)
      cumulativeSec += durationSec
      if (ci < chapters.length - 1) {
        pcmChunks.push(gapPcm)
        cumulativeSec += CHAPTER_GAP_SEC
      }
    }
    chapterOffsets.push({ id: chapter.id, startSec, endSec: cumulativeSec })
  }

  if (totalSpoken === 0) throw new Error('Voice synthesis produced no speech — check that the voice server is running')

  const wavBuf = buildWavBuffer(Buffer.concat(pcmChunks))
  const stamp = Date.now()
  const wavPath = join(outDir, `book-tts-${bookId}-${stamp}.wav`)
  await writeFile(wavPath, wavBuf)

  const mp3Path = join(outDir, `book-tts-${bookId}-${stamp}.mp3`)
  onProgress({ completed: chapters.length, total: chapters.length, speedBps: 0, etaSeconds: 0, note: 'Converting to MP3…' })
  try {
    await wavToMp3(wavPath, mp3Path, book.title)
  } finally {
    await unlink(wavPath).catch(() => {})
  }

  const put = await putBlobFromFile(mp3Path, { mime: 'audio/mpeg' })
  await withLock(lockKey(bookId), async () => {
    await db.update(mediaAssets).set({
      blobHash: put.hash, sizeBytes: put.sizeBytes, status: 'ready', error: null, updatedAt: new Date(),
    }).where(eq(mediaAssets.id, asset.id))
    await markBlobLive(put.hash)
    for (const off of chapterOffsets) {
      await db.update(bookChapters).set({ audioStartSec: off.startSec, audioEndSec: off.endSec }).where(eq(bookChapters.id, off.id))
    }
  })
  logger.info(`[books] TTS-rendered "${book.title}" (${(put.sizeBytes / 1e6).toFixed(1)} MB)`)
}
