import type { Tool, ToolResult } from './index'
import { webStreamingFallback, type WebProvider } from '@/lib/titles/streamingFallback'

// JustWatch GraphQL — public endpoint, no API key required. Ported from maipai-home-v2.
// Supports three modes: lookup (where is a title streaming), popular (top titles),
// and new (newest titles) — the latter two optionally filtered to one provider.
const GRAPHQL_URL = 'https://apis.justwatch.com/graphql'
const JUSTWATCH_BASE = 'https://www.justwatch.com'
const JUSTWATCH_IMAGE_BASE = 'https://images.justwatch.com'
const BROWSE_LIMIT = 8

type Mode = 'lookup' | 'popular' | 'new'

const OFFER_TYPE_LABELS: Record<string, string> = {
  ADS: 'with ads',
  BUY: 'to buy',
  CINEMA: 'in theaters',
  FLATRATE: 'with a subscription',
  FREE: 'for free',
  RENT: 'to rent',
}

const TITLE_FRAGMENT = `
  content(country: $country, language: $language) {
    fullPath
    title
    originalReleaseYear
    posterUrl
    shortDescription
    ageCertification
    runtime
    scoring { imdbScore imdbVotes tmdbScore tomatoMeter certifiedFresh }
    externalIds { imdbId tmdbId }
  }`

const OFFERS_FRAGMENT = `
  offers(country: $country, platform: WEB, filter: { preAffiliate: true }) {
    id
    monetizationType
    presentationType
    standardWebURL
    retailPrice(language: $language)
    currency
    availableTo
    package { id packageId shortName clearName technicalName icon }
  }`

// Single-node extras (cast/crew + similar titles) — only on the OFFERS_QUERY detail fetch,
// not the multi-result search/browse queries, to keep those light. GraphQL merges the second
// same-args content selection with TITLE_FRAGMENT's. similarTitles takes `limit` (not `first`)
// and returns a plain list (no edges) — verified live.
const DETAIL_EXTRAS_FRAGMENT = `
  content(country: $country, language: $language) {
    credits { role name characterName }
  }
  similarTitles(country: $country, limit: 12) {
    objectType
    content(country: $country, language: $language) {
      title
      originalReleaseYear
      posterUrl
    }
  }`

const SEARCH_QUERY = `
fragment SuggestedTitle on MovieOrShow {
  __typename id objectType objectId${TITLE_FRAGMENT}
}
query GetSearchResults($country: Country!, $language: Language!, $first: Int!, $searchQuery: String, $location: String!) {
  searchTitles(country: $country, first: $first, filter: { searchQuery: $searchQuery, includeTitlesWithoutUrl: true }, source: $location) {
    edges { node { ...SuggestedTitle } }
  }
}`

const OFFERS_QUERY = `
fragment TitleNode on MovieOrShow {
  __typename id objectId objectType${TITLE_FRAGMENT}${OFFERS_FRAGMENT}${DETAIL_EXTRAS_FRAGMENT}
}
query GetNodeOffers($entityId: ID!, $country: Country!, $language: Language!) {
  node(id: $entityId) { ...TitleNode }
}`

const PACKAGES_QUERY = `
query GetPackages($country: Country!) {
  packages(country: $country, platform: WEB, includeAddons: false) {
    clearName shortName technicalName
  }
}`

// Browse query is dynamic — field + page clause + optional provider filter vary by mode.
function browseQuery(mode: 'popular' | 'new', providerFiltered: boolean): string {
  const field = mode === 'popular' ? 'popularTitles' : 'newTitles'
  const pageClause = mode === 'popular' ? '' : ', pageType: NEW'
  const filterClause = providerFiltered ? ', filter: { packages: $packages }' : ''
  const vars = `$country: Country!, $language: Language!, $first: Int!${providerFiltered ? ', $packages: [String!]' : ''}`
  return `
fragment BrowseTitleNode on MovieOrShow {
  __typename id objectId objectType${TITLE_FRAGMENT}${OFFERS_FRAGMENT}
}
query GetBrowseTitles(${vars}) {
  ${field}(country: $country, first: $first${pageClause}${filterClause}) {
    edges { node { ...BrowseTitleNode } }
  }
}`
}

