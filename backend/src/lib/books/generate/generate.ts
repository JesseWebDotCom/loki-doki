// Orchestrates AI book chapter generation: loads a book_project's story bible + outline,
// walks the requested chapter range through chapter.ts's padded-budget generation, updates
// the running continuity summary, and (depending on the run's flags) pauses at the
// sample-approval gate or commits the finished book. Called from downloadJobs.ts's
// runJob() for the 'book-generate' type — mirrors podcast/generate.ts's orchestration shape.

import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { bookProjects, bookProjectChapters, downloadJobs } from '@/db/schema'
import type { DownloadProgress } from '@/lib/download'
import { getUserCeiling, buildContentPrompt } from '@/lib/contentPolicy'
import { generateChapter } from './chapter'
import { summarizeChapterForContinuity } from './covered'
import { commitProjectToBook } from './commit'
import type { StoryBible, ChapterOutlineEntry } from './storyBible'

export interface BookGeneratePayload {
  projectId: string
  userId: string
  startIdx: number
  endIdx: number        // exclusive
  isSampleRun: boolean  // true → generating chapter 0 for the Phase-1 sample-approval gate
  commitOnComplete: boolean
}

type ProjectChapterStatus = 'pending' | 'generating' | 'sample_ready' | 'approved' | 'failed'

async function upsertProjectChapter(
  projectId: string,
  idx: number,
  patch: Partial<{ title: string; draftText: string; wordCount: number; status: ProjectChapterStatus; isSample: boolean }>,
): Promise<void> {
  const now = new Date()
  const [existing] = await db.select().from(bookProjectChapters)
    .where(and(eq(bookProjectChapters.projectId, projectId), eq(bookProjectChapters.idx, idx))).limit(1)
  if (existing) {
    await db.update(bookProjectChapters).set({ ...patch, updatedAt: now }).where(eq(bookProjectChapters.id, existing.id))
  } else {
    await db.insert(bookProjectChapters).values({ id: randomUUID(), projectId, idx, updatedAt: now, ...patch })
  }
}

