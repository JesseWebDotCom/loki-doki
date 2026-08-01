// Pop-Up Facts: VH1's Pop-Up Video for the modern hub. Trivia bubbles synced to
// the section being watched: an iPhone review reaches the display segment and a
// bubble about the cover glass appears. Sections come from the SAME embedding
// topic segmentation that powers AI chapters, so bubbles land where topics
// actually change; the model is told to skip rather than guess, and everything
// is labeled AI trivia client-side. Same peek/kick serve split as the rest of
// the AI layer.

import { readFile } from 'node:fs/promises'
import { ensureTranscript } from '@/lib/youtube/download'
import { parseVttCues, segmentByEmbeddings, timedDigest } from '@/lib/youtube/aiChapters'
import { ollamaChat } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import { cachedLookupStale, cachedLookupPut, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import { logger } from '@/lib/logger'

export interface PopupFact { t: number; text: string }

// v2: main model instead of the fast tier (facts need world knowledge the
// small model doesn't have — it obeyed "silence is better" with [] every
// time). Namespace bump discards every cached empty at once.
const NAMESPACE = 'yt-popup-facts-v2'
const MISS_TTL_MS = 6 * 60 * 60 * 1000
const MAX_FACTS = 14
const MIN_SPACING_SEC = 45

const FACTS_SYSTEM =
  'You write Pop-Up Video style trivia bubbles for a video, from its transcript split into ' +
  'numbered sections. For each section you may contribute 0, 1 or 2 SHORT facts (under 140 ' +
  'characters each) that would delight a viewer watching that exact part: background on the ' +
  'products, people, places, works or events being discussed, origins, numbers, connections. ' +
  'Only include facts you are HIGHLY confident are true and verifiable general knowledge; if ' +
  'you are not sure, contribute nothing for that section - silence is always better than a ' +
  'wrong fact. Never restate what the video itself just said, never speculate about the ' +
  'creator, no opinions. Respond with ONLY a JSON array, no prose, no code fences: ' +
  '[{"s": <section number>, "text": "<the fact>"}, ...]. An empty array is a fine answer.'

/** Cached facts if a build already ran; undefined when no attempt is recorded yet. */
export async function peekPopupFacts(videoId: string): Promise<PopupFact[] | null | undefined> {
  const { value, fresh } = await cachedLookupStale<PopupFact[] | null>(NAMESPACE, videoId)
  if (value === undefined) return undefined
  if (!fresh && (value === null || value.length === 0)) return undefined
  return value
}

const _inFlight = new Set<string>()

/** Fire-and-forget build, coalesced per video. */
export function kickPopupFacts(videoId: string, userId: string, firstName: string): void {
  if (_inFlight.has(videoId)) return
  _inFlight.add(videoId)
  void (async () => {
    try {
      const facts = await buildFacts(videoId, userId, firstName)
      await cachedLookupPut(NAMESPACE, videoId, facts?.length ? THIRTY_DAYS_MS : MISS_TTL_MS, facts)
      logger.info({ videoId, count: facts?.length ?? 0 }, 'yt popup facts: cached')
    } catch (err) {
      logger.warn({ videoId, err }, 'yt popup facts: build failed')
    } finally {
      _inFlight.delete(videoId)
    }
  })()
}

async function buildFacts(videoId: string, userId: string, firstName: string): Promise<PopupFact[] | null> {
  const absPath = await ensureTranscript(videoId, userId, firstName)
  if (!absPath) return null
  const cues = parseVttCues(await readFile(absPath, 'utf-8'))
  if (cues.length < 12) return null
  const lastSec = cues[cues.length - 1]!.start
  if (lastSec < 180) return null

  // Prefer the chapter segmenter's topic sections; fall back to coarse fixed
  // sections (one per ~3 minutes over the digest) when embeddings are down.
  let segments = await segmentByEmbeddings(cues, lastSec).catch(() => null)
  if (!segments || segments.length < 2) {
    const digest = timedDigest(cues)
    const lines = digest.split('\n')
    const per = Math.max(4, Math.ceil(lines.length / Math.max(2, Math.floor(lastSec / 180))))
    segments = []
    for (let i = 0; i < lines.length; i += per) {
      const m = lines[i]!.match(/^\[(\d+):(\d{2})\]/)
      const start = m ? Number(m[1]) * 60 + Number(m[2]) : 0
      segments.push({ start, text: lines.slice(i, i + per).join(' ') })
    }
  }

  const numbered = segments
    .map((s, i) => `${i + 1}. ${s.text.slice(0, 500)}`)
    .join('\n\n')
  // Background job — latency is free, so use the MAIN model: trivia needs
  // world knowledge, and the fast tier answered [] essentially always.
  const model = await getModel()
  const result = await ollamaChat(model, [
    { role: 'system', content: FACTS_SYSTEM },
    { role: 'user', content: numbered },
  ], undefined, { temperature: 0.3, num_predict: 900 })

  const raw = result.message.content
  const m = raw.match(/\[[\s\S]*\]/)
  if (!m) {
    logger.info({ len: raw.length, head: raw.slice(0, 120) }, 'yt popup facts: no JSON array in reply')
    return null
  }
  let parsed: unknown
  try { parsed = JSON.parse(m[0]) } catch {
    logger.info({ len: m[0].length, head: m[0].slice(0, 120) }, 'yt popup facts: JSON parse failed')
    return null
  }
  if (!Array.isArray(parsed)) return null

  const facts: PopupFact[] = []
  for (const item of parsed) {
    const s = Number((item as any)?.s)
    const text = String((item as any)?.text ?? '').trim()
    if (!Number.isInteger(s) || s < 1 || s > segments.length) continue
    if (text.length < 15 || text.length > 200) continue
    // Land the bubble a beat into its section, so the topic is on screen first.
    facts.push({ t: Math.round(segments[s - 1]!.start + 6), text })
  }
  facts.sort((a, b) => a.t - b.t)
  // Breathing room between bubbles, capped so a video never turns into confetti.
  const spaced: PopupFact[] = []
  for (const f of facts) {
    const prev = spaced[spaced.length - 1]
    if (prev && f.t - prev.t < MIN_SPACING_SEC) continue
    spaced.push(f)
    if (spaced.length >= MAX_FACTS) break
  }
  return spaced
}
