// Kid-safe media: the shared "tiered by age" spine for videos and podcasts.
//
// Every profile resolves to one of three tiers, derived once from its dials (or forced by
// the profile's `kid_safe_media` master toggle):
//   • kid   — strictest. Block anything confirmed mature AND anything not yet verified clean
//             (unknown = block). YouTube Restricted Mode on.
//   • teen  — block confirmed-mature, but allow-and-flag the unrated (unknown = allow, the
//             background classifier catches the bad ones). Restricted Mode on.
//   • open  — no media filtering.
//
// Music has its own richer policy (lib/music/advisory.ts) and is intentionally left alone;
// this module governs videos + podcasts, which had no policy layer before.

import { db } from '@/db'
import { contentProfiles } from '@/db/schema'
import { eq } from 'drizzle-orm'
import {
  getUserProfileSlug, normalizeDials, MIN_DIALS,
  type ContentDials, type DialKey,
} from '@/lib/contentPolicy'
import { logger } from '@/lib/logger'

export type MediaTier = 'kid' | 'teen' | 'open'

// Ordinal helper local to tier derivation: how "mature" a dial sits (0=off … 2=unrestricted).
const LEVEL_ORDER: Record<DialKey, readonly string[]> = {
  profanity: ['off', 'mild', 'unrestricted'],
  sexual: ['off', 'suggestive', 'unrestricted'],
  violence: ['off', 'moderate', 'unrestricted'],
  substances: ['off', 'discuss', 'unrestricted'],
  crime: ['off', 'discuss', 'unrestricted'],
  hate: ['off', 'fiction', 'unrestricted'],
  selfHarm: ['off', 'discuss', 'unrestricted'],
  privacy: ['off', 'public', 'unrestricted'],
}
function ord(dial: DialKey, level: string): number {
  const i = LEVEL_ORDER[dial].indexOf(level)
  return i < 0 ? 0 : i
}

/** The one "how old is this profile" rule. `kidSafe` (the master toggle) forces `kid`.
 *  Otherwise derive from the maturity of the profile's mature-content dials:
 *  everything off → kid; any dial fully unrestricted → open; in between → teen. */
export function profileTier(dials: ContentDials, kidSafe: boolean): MediaTier {
  if (kidSafe) return 'kid'
  const mature: DialKey[] = ['sexual', 'violence', 'profanity', 'substances']
  const max = Math.max(...mature.map((k) => ord(k, dials[k])))
  if (max <= 0) return 'kid'
  if (max >= 2) return 'open'
  return 'teen'
}

// ── Per-medium policies ────────────────────────────────────────────────────────────────

export interface VideoPolicy {
  tier: MediaTier
  adult: 'block' | 'allow'            // source-flagged adult/NSFW items
  unknown: 'block' | 'allow'          // items with no clean signal yet (classifier pending)
  restrictedMode: boolean             // send YouTube InnerTube safety mode
  ceiling: ContentDials               // the profile's dials — the classifier threshold
}

export interface PodcastPolicy {
  tier: MediaTier
  explicit: 'block' | 'allow'
  unknown: 'block' | 'allow'
  ceiling: ContentDials
}

export const OPEN_VIDEO_POLICY: VideoPolicy = { tier: 'open', adult: 'allow', unknown: 'allow', restrictedMode: false, ceiling: { ...MIN_DIALS } }
export const OPEN_PODCAST_POLICY: PodcastPolicy = { tier: 'open', explicit: 'allow', unknown: 'allow', ceiling: { ...MIN_DIALS } }

function videoFromTier(tier: MediaTier, ceiling: ContentDials): VideoPolicy {
  if (tier === 'kid') return { tier, adult: 'block', unknown: 'block', restrictedMode: true, ceiling }
  if (tier === 'teen') return { tier, adult: 'block', unknown: 'allow', restrictedMode: true, ceiling }
  return { tier, adult: 'allow', unknown: 'allow', restrictedMode: false, ceiling }
}
function podcastFromTier(tier: MediaTier, ceiling: ContentDials): PodcastPolicy {
  if (tier === 'kid') return { tier, explicit: 'block', unknown: 'block', ceiling }
  if (tier === 'teen') return { tier, explicit: 'block', unknown: 'allow', ceiling }
  return { tier, explicit: 'allow', unknown: 'allow', ceiling }
}

