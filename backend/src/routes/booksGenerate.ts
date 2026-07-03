// AI book authoring (Phase 1: write a book from scratch). Mounted at /api/books alongside
// the existing `books` router (same multi-router-per-prefix pattern already used for
// /api/podcasts) — see backend/src/lib/books/generate/*.ts for the generation pipeline and
// backend/.claude/plans/noble-hugging-dawn.md-derived design for the full feature shape.

import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { bookProjects, bookProjectChapters, downloadJobs } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { generateStoryBible, generateOutline, type BookBrief, type StoryBible, type ChapterOutlineEntry } from '@/lib/books/generate/storyBible'
import { enqueueBookGenerateRun } from '@/lib/books/generate/generate'
import { commitProjectToBook } from '@/lib/books/generate/commit'
import type { AppEnv } from '@/types'

export const booksGenerate = new Hono<AppEnv>()
booksGenerate.use('*', requireAuth)

const MIN_CHAPTERS = 3
const MAX_CHAPTERS = 30
const MIN_WORDS_PER_CHAPTER = 500
const MAX_WORDS_PER_CHAPTER = 3000
const DEFAULT_CHAPTER_COUNT = 10
const DEFAULT_WORDS_PER_CHAPTER = 1500

async function getOwnedProject(projectId: string, userId: string) {
  const [project] = await db.select().from(bookProjects)
    .where(and(eq(bookProjects.id, projectId), eq(bookProjects.userId, userId))).limit(1)
  return project ?? null
}

function serializeProject(p: typeof bookProjects.$inferSelect) {
  return {
    id: p.id, mode: p.mode, sourceBookId: p.sourceBookId, resultBookId: p.resultBookId,
    title: p.title, status: p.status, error: p.error,
    prompt: p.promptJson ? JSON.parse(p.promptJson) : null,
    storyBible: p.storyBibleJson ? JSON.parse(p.storyBibleJson) : null,
    outline: p.outlineJson ? JSON.parse(p.outlineJson) : null,
    currentChapterIdx: p.currentChapterIdx,
    targetChapterCount: p.targetChapterCount,
    targetWordsPerChapter: p.targetWordsPerChapter,
    createdAt: p.createdAt, updatedAt: p.updatedAt,
  }
}

booksGenerate.post('/generate/projects', async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => null) as {
    premise?: string; genre?: string; tone?: string; pov?: string
    chapterCount?: number; wordsPerChapter?: number; title?: string
  } | null
  if (!body?.premise?.trim()) return c.json({ code: 'premise_required' }, 400)

  const chapterCount = Math.max(MIN_CHAPTERS, Math.min(MAX_CHAPTERS, body.chapterCount || DEFAULT_CHAPTER_COUNT))
  const wordsPerChapter = Math.max(MIN_WORDS_PER_CHAPTER, Math.min(MAX_WORDS_PER_CHAPTER, body.wordsPerChapter || DEFAULT_WORDS_PER_CHAPTER))
  const brief: BookBrief = { premise: body.premise.trim(), genre: body.genre, tone: body.tone, pov: body.pov, chapterCount, wordsPerChapter }

  const now = new Date()
  const projectId = randomUUID()
  await db.insert(bookProjects).values({
    id: projectId, userId: user.id, mode: 'create', title: body.title?.trim() || null,
    promptJson: JSON.stringify(brief), status: 'drafting_bible',
    targetChapterCount: chapterCount, targetWordsPerChapter: wordsPerChapter,
    createdAt: now, updatedAt: now,
  })

  try {
    const bible = await generateStoryBible(brief)
    if (!bible) throw new Error('Story bible generation failed')
    const outline = await generateOutline(bible, chapterCount, wordsPerChapter)
    if (!outline) throw new Error('Outline generation failed')

    await db.update(bookProjects).set({
      storyBibleJson: JSON.stringify(bible), outlineJson: JSON.stringify(outline),
      status: 'pending_bible_approval', updatedAt: new Date(),
    }).where(eq(bookProjects.id, projectId))
  } catch (err) {
    await db.update(bookProjects).set({
      status: 'failed', error: String((err as Error)?.message ?? err), updatedAt: new Date(),
    }).where(eq(bookProjects.id, projectId))
  }

  const [project] = await db.select().from(bookProjects).where(eq(bookProjects.id, projectId)).limit(1)
  return c.json({ project: serializeProject(project!) })
})

