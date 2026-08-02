// Candidate-pool persistence + the generic serve flow every suggestion rail shares.
// A pool is a ranked Candidate[] (~150 entries, payloads included, plus title embedding
// vectors where available for serve-time semantic capping)
// built in the background and cached 6h. Serving is cheap and always current where it
// matters: the watched set is queried live per request, dismissals hard-exclude, and
// shownCount demotes so the rail rotates instead of repeating.

import { cachedLookupPut, cachedLookupStale } from '@/lib/lookupCache'
import { logger } from '@/lib/logger'
import { getImpressions, recordShown } from './impressions'
import { capPerCreator } from './rank'
import type { InterestDomain, RankedCandidate } from './types'

// BUMP THE VERSION whenever gating/ranking rules change: pools built under old
// rules keep serving for up to 6h otherwise — and pre-vector pools bypass the
// semantic caps entirely (no vec = exempt). v7: autoplay-chain watches never seed and barely signal.
const NAMESPACE = 'interests:pool:v7'
export const POOL_TTL_MS = 6 * 60 * 60 * 1000
/** Thin-history pools re-check sooner: a new user's first few watches should start
 *  producing suggestions within the hour, not tomorrow. */
export const EMPTY_POOL_TTL_MS = 30 * 60 * 1000
export const POOL_SIZE = 150

// `variant` splits a domain's pool when candidate generation itself depends on request
// context (shows/movies bake age-certification filters into the pool, so kid/teen/open
// each build their own — a tier switch then triggers a fresh build instead of serving a
// pool built under different rules).
const poolKey = (userId: string, domain: InterestDomain, variant = '') =>
  `${domain}:${userId}${variant ? `:${variant}` : ''}`

export async function savePool(
  userId: string,
  domain: InterestDomain,
  entries: RankedCandidate[],
  ttlMs = POOL_TTL_MS,
  variant = '',
): Promise<void> {
  await cachedLookupPut(NAMESPACE, poolKey(userId, domain, variant), ttlMs, entries.slice(0, POOL_SIZE))
}

// One build per (user, domain) at a time; concurrent rail hits coalesce (relatedTopics'
// in-flight pattern). Builds are fire-and-forget from request paths.
const _building = new Map<string, Promise<void>>()

export function kickPoolBuild(userId: string, domain: InterestDomain, build: () => Promise<void>, variant = ''): void {
  const key = poolKey(userId, domain, variant)
  if (_building.has(key)) return
  const p = build()
    .catch((err) => logger.warn(`[interests] pool build failed (${key}): ${String(err)}`))
    .finally(() => _building.delete(key))
  _building.set(key, p)
}

export interface ServeOpts {
  /** How many entries the caller wants BEFORE its own policy filter — pass headroom
   *  (typically 2× the rail size) so filtering doesn't leave a short rail. */
  limit: number
  /** Live exclusion set of already-consumed refs. Queried fresh by the caller — the
   *  pool's own snapshot is up to 6h stale. */
  watchedRefs: ReadonlySet<string>
  /** Rebuilds the pool; invoked in the background when the pool is missing or stale. */
  build: () => Promise<void>
  maxPerCreator?: number
  /** Caller-side pre-filter (e.g. a source restriction) applied before the diversity
   *  cap and limit, so filtering doesn't leave a short rail. */
  entryFilter?: (entry: RankedCandidate) => boolean
  /** Pool variant (see poolKey) — pass the same value to savePool in `build`. */
  variant?: string
}

export interface ServeResult {
  entries: RankedCandidate[]
  /** True while the first pool build for this user is still running (rail shows its
   *  fallback and the frontend polls). */
  building: boolean
}

export async function servePool(userId: string, domain: InterestDomain, opts: ServeOpts): Promise<ServeResult> {
  const variant = opts.variant ?? ''
  const { value: pool, fresh } = await cachedLookupStale<RankedCandidate[]>(NAMESPACE, poolKey(userId, domain, variant))

  if (!Array.isArray(pool)) {
    kickPoolBuild(userId, domain, opts.build, variant)
    return { entries: [], building: true }
  }
  if (!fresh) kickPoolBuild(userId, domain, opts.build, variant)

  const imps = await getImpressions(userId, domain)
  const scored = pool
    .filter((e) => (opts.entryFilter?.(e) ?? true) && !opts.watchedRefs.has(e.ref) && !imps.get(e.ref)?.dismissedAt)
    .map((e) => {
      const shown = imps.get(e.ref)?.shownCount ?? 0
      const discounted = shown > 0 ? e.score / (1 + 0.5 * shown) : e.score
      // Dithering (Dunning): a little log-normal noise per serve so consecutive
      // refreshes rotate the mid-ranks instead of repeating the same page.
      const dithered = discounted * Math.exp(gaussian() * 0.25)
      return { ...e, score: dithered }
    })
    .sort((a, b) => b.score - a.score)

  const capped = capPerCreator(scored, opts.maxPerCreator ?? 2)
  let slice = capped.slice(0, opts.limit)

  // Exploration slots (the fresh-content funnel, scaled down): guarantee a few
  // never-shown items per page so cold candidates can earn their first signal
  // instead of losing to incumbents forever.
  const wantUnseen = Math.max(1, Math.floor(opts.limit / 8))
  const unseenIn = slice.filter((e) => (imps.get(e.ref)?.shownCount ?? 0) === 0).length
  if (unseenIn < wantUnseen) {
    const poolUnseen = capped.slice(opts.limit).filter((e) => (imps.get(e.ref)?.shownCount ?? 0) === 0)
    const need = Math.min(wantUnseen - unseenIn, poolUnseen.length)
    if (need > 0) {
      // Swap the lowest-scored seen items for the best unseen ones.
      const keep = slice.filter((e) => (imps.get(e.ref)?.shownCount ?? 0) === 0)
      const seen = slice.filter((e) => (imps.get(e.ref)?.shownCount ?? 0) > 0)
      slice = [...keep, ...seen.slice(0, Math.max(0, seen.length - need)), ...poolUnseen.slice(0, need)]
        .sort((a, b) => b.score - a.score)
        .slice(0, opts.limit)
    }
  }

  return { entries: slice, building: false }
}

/** Read-only pool snapshot for diagnostics: the raw stored entries plus the age
 *  of the row since its last build (null when no pool row exists). Never kicks a
 *  build, never applies impressions, never records anything. */
export async function peekPool(
  userId: string,
  domain: InterestDomain,
  variant = '',
): Promise<{ entries: RankedCandidate[]; ageMs: number | null }> {
  const { value, createdAt } = await cachedLookupStale<RankedCandidate[]>(NAMESPACE, poolKey(userId, domain, variant))
  return {
    entries: Array.isArray(value) ? value : [],
    ageMs: typeof createdAt === 'number' ? Date.now() - createdAt : null,
  }
}

/** Box-Muller standard normal — good enough for serve-time dithering. */
function gaussian(): number {
  const u = Math.max(Number.EPSILON, Math.random())
  const v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** Record the slice a rail actually returned (call AFTER policy filtering + final slice). */
export async function recordServed(userId: string, domain: InterestDomain, entries: RankedCandidate[]): Promise<void> {
  await recordShown(
    userId,
    domain,
    entries.map((e) => ({ ref: e.ref, creatorId: e.creatorId, creatorName: e.creatorName, title: e.title })),
  )
}
