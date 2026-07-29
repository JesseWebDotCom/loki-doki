// SponsorBlock — community-sourced skip segments (sponsor reads, intros, self-promo,
// interaction reminders, etc.) keyed by video id. The player overlays them on the
// scrubber and can auto-skip. Public API, no key. We proxy it server-side so the
// browser never reveals which videos the user watches to a third party.

import { eq, and } from 'drizzle-orm'
import { db } from '@/db'
import { userPreferences } from '@/db/schema'
import { logger } from '@/lib/logger'

const API = 'https://sponsor.ajay.app/api/skipSegments'

/** The SponsorBlock categories we know how to skip, with UI metadata and whether they
 *  are skipped by default. Intros & outros are OFF by default — many viewers like channel
 *  intros/end-cards, so we don't strip them unless asked. The rest (sponsor reads,
 *  self-promo, like/sub reminders, recaps, off-topic music breaks) skip unless turned off. */
export const SKIP_CATEGORIES = [
  { key: 'sponsor',        label: 'Sponsors',              description: 'Paid promotions and product placements',    default: true  },
  { key: 'selfpromo',      label: 'Self-promotion',        description: 'Unpaid plugs for the creator\'s own stuff', default: true  },
  { key: 'interaction',    label: 'Interaction reminders', description: '"Like and subscribe" prompts',              default: true  },
  { key: 'intro',          label: 'Intros & outros',       description: 'Channel intros, end cards and credits',     default: false },
  { key: 'outro',          label: 'Outros & end cards',    description: 'Credits and end-screen card sections',      default: false },
  { key: 'preview',        label: 'Previews & recaps',     description: 'Recaps of earlier content or what\'s next',  default: true  },
  { key: 'music_offtopic', label: 'Non-music sections',    description: 'Off-topic talking in music videos',         default: true  },
] as const

export type SkipCategory = (typeof SKIP_CATEGORIES)[number]['key']

const CATEGORIES = SKIP_CATEGORIES.map(c => c.key)
const USER_PREF_KEY = 'youtube.skip_categories'

/** Default skip map — the categories we auto-skip out of the box. */
export const DEFAULT_SKIP_CATEGORIES: Record<SkipCategory, boolean> =
  Object.fromEntries(SKIP_CATEGORIES.map(c => [c.key, c.default])) as Record<SkipCategory, boolean>

/** A user's effective skip-category map: their saved choices merged over the defaults,
 *  so categories added in a future release default sensibly until they're toggled. */
export async function getUserSkipCategories(userId: string): Promise<Record<SkipCategory, boolean>> {
  const [row] = await db.select({ value: userPreferences.value }).from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, USER_PREF_KEY)))
    .limit(1)
  if (!row) return { ...DEFAULT_SKIP_CATEGORIES }
  try {
    const saved = JSON.parse(row.value) as Partial<Record<SkipCategory, boolean>>
    return { ...DEFAULT_SKIP_CATEGORIES, ...saved }
  } catch {
    return { ...DEFAULT_SKIP_CATEGORIES }
  }
}

// Per-category behavior (FreeTube-style). The legacy boolean map still works:
// true maps to 'skip', false to 'off'. A saved mode map overrides per category.
//   skip:   jump over the segment automatically
//   show:   only mark it on the seek bar
//   prompt: pause-free on-screen "Skip?" button while inside the segment
//   off:    pretend the segment does not exist
export type SkipMode = 'skip' | 'show' | 'prompt' | 'off'
const MODES_PREF_KEY = 'youtube.skip_modes'
const VALID_MODES: readonly SkipMode[] = ['skip', 'show', 'prompt', 'off']

export async function getUserSkipModes(userId: string): Promise<Record<SkipCategory, SkipMode>> {
  const legacy = await getUserSkipCategories(userId)
  const base = Object.fromEntries(
    CATEGORIES.map(c => [c, legacy[c] ? 'skip' : 'off']),
  ) as Record<SkipCategory, SkipMode>

  const [row] = await db.select({ value: userPreferences.value }).from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, MODES_PREF_KEY)))
    .limit(1)
  if (!row) return base
  try {
    const saved = JSON.parse(row.value) as Partial<Record<SkipCategory, string>>
    for (const c of CATEGORIES) {
      const mode = saved[c]
      if (mode && (VALID_MODES as readonly string[]).includes(mode)) base[c] = mode as SkipMode
    }
  } catch { /* ignore malformed pref */ }
  return base
}

export interface SkipSegment {
  category: string
  start: number   // seconds
  end: number     // seconds
}

interface RawSegment {
  category: string
  actionType: string
  segment: [number, number]
}

export async function getSkipSegments(videoId: string, timeout = 6000): Promise<SkipSegment[]> {
  try {
    const cats = encodeURIComponent(JSON.stringify(CATEGORIES))
    const res = await fetch(`${API}?videoID=${encodeURIComponent(videoId)}&categories=${cats}`, {
      headers: { 'User-Agent': 'LokiDoki/1.0' },
      signal: AbortSignal.timeout(timeout),
    })
    // 404 = "no segments submitted for this video", which is the common, non-error case.
    if (res.status === 404) return []
    if (!res.ok) throw new Error(`sponsorblock ${res.status}`)
    const data = (await res.json()) as RawSegment[]
    return (Array.isArray(data) ? data : [])
      .filter(s => s.actionType === 'skip' && Array.isArray(s.segment) && s.segment.length === 2)
      .map(s => ({ category: s.category, start: s.segment[0], end: s.segment[1] }))
      .sort((a, b) => a.start - b.start)
  } catch (err) {
    logger.warn(`[youtube/sponsorblock] lookup failed for ${videoId}: ${err}`)
    return []
  }
}
