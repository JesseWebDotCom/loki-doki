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
import { computeImdbFacts, type ImdbEntityKind } from '@/lib/youtube/imdbFacts'
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
// v9: computable IMDb facts. Person/movie/show entities also get precise
// template facts from the locally ingested IMDb datasets (imdbFacts.ts),
// which are checkable by construction and bypass the LLM quality gates.
// The bump regenerates every cached result once the datasets are ingested.
const NAMESPACE = 'yt-popup-facts-v9'
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
  'interesting first, each tied to the section where it is discussed. Use the FULLEST ' +
  'name form the transcript gives (never shorten "Jason Ween" to "Ween") and classify ' +
  'each. Respond with ONLY a JSON array, no prose: ' +
  '[{"s": <section number>, "entity": "<fullest name>", "kind": "person|band|movie|show|game|product|company|place|event|other"}, ...]'

interface SectionEntity { s: number; name: string; kind: string }

/** Fast-model extraction of the notable named entities per section. Feeds both
 * the retrieval step (gatherSources) and the computable IMDb facts. Never throws. */
async function extractEntities(numbered: string): Promise<SectionEntity[]> {
  try {
    const fast = await getFastModel()
    const r = await ollamaChat(fast, [
      { role: 'system', content: ENTITY_SYSTEM },
      { role: 'user', content: numbered },
    ], undefined, { temperature: 0.1, num_predict: 300 })
    const m = r.message.content.match(/\[[\s\S]*\]/)
    if (!m) return []
    const seen = new Set<string>()
    const picked: SectionEntity[] = []
    for (const e of JSON.parse(m[0]) as unknown[]) {
      const s = Number((e as any)?.s)
      const name = String((e as any)?.entity ?? '').trim()
      const kind = String((e as any)?.kind ?? '').trim().toLowerCase()
      if (!Number.isInteger(s) || name.length < 2 || name.length > 80) continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      picked.push({ s, name, kind })
      if (picked.length >= 6) break
    }
    return picked
  } catch {
    return []
  }
}

/** Wikipedia-first (web-search fallback, steered at trivia/IMDb pages) source
 * snippets for the entities each section discusses. Returns a text block for
 * the facts prompt, or '' when nothing useful was retrievable. Never throws. */
async function gatherSources(picked: SectionEntity[]): Promise<string> {
  try {
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
      // The kind qualifier disambiguates retrieval ("Jason Ween person" never
      // lands on the band the way a bare surname search does).
      const wikiQuery = e.kind && e.kind !== 'other' ? `${e.name} ${e.kind}` : e.name
      const wiki = (await wikipediaSearch(wikiQuery, 2)).find((r) =>
        matchesEntity(e.name, r.title ?? '', r.snippet ?? ''))
      if (wiki) text = wiki.snippet ?? ''
      if (text.length < 60) {
        const web = await webSearch(`"${e.name}" ${e.kind && e.kind !== 'other' ? e.kind + ' ' : ''}trivia imdb`, 3)
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

  const entities = await extractEntities(numbered)

  // Computable IMDb facts for person/movie/show entities: precise template
  // sentences from the locally ingested datasets. Checkable by construction,
  // so they bypass the definition/transcript gates the LLM output must pass.
  // Empty when the datasets were never ingested (skip silently) or when a
  // name lookup is ambiguous (precision over recall).
  const imdbCandidates: { s: number; text: string }[] = []
  {
    const seenText = new Set<string>()
    for (const e of entities) {
      if (e.kind !== 'person' && e.kind !== 'movie' && e.kind !== 'show') continue
      if (!Number.isInteger(e.s) || e.s < 1 || e.s > segments.length) continue
      for (const text of computeImdbFacts(e.name, e.kind as ImdbEntityKind)) {
        const key = text.toLowerCase()
        if (seenText.has(key)) continue
        seenText.add(key)
        imdbCandidates.push({ s: e.s, text })
      }
    }
  }

  // Ground the trivia: pull Wikipedia/web snippets for the entities each
  // section discusses so the writer works from real sources, not model memory.
  const sources = entities.length ? await gatherSources(entities) : ''
  // Sources are MANDATORY for the LLM path: without retrieved snippets the
  // model can only restate the transcript or invent from memory, both worse
  // than silence (real feedback: "display facts NOT in the transcript").
  // Computable IMDb facts need no sources; when neither is available the
  // build is a miss, retried after the TTL when retrieval may succeed.
  if (!sources && !imdbCandidates.length) return null

  const llmFacts = sources ? await llmWriteFacts(segments, sources) : []

  // Dedupe: when the LLM already wrote about the same connection (title-word
  // overlap), the IMDb copy is redundant and the LLM version keeps its slot.
  const llmWordSets = llmFacts.map((f) => new Set(f.text.toLowerCase().match(/[a-z0-9']{4,}/g) ?? []))
  const dupOfLlm = (text: string): boolean => {
    const words = text.toLowerCase().match(/[a-z0-9']{4,}/g) ?? []
    if (!words.length) return false
    return llmWordSets.some((set) => words.filter((w) => set.has(w)).length / words.length > 0.5)
  }

  const facts: PopupFact[] = [...llmFacts]
  const perSection = new Map<number, number>()
  for (const c of imdbCandidates) {
    if (dupOfLlm(c.text)) continue
    // Land a beat after the section starts; a second fact in the same section
    // is pushed one spacing slot later so both can survive the spacing pass.
    const nth = perSection.get(c.s) ?? 0
    perSection.set(c.s, nth + 1)
    facts.push({ t: Math.round(segments[c.s - 1]!.start + 12 + nth * MIN_SPACING_SEC), text: c.text })
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

/** The retrieval-grounded LLM writing pass with its quality gates. Returns the
 * surviving facts placed at their sections' timestamps, unsorted and unspaced. */
async function llmWriteFacts(segments: { start: number; text: string }[], sources: string): Promise<PopupFact[]> {
  const numbered = segments
    .map((s, i) => `${i + 1}. ${s.text.slice(0, 500)}`)
    .join('\n\n')
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
    return []
  }
  let parsed: unknown
  try { parsed = JSON.parse(m[0]) } catch {
    logger.info({ len: m[0].length, head: m[0].slice(0, 120) }, 'yt popup facts: JSON parse failed')
    return []
  }
  if (!Array.isArray(parsed)) return []

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

  // Definition-grade "facts" are banal by construction: the classic
  // encyclopedia lead shape ("X is an American rock band...") and near-verbatim
  // copies of a source's opening 200 chars (the definition zone). Real trivia
  // lives deeper in the article.
  const sourceLeads = sources.split('\n\n').map((b) =>
    b.replace(/^SOURCE for section \d+ — [^:]+: /, '').slice(0, 200).toLowerCase().replace(/\s+/g, ' '),
  )
  const isDefinition = (text: string): boolean => {
    if (/^(the\s+)?[\w\s'&.:-]{2,45}\s(is|are|was|were)\s(a|an|the)\b/i.test(text)) return true
    const head = text.toLowerCase().replace(/\s+/g, ' ').slice(0, 60)
    return head.length >= 30 && sourceLeads.some((l) => l.includes(head))
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
    if (isDefinition(text)) continue
    // Land the bubble a beat into its section, so the topic is on screen first.
    facts.push({ t: Math.round(segments[s - 1]!.start + 6), text })
  }
  return facts
}
