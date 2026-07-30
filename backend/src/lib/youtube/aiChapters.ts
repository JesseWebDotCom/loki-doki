// AI chapters for videos whose creator never added any: build a timestamped digest of
// the caption track, ask the fast model for a chapter list, and cache it hard. Serving
// is split from generation so request paths never block on the LLM: the chapters route
// answers instantly from cache (or kicks a background build), and clients simply see
// chapters appear on a later fetch.

import { readFile } from 'node:fs/promises'
import { ensureTranscript } from '@/lib/youtube/download'
import { ollamaChat } from '@/llm/ollama'
import { getFastModel } from '@/lib/models'
import { cachedLookupStale, cachedLookupPut, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import { logger } from '@/lib/logger'

export interface AiChapter { start: number; title: string }

// v2: v1 accepted clustered timestamps (models echoing minute numbers as seconds
// produced a chapter every few seconds - real feedback). Bumping the namespace
// throws away every cached v1 list.
const NAMESPACE = 'yt-ai-chapters-v2'
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

  const digest = timedDigest(cues)
  const model = await getFastModel()
  const result = await ollamaChat(model, [
    { role: 'system', content: CHAPTERS_SYSTEM },
    { role: 'user', content: digest },
  ], undefined, { temperature: 0.2, num_predict: 500 })
  const first = parseChapterJson(result.message.content, lastSec)
  if (first) return first

  // One corrective retry: point at the exact failure mode (bad units or
  // clustered stamps) before giving up. The raw output is logged so a
  // persistent rejection is diagnosable from /api/logs/recent.
  logger.warn({ videoId, lastSec, raw: result.message.content.slice(0, 300) },
    'yt ai chapters: rejected, retrying once')
  const retry = await ollamaChat(model, [
    { role: 'system', content: CHAPTERS_SYSTEM },
    { role: 'user', content: digest },
    { role: 'assistant', content: result.message.content.slice(0, 1200) },
    { role: 'user', content:
      `Those timestamps were invalid. The video is ${Math.round(lastSec)} seconds long; chapter ` +
      '"t" values must be TOTAL SECONDS spread across that whole runtime (convert [12:30] to 750), ' +
      'with consecutive chapters minutes apart. Respond with only the corrected JSON array.' },
  ], undefined, { temperature: 0.1, num_predict: 500 })
  return parseChapterJson(retry.message.content, lastSec)
}
