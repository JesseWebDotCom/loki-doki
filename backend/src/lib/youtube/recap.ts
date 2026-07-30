// "Previously..." resume recaps: when a viewer comes back to a long video partway
// through, summarize what happened before their resume point so they can re-enter
// without scrubbing backward. Same serve/build split as AI chapters: the route
// answers from cache instantly and kicks a background LLM build on a miss.

import { readFile } from 'node:fs/promises'
import { ensureTranscript } from '@/lib/youtube/download'
import { parseVttCues, timedDigest } from '@/lib/youtube/aiChapters'
import { ollamaChat } from '@/llm/ollama'
import { getFastModel } from '@/lib/models'
import { cachedLookupStale, cachedLookupPut, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import { logger } from '@/lib/logger'

const NAMESPACE = 'yt-recap'
const MISS_TTL_MS = 6 * 60 * 60 * 1000
// Resume points bucket to 5 minutes so nearby resumes share one cached recap.
const BUCKET_SEC = 300

const RECAP_SYSTEM =
  'You write a "Previously..." recap of the first part of a video, from its timestamped ' +
  'transcript up to where the viewer stopped watching. Write 2 to 3 short sentences that ' +
  'remind them what has happened or been covered so far, so they can resume comfortably. ' +
  'Present tense, plain language, in English regardless of the transcript language. Never ' +
  'use meta openers like "The video" or "In this video", never mention the transcript or ' +
  'the viewer, and never reveal anything after the stop point. Output only the recap.'

export function recapBucket(uptoSec: number): number {
  return Math.max(1, Math.floor(uptoSec / BUCKET_SEC))
}

function cacheKey(videoId: string, bucket: number): string {
  return `${videoId}:${bucket}`
}

/** Cached recap if a build already ran; undefined when no attempt is recorded yet. */
export async function peekRecap(videoId: string, bucket: number): Promise<string | null | undefined> {
  const { value, fresh } = await cachedLookupStale<string | null>(NAMESPACE, cacheKey(videoId, bucket))
  if (value === undefined) return undefined
  if (!fresh && !value) return undefined // expired miss: let the caller re-kick
  return value
}

const _inFlight = new Set<string>()

/** Fire-and-forget recap build, coalesced per video+bucket. */
export function kickRecap(videoId: string, userId: string, firstName: string, uptoSec: number): void {
  const bucket = recapBucket(uptoSec)
  const key = cacheKey(videoId, bucket)
  if (_inFlight.has(key)) return
  _inFlight.add(key)
  void (async () => {
    try {
      const recap = await buildRecap(videoId, userId, firstName, bucket * BUCKET_SEC)
      await cachedLookupPut(NAMESPACE, key, recap ? THIRTY_DAYS_MS : MISS_TTL_MS, recap)
      logger.info({ videoId, bucket, chars: recap?.length ?? 0 }, 'yt recap: cached')
    } catch (err) {
      logger.warn({ videoId, bucket, err }, 'yt recap: build failed')
    } finally {
      _inFlight.delete(key)
    }
  })()
}

async function buildRecap(videoId: string, userId: string, firstName: string, uptoSec: number): Promise<string | null> {
  const absPath = await ensureTranscript(videoId, userId, firstName)
  if (!absPath) return null
  const cues = parseVttCues(await readFile(absPath, 'utf-8')).filter(c => c.start <= uptoSec)
  if (cues.length < 8) return null

  const digest = timedDigest(cues, 9000)
  const model = await getFastModel()
  const result = await ollamaChat(model, [
    { role: 'system', content: RECAP_SYSTEM },
    { role: 'user', content: digest },
  ], undefined, { temperature: 0.3, num_predict: 220 })
  const recap = result.message.content.trim()
  return recap.length >= 30 ? recap : null
}
