import type { Tool, ToolResult } from './index'
import { getOnTvTonight } from '@/lib/shows/tvmaze'

// Companion tool: "what's on TV tonight" / "what show is playing right now". Backed by the
// same TVMaze schedule that powers the Shows app's "On TV Tonight" section — broadcast/cable
// airings plus streaming premieres. Keyless, degrades gracefully.

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const onTvTool: Tool = {
  id: 'ontv',
  name: 'On TV Tonight',
  description: "Find TV shows airing now or tonight — broadcast, cable, and streaming premieres.",
  offline: false,
  dataSources: [
    { name: 'TVMaze', domain: 'tvmaze.com', purpose: 'TV schedule and streaming premieres', type: 'api' },
  ],
  examples: [
    'what shows are on tonight',
    'what is playing on TV right now',
    'what TV show is on now',
    'anything good on TV tonight',
    'what premieres today on streaming',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'ontv',
      description: "Get TV shows airing today/tonight (US broadcast + cable) and streaming premieres.",
      parameters: {
        type: 'object',
        required: [],
        properties: {
          query: { type: 'string', description: 'Optional show title or genre keyword to focus on.' },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    const { query } = (args ?? {}) as { query?: string }
    try {
      const entries = await getOnTvTonight(todayIso())
      if (!entries.length) return { success: false, error: 'No TV schedule available right now' }

      let list = entries
      const q = query?.trim().toLowerCase()
      if (q) {
        const filtered = entries.filter(
          (e) =>
            e.show.name.toLowerCase().includes(q) ||
            e.show.genres.some((g) => g.toLowerCase().includes(q)) ||
            (e.episode?.toLowerCase().includes(q) ?? false),
        )
        if (filtered.length) list = filtered
      }

      // Trim to a speakable set for the LLM.
      const items = list.slice(0, 25).map((e) => ({
        title: e.show.name,
        network: e.show.network,
        time: e.airtimeLabel,
        episode: e.episode,
        season: e.season,
        number: e.number,
        genres: e.show.genres,
        streaming: e.streaming,
      }))
      return { success: true, data: { date: todayIso(), count: list.length, shows: items } }
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { success: false, offline: true, error: 'The TV schedule is unavailable right now' }
      }
      return { success: false, error: String(err) }
    }
  },
}
