// Finalizes an approved book_project into a real, shared `books` row — mirrors
// uploadBookFile()'s blob-store/mediaAssets/bookChapters/bookLibrary insert pattern
// (lib/books/library.ts), the only difference being the source bytes are synthesized
// (epub/build.ts) rather than an uploaded file.

import { randomUUID } from 'node:crypto'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { books, bookChapters, bookLibrary, bookProjects, bookProjectChapters, mediaAssets, generatedImages, users } from '@/db/schema'
import { contentTmpDir, markBlobLive, putBlobFromFile, withLock } from '@/lib/content/store'
import { synthesizeEpub } from '@/lib/epub/build'
import { openEpub, readSpineChapters } from '@/lib/epub/parse'
import { startImageJob } from '@/routes/image'
import type { StoryBible } from './storyBible'

const lockKey = (bookId: string) => `book:${bookId}:ebook`

// Bounded poll for the cover-art job — a book with no cover is a fine degraded outcome,
// so this never blocks commit indefinitely. ComfyUI single-image jobs typically land
// well inside this window; a slower/cold render just ships without a cover.
const COVER_POLL_MS = 1_000
const COVER_POLL_MAX_ATTEMPTS = 20

async function tryGenerateCover(userId: string, isAdmin: boolean, bible: StoryBible, title: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    const prompt = `Book cover illustration for "${title}". ${bible.genre ? `Genre: ${bible.genre}. ` : ''}${bible.tone ? `Mood: ${bible.tone}. ` : ''}${bible.premise}. Professional book cover art, no text, no title, no lettering.`
    // Square (matches every other startImageJob caller's default) + fast:true. The
    // non-fast path runs a hi-res-fix refine pass (upscale -> VAEEncode -> second
    // KSampler), and that VAEEncode call crashed ComfyUI on this Apple Silicon/MPS
    // box regardless of dimensions (torch's native SDPA has a known MPS bug computing
    // its buffer size there — see hwfit.ts's getComfyUILaunchConfig comment). fast:true
    // skips hiresUpscale entirely (routes/image.ts:828), so that node never runs — a
    // book cover doesn't need hi-res-fix's extra detail pass anyway.
    const imageId = await startImageJob({ userId, isAdmin, prompt, width: 1024, height: 1024, fast: true })
    if (!imageId) return null

    for (let i = 0; i < COVER_POLL_MAX_ATTEMPTS; i++) {
      const [row] = await db.select().from(generatedImages).where(eq(generatedImages.id, imageId)).limit(1)
      if (!row) return null
      if (row.state === 'ready' && row.path) {
        const bytes = await readFile(row.path)
        const mime = row.path.endsWith('.webp') ? 'image/webp' : 'image/png'
        return { bytes, mime }
      }
      if (row.state === 'failed' || row.state === 'cancelled') return null
      await new Promise(r => setTimeout(r, COVER_POLL_MS))
    }
    return null // still building — ship without a cover rather than blocking commit
  } catch {
    return null
  }
}

export async function commitProjectToBook(projectId: string): Promise<{ bookId: string }> {
  const [project] = await db.select().from(bookProjects).where(eq(bookProjects.id, projectId)).limit(1)
  if (!project) throw new Error(`Unknown book project ${projectId}`)
  if (!project.storyBibleJson) throw new Error('Project has no story bible')
  if (project.resultBookId) return { bookId: project.resultBookId } // already committed — idempotent

  const bible = JSON.parse(project.storyBibleJson) as StoryBible
  const chapters = await db.select().from(bookProjectChapters)
    .where(and(eq(bookProjectChapters.projectId, projectId), eq(bookProjectChapters.status, 'approved')))
    .orderBy(bookProjectChapters.idx)
  const sampleChapters = await db.select().from(bookProjectChapters)
    .where(and(eq(bookProjectChapters.projectId, projectId), eq(bookProjectChapters.status, 'sample_ready')))
    .orderBy(bookProjectChapters.idx)
  const allChapters = [...sampleChapters, ...chapters].sort((a, b) => a.idx - b.idx)
  const usable = allChapters.filter((c): c is typeof c & { draftText: string } => !!c.draftText?.trim())
  if (!usable.length) throw new Error('No approved chapters to commit')

  const title = project.title?.trim() || bible.premise.slice(0, 80)

  const [owner] = await db.select({ role: users.role }).from(users).where(eq(users.id, project.userId)).limit(1)
  const cover = await tryGenerateCover(project.userId, owner?.role === 'admin', bible, title)

  const epubBuffer = synthesizeEpub({
    title,
    author: null,
    language: 'en',
    chapters: usable.map(c => ({ title: c.title || 'Untitled', text: c.draftText })),
    coverImage: cover ?? undefined,
  })

  const bookId = randomUUID()
  const now = new Date()
  const tmpPath = join(await contentTmpDir(), `book-generate-${bookId}.epub`)
  await writeFile(tmpPath, epubBuffer)

  // Read the freshly-written EPUB back for its spine (href per chapter) rather than
  // re-deriving hrefs by hand — keeps this in lockstep with whatever epub/build.ts emits,
  // and matches uploadEbookFile()'s use of readSpineChapters for the same reason.
  const handle = await openEpub(tmpPath)
  const spineChapters = readSpineChapters(handle)

  await withLock(lockKey(bookId), async () => {
    const put = await putBlobFromFile(tmpPath, { mime: 'application/epub+zip' })
    await db.insert(mediaAssets).values({
      id: randomUUID(), sourceType: 'book', sourceId: bookId, kind: 'ebook', format: 'epub',
      blobHash: put.hash, sizeBytes: put.sizeBytes, status: 'ready', createdAt: now, updatedAt: now,
    })
    await markBlobLive(put.hash)

    await db.insert(books).values({
      id: bookId, title, author: null, description: bible.premise, language: 'en',
      sourceType: 'ai-generated', sourceRef: null,
      metadataJson: JSON.stringify({
        generatedFromProjectId: projectId,
        sourceBookId: project.sourceBookId ?? null,
        generationMode: project.mode,
      }),
      addedByUserId: project.userId, createdAt: now, updatedAt: now,
    })

    for (const [i, c] of usable.entries()) {
      await db.insert(bookChapters).values({
        id: randomUUID(), bookId, idx: i, title: c.title || `Chapter ${i + 1}`,
        epubHref: spineChapters[i]?.href ?? null, wordCount: c.wordCount ?? null,
      })
    }

    await db.insert(bookLibrary).values({ id: randomUUID(), userId: project.userId, bookId, status: 'ready', addedAt: now })
  })

  await db.update(bookProjects).set({
    resultBookId: bookId, status: 'completed', updatedAt: now,
  }).where(eq(bookProjects.id, projectId))

  return { bookId }
}
