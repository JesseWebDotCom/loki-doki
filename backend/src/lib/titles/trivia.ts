// "Did you know?" trivia / fun facts for a title. Sourced keylessly from web search +
// Wikipedia (Trivia / Production / Reception material), then distilled by the fast model
// into a handful of standalone, verifiable-sounding fun facts. Cached 30 days.
//
// Best-effort: no corpus or model failure → []. We never fabricate; the model is told to
// draw only from the supplied snippets.

import { webSearch } from '@/lib/webSearch'
import { wikipediaSearch } from '@/lib/wikipediaSearch'
import { getFastModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'
import { cachedLookup, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import type { MediaKind } from './types'

const A = (s: string) => s.match(/\[[\s\S]*\]/)?.[0]
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => (x as string).trim()).filter(Boolean) : []

export async function getTrivia(title: string, year: string | null, kind: MediaKind): Promise<string[]> {
  const key = `${kind}:${title.toLowerCase()}:${year ?? ''}`
  return cachedLookup('title-trivia', key, THIRTY_DAYS_MS, async () => {
    const noun = kind === 'movie' ? 'film' : 'TV series'
    const y = year ? ` ${year}` : ''
    const [web, wiki] = await Promise.all([
      webSearch(`${title}${y} ${noun} trivia fun facts behind the scenes production`, 6),
      wikipediaSearch(`${title} ${noun}`, 1),
    ])
    const corpus = [...web.map((w) => `${w.title}: ${w.snippet}`), ...wiki.map((w) => w.snippet)]
      .join('\n\n')
      .slice(0, 6000)
    if (!corpus.trim()) return []

    try {
      const model = await getFastModel()
      const SYSTEM =
        `You extract "Did you know?" fun facts about a ${noun} for an info page. From the snippets, produce 4-8 short, ` +
        'self-contained, genuinely interesting facts (production stories, casting, records, easter eggs, reception ' +
        'milestones). Each is one sentence, no lead-in like "Did you know". Use ONLY facts present in the snippets; ' +
        'skip anything you are unsure about. Return ONLY a JSON array of strings.'
      const resp = await ollamaChat(
        model,
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Title: "${title}"${y}\n\nSnippets:\n${corpus}` },
        ],
        undefined,
        { temperature: 0.5, num_ctx: 8192, num_predict: 450 },
      )
      const a = A(resp.message?.content ?? '')
      return a ? strs(JSON.parse(a)).slice(0, 8) : []
    } catch {
      return []
    }
  })
}
