import type { Block, Source } from './blocks'

export function buildBlock(toolId: string, data: unknown): Block | null {
  try {
    switch (toolId) {
      case 'weather':      return buildWeatherBlock(data)
      case 'youtube':      return buildYouTubeBlock(data)
      case 'news':         return buildNewsBlock(data)
      case 'search':       return buildSearchBlock(data)
      case 'calculator':   return buildCalcBlock(data)
      case 'unit_conversion': return buildUnitBlock(data)
      case 'recipes':      return buildRecipeBlock(data)
      case 'dictionary':   return buildDictionaryBlock(data)
      case 'tvshows':      return buildTvShowBlock(data)
      case 'jokes':        return buildJokeBlock(data)
      case 'image_gen':    return buildImageGenBlock(data)
      case 'where-to-watch': return buildWhereToWatchBlock(data)
      case 'holidays':     return buildHolidaysBlock(data)
      case 'contentRating': return buildContentRatingBlock(data)
      default:             return null
    }
  } catch {
    return null
  }
}

const SOURCE_TOOLS = new Set(['search', 'news', 'youtube', 'where-to-watch', 'holidays', 'contentRating'])

export function extractSources(toolId: string, data: unknown): Source[] {
  if (!SOURCE_TOOLS.has(toolId)) return []
  try {
    const d = data as { answer_payload?: { sources?: Source[] } }
    return d?.answer_payload?.sources ?? []
  } catch {
    return []
  }
}

// ── Tool-specific builders ────────────────────────────────────────────────────

function buildContentRatingBlock(data: unknown): Block | null {
  const d = data as {
    found?: boolean
    title?: string
    ageRating?: string | null
    parentsNeedToKnow?: string | null
    categories?: Array<{ label: string; rating?: number; detail?: string }>
    url?: string
    fallback?: boolean
  }
  // Only render the card when there's something structured to show.
  const hasContent = !!d.ageRating || !!d.parentsNeedToKnow || (d.categories?.length ?? 0) > 0
  if (!d.found || !d.title || !hasContent) return null
  return {
    kind: 'content_rating',
    data: {
      title: d.title,
      ageRating: d.ageRating ?? null,
      parentsNeedToKnow: d.parentsNeedToKnow ?? null,
      categories: (d.categories ?? []).map((c) => ({ label: c.label, rating: c.rating, detail: c.detail })),
      url: d.url ?? '',
      fallback: d.fallback ?? false,
    },
  }
}

function buildWeatherBlock(data: unknown): Block | null {
  const d = data as {
    location?: string
    weather?: {
      current?: {
        temperature_2m?: number
        relative_humidity_2m?: number
        precipitation?: number
        weather_code?: number
        wind_speed_10m?: number
      }
      daily?: {
        time?: string[]
        temperature_2m_max?: number[]
        temperature_2m_min?: number[]
        precipitation_sum?: number[]
        weather_code?: number[]
      }
    }
  }
  const c = d.weather?.current
  if (!c) return null

  const daily = d.weather?.daily ?? {}
  const times = daily.time ?? []
  const tempC = Math.round(c.temperature_2m ?? 0)

  return {
    kind: 'weather',
    data: {
      location: d.location ?? '',
      tempC,
      tempF: Math.round(tempC * 9 / 5 + 32),
      humidity: Math.round(c.relative_humidity_2m ?? 0),
      precipMm: c.precipitation ?? 0,
      windKph: Math.round(c.wind_speed_10m ?? 0),
      code: c.weather_code ?? 0,
      forecast: times.slice(0, 5).map((date, i) => ({
        date,
        high: Math.round(daily.temperature_2m_max?.[i] ?? 0),
        low: Math.round(daily.temperature_2m_min?.[i] ?? 0),
        precipMm: daily.precipitation_sum?.[i] ?? 0,
        code: daily.weather_code?.[i] ?? 0,
      })),
    },
  }
}

