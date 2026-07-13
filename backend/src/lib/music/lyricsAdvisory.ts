// Music kid-safety: derive an explicit/clean advisory from a track's LYRICS when the catalog
// flags (iTunes/Deezer/tags) don't know it. Deezer/iTunes leave a large `unknown` population;
// for a teen profile (unknown = allow) those slip through, so a background LRCLIB lyric scan
// via the fast model upgrades unknowns to a real verdict, written under source 'llm'.
//
// Kept OUT of advisory.ts on purpose: this reads lyrics from routes/musicInfo, which itself
// imports advisory.ts — putting the scan here (advisory does not import this) avoids a cycle.

import { getAdvisories, upsertAdvisory } from '@/lib/music/advisory'
import { plainLyricsForAlign } from '@/routes/musicInfo'
import { getFastModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'
import { logger } from '@/lib/logger'

const EXPLICIT_SCHEMA = {
  type: 'object',
  properties: { explicit: { type: 'boolean' } },
  required: ['explicit'],
} as const

const SYSTEM =
  'You label song lyrics for a family music player. Given the lyrics, decide whether the song ' +
  'is EXPLICIT: contains strong profanity, slurs, explicit sexual content, or graphic violence a ' +
  'parent would not want a young child to hear. Ordinary lyrics (love songs, mild themes) are not ' +
  'explicit. Output JSON only: {"explicit": true|false}.'

/** Scan one track's lyrics → 1 (explicit) / 0 (clean) / null (no lyrics or error). */
async function scanLyrics(artist: string, title: string): Promise<number | null> {
  try {
    const lyrics = await plainLyricsForAlign(artist, title)
    if (!lyrics || !lyrics.trim()) return null            // instrumental / unknown → leave unknown
    const model = await getFastModel()
    const chat = await ollamaChat(
      model,
      [{ role: 'system', content: SYSTEM }, { role: 'user', content: lyrics.slice(0, 4000) }],
      [], { temperature: 0, num_predict: 20 }, EXPLICIT_SCHEMA,
    )
    const parsed = JSON.parse(chat.message?.content?.trim() || '{}') as { explicit?: boolean }
    return parsed.explicit === true ? 1 : 0
  } catch (err) {
    logger.debug(`[lyricsAdvisory] scan failed for ${artist} - ${title}: ${String(err)}`)
    return null
  }
}

// Background fill for tracks still `unknown` after catalog lookups: bounded, deduped,
// fire-and-forget. A stored 'llm' verdict (precedence below manual/tag; see advisory
// SOURCE_RANK) means the next queue build filters it correctly. Never blocks playback.
const inFlight = new Set<string>()
export function ensureLyricAdvisories(tracks: Array<{ videoId: string; title: string; artist: string }>): void {
  void (async () => {
    try {
      if (!tracks.length) return
      const known = await getAdvisories(tracks.map(t => t.videoId))
      // Only tracks with NO advisory row at all (catalog lookups haven't resolved them either).
      const todo = tracks.filter(t => !known.has(t.videoId) && t.artist && t.title && !inFlight.has(t.videoId)).slice(0, 15)
      for (const t of todo) inFlight.add(t.videoId)
      for (const t of todo) {
        try {
          const verdict = await scanLyrics(t.artist, t.title)
          if (verdict !== null) await upsertAdvisory(t.videoId, verdict, 'llm', { title: t.title, artist: t.artist })
        } finally {
          inFlight.delete(t.videoId)
        }
      }
    } catch (err) {
      logger.debug(`[lyricsAdvisory] ensureLyricAdvisories failed: ${String(err)}`)
    }
  })()
}
