import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { lookupTitle } from '@/lib/titles/streaming'
import { parseFilmTitle, titleMatches } from '@/lib/titles/filmTitle'
import { ollamaChat } from '@/llm/ollama'
import { getExtractionModel } from '@/lib/models'
import { logger } from '@/lib/logger'
import type { AppEnv } from '@/types'

/**
 * Film metadata by title, for the video apps.
 *
 * YouTube's free movies carry junk titles: "FULL COMEDY MOVIE / GROWING UP,
 * BLACK NOTICE - Jason Statham". Two passes get from that to a real film:
 * plain code first (parseFilmTitle - no model, instant, handles most of
 * them), then a small LLM only when the code pass is unsure or JustWatch
 * finds nothing. The answer is the OFFICIAL record: real title, year,
 * synopsis, runtime, certificate, poster - never the uploader's text.
 *
 * Both passes are cached for a day here, and the apps cache matches on disk
 * forever, so a given film costs one lookup ever.
 */
const titlesRoute = new Hono<AppEnv>()

const CACHE_TTL = 24 * 60 * 60_000
const cache = new Map<string, { data: unknown; expiresAt: number }>()

const EXTRACT_SYSTEM =
  'You are given the title of a YouTube upload of a full-length film. Uploaders pad these ' +
  'with marketing: "FULL MOVIE", genre words, upload years, resolutions, and cast lists. ' +
  'Name the actual film. Answer with ONLY a JSON object: {"title": "...", "year": 1999} - ' +
  'year omitted if you cannot tell. If several film names appear, pick the one the upload ' +
  'is of. If it names no real film, answer {"title": ""}. No prose, no code fences.'

/** The LLM pass: only runs when code alone did not land a match. */
async function extractWithModel(raw: string): Promise<{ title: string; year?: number } | null> {
  try {
    const model = await getExtractionModel()
    const result = await ollamaChat(model, [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: raw.slice(0, 300) },
    ], undefined, { temperature: 0, num_predict: 80 }, undefined, 20_000)
    const match = result.message.content.match(/\{[\s\S]*?\}/)
    if (!match) return null
    const parsed = JSON.parse(match[0]) as { title?: unknown; year?: unknown }
    const title = typeof parsed.title === 'string' ? parsed.title.trim() : ''
    if (title.length < 2) return null
    const year = typeof parsed.year === 'number' && parsed.year > 1900 ? parsed.year : undefined
    return { title, year }
  } catch (err) {
    logger.warn({ err }, 'film title extraction failed')
    return null
  }
}

titlesRoute.get('/lookup', requireAuth, async (c) => {
  // `raw` is the uploader's title and gets both passes; `title` is a caller
  // that already knows the film name.
  const raw = (c.req.query('raw') ?? '').trim()
  const given = (c.req.query('title') ?? '').trim()
  const givenYear = Number(c.req.query('year')) || undefined
  const type = c.req.query('type') === 'show' ? 'SHOW' : 'MOVIE'
  if (!raw && !given) return c.json({ error: 'title or raw is required' }, 400)

  const key = `${type}:${(raw || given).toLowerCase()}:${givenYear ?? ''}`
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return c.json(hit.data)

  // Pass 1: code.
  const parsed = raw ? parseFilmTitle(raw) : { title: given, year: givenYear, uncertain: false }
  const title = parsed.title || given
  const year = parsed.year ?? givenYear

  // A hit has to actually correspond to the query - JustWatch fuzzy-matches
  // and will hand back "Fear" for "No Rules, No Fear ...".
  const verify = async (query: string, queryYear?: number) => {
    const hit = await lookupTitle(queryYear ? `${query} ${queryYear}` : query, type)
    if (!hit?.found) return null
    return titleMatches(query, hit.title, { queryYear, matchedYear: hit.year }) ? hit : null
  }

  let found = title ? await verify(title, year) : null

  // Pass 2: the model, but only when code alone didn't land a match. A
  // successful code match is never second-guessed - it is both cheaper and
  // more reliable than asking a 3B model to re-read marketing copy.
  let usedModel = false
  let modelTitle = ''
  if (!found?.found && raw) {
    const guess = await extractWithModel(raw)
    if (guess) {
      modelTitle = guess.title
      const second = await verify(guess.title, guess.year)
      if (second) { found = second; usedModel = true }
    }
  }

  const payload = found?.found
    ? {
        found: true,
        title: found.title,
        year: found.year,
        description: found.shortDescription,
        certificate: found.ageCertification,
        runtimeMinutes: found.runtimeMinutes,
        posterUrl: found.posterUrl,
        cast: found.cast.slice(0, 8).map((m) => m.name).filter(Boolean),
        directors: found.directors,
        score: found.scoring,
        via: usedModel ? 'model' : 'code',
      }
    // Even with no match, hand back the cleaned-up name so the app has
    // something better than the uploader's title to show.
    // No catalogue match: still hand back the best NAME we have, so the app
    // shows something readable instead of the uploader's marketing.
    : { found: false, title: modelTitle || title || given, year: year ?? null,
        via: modelTitle ? 'model' : 'code' }

  cache.set(key, { data: payload, expiresAt: Date.now() + CACHE_TTL })
  return c.json(payload)
})

export { titlesRoute }