export async function runBookGenerateJob(
  payload: BookGeneratePayload,
  onProgress: (p: DownloadProgress & { note?: string }) => void,
  signal: AbortSignal,
): Promise<void> {
  const { projectId, userId, startIdx, endIdx, isSampleRun, commitOnComplete } = payload
  const emit = (note: string, completed = 0, total = 1) => onProgress({ completed, total, speedBps: 0, etaSeconds: 0, note })

  const [project] = await db.select().from(bookProjects).where(eq(bookProjects.id, projectId)).limit(1)
  if (!project) throw new Error(`Unknown book project ${projectId}`)
  if (!project.storyBibleJson || !project.outlineJson) throw new Error('Project has no approved story bible/outline yet')
  if (project.mode !== 'create') throw new Error(`Book generation mode "${project.mode}" is not yet supported`)

  const bible = JSON.parse(project.storyBibleJson) as StoryBible
  const outline = JSON.parse(project.outlineJson) as ChapterOutlineEntry[]
  let covered: string[] = project.coveredSummaryJson ? JSON.parse(project.coveredSummaryJson) : []

  const contentPrompt = buildContentPrompt(await getUserCeiling(userId))

  await db.update(bookProjects).set({
    status: isSampleRun ? 'pending_sample' : 'generating', updatedAt: new Date(),
  }).where(eq(bookProjects.id, projectId))

  try {
    for (let idx = startIdx; idx < endIdx; idx++) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const chapterMeta = outline[idx]
      if (!chapterMeta) continue

      emit(`Writing "${chapterMeta.title}"…`, idx - startIdx, endIdx - startIdx)
      await upsertProjectChapter(projectId, idx, { status: 'generating', isSample: isSampleRun && idx === 0 })

      let tailText = ''
      if (idx > 0) {
        const [prev] = await db.select().from(bookProjectChapters)
          .where(and(eq(bookProjectChapters.projectId, projectId), eq(bookProjectChapters.idx, idx - 1))).limit(1)
        if (prev?.draftText) tailText = prev.draftText.slice(-1200)
      }

      try {
        const generated = await generateChapter({ bible, outline, chapterIdx: idx, coveredSummary: covered, tailText, contentPrompt })
        const status = isSampleRun && idx === 0 ? 'sample_ready' : 'approved'
        await upsertProjectChapter(projectId, idx, {
          title: generated.title, draftText: generated.text, wordCount: generated.wordCount,
          status, isSample: isSampleRun && idx === 0,
        })
        const summary = await summarizeChapterForContinuity(generated.title, generated.text)
        covered = [...covered, summary]
        await db.update(bookProjects).set({
          coveredSummaryJson: JSON.stringify(covered), currentChapterIdx: idx + 1, updatedAt: new Date(),
        }).where(eq(bookProjects.id, projectId))
      } catch (err) {
        console.log(`[books] project ${projectId} chapter ${idx} failed: ${err}`)
        await upsertProjectChapter(projectId, idx, { status: 'failed' })
        // The sample gate has nothing to show the user if chapter 0 itself failed — surface it.
        if (isSampleRun && idx === 0) throw err
      }
    }

    if (isSampleRun) {
      await db.update(bookProjects).set({ status: 'pending_sample_approval', updatedAt: new Date() }).where(eq(bookProjects.id, projectId))
      return
    }

    if (commitOnComplete) {
      emit('Finalizing book…', endIdx - startIdx, endIdx - startIdx)
      await commitProjectToBook(projectId)
    } else {
      await db.update(bookProjects).set({ status: 'generating', updatedAt: new Date() }).where(eq(bookProjects.id, projectId))
    }
  } catch (err: unknown) {
    await db.update(bookProjects).set({
      status: 'failed', error: String((err as Error)?.message ?? err), updatedAt: new Date(),
    }).where(eq(bookProjects.id, projectId))
    throw err
  }
}

/** Surface a book-generate job that exhausted retries — mirrors failBookTtsRenderByJobRefId. */
export async function failBookGenerateByJobRefId(refId: string, error: string): Promise<void> {
  let payload: BookGeneratePayload
  try { payload = JSON.parse(refId) as BookGeneratePayload } catch { return }
  await db.update(bookProjects).set({
    status: 'failed', error: error.slice(0, 300), updatedAt: new Date(),
  }).where(eq(bookProjects.id, payload.projectId))
}

/** Enqueues a chapter-generation run for a project. Used by all four Phase-1 route actions
 *  (approve-bible, regenerate-sample, approve-sample, chapters/:idx/regenerate) — they differ
 *  only in the range + flags, not the underlying job. */
export async function enqueueBookGenerateRun(opts: {
  projectId: string
  userId: string
  startIdx: number
  endIdx: number
  isSampleRun: boolean
  commitOnComplete: boolean
  label: string
}): Promise<{ jobId: string }> {
  const payload: BookGeneratePayload = {
    projectId: opts.projectId, userId: opts.userId,
    startIdx: opts.startIdx, endIdx: opts.endIdx,
    isSampleRun: opts.isSampleRun, commitOnComplete: opts.commitOnComplete,
  }
  const refId = JSON.stringify(payload)
  const jobId = randomUUID()
  const now = new Date()
  await db.insert(downloadJobs).values({
    id: jobId, type: 'book-generate', refId, variantKey: null,
    domain: 'books', sizeClass: 'small', label: opts.label,
    priority: 50, status: 'pending', attempts: 0, maxAttempts: 2,
    nextEligibleAt: null, lastError: null, progress: null, createdAt: now, updatedAt: now,
  })
  await db.update(bookProjects).set({
    jobId, status: opts.isSampleRun ? 'pending_sample' : 'generating', updatedAt: now,
  }).where(eq(bookProjects.id, opts.projectId))
  return { jobId }
}