function buildYouTubeBlock(data: unknown): Block | null {
  const d = data as {
    videos?: Array<{ videoId: string; title: string; url: string; snippet: string; embedUrl: string }>
  }
  if (!d.videos?.length) return null
  return {
    kind: 'youtube',
    data: {
      videos: d.videos.map(v => ({
        videoId: v.videoId,
        title: v.title,
        url: v.url,
        snippet: v.snippet,
        embedUrl: v.embedUrl,
      })),
    },
  }
}

function buildNewsBlock(data: unknown): Block | null {
  const d = data as {
    category?: string
    items?: Array<{ title: string; url: string; source: string; published: string; snippet: string }>
  }
  if (!d.items?.length) return null
  return {
    kind: 'news',
    data: {
      category: d.category,
      items: d.items.slice(0, 6),
    },
  }
}

const THEATER_RE = /\b(in theaters?|now (playing|showing)|in cinemas?|opens?\s+(in\s+)?theaters?|opening (weekend|day|friday)|theatrical release)\b/i

function buildSearchBlock(data: unknown): Block | null {
  const d = data as {
    results?: Array<{ title: string; snippet: string; url: string }>
    answer_payload?: { sources?: Source[] }
  }
  if (!d.results?.length) return null
  const results = d.results.slice(0, 5)
  const inTheaters = results.some(r => THEATER_RE.test(r.title) || THEATER_RE.test(r.snippet))
  return {
    kind: 'search',
    data: {
      results,
      sources: d.answer_payload?.sources ?? [],
      ...(inTheaters && { inTheaters: true }),
    },
  }
}

function buildCalcBlock(data: unknown): Block | null {
  const d = data as { expression?: string; result?: number; result_str?: string }
  if (d.result === undefined) return null
  return {
    kind: 'calculator',
    data: {
      expression: d.expression ?? '',
      result: d.result,
      resultStr: d.result_str ?? String(d.result),
    },
  }
}

function buildUnitBlock(data: unknown): Block | null {
  const d = data as {
    value?: number; from_unit?: string; to_unit?: string
    result?: number; result_str?: string; category?: string
  }
  if (d.result === undefined) return null
  return {
    kind: 'unit_conversion',
    data: {
      value: d.value ?? 0,
      fromUnit: d.from_unit ?? '',
      toUnit: d.to_unit ?? '',
      result: d.result,
      resultStr: d.result_str ?? String(d.result),
      category: d.category ?? '',
    },
  }
}

function buildRecipeBlock(data: unknown): Block | null {
  const d = data as {
    found?: boolean; name?: string; category?: string; area?: string
    thumbnail?: string; instructions?: string; ingredients?: string[]
    youtube?: string; source?: string
  }
  if (!d.found || !d.name) return null
  return {
    kind: 'recipe',
    data: {
      name: d.name,
      category: d.category ?? '',
      area: d.area ?? '',
      thumbnail: d.thumbnail ?? '',
      instructions: d.instructions ?? '',
      ingredients: d.ingredients ?? [],
      youtube: d.youtube ?? '',
      source: d.source ?? '',
    },
  }
}

function buildDictionaryBlock(data: unknown): Block | null {
  const d = data as {
    found?: boolean; word?: string; phonetic?: string
    senses?: Array<{ part_of_speech: string; definition: string; example: string }>
  }
  if (!d.found || !d.word) return null
  return {
    kind: 'dictionary',
    data: {
      word: d.word,
      phonetic: d.phonetic ?? '',
      senses: (d.senses ?? []).map(s => ({
        partOfSpeech: s.part_of_speech,
        definition: s.definition,
        example: s.example,
      })),
    },
  }
}

