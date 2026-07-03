// One-off manual verification of the AI book creation flow (Phase 1: write a book from
// scratch). Mints a temp admin session directly in the DB (mirrors chat-e2e.ts) and drives
// the real HTTP routes end to end: create -> approve bible -> approve sample -> commit.
// Not a regression eval — delete after use, or keep as a manual smoke-test script.
import { randomBytes } from 'node:crypto'
import { db } from '@/db'
import { sessions, users } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { hashSessionToken } from '@/lib/session'

const BASE = process.env.EVAL_BASE_URL ?? 'http://localhost:3000'

const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1)
if (!admin) throw new Error('no admin user')

const token = randomBytes(32).toString('hex')
const sessionId = crypto.randomUUID()
await db.insert(sessions).values({
  id: sessionId, userId: admin.id, tokenHash: hashSessionToken(token),
  expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000), createdAt: new Date(),
})
const cleanup = async () => { await db.delete(sessions).where(eq(sessions.id, sessionId)) }

const headers = { 'content-type': 'application/json', cookie: `session=${token}` }
async function req(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${BASE}${path}`, { ...opts, headers: { ...headers, ...(opts.headers ?? {}) } })
  const body = await r.json().catch(() => null)
  if (!r.ok) throw new Error(`${opts.method ?? 'GET'} ${path} -> ${r.status}: ${JSON.stringify(body)}`)
  return body
}

async function pollStatus(id: string, target: string[], timeoutMs: number): Promise<any> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const s = await req(`/api/books/generate/projects/${id}/status`)
    console.log(`  [poll] status=${s.status} chapter=${s.currentChapterIdx}/${s.totalChapters} job=${s.job?.status ?? '-'} note=${s.job?.progress?.note ?? ''}`)
    if (target.includes(s.status)) return s
    if (s.status === 'failed') throw new Error(`Project failed: ${s.error}`)
    await new Promise((r) => setTimeout(r, 3000))
  }
  throw new Error(`Timed out waiting for status in [${target.join(',')}]`)
}

try {
  console.log('1. Creating project…')
  const { project } = await req('/api/books/generate/projects', {
    method: 'POST',
    body: JSON.stringify({
      premise: 'A retired lighthouse keeper on a remote New England island discovers a decades-old message in a bottle that reopens a mystery from her youth.',
      genre: 'Mystery', tone: 'Quiet, wistful, slow-burn', chapterCount: 3, wordsPerChapter: 500,
    }),
  })
  console.log(`   project ${project.id} status=${project.status}`)
  if (project.status === 'failed') throw new Error(`Bible generation failed: ${project.error}`)
  console.log(`   bible premise: ${project.storyBible?.premise}`)
  console.log(`   characters: ${project.storyBible?.characters?.map((c: any) => c.name).join(', ')}`)
  console.log(`   outline chapters: ${project.outline?.map((c: any) => c.title).join(' | ')}`)

  console.log('2. Approving bible -> writing sample chapter…')
  await req(`/api/books/generate/projects/${project.id}/approve-bible`, { method: 'POST' })
  await pollStatus(project.id, ['pending_sample_approval'], 3 * 60_000)

  const { chapter } = await req(`/api/books/generate/projects/${project.id}/chapters/0`)
  console.log(`3. Sample chapter "${chapter.title}" (${chapter.wordCount} words):`)
  console.log('   ' + (chapter.draftText as string).slice(0, 300).replace(/\n/g, ' ') + '…')

  console.log('4. Approving sample -> writing remaining chapters + committing…')
  const approveRes = await req(`/api/books/generate/projects/${project.id}/approve-sample`, { method: 'POST' })
  console.log(`   ${JSON.stringify(approveRes)}`)
  const finalStatus = await pollStatus(project.id, ['completed'], 6 * 60_000)
  console.log(`5. Completed! resultBookId=${finalStatus.resultBookId}`)

  const bookDetail = await req(`/api/books/${finalStatus.resultBookId}`)
  console.log(`6. Book row: title="${bookDetail.book.title}" sourceType=${bookDetail.book.sourceType} assets=${JSON.stringify(bookDetail.book.assets)}`)

  const chapters = await req(`/api/books/${finalStatus.resultBookId}/chapters`)
  console.log(`7. Chapters in final book: ${chapters.chapters.map((c: any) => `${c.title} (${c.wordCount}w, href=${c.epubHref})`).join(' | ')}`)

  console.log('\n✅ VERIFICATION PASSED')
} catch (err) {
  console.error('\n❌ VERIFICATION FAILED:', err)
  process.exitCode = 1
} finally {
  await cleanup()
}
