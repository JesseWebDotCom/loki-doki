// "Ask This Video": transcript-grounded Q&A with jump-to-moment citations. Same
// peek/kick split as AI chapters so the TV's short request timeout never waits on
// the LLM: asking kicks a background build keyed on (video, question) and clients
// poll until the answer lands. Answers cite timestamps taken from the transcript,
// which the player turns into seekable moment chips.

import { readFile } from 'node:fs/promises'
import { ensureTranscript } from '@/lib/youtube/download'
import { parseVttCues, timedDigest } from '@/lib/youtube/aiChapters'
import { ollamaChat } from '@/llm/ollama'
import { getFastModel } from '@/lib/models'
import { cachedLookupStale, cachedLookupPut } from '@/lib/lookupCache'
import { logger } from '@/lib/logger'

export interface AskMoment { t: number; label: string }
export interface AskAnswer { answer: string; moments: AskMoment[] }

const NAMESPACE = 'yt-ask'
const HIT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MISS_TTL_MS = 10 * 60 * 1000

const ASK_SYSTEM =
  'You answer a viewer\'s question about a video using ONLY its timestamped transcript. ' +
  'Transcript lines are stamped [minutes:seconds]; cite moments in TOTAL SECONDS (a line ' +
  'stamped [12:30] is t 750). ' +
  'Respond with ONLY a JSON object, no prose outside it, no code fences: {"answer": "<2-4 ' +
  'sentence answer in plain language>", "moments": [{"t": <seconds>, "label": "<2-5 word ' +
  'description>"}]}. Include 1 to 4 moments pointing at the transcript timestamps that ' +
  'support the answer, most relevant first. If the transcript genuinely does not contain ' +
  'the answer, say so plainly in "answer" and return an empty moments array. Never invent ' +
  'timestamps and never mention the transcript or captions.'

function cacheKey(videoId: string, question: string): string {
  return `${videoId}:${question.trim().toLowerCase()}`
}

/** Cached answer if a build already ran; undefined when no attempt is recorded yet. */
export async function peekAsk(videoId: string, question: string): Promise<AskAnswer | null | undefined> {
  const { value, fresh } = await cachedLookupStale<AskAnswer | null>(NAMESPACE, cacheKey(videoId, question))
  if (value === undefined) return undefined
  if (!fresh && value === null) return undefined
  return value
}

const _inFlight = new Set<string>()

/** Fire-and-forget answer build, coalesced per video+question. */
export function kickAsk(videoId: string, question: string, userId: string, firstName: string): void {
  const key = cacheKey(videoId, question)
  if (_inFlight.has(key)) return
  _inFlight.add(key)
  void (async () => {
    try {
      const answer = await buildAnswer(videoId, question, userId, firstName)
      await cachedLookupPut(NAMESPACE, key, answer ? HIT_TTL_MS : MISS_TTL_MS, answer)
      logger.info({ videoId, moments: answer?.moments.length ?? 0 }, 'yt ask: cached')
    } catch (err) {
      logger.warn({ videoId, err }, 'yt ask: build failed')
    } finally {
      _inFlight.delete(key)
    }
  })()
}

function parseAskJson(raw: string, runtimeSec: number): AskAnswer | null {
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  let parsed: any
  try { parsed = JSON.parse(m[0]) } catch { return null }
  const answer = String(parsed?.answer ?? '').trim()
  if (answer.length < 8) return null
  const moments: AskMoment[] = []
  if (Array.isArray(parsed?.moments)) {
    for (const item of parsed.moments) {
      const t = Number(item?.t ?? item?.start)
      const label = String(item?.label ?? '').trim()
      if (!Number.isFinite(t) || t < 0 || t > runtimeSec + 30 || !label) continue
      moments.push({ t: Math.round(t), label: label.slice(0, 60) })
      if (moments.length >= 4) break
    }
  }
  return { answer: answer.slice(0, 1200), moments }
}

async function buildAnswer(videoId: string, question: string, userId: string, firstName: string): Promise<AskAnswer | null> {
  const absPath = await ensureTranscript(videoId, userId, firstName)
  if (!absPath) return { answer: 'This video has no captions to search, so there is nothing to answer from.', moments: [] }
  const cues = parseVttCues(await readFile(absPath, 'utf-8'))
  if (cues.length < 4) return { answer: 'This video has no usable captions to search.', moments: [] }
  const runtimeSec = cues[cues.length - 1]!.start

  const digest = timedDigest(cues)
  const model = await getFastModel()
  const result = await ollamaChat(model, [
    { role: 'system', content: ASK_SYSTEM },
    { role: 'user', content: `Question: ${question.slice(0, 300)}\n\nTranscript:\n${digest}` },
  ], undefined, { temperature: 0.2, num_predict: 450 })
  return parseAskJson(result.message.content, runtimeSec)
}
