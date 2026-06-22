import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'

const API = 'https://api.dictionaryapi.dev/api/v2/entries/en'

interface PhoneticRaw { text?: string; audio?: string }
interface DefinitionRaw { definition?: string; example?: string }
interface MeaningRaw { partOfSpeech?: string; definitions?: DefinitionRaw[] }
interface EntryRaw {
  word?: string
  phonetic?: string
  phonetics?: PhoneticRaw[]
  meanings?: MeaningRaw[]
}

interface Definition { definition: string; example?: string }
interface Meaning { partOfSpeech: string; definitions: Definition[] }
interface DictionaryResult {
  word: string
  phonetic?: string
  audio: string | null
  meanings: Meaning[]
  error?: string
}

// 1-hour in-memory cache keyed by lowercase word
const cache = new Map<string, { data: DictionaryResult; expiresAt: number }>()
const CACHE_TTL = 60 * 60 * 1000

const dictionaryRoute = new Hono<AppEnv>()

dictionaryRoute.get('/', requireAuth, async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  if (!q) return c.json({ error: 'q is required' }, 400)

  const key = q.toLowerCase()

  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    return c.json(cached.data)
  }

  let result: DictionaryResult

  try {
    const res = await fetch(`${API}/${encodeURIComponent(key)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    })

    if (res.status === 404) {
      result = { word: q, audio: null, meanings: [], error: 'not_found' }
      cache.set(key, { data: result, expiresAt: Date.now() + CACHE_TTL })
      return c.json(result)
    }

    if (!res.ok) {
      return c.json({ word: q, audio: null, meanings: [], error: `api_error_${res.status}` })
    }

    const payload = (await res.json()) as unknown[]
    if (!Array.isArray(payload) || !payload.length) {
      result = { word: q, audio: null, meanings: [], error: 'not_found' }
      cache.set(key, { data: result, expiresAt: Date.now() + CACHE_TTL })
      return c.json(result)
    }

    const entry = payload[0] as EntryRaw

    // Phonetic text: prefer top-level, fall back to first phonetics entry with text
    let phonetic = entry.phonetic ?? ''
    if (!phonetic) {
      for (const p of entry.phonetics ?? []) {
        if (p.text) { phonetic = p.text; break }
      }
    }

    // Audio: first phonetics entry with a non-empty audio URL
    let audio: string | null = null
    for (const p of entry.phonetics ?? []) {
      if (p.audio) { audio = p.audio; break }
    }

    // Meanings
    const meanings: Meaning[] = (entry.meanings ?? []).map((m) => ({
      partOfSpeech: m.partOfSpeech ?? '',
      definitions: (m.definitions ?? []).map((d) => ({
        definition: d.definition ?? '',
        ...(d.example ? { example: d.example } : {}),
      })),
    }))

    result = {
      word: entry.word ?? q,
      phonetic: phonetic || undefined,
      audio,
      meanings,
    }
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError'
    return c.json({ word: q, audio: null, meanings: [], error: isTimeout ? 'offline' : 'fetch_error' })
  }

  cache.set(key, { data: result, expiresAt: Date.now() + CACHE_TTL })
  return c.json(result)
})

export { dictionaryRoute }