// ── Query / mode parsing ──────────────────────────────────────────────────────

const LEAD_PHRASES = [
  'where can i watch', 'where can i stream', 'where to watch', 'where to stream',
  'what streaming service has', 'what streaming services have', 'what platform has',
  'what platform is', 'what service has', 'how can i watch', 'how do i watch',
  'where is', 'can i watch', 'is', 'stream', 'watch',
]
const PROVIDER_TAIL_RE = /\bon (netflix|hulu|max|hbo( ?max)?|disney\+?|disney plus|prime( video)?|amazon( prime( video)?)?|peacock|paramount\+?|paramount plus|apple tv\+?|apple tv|starz|showtime)\b.*$/i

// Lookup framings always mean "where is THIS title" — never a browse, even when the
// title itself contains words like "new" (e.g. "is The New Mutants on Netflix").
const LOOKUP_FRAMING_RE = /\b(where (can i|to) (watch|stream)|how (can|do) i watch|is\s+.+\son\b|what (streaming|platform|service))/i
const NEW_INTENT_RE = /\b(new|latest|just added|recently added|newest|just released|new releases?)\b/i
const POPULAR_INTENT_RE = /\b(popular|trending|top\s|most[- ]watched|what'?s (on|hot|good|popular|trending)|recommend|binge)\b/i

// Known provider names to pull out of a free-text browse request ("popular on Netflix").
const PROVIDER_NAMES = [
  'netflix', 'hulu', 'hbo max', 'max', 'disney plus', 'disney+', 'prime video',
  'amazon prime video', 'amazon prime', 'apple tv plus', 'apple tv+', 'apple tv',
  'peacock', 'paramount plus', 'paramount+', 'starz', 'showtime', 'tubi',
  'pluto tv', 'crunchyroll', 'discovery plus', 'discovery+',
]

function detectMode(raw: string): Mode {
  const lower = (raw ?? '').toLowerCase()
  if (LOOKUP_FRAMING_RE.test(lower)) return 'lookup'
  if (NEW_INTENT_RE.test(lower)) return 'new'
  if (POPULAR_INTENT_RE.test(lower)) return 'popular'
  return 'lookup'
}

function detectProvider(raw: string): string {
  const lower = (raw ?? '').toLowerCase()
  // longest names first so "amazon prime video" wins over "amazon prime"
  for (const name of [...PROVIDER_NAMES].sort((a, b) => b.length - a.length)) {
    if (lower.includes(name)) return name
  }
  return ''
}

const CUE_TOKENS = new Set(['movie', 'film', 'series', 'show', 'tv', 'mini'])

// Strip "where can I watch …" framing down to the bare title.
function cleanTitle(raw: string): string {
  let q = (raw ?? '').toLowerCase().trim()
  for (const lead of LEAD_PHRASES) {
    if (q.startsWith(lead + ' ')) { q = q.slice(lead.length).trim(); break }
  }
  q = q.replace(PROVIDER_TAIL_RE, ' ')
  q = q.replace(/\b(streaming|available|online|right now|anywhere|to watch|on tv)\b/g, ' ')
  q = q.split(/\s+/).filter(t => !CUE_TOKENS.has(t)).join(' ')
  q = q.replace(/[?!.]+$/g, '').replace(/\s+/g, ' ').trim()
  return q || (raw ?? '').trim()
}

function inferObjectType(raw: string): 'MOVIE' | 'SHOW' | null {
  const lower = (raw ?? '').toLowerCase()
  if (/\b(tv series|tv show|mini ?series|series|show)\b/.test(lower)) return 'SHOW'
  if (/\b(movie|film)\b/.test(lower)) return 'MOVIE'
  return null
}

function normalizeTitle(text: string): string {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).join(' ')
}

