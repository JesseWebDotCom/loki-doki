// Briefing settings — resolved from the app_settings table with code defaults.
// Mirrors the "DB overrides defaults" pattern used elsewhere (models.ts). All keys
// live under the `briefing.` prefix so a single prefix scan loads the whole config.

import { db } from '@/db'
import { appSettings } from '@/db/schema'
import type { BriefingSourceId } from './types'
import { BRIEFING_SOURCE_IDS } from './types'

export interface BriefingSettings {
  enabled: boolean
  sources: Record<BriefingSourceId, boolean>
  cadenceMinutes: number
  patchSlug: string | null // explicit override, e.g. "connecticut/milford"
  defaultLocation: string // the __default__ briefing's location
  maxItems: { localNews: number; localEvents: number; worldNews: number; sports: number }
}

export const BRIEFING_KEY_PREFIX = 'briefing.'

const DEFAULTS: BriefingSettings = {
  enabled: true,
  sources: {
    weather: true,
    worldNews: true,
    localNews: true,
    localEvents: true,
    sports: true,
    onThisDay: true,
    notableDeaths: true,
    holidays: true,
    plex: false, // opt-in: only meaningful when a Plex server is configured
    calendar: true, // local read; empty until iCloud Calendar is enabled and synced
  },
  cadenceMinutes: 150, // 2.5h
  patchSlug: null,
  defaultLocation: 'Milford, CT',
  maxItems: { localNews: 3, localEvents: 3, worldNews: 2, sports: 3 },
}

function parse<T>(raw: string | undefined, fallback: T): T {
  if (raw === undefined) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

// Last successfully-resolved settings. On a DB read error we prefer this over
// returning all-enabled defaults, which would silently re-enable fetches an
// admin had explicitly disabled.
let lastKnownGood: BriefingSettings | null = null

/** Load briefing settings, applying admin overrides from app_settings over the defaults. */
export async function getBriefingSettings(): Promise<BriefingSettings> {
  let rows: { key: string; value: string }[] = []
  try {
    rows = await db.select({ key: appSettings.key, value: appSettings.value }).from(appSettings)
  } catch (e) {
    console.warn(`[briefing] settings DB read failed: ${(e as Error).message}`)
    // Prefer the last-known-good config so disabled sources stay disabled.
    return lastKnownGood ? structuredClone(lastKnownGood) : structuredClone(DEFAULTS)
  }
  const map = new Map<string, string>()
  for (const r of rows) {
    if (r.key.startsWith(BRIEFING_KEY_PREFIX)) map.set(r.key, r.value)
  }

  const sources = { ...DEFAULTS.sources }
  for (const id of BRIEFING_SOURCE_IDS) {
    sources[id] = parse(map.get(`${BRIEFING_KEY_PREFIX}source.${id}`), DEFAULTS.sources[id])
  }

  const patchSlugRaw = parse<string>(map.get(`${BRIEFING_KEY_PREFIX}patch_slug`), '').trim()

  const resolved: BriefingSettings = {
    enabled: parse(map.get(`${BRIEFING_KEY_PREFIX}enabled`), DEFAULTS.enabled),
    sources,
    cadenceMinutes: parse(map.get(`${BRIEFING_KEY_PREFIX}cadence_minutes`), DEFAULTS.cadenceMinutes),
    patchSlug: patchSlugRaw || null,
    defaultLocation:
      parse<string>(map.get(`${BRIEFING_KEY_PREFIX}default_location`), DEFAULTS.defaultLocation).trim() ||
      DEFAULTS.defaultLocation,
    maxItems: {
      localNews: parse(map.get(`${BRIEFING_KEY_PREFIX}max_items.localNews`), DEFAULTS.maxItems.localNews),
      localEvents: parse(map.get(`${BRIEFING_KEY_PREFIX}max_items.localEvents`), DEFAULTS.maxItems.localEvents),
      worldNews: parse(map.get(`${BRIEFING_KEY_PREFIX}max_items.worldNews`), DEFAULTS.maxItems.worldNews),
      sports: parse(map.get(`${BRIEFING_KEY_PREFIX}max_items.sports`), DEFAULTS.maxItems.sports),
    },
  }

  lastKnownGood = resolved
  return resolved
}

export { DEFAULTS as BRIEFING_DEFAULTS }
