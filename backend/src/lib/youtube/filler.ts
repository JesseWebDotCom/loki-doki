// "Get To The Point": LLM filler detection over the caption track. SponsorBlock already
// removes sponsor reads and self-promo; this finds what crowdsourcing cannot keep up
// with - drawn-out greetings, housekeeping, repeated recaps, padded tangents - and
// serves them as skippable segments. Deliberately conservative: skipping real content
// is far worse than sitting through filler, so anything ambiguous stays.

import { readFile } from 'node:fs/promises'
import { ensureTranscript } from '@/lib/youtube/download'
import { parseVttCues, timedDigest } from '@/lib/youtube/aiChapters'
import { ollamaChat } from '@/llm/ollama'
import { getFastModel } from '@/lib/models'
import { cachedLookupStale, cachedLookupPut, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import { logger } from '@/lib/logger'

export interface FillerSegment { start: number; end: number; label: string }

const NAMESPACE = 'yt-filler'
const MISS_TTL_MS = 6 * 60 * 60 * 1000

const FILLER_SYSTEM =
  'You find skippable filler in a video from its timestamped transcript. Transcript lines are ' +
  'stamped [minutes:seconds]; convert to TOTAL SECONDS (a line stamped [12:30] is at 750). ' +
  'Respond with ONLY a ' +
  'JSON array, no prose, no code fences: [{"s": <start seconds>, "e": <end seconds>, "label": ' +
  '"<2-4 word reason>"}, ...]. Filler means content a viewer loses nothing by skipping: ' +
  'drawn-out greetings and channel housekeeping, "before we start" tangents, restating the ' +
  'intro or earlier sections of THIS video, begging for likes/subscriptions, and padding that ' +
  'repeats a point already made. It is NOT filler when the creator is teaching, demonstrating, ' +
  'story-telling, building context the rest of the video depends on, or entertaining on-topic. ' +
  'Be conservative: when unsure, do not mark it. Segments must be at least 10 seconds, use ' +
  'timestamps from the transcript, never overlap, and in total cover no more than 20 percent ' +
  'of the runtime. An empty array is a perfectly good answer.'

/** Cached filler segments if a build already ran; undefined when no attempt is recorded. */
export async function peekFiller(videoId: string): Promise<FillerSegment[] | null | undefined> {
  const { value, fresh } = await cachedLookupStale<FillerSegment[] | null>(NAMESPACE, videoId)
  if (value === undefined) return undefined
  if (!fresh && (value === null || value.length === 0)) return undefined
  return value
}

const _inFlight = new Set<string>()

/** Fire-and-forget filler analysis, coalesced per video. */
export function kickFiller(videoId: string, userId: string, firstName: string): void {
  if (_inFlight.has(videoId)) return
  _inFlight.add(videoId)
  void (async () => {
    try {
      const segments = await buildFiller(videoId, userId, firstName)
      await cachedLookupPut(NAMESPACE, videoId, segments?.length ? THIRTY_DAYS_MS : MISS_TTL_MS, segments)
      logger.info({ videoId, count: segments?.length ?? 0 }, 'yt filler: cached')
    } catch (err) {
      logger.warn({ videoId, err }, 'yt filler: build failed')
    } finally {
      _inFlight.delete(videoId)
    }
  })()
}

function parseFillerJson(raw: string, runtimeSec: number): FillerSegment[] | null {
  const m = raw.match(/\[[\s\S]*\]/)
  if (!m) return null
  let parsed: unknown
  try { parsed = JSON.parse(m[0]) } catch { return null }
  if (!Array.isArray(parsed)) return null
  const out: FillerSegment[] = []
  for (const item of parsed) {
    const s = Number((item as any)?.s ?? (item as any)?.start)
    const e = Number((item as any)?.e ?? (item as any)?.end)
    const label = String((item as any)?.label ?? 'filler').trim() || 'filler'
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue
    if (s < 0 || e <= s + 10 || e > runtimeSec + 30) continue
    out.push({ start: Math.round(s), end: Math.round(e), label: label.slice(0, 40) })
  }
  out.sort((a, b) => a.start - b.start)
  // Drop overlaps (keep the earlier segment) and enforce the 20 percent runtime cap.
  const clean: FillerSegment[] = []
  let covered = 0
  for (const seg of out) {
    const prev = clean[clean.length - 1]
    if (prev && seg.start < prev.end) continue
    if (covered + (seg.end - seg.start) > runtimeSec * 0.2) continue
    clean.push(seg)
    covered += seg.end - seg.start
  }
  return clean
}

async function buildFiller(videoId: string, userId: string, firstName: string): Promise<FillerSegment[] | null> {
  const absPath = await ensureTranscript(videoId, userId, firstName)
  if (!absPath) return null
  const cues = parseVttCues(await readFile(absPath, 'utf-8'))
  if (cues.length < 12) return null
  const runtimeSec = cues[cues.length - 1]!.start
  if (runtimeSec < 180) return null // nothing worth trimming in a short video

  const digest = timedDigest(cues)
  const model = await getFastModel()
  const result = await ollamaChat(model, [
    { role: 'system', content: FILLER_SYSTEM },
    { role: 'user', content: digest },
  ], undefined, { temperature: 0.1, num_predict: 500 })
  return parseFillerJson(result.message.content, runtimeSec)
}
