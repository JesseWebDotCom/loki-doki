// Where-to-stream for a title, plus popular/trending browse — thin wrappers over the
// existing whereToWatch tool (keyless JustWatch). Shared by Shows and Movies so both get
// identical streaming chips and discovery rows without re-implementing the GraphQL.

import { whereToWatchTool } from '@/tools/whereToWatch'
import { webStreamingFallback, type WebProvider } from './streamingFallback'
import type { CastMember, SimilarTitle, StreamProvider, TitleScoring } from './types'

export { webStreamingFallback } from './streamingFallback'
export type { WebProvider } from './streamingFallback'

export interface StreamingInfo {
  providers: StreamProvider[]
  theaters: StreamProvider[]
  justwatchUrl: string | null
  // Real aggregate scores (IMDb/RT/TMDB) relayed by JustWatch, when known.
  scoring?: TitleScoring | null
  imdbId?: string | null
  // Filled only when JustWatch reports no streaming options: services a keyless web search
  // suggests carry the title (esp. free/ad-supported ones JustWatch tracks poorly — Tubi,
  // Pluto, Plex, Freevee, the Roku Channel). Best-effort, hence "reported".
  webProviders?: WebProvider[]
}

export interface BrowseTitle {
  title: string
  year: number | null
  objectType: 'MOVIE' | 'SHOW' | string
  posterUrl: string
  justwatchUrl: string
  providers: StreamProvider[]
}

const EMPTY: StreamingInfo = { providers: [], theaters: [], justwatchUrl: null }

export async function getStreaming(
  title: string,
  objectType: 'MOVIE' | 'SHOW',
  country = 'US',
  year: number | null = null,
): Promise<StreamingInfo> {
  try {
    const res = await whereToWatchTool.execute({ query: title, mode: 'lookup', object_type: objectType }, { country })
    const d = (res.success && res.data ? res.data : {}) as {
      found?: boolean
      providers?: StreamProvider[]
      theaters?: StreamProvider[]
      justwatchUrl?: string
      scoring?: TitleScoring | null
      imdbId?: string | null
    }
    const providers = d.found ? d.providers ?? [] : []
    const theaters = d.found ? d.theaters ?? [] : []
    const justwatchUrl = d.found ? d.justwatchUrl ?? null : null
    // JustWatch under-reports free/ad-supported services and some titles entirely — when it
    // shows no streaming options (and the title isn't theatrical-only), supplement with a
    // web-search check.
    const webProviders = providers.length === 0 && theaters.length === 0 ? await webStreamingFallback(title, year) : []
    return { providers, theaters, justwatchUrl, webProviders, scoring: d.found ? d.scoring ?? null : null, imdbId: d.found ? d.imdbId ?? null : null }
  } catch {
    return EMPTY
  }
}

export interface TitleLookup {
  found: boolean
  title: string
  year: number | null
  shortDescription: string
  ageCertification: string
  runtimeMinutes: number | null
  posterUrl: string
  justwatchUrl: string | null
  providers: StreamProvider[]
  theaters: StreamProvider[]
  scoring: TitleScoring | null
  imdbId: string | null
  tmdbId: string | null
  cast: CastMember[]
  directors: string[]
  similarTitles: SimilarTitle[]
}

/** Full JustWatch lookup for a title — metadata + streaming. The Movies app uses this as its
 *  primary metadata source (there's no keyless movie equivalent of TVMaze). */
export async function lookupTitle(title: string, objectType: 'MOVIE' | 'SHOW', country = 'US'): Promise<TitleLookup | null> {
  try {
    const res = await whereToWatchTool.execute({ query: title, mode: 'lookup', object_type: objectType }, { country })
    if (!res.success || !res.data) return null
    const d = res.data as Partial<TitleLookup> & { found?: boolean }
    if (!d.found) return { ...EMPTY_LOOKUP, found: false, title }
    return {
      found: true,
      title: d.title ?? title,
      year: d.year ?? null,
      shortDescription: d.shortDescription ?? '',
      ageCertification: d.ageCertification ?? '',
      runtimeMinutes: d.runtimeMinutes ?? null,
      posterUrl: d.posterUrl ?? '',
      justwatchUrl: d.justwatchUrl ?? null,
      providers: d.providers ?? [],
      theaters: d.theaters ?? [],
      scoring: d.scoring ?? null,
      imdbId: d.imdbId ?? null,
      tmdbId: d.tmdbId ?? null,
      cast: d.cast ?? [],
      directors: d.directors ?? [],
      similarTitles: d.similarTitles ?? [],
    }
  } catch {
    return null
  }
}

const EMPTY_LOOKUP: TitleLookup = {
  found: false,
  title: '',
  year: null,
  shortDescription: '',
  ageCertification: '',
  runtimeMinutes: null,
  posterUrl: '',
  justwatchUrl: null,
  providers: [],
  theaters: [],
  scoring: null,
  imdbId: null,
  tmdbId: null,
  cast: [],
  directors: [],
  similarTitles: [],
}

/** JustWatch popular titles, optionally filtered to MOVIE or SHOW. */
export async function getPopularTitles(objectType?: 'MOVIE' | 'SHOW', country = 'US'): Promise<BrowseTitle[]> {
  try {
    const res = await whereToWatchTool.execute({ mode: 'popular', object_type: objectType }, { country })
    if (!res.success || !res.data) return []
    const items = ((res.data as { items?: BrowseTitle[] }).items ?? [])
    return objectType ? items.filter((i) => String(i.objectType).toUpperCase() === objectType) : items
  } catch {
    return []
  }
}
