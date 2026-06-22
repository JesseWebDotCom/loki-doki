// Condense a YouTube transcript into a third-person brief for the podcast hosts to
// DISCUSS — an overall premise plus the video's major beats in order. This is what keeps
// episodes on the big picture (and in the third person): without it the hosts get a raw,
// truncated first-person transcript and end up re-enacting random early-video minutiae
// instead of walking the actual arc of the video.
//
// We cover the WHOLE transcript, not just the head: a long video won't fit a local model's
// context window in one shot (and a single big call would silently drop the END — the
// final-thoughts part of the arc). So we map-reduce — summarize each chunk's beats, then
// combine them into one ordered arc. Short videos take a single pass.

import { getFastModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'

export interface VideoBrief {
  /** One or two third-person sentences: what the video is about overall. */
  premise: string
  /** The major arc of the video, in order — the big moves, not minor asides. */
  beats: string[]
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

/** One-pass: short transcript → premise + ordered beats in a single call. */
async function singlePass(title: string, author: string | undefined, text: string): Promise<VideoBrief | null> {
  const SYSTEM =
    'You summarize a YouTube video for podcast hosts who will DISCUSS it (they did NOT make it). From the ' +
    'transcript produce JSON with two fields. "premise": one or two plain sentences, THIRD PERSON, saying what the ' +
    'video is about overall — name the creator/channel explicitly (use the author/channel given in the title), ' +
    'NEVER first person ("I"/"we"). ' +
    '"beats": 4 to 8 short bullets capturing the MAJOR arc IN ORDER (the big moves/turning points — e.g. buys it, ' +
    'first impressions, tests it, fixes it, final verdict), each one short third-person sentence. Capture the overall ' +
    'story and the significant parts; ignore trivial detail. Return ONLY JSON: {"premise":"...","beats":["..."]}.'
  try {
    const model = await getFastModel()
    const resp = await ollamaChat(model, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Title: "${title}"${author ? ` by ${author}` : ''}\n\nTranscript:\n${text}` },
    ], undefined, { temperature: 0.4, num_ctx: 8192, num_predict: 500 })
    const j = J(resp.message?.content ?? '')
    if (!j) return null
    const p = JSON.parse(j) as { premise?: unknown; beats?: unknown }
    const premise = typeof p.premise === 'string' ? p.premise.trim() : ''
    const beats = strs(p.beats).slice(0, 8)
    return premise || beats.length ? { premise, beats } : null
  } catch {
    return null
  }
}

/** Map step: the key beats within one chunk of a longer transcript. */
async function chunkBeats(title: string, author: string | undefined, chunk: string, idx: number, total: number): Promise<string[]> {
  const SYSTEM =
    `You are summarizing PART ${idx} of ${total} of a YouTube video transcript for podcast hosts who will discuss ` +
    'it. List the key things that happen in THIS part as short THIRD-PERSON bullets (the creator does X; never ' +
    'first person). Keep them in order. Return ONLY a JSON array of strings.'
  try {
    const model = await getFastModel()
    const resp = await ollamaChat(model, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Title: "${title}"${author ? ` by ${author}` : ''}\n\nPart ${idx}/${total}:\n${chunk}` },
    ], undefined, { temperature: 0.3, num_ctx: 8192, num_predict: 400 })
    return strs(A(resp.message?.content ?? '') ? JSON.parse(A(resp.message?.content ?? '')!) : [])
  } catch {
    return []
  }
}

/** Reduce step: fold all chunk beats into one clean premise + ordered arc. */
async function reduceBeats(title: string, author: string | undefined, beats: string[]): Promise<VideoBrief | null> {
  const SYSTEM =
    'You are given an ordered list of raw beats spanning a whole YouTube video, for podcast hosts who will discuss ' +
    'it. Produce JSON: "premise" (one or two THIRD-PERSON sentences on what the video is about overall; never first ' +
    'person) and "beats" (4 to 8 short third-person bullets capturing the MAJOR arc IN ORDER, merging duplicates and ' +
    'dropping trivia). Return ONLY JSON: {"premise":"...","beats":["..."]}.'
  try {
    const model = await getFastModel()
    const resp = await ollamaChat(model, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Title: "${title}"${author ? ` by ${author}` : ''}\n\nRaw beats, in order:\n- ${beats.join('\n- ')}` },
    ], undefined, { temperature: 0.4, num_ctx: 8192, num_predict: 500 })
    const j = J(resp.message?.content ?? '')
    if (!j) return { premise: '', beats: beats.slice(0, 8) }   // fall back to raw beats
    const p = JSON.parse(j) as { premise?: unknown; beats?: unknown }
    const premise = typeof p.premise === 'string' ? p.premise.trim() : ''
    const out = strs(p.beats).slice(0, 8)
    return { premise, beats: out.length ? out : beats.slice(0, 8) }
  } catch {
    return { premise: '', beats: beats.slice(0, 8) }
  }
}

/**
 * Summarize the ENTIRE transcript into a premise + ordered arc. Single pass for short
 * videos; chunked map-reduce for long ones so the end of the video is never dropped.
 * `maxChunks` bounds the work for multi-video episodes. Best-effort — null on failure so
 * the caller can fall back to a raw transcript excerpt.
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
