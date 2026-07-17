// Ask-the-video: conversational Q&A over the current video's transcript, grounded and
// cited. Excerpts come from the semantic index when the video is already embedded
// (question-relevant chunks win), else fresh VTT chunks; the model must cite moments as
// [t=<seconds>] tokens, which the watch panel renders as seek chips. All local:
// same Ollama chat stack as summaries, nothing leaves the house.

import { and, eq } from 'drizzle-orm'
import { readFile } from 'node:fs/promises'
import { db } from '@/db'
import { videoEmbeddings } from '@/db/schema'
import { ollamaChat } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import { embed, cachedVector, cosineSimilarity } from '@/llm/embed'
import { ensureTranscript } from '@/lib/youtube/download'
import { resolveVideoVtt } from '@/lib/podcast/transcript'
import { parseVttCues, chunkCues, ensureVideoIndexed } from '@/lib/videos/semanticIndex'
import { logger } from '@/lib/logger'

export interface AskTurn { role: 'user' | 'assistant'; content: string }

interface Excerpt { startSec: number | null; text: string }

const MAX_EXCERPTS = 10

async function relevantExcerpts(
  source: string, videoId: string, question: string,
  userId: string, userFirstName: string, url: string | null,
): Promise<Excerpt[]> {
  // Preferred: indexed chunks ranked against the question.
  const rows = await db.select().from(videoEmbeddings)
    .where(and(eq(videoEmbeddings.source, source), eq(videoEmbeddings.videoId, videoId)))
  const chunks = rows.filter((r) => r.segment >= 0)
  if (chunks.length > 0) {
    try {
      const qVec = await embed(question)
      const scored = chunks
        .map((r) => ({ r, score: cachedVector(`${r.id}:${r.updatedAt.getTime()}`, r.embedding) ? cosineSimilarity(qVec, cachedVector(`${r.id}:${r.updatedAt.getTime()}`, r.embedding)!) : -1 }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_EXCERPTS)
        .sort((a, b) => (a.r.startSec ?? 0) - (b.r.startSec ?? 0))
      if (scored.length) return scored.map((x) => ({ startSec: x.r.startSec, text: x.r.text }))
    } catch { /* embedding down: fall through to raw chunks */ }
    return chunks.slice(0, MAX_EXCERPTS).map((r) => ({ startSec: r.startSec, text: r.text }))
  }

  // Not indexed yet: parse the VTT fresh (and kick indexing off for next time).
  ensureVideoIndexed(source, videoId, { userId, userFirstName, url })
  let vtt: string | null = null
  try {
    if (source === 'youtube') {
      const p = await ensureTranscript(videoId, userId, userFirstName)
      if (p) vtt = await readFile(p, 'utf-8').catch(() => null)
    } else {
      vtt = await resolveVideoVtt({ source, videoId, url: url ?? undefined }, userId, userFirstName)
    }
  } catch { /* caption fetch failed */ }
  if (!vtt) return []
  const all = chunkCues(parseVttCues(vtt))
  if (all.length <= MAX_EXCERPTS + 4) return all.map((ch) => ({ startSec: Math.floor(ch.start), text: ch.text.slice(0, 500) }))
  // Evenly sample long videos so the answer at least knows the shape of the whole thing.
  const step = all.length / (MAX_EXCERPTS + 4)
  const picked: Excerpt[] = []
  for (let i = 0; i < all.length; i += step) {
    const ch = all[Math.floor(i)]!
    picked.push({ startSec: Math.floor(ch.start), text: ch.text.slice(0, 500) })
  }
  return picked
}

export async function askVideo(opts: {
  source: string
  videoId: string
  question: string
  history: AskTurn[]
  title: string | null
  creatorName: string | null
  url: string | null
  userId: string
  userFirstName: string
}): Promise<{ answer: string; grounded: boolean } | null> {
  const question = opts.question.trim().slice(0, 500)
  if (question.length < 2) return null
  const excerpts = await relevantExcerpts(opts.source, opts.videoId, question, opts.userId, opts.userFirstName, opts.url)

  const header = `Video: ${opts.title ?? opts.videoId}${opts.creatorName ? ` (by ${opts.creatorName})` : ''}`
  const body = excerpts.length
    ? excerpts.map((e) => `[t=${e.startSec ?? 0}] ${e.text}`).join('\n')
    : '(no transcript is available for this video)'

  try {
    const model = await getModel()
    const res = await ollamaChat(
      model,
      [
        {
          role: 'system',
          content:
            'You answer questions about one specific video for a family member, using ONLY the transcript excerpts provided. ' +
            'Each excerpt starts with its start time as [t=<seconds>]. When your answer draws on a moment, cite it inline with that exact token, e.g. "they explain the seal at [t=312]". ' +
            'If the excerpts do not contain the answer, say so briefly rather than guessing. ' +
            'Keep answers short, warm, and conversational. Explain simply if the question sounds like it comes from a child.',
        },
        ...opts.history.slice(-6).map((t) => ({ role: t.role, content: t.content.slice(0, 1000) })),
        { role: 'user', content: `${header}\n\nTranscript excerpts:\n${body}\n\nQuestion: ${question}` },
      ],
      undefined,
      { temperature: 0.3, num_predict: 500 },
      undefined,
      45_000,
    )
    const answer = res.message.content?.trim()
    if (!answer) return null
    return { answer, grounded: excerpts.length > 0 }
  } catch (err) {
    logger.debug(`[videos/ask] failed for ${opts.source}:${opts.videoId}: ${String(err)}`)
    return null
  }
}