function buildTvShowBlock(data: unknown): Block | null {
  const d = data as {
    found?: boolean; name?: string; network?: string; status?: string
    summary?: string; premiered?: string; ended?: string; genres?: string[]
    rating?: number | null; season_count?: number; image?: string; url?: string
    recent_news?: Array<{ title: string; snippet: string; url: string }>
  }
  if (!d.found || !d.name) return null
  return {
    kind: 'tvshow',
    data: {
      name: d.name,
      network: d.network ?? '',
      status: d.status ?? '',
      summary: d.summary ?? '',
      premiered: d.premiered ?? '',
      ended: d.ended ?? '',
      genres: d.genres ?? [],
      rating: d.rating ?? null,
      seasonCount: d.season_count ?? 0,
      image: d.image ?? '',
      url: d.url ?? '',
      recentNews: d.recent_news ?? [],
    },
  }
}

function buildJokeBlock(data: unknown): Block | null {
  const d = data as { joke?: string; answer_payload?: { gist?: string } }
  const joke = d.joke ?? d.answer_payload?.gist ?? ''
  if (!joke) return null
  return { kind: 'joke', data: { joke } }
}

function buildImageGenBlock(data: unknown): Block | null {
  const d = data as { imageId?: string; prompt?: string; status?: string }
  if (!d.imageId) return null
  return {
    kind: 'image_gen',
    data: {
      imageId: d.imageId,
      prompt: d.prompt ?? '',
      status: (d.status as 'building' | 'ready' | 'failed' | 'cancelled') ?? 'building',
    },
  }
}

function buildWhereToWatchBlock(data: unknown): Block | null {
  type Provider = { name: string; offerType: string; label: string; url: string }
  type Item = { title: string; year?: number | null; objectType?: string; posterUrl?: string; justwatchUrl?: string; providers?: Provider[] }
  const d = data as {
    mode?: string; found?: boolean; country?: string
    title?: string; year?: number | null; objectType?: string
    ageCertification?: string; runtimeMinutes?: number | null; posterUrl?: string
    justwatchUrl?: string; provider?: string
    providers?: Provider[]; theaters?: Provider[]; items?: Item[]
  }
  if (!d.found) return null

  // Browse modes (popular / new) → a list of titles.
  if (d.mode === 'popular' || d.mode === 'new') {
    if (!d.items?.length) return null
    return {
      kind: 'where_to_watch',
      data: {
        mode: 'browse',
        country: d.country ?? '',
        browseLabel: d.mode === 'popular' ? 'Popular' : 'New',
        provider: d.provider ?? '',
        items: d.items.map(it => ({
          title: it.title,
          year: it.year ?? null,
          objectType: it.objectType ?? '',
          posterUrl: it.posterUrl ?? '',
          justwatchUrl: it.justwatchUrl ?? '',
          providers: it.providers ?? [],
        })),
      },
    }
  }

  // Lookup mode → single title with its providers.
  if (!d.title) return null
  return {
    kind: 'where_to_watch',
    data: {
      mode: 'lookup',
      title: d.title,
      year: d.year ?? null,
      objectType: d.objectType ?? '',
      ageCertification: d.ageCertification ?? '',
      runtimeMinutes: d.runtimeMinutes ?? null,
      posterUrl: d.posterUrl ?? '',
      justwatchUrl: d.justwatchUrl ?? '',
      country: d.country ?? '',
      providers: d.providers ?? [],
      theaters: d.theaters ?? [],
    },
  }
}

function buildHolidaysBlock(data: unknown): Block | null {
  const d = data as {
    mode?: 'lookup' | 'list'; found?: boolean; country?: string; year?: number
    partial?: boolean
    holiday?: { name: string; date: string; weekday: string }
    holidays?: Array<{ name: string; date: string; weekday: string }>
  }
  if (!d.found) return null
  if (d.mode === 'lookup' && !d.holiday) return null
  if (d.mode === 'list' && !(d.holidays && d.holidays.length)) return null
  return {
    kind: 'holidays',
    data: {
      mode: d.mode ?? 'lookup',
      country: d.country ?? '',
      year: d.year ?? new Date().getFullYear(),
      partial: d.partial,
      holiday: d.holiday,
      holidays: d.holidays,
    },
  }
}