function titleSimilarity(query: string, candidate: string): number {
  const a = normalizeTitle(query)
  const b = normalizeTitle(candidate)
  if (!a || !b) return 0
  if (a === b) return 1
  if (b.includes(a) || a.includes(b)) return 0.85
  const at = new Set(a.split(' '))
  const bt = new Set(b.split(' '))
  let overlap = 0
  for (const t of at) if (bt.has(t)) overlap++
  return overlap / Math.max(at.size, bt.size)
}

// ── GraphQL plumbing ──────────────────────────────────────────────────────────

async function postGraphql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(6000),
  })
  if (!res.ok) return null
  const payload = await res.json() as Record<string, unknown>
  if (!payload || typeof payload !== 'object' || (payload as { errors?: unknown }).errors) return null
  return payload
}

function contentOf(node: Record<string, unknown>): Record<string, unknown> {
  const c = node?.content
  return c && typeof c === 'object' ? c as Record<string, unknown> : {}
}

function posterUrl(raw: string): string {
  const path = (raw ?? '').trim()
  if (!path) return ''
  if (path.startsWith('http')) return path
  let rendered = path.replace('{profile}', 's718').replace('{format}', 'jpg')
  if (!rendered.startsWith('/')) rendered = `/${rendered}`
  return `${JUSTWATCH_IMAGE_BASE}${rendered}`
}

function justwatchUrl(raw: string): string {
  const path = (raw ?? '').trim()
  if (!path) return ''
  return path.startsWith('http') ? path : `${JUSTWATCH_BASE}${path}`
}

interface Provider {
  name: string; offerType: string; label: string; url: string
  // Rental/purchase price like "$3.99" and the leaving-soon date (ISO), when JustWatch reports them.
  price?: string | null
  availableTo?: string | null
}

