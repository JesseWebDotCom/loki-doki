// Music content protections: parental-advisory data per track + per-profile policy.
//
// Advisory sources, in write precedence: manual (admin override) > tag (local file
// ITUNESADVISORY/rtng) > deezer/itunes (catalog flags). Rows are keyed on the unified
// track ref; identity (title/artist) is denormalized for admin review lists.
//
// Policy lives on content_profiles.music_json ({explicit, unknown, lyrics, maskTitles});
// a null column derives sane defaults from the profile's existing profanity dial, so
// child profiles are protected the moment this ships with zero admin work.

import { db } from '@/db'
import { musicTrackAdvisory, contentProfiles } from '@/db/schema'
import { eq, inArray } from 'drizzle-orm'
import { cachedLookup, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import { getUserProfileSlug } from '@/lib/contentPolicy'
import { logger } from '@/lib/logger'

// ── Advisory rows ────────────────────────────────────────────────────────────────────

export type AdvisorySource = 'tag' | 'deezer' | 'itunes' | 'manual'
/** null=unknown, 0=clean, 1=explicit, 2=clean edit of an explicit song. */
export type AdvisoryValue = number | null

const SOURCE_RANK: Record<AdvisorySource, number> = { manual: 3, tag: 2, deezer: 1, itunes: 1 }

export async function upsertAdvisory(
  ref: string, explicit: AdvisoryValue, source: AdvisorySource,
  identity?: { title?: string | null; artist?: string | null },
): Promise<void> {
  try {
    const [existing] = await db.select({ source: musicTrackAdvisory.source })
      .from(musicTrackAdvisory).where(eq(musicTrackAdvisory.ref, ref)).limit(1)
    if (existing && SOURCE_RANK[existing.source as AdvisorySource] > SOURCE_RANK[source]) return
    const now = new Date()
    await db.insert(musicTrackAdvisory)
      .values({ ref, explicit, source, title: identity?.title ?? null, artist: identity?.artist ?? null, checkedAt: now })
      .onConflictDoUpdate({ target: musicTrackAdvisory.ref, set: { explicit, source, checkedAt: now } })
  } catch (err) {
    logger.debug(`[advisory] upsert failed for ${ref}: ${String(err)}`)
  }
}

export async function getAdvisories(refs: string[]): Promise<Map<string, AdvisoryValue>> {
  const out = new Map<string, AdvisoryValue>()
  if (!refs.length) return out
  const rows = await db.select({ ref: musicTrackAdvisory.ref, explicit: musicTrackAdvisory.explicit })
    .from(musicTrackAdvisory).where(inArray(musicTrackAdvisory.ref, refs.slice(0, 500)))
  for (const r of rows) out.set(r.ref, r.explicit)
  return out
}

// ── iTunes lookup (keyless; the same API that already serves our album art) ──────────

/** Song advisory by identity via iTunes Search: 'explicit'|'notExplicit'|'cleaned'.
 *  Cached 30 days including misses (null result). */
export async function itunesSongAdvisory(artist: string, title: string): Promise<AdvisoryValue> {
  const a = artist.trim()
  const t = title.trim()
  if (!a || !t) return null
  return cachedLookup('itunes-advisory', `${a}~${t}`.toLowerCase(), THIRTY_DAYS_MS, async () => {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    const wantArtist = norm(a)
    const wantTitle = norm(t)
    try {
      const term = encodeURIComponent(`${a} ${t}`.trim())
      const res = await fetch(`https://itunes.apple.com/search?term=${term}&entity=song&media=music&limit=8&explicit=Yes`, {        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000),
      })
      if (!res.ok) return null
      const data = await res.json() as { results?: Array<{ artistName?: string; trackName?: string; trackExplicitness?: string }> }
      const hits = (data.results ?? []).filter(r => {
        const ra = norm(r.artistName ?? ''); const rt = norm(r.trackName ?? '')
        const artistOk = !!ra && (ra === wantArtist || ra.includes(wantArtist) || wantArtist.includes(ra))
        const titleOk = !!rt && (rt === wantTitle || rt.startsWith(wantTitle))
        return artistOk && titleOk
      })
      if (!hits.length) return null
      // Protective reading: 'cleaned' means an explicit ORIGINAL exists, and a streamed
      // resolution of this identity is almost certainly that original - so both
      // 'explicit' and 'cleaned' verdicts mark the SONG as explicit. (The value 2 stays
      // reserved for local files whose own tags say the file is the clean edit.)
      if (hits.some(h => h.trackExplicitness === 'explicit' || h.trackExplicitness === 'cleaned')) return 1
      if (hits.some(h => h.trackExplicitness === 'notExplicit')) return 0
      return null
    } catch (err) {
      logger.debug(`[advisory] itunes lookup failed: ${String(err)}`)
      return null
    }
  })
}

