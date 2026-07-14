// Minimal JustWatch search — returns MULTIPLE results (the whereToWatch tool only resolves a
// single best match, which is fine for "where can I watch X" but not for a search grid). Used
// by the Movies app's search + as a generic title resolver. Keyless GraphQL, cached.

import { cachedLookup } from '@/lib/lookupCache'

const GRAPHQL_URL = 'https://apis.justwatch.com/graphql'
const JUSTWATCH_BASE = 'https://www.justwatch.com'
const JUSTWATCH_IMAGE_BASE = 'https://images.justwatch.com'
const SIX_HOURS_MS = 6 * 60 * 60 * 1000

const SEARCH_QUERY = `
fragment Hit on MovieOrShow {
  __typename id objectType objectId
  content(country: $country, language: $language) {
    fullPath title originalReleaseYear posterUrl shortDescription runtime ageCertification
    genres { translation(language: $language) }
  }
}
query Search($country: Country!, $language: Language!, $first: Int!, $searchQuery: String) {
  searchTitles(country: $country, first: $first, filter: { searchQuery: $searchQuery, includeTitlesWithoutUrl: true }, source: "SearchSuggester") {
    edges { node { ...Hit } }
  }
}`

export interface JwTitle {
  title: string
  year: number | null
  objectType: 'MOVIE' | 'SHOW' | string
  summary: string
  poster: string | null
  justwatchUrl: string | null
  genres: string[]
}

function nodeToTitle(node: Record<string, unknown>): JwTitle | null {
  const content = (node.content as Record<string, unknown> | null) ?? {}
  const title = String(content.title ?? '').trim()
  if (!title) return null
  const genres = Array.isArray(content.genres)
    ? (content.genres as Array<{ translation?: unknown }>).map((g) => String(g.translation ?? '')).filter(Boolean)
    : []
  return {
    title,
    year: typeof content.originalReleaseYear === 'number' ? content.originalReleaseYear : null,
    objectType: String(node.objectType ?? '').toUpperCase(),
    summary: String(content.shortDescription ?? ''),
    poster: posterUrl(String(content.posterUrl ?? '')),
    justwatchUrl: justwatchUrl(String(content.fullPath ?? '')),
    genres,
  }
}

function posterUrl(raw: string): string | null {
  const path = (raw ?? '').trim()
  if (!path) return null
  if (path.startsWith('http')) return path
  let rendered = path.replace('{profile}', 's718').replace('{format}', 'jpg')
  if (!rendered.startsWith('/')) rendered = `/${rendered}`
  return `${JUSTWATCH_IMAGE_BASE}${rendered}`
}

function justwatchUrl(raw: string): string | null {
  const path = (raw ?? '').trim()
  if (!path) return null
  return path.startsWith('http') ? path : `${JUSTWATCH_BASE}${path}`
}

export async function searchTitles(
  query: string,
  objectType: 'MOVIE' | 'SHOW' | null,
  limit = 24,
  country = 'US',
): Promise<JwTitle[]> {
  const q = query.trim()
  if (!q) return []
  return cachedLookup('justwatch-search', `${objectType ?? 'ALL'}:${country}:${q.toLowerCase()}`, SIX_HOURS_MS, async () => {
    try {
      const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: SEARCH_QUERY, variables: { country, language: 'en', first: Math.min(limit * 2, 40), searchQuery: q } }),
        signal: AbortSignal.timeout(7000),
      })
      if (!res.ok) return []
      const payload = (await res.json()) as { data?: { searchTitles?: { edges?: Array<{ node?: Record<string, unknown> }> } }; errors?: unknown }
      if (payload.errors) return []
      const edges = payload.data?.searchTitles?.edges ?? []
      const out: JwTitle[] = []
      for (const e of edges) {
        if (!e.node) continue
        const t = nodeToTitle(e.node)
        if (!t) continue
        if (objectType && t.objectType !== objectType) continue
        out.push(t)
        if (out.length >= limit) break
      }
      return out
    } catch {
      return []
    }
  })
}

// ── Rich discovery: filtered popular/trending/in-cinema/by-genre ───────────────────

const THIRTY_MIN_MS = 30 * 60 * 1000

const BROWSE_QUERY = `
fragment BHit on MovieOrShow {
  __typename id objectType objectId
  content(country: $country, language: $language) {
    fullPath title originalReleaseYear posterUrl shortDescription
    genres { translation(language: $language) }
  }
}
query Browse($country: Country!, $language: Language!, $first: Int!, $filter: TitleFilter, $sortBy: PopularTitlesSorting!) {
  popularTitles(country: $country, first: $first, filter: $filter, sortBy: $sortBy) {
    edges { node { ...BHit } }
  }
}`

export interface BrowseOpts {
  objectType: 'MOVIE' | 'SHOW'
  sortBy?: 'POPULAR' | 'TRENDING' | 'IMDB_SCORE' | 'RELEASE_YEAR'
  /** Restrict to titles currently in cinemas (drives the "In Theaters" shelf — no ZIP needed). */
  cinema?: boolean
  releaseYearMin?: number
  /** Minimum IMDb vote count. REQUIRED alongside IMDB_SCORE sort — without a floor the top
   *  of the list is obscure few-vote titles (verified live: 200k ≈ the IMDb-Top-250 flavor). */
  imdbVotesMin?: number
  /** US age certifications to allow, e.g. ["G","PG"] or ["TV-Y","TV-G"] (verified live). */
  ageCertifications?: string[]
  /** JustWatch genre shortNames, e.g. ["act","cmy"]. */
  genres?: string[]
  first?: number
  country?: string
}

export async function browsePopular(opts: BrowseOpts): Promise<JwTitle[]> {
  const { objectType, sortBy = 'POPULAR', cinema = false, releaseYearMin, imdbVotesMin, ageCertifications, genres, first = 20, country = 'US' } = opts
  const filter: Record<string, unknown> = { objectTypes: [objectType] }
  if (cinema) filter.monetizationTypes = ['CINEMA']
  if (releaseYearMin) filter.releaseYear = { min: releaseYearMin }
  if (imdbVotesMin) filter.imdbVotes = { min: imdbVotesMin }
  if (ageCertifications?.length) filter.ageCertifications = ageCertifications
  if (genres?.length) filter.genres = genres

  const cacheKey = JSON.stringify({ objectType, sortBy, cinema, releaseYearMin, imdbVotesMin, ageCertifications, genres, first, country })
  return cachedLookup('justwatch-browse', cacheKey, THIRTY_MIN_MS, async () => {
    try {
      const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: BROWSE_QUERY, variables: { country, language: 'en', first, filter, sortBy } }),
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) return []
      const payload = (await res.json()) as { data?: { popularTitles?: { edges?: Array<{ node?: Record<string, unknown> }> } }; errors?: unknown }
      if (payload.errors) return []
      const edges = payload.data?.popularTitles?.edges ?? []
      const out: JwTitle[] = []
      const seen = new Set<string>()
      for (const e of edges) {
        if (!e.node) continue
        const t = nodeToTitle(e.node)
        if (!t || t.objectType !== objectType) continue
        const key = `${t.title.toLowerCase()}:${t.year ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(t)
      }
      return out
    } catch {
      return []
    }
  })
}