function parseProviders(offers: unknown): Provider[] {
  if (!Array.isArray(offers)) return []
  const out: Provider[] = []
  const seen = new Set<string>()
  for (const offer of offers) {
    if (!offer || typeof offer !== 'object') continue
    const o = offer as Record<string, unknown>
    const pkg = o.package && typeof o.package === 'object' ? o.package as Record<string, unknown> : {}
    const name = String(pkg.clearName ?? '').trim()
    const offerType = String(o.monetizationType ?? '').trim()
    if (!name || !offerType) continue
    const key = `${name}|${offerType}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      name,
      offerType,
      label: OFFER_TYPE_LABELS[offerType] ?? offerType.toLowerCase(),
      url: String(o.standardWebURL ?? '').trim(),
      price: o.retailPrice ? String(o.retailPrice) : null,
      availableTo: o.availableTo ? String(o.availableTo) : null,
    })
  }
  const rank = (t: string) => (t === 'FLATRATE' ? 0 : t === 'FREE' || t === 'ADS' ? 1 : 2)
  return out.sort((a, b) => rank(a.offerType) - rank(b.offerType))
}

interface BrowseItem {
  title: string
  year: number | null
  objectType: string
  posterUrl: string
  justwatchUrl: string
  providers: Provider[]
}

function browseItemFromNode(node: Record<string, unknown>): BrowseItem | null {
  const content = contentOf(node)
  const title = String(content.title ?? '').trim()
  if (!title) return null
  return {
    title,
    year: typeof content.originalReleaseYear === 'number' ? content.originalReleaseYear : null,
    objectType: String(node.objectType ?? '').toUpperCase(),
    posterUrl: posterUrl(String(content.posterUrl ?? '')),
    justwatchUrl: justwatchUrl(String(content.fullPath ?? '')),
    providers: parseProviders(node.offers).filter(p => p.offerType !== 'CINEMA'),
  }
}

function normalizeProviderKey(value: string): string {
  return (value.toLowerCase().match(/[a-z0-9]+/g) ?? []).join('')
}

// Resolve a free-text provider name to JustWatch's package shortName for filtering.
function resolveProviderShortName(providerQuery: string, packages: Array<Record<string, unknown>>): { shortName: string; clearName: string } | null {
  const needle = normalizeProviderKey(providerQuery)
  if (!needle) return null
  for (const pkg of packages) {
    const clear = String(pkg.clearName ?? '')
    const short = String(pkg.shortName ?? '')
    const tech = String(pkg.technicalName ?? '')
    const candidates = [clear, short, tech, tech.replace('plus', '+')]
    if (candidates.some(c => normalizeProviderKey(c) === needle)) {
      return { shortName: short, clearName: clear || providerQuery }
    }
  }
  return null
}

// ── TMDB clean-path implementation ────────────────────────────────────────────

const TMDB_BASE = 'https://api.themoviedb.org/3'

interface TmdbProvider { provider_name: string }
interface TmdbProviders { flatrate?: TmdbProvider[]; rent?: TmdbProvider[]; buy?: TmdbProvider[] }

async function runTmdb(title: string, mode: Mode, country: string, apiKey: string, objectTypeArg?: string): Promise<ToolResult> {
  if (mode !== 'lookup') {
    // Browse: TMDB trending as a reasonable substitute for popular/new
    const trendingType = objectTypeArg?.toUpperCase() === 'SHOW' ? 'tv' : 'movie'
    const res = await fetch(`${TMDB_BASE}/trending/${trendingType}/week?api_key=${encodeURIComponent(apiKey)}&language=en-US`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) throw new Error('TMDB unavailable')
    const data = await res.json() as { results?: Array<{ title?: string; name?: string; id: number; media_type?: string; overview?: string }> }
    const items = (data.results ?? []).slice(0, 8).map(r => ({
      id: r.id,
      title: r.title ?? r.name ?? '',
      overview: r.overview ?? '',
      mediaType: r.media_type ?? trendingType,
    }))
    return {
      success: true,
      data: {
        mode,
        items,
        answer_payload: {
          gist: `Trending ${trendingType === 'tv' ? 'shows' : 'movies'} right now: ${items.map(i => i.title).slice(0, 3).join(', ')}.`,
          highlights: items.slice(3).map(i => i.title),
          depth_available: false,
        },
      },
    }
  }

  // Lookup: search then fetch providers
  if (!title) return { success: false, error: 'A title is required' }
  const searchRes = await fetch(
    `${TMDB_BASE}/search/multi?query=${encodeURIComponent(title)}&api_key=${encodeURIComponent(apiKey)}&language=en-US&page=1`,
    { signal: AbortSignal.timeout(8000) },
  )
  if (!searchRes.ok) throw new Error('TMDB unavailable')
  const searchData = await searchRes.json() as { results?: Array<{ id: number; media_type?: string; title?: string; name?: string }> }
  const first = searchData.results?.find(r => r.media_type === 'movie' || r.media_type === 'tv')
  if (!first) {
    return { success: true, data: { mode: 'lookup', found: false, query: title, answer_payload: { gist: `I couldn't find "${title}" on TMDB.` } } }
  }
  const mediaType = first.media_type === 'tv' ? 'tv' : 'movie'
  const titleStr = first.title ?? first.name ?? title

  const provRes = await fetch(
    `${TMDB_BASE}/${mediaType}/${first.id}/watch/providers?api_key=${encodeURIComponent(apiKey)}`,
    { signal: AbortSignal.timeout(8000) },
  )
  if (!provRes.ok) throw new Error('TMDB unavailable')
  const provData = await provRes.json() as { results?: Record<string, TmdbProviders> }
  const cp = provData.results?.[country] ?? {}
  const streaming = (cp.flatrate ?? []).map(p => p.provider_name)
  const rent = (cp.rent ?? []).map(p => p.provider_name)
  const buy = (cp.buy ?? []).map(p => p.provider_name)

  const gist = streaming.length
    ? `${titleStr} is streaming on ${streaming.join(', ')}.`
    : rent.length
      ? `${titleStr} is available to rent on ${rent.slice(0, 3).join(', ')}.`
      : `${titleStr} is available to buy on ${(buy.slice(0, 3).join(', ') || 'some services')}.`

  return {
    success: true,
    data: {
      mode: 'lookup',
      found: true,
      title: titleStr,
      streaming,
      rent,
      buy,
      answer_payload: { gist, depth_available: false },
    },
  }
}