booksGenerate.get('/generate/projects', async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(bookProjects).where(eq(bookProjects.userId, user.id)).orderBy(desc(bookProjects.updatedAt))
  return c.json({ projects: rows.map(serializeProject) })
})

booksGenerate.get('/generate/projects/:id', async (c) => {
  const user = c.get('user')
  const project = await getOwnedProject(c.req.param('id'), user.id)
  if (!project) return c.json({ code: 'not_found' }, 404)
  const chapters = await db.select().from(bookProjectChapters)
    .where(eq(bookProjectChapters.projectId, project.id)).orderBy(bookProjectChapters.idx)
  return c.json({
    project: serializeProject(project),
    chapters: chapters.map(ch => ({
      idx: ch.idx, title: ch.title, wordCount: ch.wordCount, status: ch.status, isSample: ch.isSample,
      diffStatus: ch.diffStatus, hasDraft: !!ch.draftText, hasAlternate: !!ch.alternateText,
    })),
  })
})

booksGenerate.put('/generate/projects/:id/bible', async (c) => {
  const user = c.get('user')
  const project = await getOwnedProject(c.req.param('id'), user.id)
  if (!project) return c.json({ code: 'not_found' }, 404)
  if (project.status !== 'pending_bible_approval' && project.status !== 'failed') {
    return c.json({ code: 'not_editable' }, 409)
  }
  const body = await c.req.json().catch(() => null) as { storyBible?: StoryBible; outline?: ChapterOutlineEntry[] } | null
  if (!body) return c.json({ code: 'bad_request' }, 400)

  const patch: Partial<typeof bookProjects.$inferInsert> = { updatedAt: new Date() }
  if (body.storyBible) patch.storyBibleJson = JSON.stringify(body.storyBible)
  if (body.outline) patch.outlineJson = JSON.stringify(body.outline)
  if (project.status === 'failed') patch.status = 'pending_bible_approval'
  await db.update(bookProjects).set(patch).where(eq(bookProjects.id, project.id))
  return c.json({ ok: true })
})

booksGenerate.post('/generate/projects/:id/approve-bible', async (c) => {
  const user = c.get('user')
  const project = await getOwnedProject(c.req.param('id'), user.id)
  if (!project) return c.json({ code: 'not_found' }, 404)
  if (project.status !== 'pending_bible_approval') return c.json({ code: 'wrong_status' }, 409)

  const { jobId } = await enqueueBookGenerateRun({
    projectId: project.id, userId: user.id, startIdx: 0, endIdx: 1,
    isSampleRun: true, commitOnComplete: false, label: `Sample chapter: ${project.title || 'Untitled'}`,
  })
  return c.json({ ok: true, jobId })
})

booksGenerate.post('/generate/projects/:id/regenerate-sample', async (c) => {
  const user = c.get('user')
  const project = await getOwnedProject(c.req.param('id'), user.id)
  if (!project) return c.json({ code: 'not_found' }, 404)
  if (!['pending_sample_approval', 'pending_sample', 'failed'].includes(project.status)) return c.json({ code: 'wrong_status' }, 409)

  const { jobId } = await enqueueBookGenerateRun({
    projectId: project.id, userId: user.id, startIdx: 0, endIdx: 1,
    isSampleRun: true, commitOnComplete: false, label: `Sample chapter: ${project.title || 'Untitled'}`,
  })
  return c.json({ ok: true, jobId })
})