interface ProfileRow { dials: ContentDials; videoJson: string | null; podcastJson: string | null; kidSafe: boolean }

// Short-lived per-user memo, in the style of allowlistViewFor (lib/videos/allowlist.ts):
// videoPolicyFor runs several times per search/list request (the route + the filter
// chokepoints), each paying a slug lookup + profile read. Profile edits are rare — the
// admin routes invalidate on write, and 30s staleness is fine for a policy tier anyway.
const rowCache = new Map<string, { at: number; row: ProfileRow | null }>()
const ROW_CACHE_MS = 30_000

export function invalidatePolicyTierCache(userId?: string): void {
  if (userId) rowCache.delete(userId)
  else rowCache.clear()
}

async function loadProfileRow(userId: string): Promise<ProfileRow | null> {
  const hit = rowCache.get(userId)
  if (hit && Date.now() - hit.at < ROW_CACHE_MS) return hit.row
  const slug = await getUserProfileSlug(userId)
  const [row] = await db.select({
    dials: contentProfiles.dials,
    videoJson: contentProfiles.videoJson,
    podcastJson: contentProfiles.podcastJson,
    kidSafe: contentProfiles.kidSafeMedia,
  }).from(contentProfiles).where(eq(contentProfiles.slug, slug)).limit(1)
  const parsed: ProfileRow | null = row ? {
    dials: normalizeDials(JSON.parse(row.dials) as Partial<Record<DialKey, unknown>>),
    videoJson: row.videoJson, podcastJson: row.podcastJson, kidSafe: !!row.kidSafe,
  } : null
  rowCache.set(userId, { at: Date.now(), row: parsed })
  return parsed
}

/** Resolve the video policy for a user. An admin per-medium override (video_json) may relax
 *  or tighten adult/unknown/restrictedMode, but never below the tier's ceiling dials. Fails
 *  open (returns OPEN) so a policy-layer error never hides an adult's whole feed. */
export async function videoPolicyFor(userId: string): Promise<VideoPolicy> {
  try {
    const row = await loadProfileRow(userId)
    if (!row) return OPEN_VIDEO_POLICY
    const tier = profileTier(row.dials, row.kidSafe)
    const base = videoFromTier(tier, row.dials)
    if (!row.kidSafe && row.videoJson) {
      try {
        const o = JSON.parse(row.videoJson) as Partial<VideoPolicy>
        return {
          ...base,
          adult: o.adult === 'allow' ? 'allow' : o.adult === 'block' ? 'block' : base.adult,
          unknown: o.unknown === 'allow' ? 'allow' : o.unknown === 'block' ? 'block' : base.unknown,
          restrictedMode: typeof o.restrictedMode === 'boolean' ? o.restrictedMode : base.restrictedMode,
        }
      } catch { /* fall through to derived */ }
    }
    return base
  } catch (err) {
    logger.debug(`[policyTier] videoPolicyFor failed (open): ${String(err)}`)
    return OPEN_VIDEO_POLICY
  }
}

export async function podcastPolicyFor(userId: string): Promise<PodcastPolicy> {
  try {
    const row = await loadProfileRow(userId)
    if (!row) return OPEN_PODCAST_POLICY
    const tier = profileTier(row.dials, row.kidSafe)
    const base = podcastFromTier(tier, row.dials)
    if (!row.kidSafe && row.podcastJson) {
      try {
        const o = JSON.parse(row.podcastJson) as Partial<PodcastPolicy>
        return {
          ...base,
          explicit: o.explicit === 'allow' ? 'allow' : o.explicit === 'block' ? 'block' : base.explicit,
          unknown: o.unknown === 'allow' ? 'allow' : o.unknown === 'block' ? 'block' : base.unknown,
        }
      } catch { /* fall through */ }
    }
    return base
  } catch (err) {
    logger.debug(`[policyTier] podcastPolicyFor failed (open): ${String(err)}`)
    return OPEN_PODCAST_POLICY
  }
}

/** Resolve just the age tier for a user, for callers (web search) with no per-medium
 *  override JSON of their own. Fails open, matching video/podcast policy above. */
export async function searchTierFor(userId: string): Promise<MediaTier> {
  try {
    const row = await loadProfileRow(userId)
    if (!row) return 'open'
    return profileTier(row.dials, row.kidSafe)
  } catch (err) {
    logger.debug(`[policyTier] searchTierFor failed (open): ${String(err)}`)
    return 'open'
  }
}