// ── Tool ──────────────────────────────────────────────────────────────────────

export const whereToWatchTool: Tool = {
  id: 'where-to-watch',
  name: 'Where to Watch',
  description: 'Find where a movie or TV show is streaming, or browse popular/new titles',
  offline: false,
  passMessage: 'query',
  dataSources: [
    { name: 'JustWatch', domain: 'justwatch.com', purpose: 'Streaming availability across services', type: 'api' },
    { name: 'TMDB', domain: 'themoviedb.org', purpose: 'Movie and TV show metadata (used when API key is configured)', type: 'api' },
  ],
  configSchema: [
    {
      key: 'tmdb_api_key',
      label: 'TMDB API Key',
      description: 'Free key from themoviedb.org. If set, uses the official TMDB streaming-providers API instead of an unofficial fallback.',
      type: 'secret' as const,
      scope: 'global' as const,
      placeholder: 'eyJhbGciOiJIUzI1NiJ9...',
    },
    {
      key: 'country',
      label: 'Country',
      description: 'ISO country code used for streaming availability (e.g. US, GB, CA)',
      type: 'string' as const,
      scope: 'user' as const,
      default: 'US',
      placeholder: 'US',
    },
  ],
  examples: [
    'where can I watch a specific movie or show — which streaming service has it',
    'is a movie or TV show available on Netflix, Hulu, Max, Disney+, or Prime',
    'is a movie still in theaters and where to buy tickets',
    'how to stream a film — subscription, rent, or buy options',
    'what is popular or trending on streaming right now',
    'what are the newest titles just added to a streaming service',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'where-to-watch',
      description: 'Find streaming availability for a title, or browse popular/new titles',
      parameters: {
        type: 'object',
        required: [],
        properties: {
          query: { type: 'string', description: 'The movie or show title (for a specific lookup)' },
          mode: { type: 'string', enum: ['lookup', 'popular', 'new'], description: 'lookup a title, or browse popular / new titles' },
          provider: { type: 'string', description: 'Optional streaming service to filter browse results, e.g. "Netflix"' },
          object_type: { type: 'string', enum: ['MOVIE', 'SHOW'], description: 'Optional: restrict to a movie or a TV show' },
        },
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const a = (args ?? {}) as { query?: string; mode?: string; provider?: string; object_type?: string }
    const rawQuery = (a.query ?? '').trim()
    const country = String(config?.['country'] ?? 'US').toUpperCase().trim() || 'US'
    const language = 'en'
    const tmdbKey = String(config?.['tmdb_api_key'] ?? '').trim()
    const userId = String(config?.['_userId'] ?? '').trim()

    // Mode: explicit arg wins; otherwise infer from the message.
    const explicitMode = a.mode?.toLowerCase()
    const mode: Mode = (explicitMode === 'popular' || explicitMode === 'new' || explicitMode === 'lookup')
      ? explicitMode
      : detectMode(rawQuery)

    // TMDB path — official free API, no consent needed
    if (tmdbKey) {
      try {
        return await runTmdb(rawQuery, mode, country, tmdbKey, a.object_type)
      } catch {
        // Fall through to JustWatch
      }
    }

    // JustWatch path — unofficial GraphQL endpoint
    try {
      if (mode === 'lookup') {
        if (!rawQuery) return { success: false, error: 'A title is required' }
        return await runLookup(rawQuery, country, language, a.object_type)
      }
      const providerQuery = (a.provider ?? '').trim() || detectProvider(rawQuery)
      return await runBrowse(mode, country, language, providerQuery)
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { success: false, offline: true, error: 'Network unavailable' }
      }
      return { success: false, error: String(err) }
    }
  },
}

