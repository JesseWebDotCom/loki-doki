import type { Tool, ToolResult } from './index'
import { commonSenseRating, type ContentCategory } from '@/lib/briefing/sources/commonSense'
import { ollamaChat } from '@/llm/ollama'
import { getFastModel } from '@/lib/models'

function categoryLine(c: ContentCategory): string {
  const dots = typeof c.rating === 'number' ? ` (${Math.round(c.rating)}/5)` : ''
  return c.detail ? `${c.label}${dots}: ${c.detail}` : `${c.label}${dots}`
}

async function llmContentRating(title: string): Promise<ToolResult> {
  const model = await getFastModel()
  const prompt =
    `Give a brief content-rating summary for "${title}". Include:\n` +
    `1. MPAA or TV rating if known (e.g. PG-13, TV-14, R, etc.)\n` +
    `2. Recommended minimum age\n` +
    `3. Key content areas: violence, language, sexual content, mature themes\n` +
    `Be concise and factual. If you are unsure about a detail, say so briefly.\n` +
    `Output only the summary, no preamble.`
  try {
    const res = await ollamaChat(
      model,
      [{ role: 'user', content: prompt }],
      undefined,
      { num_predict: 200, temperature: 0.1 },
    )
    const text = (res.message?.content ?? '').trim()
    if (!text) return { success: false, error: 'Rating unavailable' }
    return {
      success: true,
      data: {
        found: true,
        title,
        source: 'ai',
        aiRating: text,
        answer_payload: {
          gist: `Content analysis for ${title} (AI-generated from training knowledge): ${text.slice(0, 120)}`,
          depth_available: false,
        },
      },
    }
  } catch {
    return { success: false, error: 'Rating unavailable' }
  }
}

export const contentRatingTool: Tool = {
  id: 'contentRating',
  name: 'Content Rating',
  description:
    'Look up parental guidance for a movie, TV show, book, game, or app — age rating plus violence/language/sex/drugs breakdowns',
  offline: false,
  core: true,
  passMessage: 'query',
  dataSources: [
    { name: 'DuckDuckGo', domain: 'duckduckgo.com', purpose: 'Finds the review page on Common Sense Media', type: 'api' },
    { name: 'Common Sense Media', domain: 'commonsensemedia.org', purpose: 'Parental guidance ratings and content breakdowns', type: 'web' },
  ],
  examples: [
    'is this movie ok for my kid',
    'age rating and parent guide for a show or movie',
    'does this movie have drug use, sex, or violence',
    'common sense media review for a film, book, or game',
    'is this appropriate for a 10 year old',
    'parental content rating for a video game',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'contentRating',
      description: 'Get parental content guidance for a title',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'The title to look up, e.g. "Michael (2026 movie)" or "Bluey"' },
        },
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const { query = '' } = (args ?? {}) as { query?: string }
    const title = query.trim()
    if (!title) return { success: false, error: 'A title is required' }

    const userId = String(config?.['_userId'] ?? '').trim()

    // Common Sense Media path — detailed scrape
    if (userId) {
      try {
        const r = await commonSenseRating(title)
        if (r) {
          const agePart = r.ageRating ? `Common Sense Media rates ${r.title} age ${r.ageRating}.` : `Common Sense Media review for ${r.title}.`
          const highlights: string[] = []
          if (r.parentsNeedToKnow) highlights.push(r.parentsNeedToKnow)
          for (const c of r.categories) highlights.push(categoryLine(c))
          return {
            success: true,
            data: {
              found: true,
              title: r.title,
              url: r.url,
              source: 'csm',
              ageRating: r.ageRating ?? null,
              parentsNeedToKnow: r.parentsNeedToKnow ?? null,
              categories: r.categories,
              fallback: r.fallback,
              answer_payload: {
                gist: agePart,
                highlights: highlights.slice(0, 8),
                sources: [{ url: r.url, title: `Common Sense Media — ${r.title}` }],
                depth_available: false,
              },
            },
          }
        }
      } catch {
        // Fall through to LLM path
      }
    }

    // Clean default — local LLM rating (no external requests)
    return llmContentRating(title)
  },
}
