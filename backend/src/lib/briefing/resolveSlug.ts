// Resolve the effective Patch.com slug for a location. Patch slugs are NOT always a clean
// "<state>/<town>" — there are regional patches, multi-word towns, and neighborhood patches —
// so a deterministic derive misses many places. Resolution order:
//   1. caller's explicit admin override (handled by the caller, not here)
//   2. deterministic deriveSlug(), validated against patch.com  (free, no LLM)
//   3. AI: ask the local model for candidate slugs, validate each against patch.com
// Successful resolutions are cached (location → slug) so the LLM runs at most once per town.
// Failures are NOT cached, so a transient patch.com/Ollama outage self-heals on the next call.

import { structuredCall } from '@/llm/structured'
import { getModel } from '@/lib/models'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { deriveSlug } from './slug'
import { patchSlugHasNews } from './sources/patch'

const CACHE_KEY = 'briefing.patch_slug_resolved' // { [location]: slug }

const AI_SYSTEM = `You map a US town/city to its Patch.com community URL slug.
A Patch slug looks like "<state-name>/<town>", all lowercase, full state name (NOT the abbreviation).
Multi-word town names are inconsistent on Patch — some hyphenate, some run the words together —
so offer BOTH forms as candidates. Some towns also belong to a shared regional Patch.
Examples:
- "Milford, CT" -> "connecticut/milford"
- "New Haven, CT" -> ["connecticut/newhaven", "connecticut/new-haven"]
- "Park Slope, Brooklyn, NY" -> "new-york/park-slope"
Respond ONLY with JSON: {"slugs": ["best-guess", "second-guess", "third-guess"]}
Give up to 3 candidates, most likely first. No path prefix, no domain, no leading slash.`

function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/(www\.)?patch\.com\//i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()
}

async function aiResolve(location: string): Promise<string | null> {
  let candidates: string[]
  try {
    const model = await getModel()
    const out = await structuredCall<{ slugs?: unknown }>(model, `Town: ${location}`, AI_SYSTEM)
    candidates = (Array.isArray(out.slugs) ? out.slugs : [])
      .filter((s): s is string => typeof s === 'string')
      .map(normalizeSlug)
      .filter(Boolean)
      .slice(0, 3)
  } catch {
    return null // Ollama unavailable → caller falls back to web search
  }
  for (const slug of candidates) {
    if (await patchSlugHasNews(slug)) return slug
  }
  return null
}

/**
 * Best effort Patch slug for `location` (e.g. "Milford, CT"), or null if none can be found.
 * Tries a deterministic derive first, then the local model. Caches successes only.
 */
export async function resolvePatchSlug(location: string | null | undefined): Promise<string | null> {
  const loc = location?.trim()
  if (!loc) return null

  const cache = ((await getAppSetting(CACHE_KEY)) as Record<string, string> | null) ?? {}
  if (cache[loc]) return cache[loc]!

  const derived = deriveSlug(loc)
  const slug = derived && (await patchSlugHasNews(derived)) ? derived : await aiResolve(loc)

  if (slug) await setAppSetting(CACHE_KEY, { ...cache, [loc]: slug })
  return slug
}
