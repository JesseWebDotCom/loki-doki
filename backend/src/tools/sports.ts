import type { Tool, ToolResult } from './index'
import { sportsToday, DEFAULT_LEAGUES, type LeagueRef } from '@/lib/briefing/sources/sports'

// Map a free-text query to a specific league when one is clearly named; otherwise we show
// today's games across all in-season leagues.
const LEAGUE_KEYWORDS: Array<{ re: RegExp; path: string; key: string }> = [
  { re: /\b(mlb|baseball|world series)\b/i, path: 'baseball/mlb', key: 'MLB' },
  { re: /\b(world cup|fifa)\b/i, path: 'soccer/fifa.world', key: 'World Cup' },
  { re: /\b(nfl|football)\b/i, path: 'football/nfl', key: 'NFL' },
  { re: /\b(nba|basketball)\b/i, path: 'basketball/nba', key: 'NBA' },
  { re: /\b(nhl|hockey)\b/i, path: 'hockey/nhl', key: 'NHL' },
  { re: /\b(mls|soccer)\b/i, path: 'soccer/usa.1', key: 'MLS' },
]

export const sportsTool: Tool = {
  id: 'sports',
  name: 'Sports Scores',
  description: "Today's live scores, results, and matchups across major leagues (MLB, World Cup, NFL, NBA, NHL, MLS)",
  offline: false,
  dataSources: [
    { name: 'ESPN', domain: 'espn.com', purpose: 'Live scores and schedules across major leagues', type: 'api' },
  ],
  passMessage: 'query',
  examples: [
    'what’s the score in the game',
    'who is playing today in baseball / the world cup',
    'latest scores and results for a league',
    'is there a game on tonight',
    'how did my team do',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'sports',
      description: "Get today's scores and matchups, optionally for a specific league or sport",
      parameters: {
        type: 'object',
        required: [],
        properties: {
          query: { type: 'string', description: 'Optional league/sport/team, e.g. "MLB", "World Cup". Omit for all of today’s games.' },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    const { query = '' } = (args ?? {}) as { query?: string }
    const q = query.trim()
    const matched = LEAGUE_KEYWORDS.find((l) => l.re.test(q))
    const leagues: LeagueRef[] | undefined = matched ? [{ key: matched.key, path: matched.path }] : DEFAULT_LEAGUES

    try {
      const items = await sportsToday({ leagues, limit: matched ? 8 : 6 })
      if (!items.length) {
        return { success: true, data: { games: [], answer_payload: { gist: matched ? `No ${matched.key} games found today.` : 'No major games found today.' } } }
      }
      return {
        success: true,
        data: {
          games: items,
          answer_payload: {
            gist: items[0]!.title,
            highlights: items.slice(1).map((i) => i.title),
            sources: [],
            depth_available: false,
          },
        },
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { success: false, offline: true, error: 'Network unavailable' }
      }
      return { success: false, error: String(err) }
    }
  },
}
