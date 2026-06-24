// Reviews digest for a title: aggregate critic/audience scores plus an LLM-distilled
// reception summary with pros/cons. Keyless — scores are regex-mined from web-search
// snippets (Rotten Tomatoes / IMDb / Metacritic), and the prose is condensed from web +
// Wikipedia "Reception" material by the fast model (same pattern as podcast videoBrief).
//
// Best-effort throughout: no corpus → null; model failure → scores-only digest.

import { webSearch } from '@/lib/webSearch'
import { wikipediaSearch } from '@/lib/wikipediaSearch'
import { getFastModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'
import { cachedLookup, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import type { MediaKind, ReviewDigest, ReviewScore } from './types'

const J = (s: string) => s.match(/\{[\s\S]*\}/)?.[0]
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => (x as string).trim()).filter(Boolean) : []

// Mine aggregate scores out of free-text snippets. Conservative patterns — better to miss a
// score than to invent one.
function mineScores(text: string): ReviewScore[] {
  const out: ReviewScore[] = []
  const seen = new Set<string>()
  const push = (source: string, value: string) => {
    if (seen.has(source)) return
    seen.add(source)
    out.push({ source, value })
  }
  let m: RegExpMatchArray | null

  if ((m = text.match(/(\d{1,3})\s*%[^.]{0,30}?rotten tomatoes/i)) || (m = text.match(/rotten tomatoes[^.]{0,30}?(\d{1,3})\s*%/i)))
    push('Rotten Tomatoes', `${m[1]}%`)
  if ((m = text.match(/imdb[^.]{0,20}?(\d(?:\.\d)?)\s*\/\s*10/i)) || (m = text.match(/(\d(?:\.\d)?)\s*\/\s*10[^.]{0,15}?imdb/i)))
    push('IMDb', `${m[1]}/10`)
  if ((m = text.match(/metacritic[^.]{0,25}?(\d{1,3})\b/i)) || (m = text.match(/metascore[^.]{0,15}?(\d{1,3})\b/i)))
    push('Metacritic', `${m[1]}/100`)

  return out
}

export async function getReviews(title: string, year: string | null, kind: MediaKind): Promise<ReviewDigest | null> {
  const key = `${kind}:${title.toLowerCase()}:${year ?? ''}`
  return cachedLookup('title-reviews', key, THIRTY_DAYS_MS, async () => {
    const noun = kind === 'movie' ? 'movie' : 'TV series'
    const y = year ? ` ${year}` : ''
    const [web, wiki] = await Promise.all([
      webSearch(`${title}${y} ${noun} reviews rotten tomatoes imdb metacritic`, 6),
      wikipediaSearch(`${title} ${kind === 'movie' ? 'film' : 'TV series'}`, 1),
    ])

    const sources = web.slice(0, 4).map((w) => ({ title: w.title, url: w.url }))
    const corpus = [...web.map((w) => `${w.title}: ${w.snippet}`), ...wiki.map((w) => w.snippet)]
      .join('\n\n')
      .slice(0, 6000)
    if (!corpus.trim()) return null

    const scores = mineScores(corpus)

    let summary = ''
    let pros: string[] = []
    let cons: string[] = []
    try {
      const model = await getFastModel()
      const SYSTEM =
        `You summarize critical and audience reception of a ${noun} for a info page. From the snippets, write a ` +
        'neutral 2-3 sentence "summary" of how it was received, plus "pros" (2-4 short praise points critics/audiences ' +
        'raised) and "cons" (2-4 short criticisms). Base everything ONLY on the snippets; do not invent. If reception ' +
        'is unclear, keep it brief. Return ONLY JSON: {"summary":"...","pros":["..."],"cons":["..."]}.'
      const resp = await ollamaChat(
        model,
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Title: "${title}"${y}\n\nSnippets:\n${corpus}` },
        ],
        undefined,
        { temperature: 0.4, num_ctx: 8192, num_predict: 450 },
      )
      const j = J(resp.message?.content ?? '')
      if (j) {
        const p = JSON.parse(j) as { summary?: unknown; pros?: unknown; cons?: unknown }
        summary = typeof p.summary === 'string' ? p.summary.trim() : ''
        pros = strs(p.pros).slice(0, 4)
        cons = strs(p.cons).slice(0, 4)
      }
    } catch {
      /* model unavailable — return scores-only digest */
    }

    if (!summary && !pros.length && !cons.length && !scores.length) return null
    return { summary, pros, cons, scores, sources }
  })
}
