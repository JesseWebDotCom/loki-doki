// Ask-the-video: conversational Q&A over the current video, grounded and cited.
// Transcript excerpts come from the semantic index when the video is already embedded
// (question-relevant chunks win), else fresh VTT chunks; the model must cite moments as
// [t=<seconds>] tokens, which the watch panel renders as seek chips. Alongside the
// transcript, a channel/creator "About" blurb and the video's top comments give the model
// background the video itself never says aloud ("who is this", "what's special about
// them") — see askContext.ts. All local: same Ollama chat stack as summaries, nothing
// leaves the house except the (keyless, non-attributed) web-search fallback for About.

import { and, eq } from 'drizzle-orm'
import { readFile } from 'node:fs/promises'
import { db } from '@/db'
import { videoEmbeddings } from '@/db/schema'
import { embed, cachedVector, cosineSimilarity } from '@/llm/embed'
import { ensureTranscript } from '@/lib/youtube/download'
import { resolveVideoVtt } from '@/lib/podcast/transcript'
import { parseVttCues, chunkCues, ensureVideoIndexed } from '@/lib/videos/semanticIndex'
import { getVideoAboutBlurb, getVideoTopComments } from '@/lib/videos/askContext'

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

export const ASK_VIDEO_SYSTEM_PROMPT =
  'You answer questions about one specific video for a family member. Ground your answer in the transcript ' +
  'excerpts, the About text, and the comments below, in that order of trust. ' +
  'Each transcript excerpt starts with its start time as [t=<seconds>]. When your answer draws on a moment ' +
  'actually shown in the video, cite it inline with that exact token, e.g. "they explain the seal at [t=312]". ' +
  'The About text and comments give background the video itself may never say aloud (who the people are, why ' +
  'something is notable) — you may draw on them too, but never invent a [t=] citation for something that only ' +
  'came from About or a comment. ' +
  'If none of the material below answers the question, say so briefly rather than guessing. ' +
  'Keep answers short, warm, and conversational. Explain simply if the question sounds like it comes from a child.'

export interface AskVideoContext {
  /** The user-turn content: video header + About + comments + transcript excerpts + the question. */
  content: string
  /** True once anything beyond bare metadata backs the answer (transcript, About, or comments). */
  grounded: boolean
}

/** Build the grounded context for one question about a video. Fetches transcript
 *  excerpts, the channel/creator About blurb, and top comments in parallel — all three
 *  are independently cached or best-effort, so a slow/missing one never blocks the rest. */
export async function buildAskVideoContext(opts: {
  source: string
  videoId: string
  question: string
  title: string | null
  creatorName: string | null
  creatorId: string | null
  url: string | null
  userId: string
  userFirstName: string
}): Promise<AskVideoContext> {
  const question = opts.question.trim().slice(0, 500)
  const [excerpts, about, comments] = await Promise.all([
    relevantExcerpts(opts.source, opts.videoId, question, opts.userId, opts.userFirstName, opts.url),
    getVideoAboutBlurb(opts.source, opts.creatorId, opts.creatorName),
    getVideoTopComments(opts.source, opts.videoId),
  ])

  const header = `Video: ${opts.title ?? opts.videoId}${opts.creatorName ? ` (by ${opts.creatorName})` : ''}`
  const aboutBlock = about ? `\n\nAbout ${opts.creatorName ?? 'the creator'}: ${about}` : ''
  const commentsBlock = comments.length
    ? `\n\nTop comments:\n${comments.map((c) => `- ${c.author}: ${c.text}`).join('\n')}`
    : ''
  const transcriptBlock = excerpts.length
    ? excerpts.map((e) => `[t=${e.startSec ?? 0}] ${e.text}`).join('\n')
    : '(no transcript is available for this video)'

  return {
    content: `${header}${aboutBlock}${commentsBlock}\n\nTranscript excerpts:\n${transcriptBlock}\n\nQuestion: ${question}`,
    grounded: excerpts.length > 0 || !!about || comments.length > 0,
  }
}
