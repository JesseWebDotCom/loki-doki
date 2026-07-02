// Condense a YouTube transcript into a third-person brief for the podcast hosts to
// DISCUSS — an overall premise plus the video's major beats in order, each beat carrying
// CONCRETE supporting details. The details are what keep episodes substantive: a beat list
// alone ("they review the movie") leaves the script model ~200 words of material to stretch
// over a 10+ minute episode, and it fills the gap with invented facts and content-free
// waffle about the creator's "mission". Specific moments, opinions, names, and numbers from
// the actual transcript give the hosts real things to react to.
//
// We cover the WHOLE transcript, not just the head: a long video won't fit a local model's
// context window in one shot (and a single big call would silently drop the END — the
// final-thoughts part of the arc). So we map-reduce — summarize each chunk's beats, then
// combine them into one ordered arc. Short videos take a single pass.

import { getFastModel, getScriptModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'

export interface VideoBeat {
  /** One short third-person sentence: the big move/turning point. */
  point: string
  /** 2-4 concrete supporting details from the transcript: specific moments, what the
   *  creator actually said/thought, names, numbers. Third person. */
  details: string[]
}

export interface VideoBrief {
  /** One or two third-person sentences: what the video is about overall. */
  premise: string
  /** The major arc of the video, in order — big moves with concrete detail. */
  beats: VideoBeat[]
}

// Per-chunk character budget — comfortably inside the fast model's context with room for
// the instructions and output. Chunk count is capped (maxChunks) so very long videos use
// bigger chunks rather than unbounded calls; the whole transcript is always covered.
const CHUNK_CHARS = 7_000

function splitChunks(text: string, maxChunks: number): string[] {
  const n = Math.min(Math.max(1, maxChunks), Math.max(1, Math.ceil(text.length / CHUNK_CHARS)))
  if (n === 1) return [text]
  const size = Math.ceil(text.length / n)
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(text.slice(i * size, (i + 1) * size))
  return out
}

const J = (s: string) => s.match(/\{[\s\S]*\}/)?.[0]
const A = (s: string) => s.match(/\[[\s\S]*\]/)?.[0]
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter(x => typeof x === 'string').map(x => (x as string).trim()).filter(Boolean) : []

/** Coerce a parsed beats field into VideoBeat[]; accepts plain strings for resilience. */
function coerceBeats(v: unknown, cap = 8): VideoBeat[] {
  if (!Array.isArray(v)) return []
  const out: VideoBeat[] = []
  for (const b of v) {
    if (typeof b === 'string' && b.trim()) {
      out.push({ point: b.trim(), details: [] })
    } else if (b && typeof b === 'object') {
      const point = typeof (b as Record<string, unknown>).point === 'string' ? ((b as Record<string, unknown>).point as string).trim() : ''
      if (point) out.push({ point, details: strs((b as Record<string, unknown>).details).slice(0, 4) })
    }
    if (out.length >= cap) break
  }
  return out
}

const BEAT_SHAPE =
  '"beats": 4 to 8 objects capturing the MAJOR arc IN ORDER, each ' +
  '{"point":"<one short third-person sentence — the big move>","details":["<2-4 concrete specifics from the ' +
  'transcript backing this beat: the exact things shown or done, what the creator actually said or thought about ' +
  'it (their real opinions and jokes), names, numbers>"]}. Details must come FROM THE TRANSCRIPT — never invent, ' +
  'never pad with generalities.'

/** One-pass: short transcript → premise + detailed ordered beats in a single call. */
async function singlePass(title: string, author: string | undefined, text: string): Promise<VideoBrief | null> {
  const SYSTEM =
    'You summarize a YouTube video for podcast hosts who will DISCUSS it (they did NOT make it). From the ' +
    'transcript produce JSON with two fields. "premise": one or two plain sentences, THIRD PERSON, saying what the ' +
    'video is about overall — name the creator/channel explicitly (use the author/channel given in the title), ' +
    'NEVER first person ("I"/"we"). ' +
    BEAT_SHAPE +
    ' Return ONLY JSON: {"premise":"...","beats":[{"point":"...","details":["..."]}]}.'
  try {
    // The brief is the foundation the whole episode stands on — use the script-quality
    // model here rather than the small router model.
    const model = await getScriptModel()
    const resp = await ollamaChat(model, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Title: "${title}"${author ? ` by ${author}` : ''}\n\nTranscript:\n${text}` },
    ], undefined, { temperature: 0.4, num_ctx: 8192, num_predict: 1200 })
    const j = J(resp.message?.content ?? '')
    if (!j) return null
    const p = JSON.parse(j) as { premise?: unknown; beats?: unknown }
    const premise = typeof p.premise === 'string' ? p.premise.trim() : ''
    const beats = coerceBeats(p.beats)
    return premise || beats.length ? { premise, beats } : null
  } catch {
    return null
  }
}

/** Map step: the key beats (with concrete specifics) within one chunk of a longer transcript. */
async function chunkBeats(title: string, author: string | undefined, chunk: string, idx: number, total: number): Promise<string[]> {
  const SYSTEM =
    `You are summarizing PART ${idx} of ${total} of a YouTube video transcript for podcast hosts who will discuss ` +
    'it. List the key things that happen in THIS part as short THIRD-PERSON bullets (the creator does X; never ' +
    'first person). Make each bullet CONCRETE: include the specific thing shown or done and what the creator ' +
    'actually said or thought about it — real opinions, jokes, names, numbers from the transcript, not vague ' +
    'summaries. Keep them in order. Return ONLY a JSON array of strings.'
  try {
    const model = await getFastModel()
    const resp = await ollamaChat(model, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Title: "${title}"${author ? ` by ${author}` : ''}\n\nPart ${idx}/${total}:\n${chunk}` },
    ], undefined, { temperature: 0.3, num_ctx: 8192, num_predict: 600 })
    return strs(A(resp.message?.content ?? '') ? JSON.parse(A(resp.message?.content ?? '')!) : [])
  } catch {
    return []
  }
}

