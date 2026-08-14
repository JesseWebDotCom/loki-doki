// Resolve the effective Patch.com slug for a location. Patch slugs are NOT always a clean
// "<state>/<town>" — there are regional patches, multi-word towns, and neighborhood patches —
// so a deterministic derive misses many places. Resolution order:
//   1. caller's explicit admin override (handled by the caller, not here)
//   2. deterministic deriveSlug(), validated against patch.com  (free, no LLM)
//   3. AI: ask the local model for candidate slugs, validate each against patch.com
// Successful resolutions are cached (location → slug) so the LLM runs at most once per town.
//
// Failures are cached too, but only for MISS_TTL_MS, which is the compromise between two
// real problems. Never caching them (the original behavior) meant a town with no Patch
// community at all - most of the country outside the Northeast - re-ran the local model on
// every single request forever: asking the News app for Austin, TX took over 60s and timed
// out at the proxy, every time, permanently (Jesse, 2026-08-13). Caching them forever would
// mean a town that was merely unlucky during a patch.com or Ollama blip stays broken until
// someone clears app_settings by hand. A week is long enough that the model runs about
// once per town, short enough that a bad day heals itself.

import { structuredCall } from '@/llm/structured'
import { getModel } from '@/lib/models'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { deriveSlug } from './slug'
import { patchSlugHasNews } from './sources/patch'

const CACHE_KEY = 'briefing.patch_slug_resolved' // { [location]: slug }
// Kept in its OWN key rather than as a null in the map above, so the existing hit cache
// keeps its shape and every other reader of it is untouched.
const MISS_KEY = 'briefing.patch_slug_missed' // { [location]: checkedAtMs }
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000

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
 * Tries a deterministic derive first, then the local model. Caches hits forever and misses
 * for a week. Slow on a cold town by design: callers that cannot wait use `peekPatchSlug`.
 */
// One resolution per town at a time. The News app now kicks this off in the background on
// a cache miss, and a client that retries (or a phone and a TV asking together) would
// otherwise start a second and third model call for the same town while the first is still
// running.
const inFlight = new Map<string, Promise<string | null>>()

export function resolvePatchSlug(location: string | null | undefined): Promise<string | null> {
  const loc = location?.trim()
  if (!loc) return Promise.resolve(null)
  const running = inFlight.get(loc)
  if (running) return running
  const task = resolveUncached(loc).finally(() => inFlight.delete(loc))
  inFlight.set(loc, task)
  return task
}

async function resolveUncached(loc: string): Promise<string | null> {
  const cache = ((await getAppSetting(CACHE_KEY)) as Record<string, string> | null) ?? {}
  if (cache[loc]) return cache[loc]!

  const misses = ((await getAppSetting(MISS_KEY)) as Record<string, number> | null) ?? {}
  const missedAt = misses[loc]
  if (missedAt && Date.now() - missedAt < MISS_TTL_MS) return null

  const derived = deriveSlug(loc)
  const slug = derived && (await patchSlugHasNews(derived)) ? derived : await aiResolve(loc)

  if (slug) {
    await setAppSetting(CACHE_KEY, { ...cache, [loc]: slug })
    if (missedAt !== undefined) {
      // It resolved this time: drop the tombstone rather than leaving a stale one behind.
      const { [loc]: _gone, ...rest } = misses
      await setAppSetting(MISS_KEY, rest)
    }
  } else {
    await setAppSetting(MISS_KEY, { ...misses, [loc]: Date.now() })
  }
  return slug
}

/**
 * The cached answer ONLY: never derives, never fetches patch.com, never calls the model.
 *
 * For request paths that must not stall. `known: false` means nobody has ever asked about
 * this town (or its tombstone has expired), and the caller is expected to serve whatever it
 * can without Patch and kick off a real `resolvePatchSlug` in the background so the next
 * request is answerable. See routes/news.ts.
 */
export async function peekPatchSlug(
  location: string | null | undefined,
): Promise<{ known: boolean; slug: string | null }> {
  const loc = location?.trim()
  if (!loc) return { known: true, slug: null }

  const cache = ((await getAppSetting(CACHE_KEY)) as Record<string, string> | null) ?? {}
  if (cache[loc]) return { known: true, slug: cache[loc]! }

  const misses = ((await getAppSetting(MISS_KEY)) as Record<string, number> | null) ?? {}
  const missedAt = misses[loc]
  if (missedAt && Date.now() - missedAt < MISS_TTL_MS) return { known: true, slug: null }

  return { known: false, slug: null }
}