// ── Lookup ──────────────────────────────────────────────────────────────────

async function runLookup(rawQuery: string, country: string, language: string, objectTypeArg?: string): Promise<ToolResult> {
  const title = cleanTitle(rawQuery)
  const objectType = (objectTypeArg?.toUpperCase() === 'MOVIE' || objectTypeArg?.toUpperCase() === 'SHOW')
    ? objectTypeArg.toUpperCase()
    : inferObjectType(rawQuery)

  const searchPayload = await postGraphql(SEARCH_QUERY, {
    country, language, first: 5, searchQuery: title, location: 'SearchSuggester',
  })
  if (!searchPayload) return { success: false, offline: true, error: 'JustWatch unavailable' }

  const edges = (((searchPayload.data as Record<string, unknown>)?.searchTitles as Record<string, unknown>)?.edges) as unknown[]
  if (!Array.isArray(edges) || !edges.length) {
    return { success: true, data: { mode: 'lookup', found: false, query: title, answer_payload: { gist: `I couldn't find "${title}" on JustWatch.` } } }
  }

  let nodes = edges
    .map(e => (e as Record<string, unknown>)?.node)
    .filter((n): n is Record<string, unknown> => !!n && typeof n === 'object')
  if (objectType) {
    const filtered = nodes.filter(n => String(n.objectType ?? '').toUpperCase() === objectType)
    if (filtered.length) nodes = filtered
  }
  const best = nodes.sort((x, y) =>
    titleSimilarity(title, String(contentOf(y).title ?? '')) - titleSimilarity(title, String(contentOf(x).title ?? '')),
  )[0]
  if (!best?.id) {
    return { success: true, data: { mode: 'lookup', found: false, query: title, answer_payload: { gist: `I couldn't find "${title}" on JustWatch.` } } }
  }

  const offersPayload = await postGraphql(OFFERS_QUERY, { entityId: String(best.id), country, language })
  const node = (offersPayload?.data as Record<string, unknown>)?.node as Record<string, unknown> | undefined
  const content = contentOf(node ?? best)
  const allOffers = parseProviders(node?.offers)
  // CINEMA offers are theatrical (Fandango, Regal, etc.) — surface them separately.
  const theaters = allOffers.filter(p => p.offerType === 'CINEMA')
  const providers = allOffers.filter(p => p.offerType !== 'CINEMA')

  const resolvedTitle = String(content.title ?? title)
  const resolvedYear = typeof content.originalReleaseYear === 'number' ? content.originalReleaseYear : null
  // JustWatch under-reports free/ad-supported services (and some titles entirely). When it
  // has no streaming options — and the title isn't theatrical-only — check secondary sources
  // (web search) so the answer isn't a false "not available". Skip for in-cinema titles, where
  // the web is dominated by "when will it come to X" speculation.
  const webProviders = providers.length === 0 && theaters.length === 0 ? await webStreamingFallback(resolvedTitle, resolvedYear) : []

  // Detail extras (verified live): real aggregate scores, stable external ids, cast/crew,
  // and JustWatch's own similar-titles list. All optional — older cache entries and thin
  // titles simply omit them.
  const scoringRaw = (content.scoring ?? {}) as Record<string, unknown>
  const scoring = {
    imdbScore: typeof scoringRaw.imdbScore === 'number' ? scoringRaw.imdbScore : null,
    imdbVotes: typeof scoringRaw.imdbVotes === 'number' ? Math.round(scoringRaw.imdbVotes) : null,
    tmdbScore: typeof scoringRaw.tmdbScore === 'number' ? scoringRaw.tmdbScore : null,
    tomatoMeter: typeof scoringRaw.tomatoMeter === 'number' ? scoringRaw.tomatoMeter : null,
    certifiedFresh: scoringRaw.certifiedFresh === true,
  }
  const externalIdsRaw = (content.externalIds ?? {}) as Record<string, unknown>
  const imdbId = externalIdsRaw.imdbId ? String(externalIdsRaw.imdbId) : null
  const tmdbId = externalIdsRaw.tmdbId ? String(externalIdsRaw.tmdbId) : null
  const creditsRaw = Array.isArray(content.credits) ? (content.credits as Array<Record<string, unknown>>) : []
  const cast = creditsRaw
    .filter((cr) => String(cr.role ?? '') === 'ACTOR' && cr.name)
    .slice(0, 24)
    .map((cr) => ({ name: String(cr.name), character: cr.characterName ? String(cr.characterName) : '' }))
  const directors = creditsRaw
    .filter((cr) => String(cr.role ?? '') === 'DIRECTOR' && cr.name)
    .slice(0, 4)
    .map((cr) => String(cr.name))
  const similarRaw = Array.isArray((node ?? best).similarTitles) ? ((node ?? best).similarTitles as Array<Record<string, unknown>>) : []
  const similarTitles = similarRaw
    .map((s) => {
      const c = (s.content ?? {}) as Record<string, unknown>
      if (!c.title) return null
      return {
        title: String(c.title),
        year: typeof c.originalReleaseYear === 'number' ? c.originalReleaseYear : null,
        objectType: String(s.objectType ?? '').toUpperCase(),
        posterUrl: posterUrl(String(c.posterUrl ?? '')),
      }
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)

  const data = {
    mode: 'lookup' as const,
    found: true,
    title: resolvedTitle,
    objectType: String((node ?? best).objectType ?? '').toUpperCase(),
    year: resolvedYear,
    shortDescription: String(content.shortDescription ?? ''),
    ageCertification: String(content.ageCertification ?? ''),
    runtimeMinutes: typeof content.runtime === 'number' ? content.runtime : null,
    posterUrl: posterUrl(String(content.posterUrl ?? '')),
    justwatchUrl: justwatchUrl(String(content.fullPath ?? '')),
    country,
    providers,
    theaters,
    webProviders,
    scoring,
    imdbId,
    tmdbId,
    cast,
    directors,
    similarTitles,
  }

  return { success: true, data: { ...data, answer_payload: deriveLookupPayload(data) } }
}

// ── Browse (popular / new) ────────────────────────────────────────────────────

async function runBrowse(mode: 'popular' | 'new', country: string, language: string, providerQuery: string): Promise<ToolResult> {
  let providerShortName = ''
  let providerName = providerQuery

  if (providerQuery) {
    const packagesPayload = await postGraphql(PACKAGES_QUERY, { country })
    const packages = ((packagesPayload?.data as Record<string, unknown>)?.packages ?? []) as Array<Record<string, unknown>>
    const resolved = resolveProviderShortName(providerQuery, Array.isArray(packages) ? packages : [])
    if (resolved) {
      providerShortName = resolved.shortName
      providerName = resolved.clearName
    } else {
      // Unknown provider — fall back to an unfiltered browse rather than failing.
      providerName = ''
    }
  }

  const providerFiltered = !!providerShortName
  const vars: Record<string, unknown> = { country, language, first: BROWSE_LIMIT }
  if (providerFiltered) vars.packages = [providerShortName]

  const payload = await postGraphql(browseQuery(mode, providerFiltered), vars)
  if (!payload) return { success: false, offline: true, error: 'JustWatch unavailable' }

  const key = mode === 'popular' ? 'popularTitles' : 'newTitles'
  const edges = (((payload.data as Record<string, unknown>)?.[key] as Record<string, unknown>)?.edges) as unknown[]
  const items = (Array.isArray(edges) ? edges : [])
    .map(e => (e as Record<string, unknown>)?.node)
    .filter((n): n is Record<string, unknown> => !!n && typeof n === 'object')
    .map(browseItemFromNode)
    .filter((i): i is BrowseItem => i !== null)

  if (!items.length) {
    // JustWatch's "new" feed only returns titled results when scoped to a service.
    const gist = (mode === 'new' && !providerName)
      ? "JustWatch doesn't offer a general new-releases feed — ask what's new on a specific service, e.g. \"what's new on Netflix\"."
      : `I couldn't find ${mode === 'popular' ? 'popular' : 'new'} titles${providerName ? ` on ${providerName}` : ''} right now.`
    return { success: true, data: { mode, found: false, country, provider: providerName, items: [], answer_payload: { gist } } }
  }

  const data = { mode, found: true, country, provider: providerName, items }
  return { success: true, data: { ...data, answer_payload: deriveBrowsePayload(mode, country, providerName, items) } }
}

// ── Answer payloads ───────────────────────────────────────────────────────────

function deriveLookupPayload(data: {
  title: string; year: number | null; country: string; providers: Provider[]; theaters: Provider[]
  runtimeMinutes: number | null; ageCertification: string; shortDescription: string; justwatchUrl: string
  webProviders?: WebProvider[]
}) {
  const yearText = data.year ? ` (${data.year})` : ''
  const theaterNames = data.theaters.map(t => t.name).join(', ')
  const inTheaters = data.theaters.length > 0
  const webNames = (data.webProviders ?? []).map(w => w.name)

  const highlights: string[] = []
  if (data.ageCertification) highlights.push(`Rating: ${data.ageCertification}`)
  if (data.runtimeMinutes && data.runtimeMinutes > 0) highlights.push(`Runtime: ${data.runtimeMinutes} minutes`)
  if (inTheaters) highlights.push(`In theaters — tickets via ${theaterNames}`)
  for (const p of data.providers.slice(0, 6)) highlights.push(`${p.name}: ${p.label}`)
  if (!data.providers.length && webNames.length) highlights.push(`Reported online (verify): ${webNames.join(', ')}`)

  const sources = data.justwatchUrl ? [{ url: data.justwatchUrl, title: data.title }] : []
  const depth_available = Boolean(data.shortDescription) || data.providers.length > 6

  // No streaming options on JustWatch — fall back to what secondary (web) sources report.
  if (!data.providers.length) {
    if (webNames.length) {
      const gist =
        `JustWatch lists no ${data.country} streaming for ${data.title}${yearText}, but other sources report it on ` +
        `${webNames.slice(0, 4).join(', ')} (often free/ad-supported services JustWatch misses — worth verifying).` +
        (inTheaters ? ` It's also in theaters now (tickets via ${theaterNames}).` : '')
      return { gist, highlights, sources, depth_available: true }
    }
    const gist = inTheaters
      ? `${data.title}${yearText} is in theaters now (tickets via ${theaterNames}); it isn't streaming in ${data.country} yet.`
      : `${data.title}${yearText} doesn't appear to be streaming in ${data.country} right now.`
    return { gist, highlights, sources, depth_available }
  }

  const lead = data.providers[0]!
  let gist = `${data.title}${yearText} is available in ${data.country} on ${lead.name} (${lead.label}).`
  if (inTheaters) gist += ` It's also in theaters now (tickets via ${theaterNames}).`
  return { gist, highlights, sources, depth_available }
}

function itemSummary(item: BrowseItem): string {
  const parts: string[] = []
  parts.push(item.year ? `${item.title} (${item.year})` : item.title)
  if (item.objectType === 'MOVIE') parts.push('movie')
  else if (item.objectType === 'SHOW') parts.push('show')
  if (item.providers.length) parts.push(item.providers[0]!.name)
  return parts.join(' • ')
}

function deriveBrowsePayload(mode: 'popular' | 'new', country: string, provider: string, items: BrowseItem[]) {
  const label = mode === 'popular' ? 'popular' : 'new'
  const providerText = provider ? ` on ${provider}` : ''
  return {
    gist: `Here are the top ${label} titles${providerText} in ${country}.`,
    highlights: items.slice(0, 5).map(itemSummary),
    sources: items.slice(0, 3)
      .filter(i => i.justwatchUrl)
      .map(i => ({ url: i.justwatchUrl, title: i.title })),
    depth_available: items.length > 5,
  }
}