booksGenerate.post('/generate/projects/:id/approve-sample', async (c) => {
  const user = c.get('user')
  const project = await getOwnedProject(c.req.param('id'), user.id)
  if (!project) return c.json({ code: 'not_found' }, 404)
  if (project.status !== 'pending_sample_approval') return c.json({ code: 'wrong_status' }, 409)
  if (!project.outlineJson) return c.json({ code: 'no_outline' }, 409)
  const outline = JSON.parse(project.outlineJson) as ChapterOutlineEntry[]

  // A single-chapter book has nothing left to generate after the sample — commit directly.
  if (outline.length <= 1) {
    await commitProjectToBook(project.id)
    return c.json({ ok: true, committed: true })
  }

  const { jobId } = await enqueueBookGenerateRun({
    projectId: project.id, userId: user.id, startIdx: 1, endIdx: outline.length,
    isSampleRun: false, commitOnComplete: true, label: `Writing: ${project.title || 'Untitled'}`,
  })
  return c.json({ ok: true, jobId })
})

booksGenerate.post('/generate/projects/:id/reject', async (c) => {
  const user = c.get('user')
  const project = await getOwnedProject(c.req.param('id'), user.id)
  if (!project) return c.json({ code: 'not_found' }, 404)
  if (project.status === 'completed') return c.json({ code: 'already_completed' }, 409)
  await db.update(bookProjects).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(bookProjects.id, project.id))
  return c.json({ ok: true })
})

booksGenerate.get('/generate/projects/:id/status', async (c) => {
  const user = c.get('user')
  const project = await getOwnedProject(c.req.param('id'), user.id)
  if (!project) return c.json({ code: 'not_found' }, 404)

  let job: typeof downloadJobs.$inferSelect | null = null
  if (project.jobId) {
    const [row] = await db.select().from(downloadJobs).where(eq(downloadJobs.id, project.jobId)).limit(1)
    job = row ?? null
  }
  const outline = project.outlineJson ? JSON.parse(project.outlineJson) as ChapterOutlineEntry[] : []
  return c.json({
    status: project.status, error: project.error,
    currentChapterIdx: project.currentChapterIdx, totalChapters: outline.length,
    resultBookId: project.resultBookId,
    job: job ? { status: job.status, progress: job.progress ? JSON.parse(job.progress) : null, lastError: job.lastError } : null,
  })
})

booksGenerate.get('/generate/projects/:id/chapters/:idx', async (c) => {
  const user = c.get('user')
  const project = await getOwnedProject(c.req.param('id'), user.id)
  if (!project) return c.json({ code: 'not_found' }, 404)
  const idx = parseInt(c.req.param('idx'), 10)
  const [chapter] = await db.select().from(bookProjectChapters)
    .where(and(eq(bookProjectChapters.projectId, project.id), eq(bookProjectChapters.idx, idx))).limit(1)
  if (!chapter) return c.json({ code: 'not_found' }, 404)
  return c.json({ chapter })
})

booksGenerate.post('/generate/projects/:id/chapters/:idx/regenerate', async (c) => {
  const user = c.get('user')
  const project = await getOwnedProject(c.req.param('id'), user.id)
  if (!project) return c.json({ code: 'not_found' }, 404)
  const idx = parseInt(c.req.param('idx'), 10)
  if (!Number.isInteger(idx) || idx < 0) return c.json({ code: 'bad_idx' }, 400)

  const { jobId } = await enqueueBookGenerateRun({
    projectId: project.id, userId: user.id, startIdx: idx, endIdx: idx + 1,
    isSampleRun: idx === 0 && project.status !== 'completed', commitOnComplete: false,
    label: `Regenerating chapter ${idx + 1}: ${project.title || 'Untitled'}`,
  })
  return c.json({ ok: true, jobId })
})

booksGenerate.post('/generate/projects/:id/commit', async (c) => {
  const user = c.get('user')
  const project = await getOwnedProject(c.req.param('id'), user.id)
  if (!project) return c.json({ code: 'not_found' }, 404)
  try {
    const { bookId } = await commitProjectToBook(project.id)
    return c.json({ ok: true, bookId })
  } catch (err) {
    return c.json({ code: 'commit_failed', error: String((err as Error)?.message ?? err) }, 400)
  }
})

booksGenerate.delete('/generate/projects/:id', async (c) => {
  const user = c.get('user')
  const project = await getOwnedProject(c.req.param('id'), user.id)
  if (!project) return c.json({ code: 'not_found' }, 404)
  await db.delete(bookProjects).where(eq(bookProjects.id, project.id))
  return c.json({ ok: true })
})
