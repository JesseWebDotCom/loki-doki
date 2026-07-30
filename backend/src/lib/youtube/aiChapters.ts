// AI chapters for videos whose creator never added any: build a timestamped digest of
// the caption track, ask the fast model for a chapter list, and cache it hard. Serving
// is split from generation so request paths never block on the LLM: the chapters route
// answers instantly from cache (or kicks a background build), and clients simply see
// chapters appear on a later fetch.

import { readFile } from 'node:fs/promises'
import { ensureTranscript } from '@/lib/youtube/download'
import { ollamaChat } from '@/llm/ollama'
import { embed, cosineSimilarity } from '@/llm/embed'
import { getFastModel } from '@/lib/models'
import { cachedLookupStale, cachedLookupPut, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import { logger } from '@/lib/logger'

export interface AiChapter { start: number; title: string }

// v3: boundaries now come from embedding topic segmentation instead of LLM-invented
// timestamps (v1 clustered chapters every few seconds; v2's prompt fix produced
// suspiciously uniform spacing). Each bump discards the previous generation's cache.
const NAMESPACE = 'yt-ai-chapters-v3'
// A negative result (no captions, LLM garbage) retries sooner than a good one: captions
// often appear hours after upload, and a flaky model run should not blank a video for a month.
const MISS_TTL_MS = 6 * 60 * 60 * 1000

const CHAPTERS_SYSTEM =
  'You segment a video into chapters from its timestamped transcript. Transcript lines are ' +
  'stamped [minutes:seconds]. Respond with ONLY a JSON array, no prose, no code fences: ' +
  '[{"t": <start in TOTAL SECONDS as integer>, "title": "<2-6 word title>"}, ...]. Convert ' +
  'stamps to total seconds: a line stamped [12:30] starts at t 750, never t 12. Rules: 4 to ' +
  '10 chapters covering the whole runtime, so consecutive chapters are normally MINUTES apart, ' +
  'never seconds apart; the first chapter starts at t 0; timestamps strictly ascending; titles ' +
  'are plain, specific, sentence case, in English, and never clickbait; a chapter marks a ' +
  'genuine topic shift, not every paragraph. The transcript may be auto-generated and messy; ' +
  'segment whatever is present.'

export interface Cue { start: number; text: string }

/** Parse VTT into deduped cues. Auto-generated tracks repeat rolling lines, so consecutive
 *  duplicate text is collapsed onto the first cue that carried it. */
export function parseVttCues(vtt: string): Cue[] {
  const cues: Cue[] = []
  const blocks = vtt.split(/\r?\n\r?\n/)
  for (const block of blocks) {
    const m = block.match(/(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->/) ??
              block.match(/(\d{1,2}):(\d{2})[.,](\d{3})\s*-->/)
    if (!m) continue
    const start = m.length === 5
      ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
      : Number(m[1]) * 60 + Number(m[2])
    const text = block
      .split(/\r?\n/)
      .filter(l => !l.includes('-->') && !/^WEBVTT|^Kind:|^Language:|^NOTE/.test(l))
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    const prev = cues[cues.length - 1]
    if (prev && (prev.text === text || text.startsWith(prev.text) || prev.text.endsWith(text))) {
      if (text.length > prev.text.length) prev.text = text
      continue
    }
    cues.push({ start, text })
  }
  return cues
}

/** Collapse cues into [m:ss]-stamped blocks and evenly sample them into the char budget,
 *  so a 3-hour video still contributes context from its whole runtime, not just the intro. */
export function timedDigest(cues: Cue[], budget = 13_000): string {
  const BLOCK_SEC = 25
  const blocks: { start: number; text: string }[] = []
  for (const cue of cues) {
    const last = blocks[blocks.length - 1]
    if (last && cue.start - last.start < BLOCK_SEC) last.text += ' ' + cue.text
    else blocks.push({ start: cue.start, text: cue.text })
  }
  const stamp = (s: number) => `[${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}]`
  let lines = blocks.map(b => `${stamp(b.start)} ${b.text}`)
  let total = lines.reduce((n, l) => n + l.length + 1, 0)
  if (total > budget) {
    const keep = Math.max(8, Math.floor(lines.length * (budget / total)))
    const stride = lines.length / keep
    lines = Array.from({ length: keep }, (_, i) => lines[Math.floor(i * stride)]!)
  }
  return lines.join('\n').slice(0, budget)
}

function parseChapterJson(raw: string, runtimeSec: number): AiChapter[] | null {
  const m = raw.match(/\[[\s\S]*\]/)
  if (!m) return null
  let parsed: unknown
  try { parsed = JSON.parse(m[0]) } catch { return null }
  if (!Array.isArray(parsed)) return null
  let out: AiChapter[] = []
  for (const item of parsed) {
    const t = Number((item as any)?.t ?? (item as any)?.start)
    const title = String((item as any)?.title ?? '').trim()
    if (!Number.isFinite(t) || t < 0 || !title) continue
    out.push({ start: Math.round(t), title: title.slice(0, 80) })
  }
  out.sort((a, b) => a.start - b.start)

  // Wrong-units rescue: small models sometimes echo the [m:ss] minute as the
  // seconds value, cramming every chapter into the first sliver of the runtime
  // ("a chapter every few seconds" - real feedback). If the whole list fits in
  // a tiny fraction of the video but scales cleanly by 60, it was minutes.
  const last = out[out.length - 1]?.start ?? 0
  if (out.length >= 3 && last > 0 && last < runtimeSec * 0.15 && last * 60 <= runtimeSec + 120) {
    out = out.map((c) => ({ ...c, start: c.start * 60 }))
  }

  // A chapter list is only useful when it spans the video with real spacing:
  // enforce a minimum gap (chapters are minutes apart, not paragraphs) and
  // require coverage of at least a third of the runtime.
  const minGap = Math.max(45, Math.floor(runtimeSec / 40))
  const spaced: AiChapter[] = []
  for (const c of out) {
    const prev = spaced[spaced.length - 1]
    if (prev && c.start - prev.start < minGap) continue
    if (c.start > runtimeSec + 60) continue
    spaced.push(c)
  }
  if (spaced.length < 3) return null
  if ((spaced[spaced.length - 1]?.start ?? 0) < runtimeSec * 0.33) return null
  if (spaced[0]!.start > 0) spaced[0] = { ...spaced[0]!, start: 0 }
  return spaced.slice(0, 12)
}

const _inFlight = new Set<string>()

/** Cached AI chapters if a build already ran; undefined when no attempt is recorded yet. */
export async function peekAiChapters(videoId: string): Promise<AiChapter[] | null | undefined> {
  const { value, fresh } = await cachedLookupStale<AiChapter[] | null>(NAMESPACE, videoId)
  if (value === undefined) return undefined
  // An expired miss is treated as "never tried" so the caller re-kicks a build; an
  // expired HIT keeps serving (chapters do not go stale, the TTL just bounds the row).
  if (!fresh && (value === null || value.length === 0)) return undefined
  return value
}

/** Fire-and-forget build, coalesced per video. Safe to call on every chapters request. */
export function kickAiChapters(videoId: string, userId: string, firstName: string): void {
  if (_inFlight.has(videoId)) return
  _inFlight.add(videoId)
  void (async () => {
    try {
      const chapters = await buildAiChapters(videoId, userId, firstName)
      await cachedLookupPut(NAMESPACE, videoId, chapters ? THIRTY_DAYS_MS : MISS_TTL_MS, chapters)
      logger.info({ videoId, count: chapters?.length ?? 0 }, 'yt ai chapters: cached')
    } catch (err) {
      logger.warn({ videoId, err }, 'yt ai chapters: build failed')
    } finally {
      _inFlight.delete(videoId)
    }
  })()
}

async function buildAiChapters(videoId: string, userId: string, firstName: string): Promise<AiChapter[] | null> {
  const absPath = await ensureTranscript(videoId, userId, firstName)
  if (!absPath) return null
  const cues = parseVttCues(await readFile(absPath, 'utf-8'))
  if (cues.length < 12) return null
  const lastSec = cues[cues.length - 1]!.start
  if (lastSec < 240) return null // short videos do not need chapters

  // Boundary detection is TextTiling over embeddings (how Panopto-class systems
  // chapter): the transcript is chunked, each chunk embedded, and a boundary is a
  // valley in the similarity between the windows before and after it. The LLM never
  // picks timestamps (it kept echoing minute numbers as seconds); it only titles the
  // segments the math found. Falls back to the prompt path if the embed model is out.
  try {
    const segmented = await segmentByEmbeddings(cues, lastSec)
    if (segmented) return await titleSegments(segmented, lastSec)
  } catch (err) {
    logger.warn({ videoId, err }, 'yt ai chapters: embedding segmentation failed, falling back')
  }

  const digest = timedDigest(cues)
  const model = await getFastModel()
  const result = await ollamaChat(model, [
    { role: 'system', content: CHAPTERS_SYSTEM },
    { role: 'user', content: digest },
  ], undefined, { temperature: 0.2, num_predict: 500 })
  return parseChapterJson(result.message.content, lastSec)
}

interface Segment { start: number; text: string }

/** Chunk cues into ~30s blocks (grown for long videos so we embed at most ~110). */
function blocksForEmbedding(cues: Cue[], lastSec: number): Segment[] {
  const blockSec = Math.max(30, Math.ceil(lastSec / 110 / 5) * 5)
  const blocks: Segment[] = []
  for (const cue of cues) {
    const last = blocks[blocks.length - 1]
    if (last && cue.start - last.start < blockSec) last.text += ' ' + cue.text
    else blocks.push({ start: cue.start, text: cue.text })
  }
  return blocks
}

/**
 * TextTiling: similarity between the mean vectors of the W blocks on each side of
 * every candidate boundary; a boundary's depth is how far its valley sits below the
 * nearest peaks on both sides. Deep valleys = real topic shifts. Chapter count and
 * spacing scale with runtime, except near the edges where short intro/outro chapters
 * are legitimate (real feedback: spread out mostly, but intros and outros run short).
 */
async function segmentByEmbeddings(cues: Cue[], lastSec: number): Promise<Segment[] | null> {
  const blocks = blocksForEmbedding(cues, lastSec)
  if (blocks.length < 8) return null

  const vectors: number[][] = []
  for (const b of blocks) vectors.push(await embed(b.text.slice(0, 1500)))

  const W = 3
  const mean = (from: number, to: number): number[] => {
    const out = new Array(vectors[0]!.length).fill(0)
    let n = 0
    for (let i = Math.max(0, from); i < Math.min(vectors.length, to); i++) {
      const v = vectors[i]!
      for (let d = 0; d < out.length; d++) out[d] += v[d]!
      n++
    }
    for (let d = 0; d < out.length; d++) out[d] /= Math.max(1, n)
    return out
  }

  const sims: number[] = []
  for (let i = 1; i < blocks.length; i++) {
    sims[i] = cosineSimilarity(mean(i - W, i), mean(i, i + W))
  }

  const depth = (i: number): number => {
    let l = sims[i]!
    for (let j = i - 1; j >= 1 && sims[j]! >= l; j--) l = sims[j]!
    let r = sims[i]!
    for (let j = i + 1; j < blocks.length && sims[j]! >= r; j++) r = sims[j]!
    return (l - sims[i]!) + (r - sims[i]!)
  }

  const candidates = []
  for (let i = 1; i < blocks.length; i++) candidates.push({ i, score: depth(i) })
  candidates.sort((a, b) => b.score - a.score)

  // One chapter per ~5-6 minutes, clamped to a sane range.
  const targetChapters = Math.min(12, Math.max(4, Math.round(lastSec / 330)))
  const interiorGap = Math.max(60, Math.floor(lastSec / (targetChapters * 2)))
  const edgeGap = 20 // intros and outros are allowed to run short
  const accepted: number[] = []
  for (const c of candidates) {
    if (accepted.length >= targetChapters - 1) break
    if (c.score <= 0.005) continue // flat ground, not a valley
    const t = blocks[c.i]!.start
    const nearEdge = t < 150 || t > lastSec - 150
    const gap = nearEdge ? edgeGap : interiorGap
    if (t < edgeGap || t > lastSec - edgeGap) continue
    if (accepted.some((a) => Math.abs(blocks[a]!.start - t) < gap)) continue
    accepted.push(c.i)
  }
  if (accepted.length < 2) return null

  accepted.sort((a, b) => a - b)
  const starts = [0, ...accepted]
  return starts.map((blockIdx, s) => {
    const end = starts[s + 1] ?? blocks.length
    const text = blocks.slice(blockIdx === 0 ? 0 : blockIdx, end === blocks.length ? blocks.length : end)
      .map((b) => b.text).join(' ')
    return { start: blockIdx === 0 ? 0 : blocks[blockIdx]!.start, text }
  })
}

/** One LLM call to title the segments the math found; timestamps never touch the model. */
async function titleSegments(segments: Segment[], lastSec: number): Promise<AiChapter[]> {
  const model = await getFastModel()
  const numbered = segments
    .map((s, i) => `${i + 1}. ${s.text.slice(0, 550)}`)
    .join('\n\n')
  const result = await ollamaChat(model, [
    { role: 'system', content:
      'You title the chapters of a video. You are given each chapter\'s transcript text, ' +
      `numbered 1 to ${segments.length}. Respond with ONLY a JSON array of exactly ` +
      `${segments.length} strings, in order: the chapter titles. Each title is 2-6 plain, ` +
      'specific, sentence-case English words describing that section. Never clickbait, no ' +
      'numbering, no quotes inside titles.' },
    { role: 'user', content: numbered },
  ], undefined, { temperature: 0.2, num_predict: 400 })

  let titles: string[] = []
  const m = result.message.content.match(/\[[\s\S]*\]/)
  if (m) {
    try {
      const parsed = JSON.parse(m[0])
      if (Array.isArray(parsed)) titles = parsed.map((t) => String(t).trim().slice(0, 80))
    } catch { /* fall through to generic titles */ }
  }
  return segments.map((s, i) => ({
    start: Math.round(s.start),
    title: titles[i] || (i === 0 ? 'Introduction'
      : s.start > lastSec - 180 ? 'Wrapping up' : `Part ${i + 1}`),
  }))
}
