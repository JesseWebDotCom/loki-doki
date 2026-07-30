// "Worth it?": a pre-watch verdict so nobody commits 40 minutes to a video that
// never answers its own title. One structured pass over the transcript: a two
// sentence tl;dr, whether the video actually answers what the title promises,
// and the topics it really covers. Same peek/kick serve split as the AI layer.

import { getTranscriptText } from '@/lib/youtube/transcript'
import { ollamaChat } from '@/llm/ollama'
import { getFastModel } from '@/lib/models'
import { cachedLookupStale, cachedLookupPut, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import { logger } from '@/lib/logger'

export interface WorthVerdict {
  tldr: string
  /** "Yes: ...", "Partly: ..." or "No: ..." - does it deliver on the title? */
  answersTitle: string
  keyTopics: string[]
}

// v2: v1 rejected any answersTitle not literally starting "Yes:" (models write
// "Yes -", "Yes,", or a bare "No"); the parser now normalizes the grade.
const NAMESPACE = 'yt-worth-v2'
const MISS_TTL_MS = 6 * 60 * 60 * 1000

const WORTH_SYSTEM =
  'You help a viewer decide whether a video is worth their time, from its title and ' +
  'transcript. Respond with ONLY a JSON object, no prose outside it, no code fences: ' +
  '{"tldr": "<1-2 sentences: what the video actually contains and concludes>", ' +
  '"answersTitle": "<starts with exactly Yes:, Partly: or No:, then one short clause on ' +
  'whether the video delivers what its title promises>", "keyTopics": ["<3 to 6 short ' +
  'topics actually covered>"]}. Be blunt: clickbait that never pays off gets a No. Never ' +
  'mention the transcript, write in English.'

export async function peekWorth(videoId: string): Promise<WorthVerdict | null | undefined> {
  const { value, fresh } = await cachedLookupStale<WorthVerdict | null>(NAMESPACE, videoId)
  if (value === undefined) return undefined
  if (!fresh && value === null) return undefined
  return value
}

const _inFlight = new Set<string>()

export function kickWorth(videoId: string, title: string, userId: string, firstName: string): void {
  if (_inFlight.has(videoId)) return
  _inFlight.add(videoId)
  void (async () => {
    try {
      const verdict = await buildVerdict(videoId, title, userId, firstName)
      await cachedLookupPut(NAMESPACE, videoId, verdict ? THIRTY_DAYS_MS : MISS_TTL_MS, verdict)
      logger.info({ videoId, has: !!verdict }, 'yt worth-it: cached')
    } catch (err) {
      logger.warn({ videoId, err }, 'yt worth-it: build failed')
    } finally {
      _inFlight.delete(videoId)
    }
  })()
}

async function buildVerdict(videoId: string, title: string, userId: string, firstName: string): Promise<WorthVerdict | null> {
  const text = (await getTranscriptText(videoId, userId, firstName))?.slice(0, 11_000)
  if (!text) return null
  const model = await getFastModel()
  const result = await ollamaChat(model, [
    { role: 'system', content: WORTH_SYSTEM },
    { role: 'user', content: `Title: ${title}\n\nTranscript:\n${text}` },
  ], undefined, { temperature: 0.2, num_predict: 350 })

  const raw = result.message.content
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) {
    logger.warn({ videoId, raw: raw.slice(0, 200) }, 'yt worth-it: no JSON in reply')
    return null
  }
  let parsed: any
  try { parsed = JSON.parse(m[0]) } catch {
    logger.warn({ videoId, raw: m[0].slice(0, 200) }, 'yt worth-it: malformed JSON')
    return null
  }
  const tldr = String(parsed?.tldr ?? '').trim()
  const answersRaw = String(parsed?.answersTitle ?? '').trim()
  // Normalize the grade: models write "Yes:", "Yes -", "Yes," or a bare "yes".
  const gm = answersRaw.match(/^["']?(yes|partly|partially|no)\b[\s:,.-]*(.*)$/i)
  if (tldr.length < 20 || !gm) {
    logger.warn({ videoId, tldr: tldr.slice(0, 80), answers: answersRaw.slice(0, 80) },
      'yt worth-it: verdict failed validation')
    return null
  }
  const gradeWord = gm[1]!.toLowerCase() === 'partially' ? 'Partly'
    : gm[1]![0]!.toUpperCase() + gm[1]!.slice(1).toLowerCase()
  const answers = gm[2] ? `${gradeWord}: ${gm[2]}` : `${gradeWord}: it does what the title says.`
  const topics = Array.isArray(parsed?.keyTopics)
    ? parsed.keyTopics.map((t: unknown) => String(t).trim()).filter((t: string) => t.length > 1).slice(0, 6)
    : []
  return { tldr: tldr.slice(0, 400), answersTitle: answers.slice(0, 200), keyTopics: topics }
}
