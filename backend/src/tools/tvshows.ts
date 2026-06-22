import type { Tool, ToolResult } from './index'
import { searchTool } from './search'

const API = 'https://api.tvmaze.com'

const TRAILING_NOISE = new Set([
  'episode', 'episodes', 'finale', 'news', 'renewal', 'renewed',
  'season', 'seasons', 'series', 'show', 'tv',
])

function stripHtml(html: string): string {
  return (html ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#\d+;/g, '')
    .trim()
}

function queryVariants(query: string): string[] {
  const tokens = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  const trimmed = [...tokens]
  while (trimmed.length > 1 && TRAILING_NOISE.has(trimmed[trimmed.length - 1])) trimmed.pop()
  const candidates = [query.trim(), tokens.join(' '), trimmed.join(' ')]
  const seen = new Set<string>()
  return candidates.filter(v => v && !seen.has(v) && seen.add(v))
}

function scoreShow(show: Record<string, unknown>, query: string): [number, number] {
  const name = String(show.name ?? '').toLowerCase().trim()
  const q = query.toLowerCase().trim()
  if (name === q) return [3, Number(show.weight ?? 0)]
  if (q && name.includes(q)) return [2, Number(show.weight ?? 0)]
  return [1, Number(show.weight ?? 0)]
}

function coerceShow(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>
    if (p.show && typeof p.show === 'object') return p.show as Record<string, unknown>
    return p
  }
  return {}
}

async function fetchShow(query: string): Promise<{ show: Record<string, unknown>; error?: string }> {
  const variants = queryVariants(query)

  for (const variant of variants) {
    try {
      const res = await fetch(`${API}/singlesearch/shows?q=${encodeURIComponent(variant)}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) return { show: coerceShow(await res.json()) }
      if (res.status !== 404) return { show: {}, error: `http_${res.status}` }
    } catch { /* try next variant */ }
  }

  for (const variant of variants) {
    try {
      const res = await fetch(`${API}/search/shows?q=${encodeURIComponent(variant)}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) continue
      const results = (await res.json()) as unknown[]
      if (!Array.isArray(results) || !results.length) continue
      const best = results
        .map(item => coerceShow((item as Record<string, unknown>).show ?? item))
        .filter(s => s.name)
        .sort((a, b) => {
          const [sa, wa] = scoreShow(a, variant)
          const [sb, wb] = scoreShow(b, variant)
          return sb !== sa ? sb - sa : wb - wa
        })[0]
      if (best) return { show: best }
    } catch { /* try next */ }
  }

  return { show: {} }
}

async function fetchCast(showId: unknown): Promise<string> {
  if (!showId) return ''
  try {
    const res = await fetch(`${API}/shows/${showId}/cast`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return ''
    const cast = (await res.json()) as Array<{ person?: { name?: string } }>
    const names = cast.slice(0, 5).map(c => c.person?.name).filter(Boolean)
    return names.length ? `Cast: ${names.join(', ')}` : ''
  } catch { return '' }
}

async function fetchSeasonCount(showId: unknown): Promise<number> {
  if (!showId) return 0
  try {
    const res = await fetch(`${API}/shows/${showId}/seasons`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return 0
    const seasons = await res.json()
    return Array.isArray(seasons) ? seasons.length : 0
  } catch { return 0 }
}

function firstSentence(text: string, maxLen = 280): string {
  const t = text.trim()
  if (!t) return ''
  const s = t.split(/\.\s+/)[0].trim()
  if (s.length <= maxLen) return s + (s.endsWith('.') ? '' : '.')
  return s.slice(0, maxLen - 1).trimEnd() + '…'
}

function deriveAnswerPayload(data: {
  name: string; summary: string; network: string; status: string;
  season_count: number; premiered: string; ended: string;
  genres: string[]; runtime: number; cast_line: string; url: string
}) {
  if (!data.name) return { gist: '', highlights: [], sources: [], depth_available: false }
  const head = data.network ? `${data.name} (${data.network})` : data.name
  const lead = firstSentence(data.summary)
  const gist = lead ? `${head}: ${lead}` : head
  const highlights: string[] = []
  if (data.status) highlights.push(`Status: ${data.status}`)
  if (data.season_count) highlights.push(`Seasons: ${data.season_count}`)
  if (data.premiered && data.ended) highlights.push(`Aired: ${data.premiered} – ${data.ended}`)
  else if (data.premiered) highlights.push(`Premiered: ${data.premiered}`)
  if (data.genres.length) highlights.push(`Genres: ${data.genres.join(', ')}`)
  if (data.cast_line) highlights.push(data.cast_line)
  const source = data.url ? [{ url: data.url, title: data.name }] : []
  return { gist, highlights, sources: source, depth_available: data.summary.length > lead.length + 150 }
}

export const tvShowsTool: Tool = {
  id: 'tvshows',
  name: 'TV Shows',
  description: 'Look up TV show details, cast, seasons, and recent news via TVMaze',
  offline: false,
  dataSources: [
    { name: 'TVMaze', domain: 'tvmaze.com', purpose: 'TV show details, cast, and season information', type: 'api' },
  ],
  passMessage: 'query',
  examples: [
    'TV show details — cast, network, seasons, status, and summary',
    'information about a specific television series by name',
    'how many seasons or episodes does a show have',
    'is a TV show still running or cancelled',
    'recommend or find a TV series to watch',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'tvshows',
      description: 'Look up a TV show — cast, network, seasons, status, and summary',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Show title or name' },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    const { query } = args as { query: string }
    if (!query?.trim()) return { success: false, error: 'Query is required' }
    const q = query.trim()

    try {
      const { show, error } = await fetchShow(q)
      if (error) return { success: false, error }
      if (!show.name) return { success: true, data: { found: false, answer_payload: { gist: `No TV show found for "${q}".` } } }

      const showId = show.id

      // Parallel: seasons + cast + recent news fan-out
      const [seasonCount, castLine, recentResult] = await Promise.all([
        fetchSeasonCount(showId),
        fetchCast(showId),
        searchTool.execute({ query: `${q} tv show renewed cancelled news`, max_results: 3 }),
      ])

      const recentNews = (recentResult.success && recentResult.data)
        ? (recentResult.data as { results: Array<{ title: string; snippet: string; url: string }> }).results
        : []

      const network = String((show.network as Record<string, unknown> | null)?.name ?? (show.webChannel as Record<string, unknown> | null)?.name ?? '')
      const schedule = (show.schedule as Record<string, unknown> | null) ?? {}
      const image = (show.image as Record<string, unknown> | null) ?? {}

      const data = {
        found: true,
        name: String(show.name ?? ''),
        summary: stripHtml(String(show.summary ?? '')),
        premiered: String(show.premiered ?? ''),
        ended: String(show.ended ?? ''),
        status: String(show.status ?? ''),
        network,
        language: String(show.language ?? ''),
        genres: (Array.isArray(show.genres) ? show.genres : []) as string[],
        rating: (show.rating as Record<string, unknown> | null)?.average ?? null,
        runtime: Number(show.runtime ?? show.averageRuntime ?? 0),
        schedule_days: (Array.isArray((schedule as Record<string, unknown>).days) ? (schedule as Record<string, unknown>).days : []) as string[],
        season_count: seasonCount,
        cast_line: castLine,
        url: String(show.url ?? ''),
        image: String(image.original ?? image.medium ?? ''),
        recent_news: recentNews,
      }

      return {
        success: true,
        data: { ...data, answer_payload: deriveAnswerPayload(data) },
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { success: false, offline: true, error: 'Network unavailable' }
      }
      return { success: false, error: String(err) }
    }
  },
}