// Background fill for unknown refs: bounded, deduped, fire-and-forget. Queue tune-ins
// must never wait on iTunes - the NEXT build sees the stored verdicts.
const inFlight = new Set<string>()
export function ensureAdvisories(tracks: Array<{ videoId: string; title: string; artist: string }>): void {
  void (async () => {
    try {
      const known = await getAdvisories(tracks.map(t => t.videoId))
      const todo = tracks.filter(t => !known.has(t.videoId) && !inFlight.has(t.videoId)).slice(0, 30)
      for (const t of todo) inFlight.add(t.videoId)
      for (const t of todo) {
        try {
          const verdict = await itunesSongAdvisory(t.artist, t.title)
          // Store even null verdicts: "checked, still unknown" stops re-lookups (the
          // 30-day iTunes cache would absorb them anyway, but the row makes policy fast).
          await upsertAdvisory(t.videoId, verdict, 'itunes', { title: t.title, artist: t.artist })
        } finally {
          inFlight.delete(t.videoId)
        }
      }
    } catch (err) {
      logger.debug(`[advisory] ensureAdvisories failed: ${String(err)}`)
    }
  })()
}

// ── Per-profile policy ───────────────────────────────────────────────────────────────

export interface MusicPolicy {
  explicit: 'block' | 'allow'
  unknown: 'block' | 'allow'            // block = strict, allow = lenient (user decision)
  lyrics: 'hide-explicit' | 'show'
  maskTitles: boolean
}

export const OPEN_POLICY: MusicPolicy = { explicit: 'allow', unknown: 'allow', lyrics: 'show', maskTitles: false }

/** Defaults when a profile has no explicit music settings: derive from its profanity dial.
 *  Clean profile → protected (block explicit, lenient on unknown, hide explicit lyrics,
 *  mask titles); mild → block explicit only; unrestricted → wide open. */
function defaultsFromDials(dialsJson: string): MusicPolicy {
  try {
    const profanity = (JSON.parse(dialsJson) as Record<string, string>).profanity ?? 'unrestricted'
    if (profanity === 'off') return { explicit: 'block', unknown: 'allow', lyrics: 'hide-explicit', maskTitles: true }
    if (profanity === 'mild') return { explicit: 'block', unknown: 'allow', lyrics: 'hide-explicit', maskTitles: false }
  } catch { /* fall through */ }
  return OPEN_POLICY
}

export function parseMusicPolicy(musicJson: string | null, dialsJson: string): MusicPolicy {
  if (musicJson) {
    try {
      const m = JSON.parse(musicJson) as Partial<MusicPolicy>
      return {
        explicit: m.explicit === 'block' ? 'block' : 'allow',
        unknown: m.unknown === 'block' ? 'block' : 'allow',
        lyrics: m.lyrics === 'hide-explicit' ? 'hide-explicit' : 'show',
        maskTitles: m.maskTitles === true,
      }
    } catch { /* fall through to derived */ }
  }
  return defaultsFromDials(dialsJson)
}

export async function musicPolicyFor(userId: string): Promise<MusicPolicy> {
  try {
    const slug = await getUserProfileSlug(userId)
    const [row] = await db.select({ musicJson: contentProfiles.musicJson, dials: contentProfiles.dials })
      .from(contentProfiles).where(eq(contentProfiles.slug, slug)).limit(1)
    if (!row) return OPEN_POLICY
    return parseMusicPolicy(row.musicJson, row.dials)
  } catch (err) {
    logger.debug(`[advisory] musicPolicyFor failed (open): ${String(err)}`)
    return OPEN_POLICY
  }
}

/** Should this advisory state be blocked from playback under this policy? */
export function isBlocked(policy: MusicPolicy, advisory: AdvisoryValue | undefined): boolean {
  if (advisory === 1) return policy.explicit === 'block'
  if (advisory === null || advisory === undefined) return policy.unknown === 'block'
  return false   // 0 clean / 2 clean edit
}

/** Should lyrics be hidden for this advisory state under this policy? */
export function lyricsHidden(policy: MusicPolicy, advisory: AdvisoryValue | undefined): boolean {
  if (policy.lyrics === 'show') return false
  return advisory === 1 || advisory === null || advisory === undefined
}

/**
 * Filter a station queue / playlist for a user. Explicit tracks drop under a blocking
 * profile; unknowns drop only in strict mode (and get background-checked either way, so
 * the picture sharpens with use). Fails open: an advisory-layer error never kills music.
 */
export async function filterTracksForUser<T extends { videoId: string; title: string; artist: string }>(
  userId: string, tracks: T[],
): Promise<T[]> {
  try {
    if (!tracks.length) return tracks
    const policy = await musicPolicyFor(userId)
    if (policy.explicit === 'allow' && policy.unknown === 'allow') return tracks
    const advisories = await getAdvisories(tracks.map(t => t.videoId))
    ensureAdvisories(tracks.filter(t => !advisories.has(t.videoId)))
    const kept = tracks.filter(t => !isBlocked(policy, advisories.get(t.videoId)))
    if (kept.length < tracks.length) {
      logger.debug(`[advisory] filtered ${tracks.length - kept.length}/${tracks.length} tracks for user ${userId}`)
    }
    return kept
  } catch (err) {
    logger.debug(`[advisory] filterTracksForUser failed (kept all): ${String(err)}`)
    return tracks
  }
}
