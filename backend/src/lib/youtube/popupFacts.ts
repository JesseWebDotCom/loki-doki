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
import { getModel, getFastModel } from '@/lib/models'
import { wikipediaSearch } from '@/lib/wikipediaSearch'
import { webSearch } from '@/lib/webSearch'
import { cachedLookupStale, cachedLookupPut, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import { logger } from '@/lib/logger'

export interface PopupFact { t: number; text: string }

// v2: main model instead of the fast tier (facts need world knowledge the
// small model doesn't have — it obeyed "silence is better" with [] every
// time). Namespace bump discards every cached empty at once.
// v4: retrieval-grounded. The local model's own trivia memory is thin, so
// facts are anchored in live Wikipedia/web snippets for the entities each
// section discusses (v3 fixed sentence form; v4 gives it something true and
// interesting to say).
const NAMESPACE = 'yt-popup-facts-v7'
const MISS_TTL_MS = 6 * 60 * 60 * 1000
const MAX_FACTS = 14
const MIN_SPACING_SEC = 45

const FACTS_SYSTEM =
  'You write VH1 Pop-Up Video style trivia bubbles for a video. You are given the ' +
  'transcript split into numbered sections, and a VERIFIED SOURCES block of live ' +
  'Wikipedia/web snippets about the things each section discusses. RULE ONE: every fact ' +
  'MUST come from a detail in the VERIFIED SOURCES - never from the transcript and never ' +
  'from your own memory. RULE TWO: if the transcript already says it, it is NOT a fact - ' +
  'the whole point is telling the viewer something the video does NOT. The transcript is ' +
  'context for matching sources to moments, nothing more. For each section contribute 0 or ' +
  '1 fact: surprising background on the people, products, places, works or events being ' +
  'discussed - origins, behind-the-scenes details, numbers, connections to other works. ' +
  'Every fact MUST be a COMPLETE SENTENCE of 15-30 words with a specific, checkable ' +
  'detail. Example of the style: "The white streak in Nancy\'s hair is ' +
  'on her right side here, but it was on her left in A Nightmare on Elm Street (1984)." ' +
  'NEVER a bare phrase or fragment, NEVER a summary of what is on screen. ' +
  'A SOURCE may describe the WRONG thing (same name, different subject) - if a source does ' +
  'not clearly match what the section is actually discussing, IGNORE it entirely. Skip ' +
  'dictionary definitions and anything an average viewer already knows; a bubble must ' +
  'surprise. If no source yields a good fact for a section, contribute nothing - silence ' +
  'is always better than a wrong or redundant fact. Never speculate about the creator, no ' +
  'opinions. Respond with ONLY a JSON array, no prose, no code fences: ' +
  '[{"s": <section number>, "text": "<the fact>"}, ...]. An empty array is a fine answer.'

const ENTITY_SYSTEM =
  'From the numbered transcript sections, list the notable named things worth trivia: ' +
  'people, movies/shows/games/works, products, companies, places, events. Up to 8, most ' +
  'interesting first, each tied to the section where it is discussed. Respond with ONLY a ' +
  'JSON array, no prose: [{"s": <section number>, "entity": "<name>"}, ...]'

/** Wikipedia-first (web-search fallback, steered at trivia/IMDb pages) source
 * snippets for the entities each section discusses. Returns a text block for
 * the facts prompt, or '' when nothing useful was retrievable. Never throws. */
async function gatherSources(numbered: string): Promise<string> {
  try {
    const fast = await getFastModel()
    const r = await ollamaChat(fast, [
      { role: 'system', content: ENTITY_SYSTEM },
      { role: 'user', content: numbered },
    ], undefined, { temperature: 0.1, num_predict: 300 })
    const m = r.message.content.match(/\[[\s\S]*\]/)
    if (!m) return ''
    const seen = new Set<string>()
    const picked: { s: number; name: string }[] = []
    for (const e of JSON.parse(m[0]) as unknown[]) {
      const s = Number((e as any)?.s)
      const name = String((e as any)?.entity ?? '').trim()
      if (!Number.isInteger(s) || name.length < 2 || name.length > 80) continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      picked.push({ s, name })
      if (picked.length >= 6) break
    }
    // Mechanical source-relevance check: retrieval for "Jason Ween" (a
    // streamer) happily returns Ween (the band) on the shared surname, and no
    // prompt guard reliably catches same-name-wrong-subject. A source is
    // accepted only when it demonstrably matches the WHOLE entity: the result
    // title covers most of the entity's words, or the snippet contains the
    // full entity phrase.
    const matchesEntity = (name: string, title: string, snippet: string): boolean => {
      const entity = name.toLowerCase()
      const t = title.toLowerCase()
      const s = snippet.toLowerCase()
      if (s.includes(entity)) return true
      const words = entity.split(/\s+/).filter((w) => w.length > 1)
      if (!words.length) return false
      const covered = words.filter((w) => t.includes(w)).length
      return covered / words.length >= 0.75
    }
    const blocks = await Promise.all(picked.map(async e => {
      let text = ''
      const wiki = (await wikipediaSearch(e.name, 2)).find((r) =>
        matchesEntity(e.name, r.title ?? '', r.snippet ?? ''))
      if (wiki) text = wiki.snippet ?? ''
      if (text.length < 60) {
        const web = await webSearch(`"${e.name}" trivia imdb`, 3)
        text = web
          .filter((w) => matchesEntity(e.name, w.title ?? '', w.snippet ?? ''))
          .map((w) => w.snippet)
          .join(' ')
      }
      text = text.replace(/\s+/g, ' ').trim().slice(0, 450)
      return text ? `SOURCE for section ${e.s} — ${e.name}: ${text}` : ''
    }))
    return blocks.filter(Boolean).join('\n\n')
  } catch {
    return ''
  }
}

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

  // Ground the trivia: pull Wikipedia/web snippets for the entities each
  // section discusses so the writer works from real sources, not model memory.
  const sources = await gatherSources(numbered)
  // Sources are MANDATORY: without retrieved snippets the model can only
  // restate the transcript or invent from memory - both worse than silence
  // (real feedback: "display facts NOT in the transcript"). Cached as a miss,
  // retried after the TTL when retrieval may succeed.
  if (!sources) return null

  // Background job — latency is free, so use the MAIN model: trivia needs
  // world knowledge, and the fast tier answered [] essentially always.
  const model = await getModel()
  const user = `${numbered}\n\nVERIFIED SOURCES — every fact must come from a detail in these that the video itself does not mention:\n\n${sources}`
  const result = await ollamaChat(model, [
    { role: 'system', content: FACTS_SYSTEM },
    { role: 'user', content: user },
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

  // Transcript-overlap gate: a "fact" whose distinctive words mostly appear in
  // the video's own transcript is a restatement, not trivia - the model slips
  // these through no matter what the prompt says. Words of 5+ chars are the
  // discriminative ones (short words match everything).
  const transcriptWords = new Set(
    segments.flatMap((seg) => seg.text.toLowerCase().match(/[a-z']{5,}/g) ?? []),
  )
  const restatesTranscript = (text: string): boolean => {
    const words = text.toLowerCase().match(/[a-z']{5,}/g) ?? []
    if (words.length < 4) return false
    const hits = words.filter((w) => transcriptWords.has(w)).length
    return hits / words.length > 0.6
  }

  const facts: PopupFact[] = []
  for (const item of parsed) {
    const s = Number((item as any)?.s)
    const text = String((item as any)?.text ?? '').trim()
    if (!Number.isInteger(s) || s < 1 || s > segments.length) continue
    // Sentences, not fragments: a real fact has length AND multiple words AND
    // sentence punctuation somewhere.
    if (text.length < 40 || text.length > 220) continue
    if (text.split(/\s+/).length < 7) continue
    if (restatesTranscript(text)) continue
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
