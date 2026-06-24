// Keyless web-search fallback for "where to watch". JustWatch (our primary streaming source)
// under-reports free / ad-supported services (Tubi, Pluto, Plex, Freevee, the Roku Channel)
// and sometimes whole titles whose US rights are scattered — reporting "not available" when
// the show actually streams. When JustWatch shows nothing, we ask the web and pull recognized
// service names out of the snippets. Best-effort + cached; lives in its own module so both the
// streaming helper and the whereToWatch tool can use it without an import cycle.

import { webSearch } from '@/lib/webSearch'
import { cachedLookup } from '@/lib/lookupCache'

export interface WebProvider {
  name: string
  searchUrl: string
}

// Weighted toward the free/ad-supported (FAST/AVOD) services JustWatch tracks poorly, plus
// the majors.
const KNOWN_SERVICES: Array<{ name: string; aliases: string[] }> = [
  { name: 'Netflix', aliases: ['netflix'] },
  { name: 'Hulu', aliases: ['hulu'] },
  { name: 'Max', aliases: ['hbo max', ' max '] },
  { name: 'Disney+', aliases: ['disney+', 'disney plus'] },
  { name: 'Prime Video', aliases: ['prime video', 'amazon prime'] },
  { name: 'Peacock', aliases: ['peacock'] },
  { name: 'Paramount+', aliases: ['paramount+', 'paramount plus'] },
  { name: 'Apple TV+', aliases: ['apple tv+', 'apple tv plus'] },
  { name: 'Tubi', aliases: ['tubi'] },
  { name: 'Pluto TV', aliases: ['pluto tv', 'pluto'] },
  { name: 'Plex', aliases: ['plex'] },
  { name: 'The Roku Channel', aliases: ['roku channel'] },
  { name: 'Amazon Freevee', aliases: ['freevee'] },
  { name: 'Crackle', aliases: ['crackle'] },
  { name: 'Starz', aliases: ['starz'] },
  { name: 'Showtime', aliases: ['showtime'] },
  { name: 'AMC+', aliases: ['amc+', 'amc plus'] },
  { name: 'Crunchyroll', aliases: ['crunchyroll'] },
  { name: 'Kanopy', aliases: ['kanopy'] },
  { name: 'Hoopla', aliases: ['hoopla'] },
]

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

// Affirmative "it's available here" phrasing that must appear NEAR a service name to count it.
const POSITIVE_CUES = [
  'streaming on', 'streams on', 'now streaming', 'available on', 'available to stream', 'watch on',
  'watch it on', 'stream it on', 'you can watch', 'now on', 'currently on', 'free on', 'find it on',
  'is streaming', 'is available on', 'is on',
]
// Negation / future / speculation that disqualifies a nearby service mention. The Backrooms
// case ("not yet available to stream on Max", "when will it be on Max") is exactly this.
const NEGATIVE_CUES = [
  'not ', "isn't", 'is not', "won't", 'will not', 'no ', 'yet', 'will be', 'will it', 'when will',
  'coming to', 'coming soon', 'expected', 'release date', 'releases on', 'hit the platform', 'be available',
  'rumor', 'rumour', 'leaving', 'expiring', 'expires', 'not yet', 'theaters only', 'theatres only', 'in theaters',
]

function mentionedAffirmatively(text: string, aliases: string[]): boolean {
  for (const alias of aliases) {
    let from = 0
    for (;;) {
      const i = text.indexOf(alias, from)
      if (i < 0) break
      from = i + alias.length
      const window = text.slice(Math.max(0, i - 90), i + alias.length + 25)
      if (NEGATIVE_CUES.some((c) => window.includes(c))) continue
      if (POSITIVE_CUES.some((c) => window.includes(c))) return true
    }
  }
  return false
}

export async function webStreamingFallback(title: string, year: number | null): Promise<WebProvider[]> {
  const key = `${title.toLowerCase()}:${year ?? ''}`
  return cachedLookup('streaming-web-fallback-v2', key, SEVEN_DAYS_MS, async () => {
    try {
      const q = `${title}${year ? ` ${year}` : ''} where to watch stream`
      const results = await webSearch(q, 6)
      // Pad with spaces so the " max " word-boundary alias behaves.
      const text = ' ' + results.map((r) => `${r.title} ${r.snippet}`).join('  ').toLowerCase() + ' '
      const found: WebProvider[] = []
      for (const svc of KNOWN_SERVICES) {
        // Require affirmative, non-negated context near the service name — avoids matching
        // "not yet on Max" / "when will it come to Netflix".
        if (mentionedAffirmatively(text, svc.aliases)) {
          found.push({
            name: svc.name,
            searchUrl: `https://www.google.com/search?q=${encodeURIComponent(`watch ${title} on ${svc.name}`)}`,
          })
        }
      }
      return found
    } catch {
      return []
    }
  })
}