/** Reduce step: fold all chunk bullets into one clean premise + detailed ordered arc. */
async function reduceBeats(title: string, author: string | undefined, bullets: string[]): Promise<VideoBrief | null> {
  const SYSTEM =
    'You are given an ordered list of raw bullets spanning a whole YouTube video, for podcast hosts who will ' +
    'discuss it. Produce JSON: "premise" (one or two THIRD-PERSON sentences on what the video is about overall; ' +
    'never first person) and ' + BEAT_SHAPE.replace('FROM THE TRANSCRIPT', 'FROM THE BULLETS') +
    ' Group the raw bullets into beats, KEEPING their concrete specifics as the details — merge duplicates, drop ' +
    'only true trivia. Return ONLY JSON: {"premise":"...","beats":[{"point":"...","details":["..."]}]}.'
  const rawFallback = (): VideoBrief => ({ premise: '', beats: coerceBeats(bullets, 8) })
  try {
    const model = await getScriptModel()
    const resp = await ollamaChat(model, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Title: "${title}"${author ? ` by ${author}` : ''}\n\nRaw bullets, in order:\n- ${bullets.join('\n- ')}` },
    ], undefined, { temperature: 0.4, num_ctx: 8192, num_predict: 1200 })
    const j = J(resp.message?.content ?? '')
    if (!j) return rawFallback()
    const p = JSON.parse(j) as { premise?: unknown; beats?: unknown }
    const premise = typeof p.premise === 'string' ? p.premise.trim() : ''
    const beats = coerceBeats(p.beats)
    return { premise, beats: beats.length ? beats : rawFallback().beats }
  } catch {
    return rawFallback()
  }
}

/**
 * Summarize the ENTIRE transcript into a premise + ordered arc with concrete per-beat
 * details. Single pass for short videos; chunked map-reduce for long ones so the end of
 * the video is never dropped. `maxChunks` bounds the work for multi-video episodes.
 * Best-effort — null on failure so the caller can fall back to a raw transcript excerpt.
 */
export async function summarizeVideo(
  title: string,
  author: string | undefined,
  transcript: string,
  maxChunks = 6,
): Promise<VideoBrief | null> {
  const text = transcript.trim()
  if (!text) return null

  const chunks = splitChunks(text, maxChunks)
  if (chunks.length === 1) return singlePass(title, author, chunks[0]!)

  const collected: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    collected.push(...await chunkBeats(title, author, chunks[i]!, i + 1, chunks.length))
  }
  if (!collected.length) return null
  return reduceBeats(title, author, collected)
}
