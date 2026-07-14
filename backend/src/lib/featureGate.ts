import { createMiddleware } from 'hono/factory'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { userPreferences } from '@/db/schema'
import { getAppSetting } from '@/lib/settings'
import { logger } from '@/lib/logger'
import type { AppEnv } from '@/types'

// Central capability gate. Turns the admin feature toggles into a real backend boundary:
// a disabled feature's REST routes 403, its WebSocket handshakes are refused, its token
// endpoints stop authenticating, and its boot pollers don't start. This is the enforcement
// layer the sidebar-only `app_feature.*` flags never had.
//
// Storage is unified on the SAME `app_settings` key space the existing appFeatures router
// uses (`app_feature.<id>`), so there is one source of truth, not a parallel table. The
// difference is that these ids default OFF and are read at the HTTP/WS/poller boundary.

export type FeatureRisk = 'critical' | 'high' | 'medium' | 'low'

export interface FeatureMeta {
  id: string
  label: string
  risk: FeatureRisk
  /** Default when no admin toggle row exists. Risky capabilities default OFF (opt-in). */
  defaultEnabled: boolean
  /** True when using this feature should be gated per-profile (admins + explicitly-granted
   *  users only), not just globally on/off — e.g. shell/terminal access. */
  perProfile?: boolean
  description: string
}

// NOTE on defaults: the security-hardened target posture is risky-features-OFF (opt-in).
// But this store already backs a LIVE deployment, and there is not yet a Security Controls
// admin UI to re-enable a feature the operator relies on — so flipping these OFF here would
// silently break the running app with no in-product way back. We therefore ship the
// ENFORCEMENT mechanism now with global defaults ON (nothing that works today breaks; the
// admin can genuinely turn any of these OFF and it is enforced), while `perProfile` features
// (remote/coding) default-DENY for non-admins immediately — that closes the "a PIN-free kid
// profile opens a shell" hole without touching the admin's own access. Once the Security
// Controls UI ships, flip the critical defaults to false for a true opt-in posture.
export const FEATURES: Record<string, FeatureMeta> = {
  // Critical — code execution, remote machine access, server-side browser automation.
  remote: {
    id: 'remote', label: 'Remote Access', risk: 'critical', defaultEnabled: true, perProfile: true,
    description: 'SSH, VNC, RDP, SFTP, and host shell access to other machines and to this server.',
  },
  coding: {
    id: 'coding', label: 'Coding Terminal', risk: 'critical', defaultEnabled: true, perProfile: true,
    description: 'Persistent AI coding terminals (Claude Code) running on the server.',
  },
  browser_session: {
    id: 'browser_session', label: 'Server Browser Automation', risk: 'high', defaultEnabled: true,
    description: 'Headless Chromium that visits third-party sites from the server (bookmark archiving, snapshots).',
  },
  // High — network reach, downloads, third-party fetches, token endpoints.
  media_downloads: {
    id: 'media_downloads', label: 'Media Downloads', risk: 'high', defaultEnabled: true,
    description: 'Download audio/video from arbitrary links via yt-dlp/ffmpeg (the Clipper app).',
  },
  opds: {
    id: 'opds', label: 'OPDS Library Feed', risk: 'high', defaultEnabled: true,
    description: 'Token-authenticated OPDS feed exposing the book library to external e-readers.',
  },
  kosync: {
    id: 'kosync', label: 'KOReader Sync', risk: 'high', defaultEnabled: true,
    description: 'KOReader reading-progress sync with open account registration.',
  },
  people_lookup: {
    id: 'people_lookup', label: 'People & Property Lookup', risk: 'high', defaultEnabled: true,
    description: 'Scrape public property records and reverse people-lookup by name/address/phone. A doxxing/stalking vector — disable to remove it from every profile and the companion.',
  },
  // Lower-risk local apps — default ON. Kept here so their toggles share one code path.
  bookmarks: {
    id: 'bookmarks', label: 'Bookmarks', risk: 'low', defaultEnabled: true,
    description: 'Save and read bookmarked pages.',
  },
  notes: {
    id: 'notes', label: 'Notes', risk: 'low', defaultEnabled: true,
    description: 'Household notes and knowledge base.',
  },
  'home-inventory': {
    id: 'home-inventory', label: 'Home Inventory', risk: 'low', defaultEnabled: true,
    description: 'Track devices and belongings.',
  },
}

/** True if a feature is enabled. Absent toggle → the registry default (risky features OFF).
 *  Unknown ids default to enabled so this can't accidentally black-hole an ungated feature. */
export async function isFeatureEnabled(id: string): Promise<boolean> {
  const meta = FEATURES[id]
  const value = await getAppSetting(`app_feature.${id}`)
  if (typeof value === 'boolean') return value
  return meta?.defaultEnabled ?? true
}

/** Hono middleware: 403 + audit log when the feature is disabled. Runs before token
 *  resolution / handlers, and (for Bun WS routes) before the upgrade handshake completes. */
export function requireFeature(id: string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!(await isFeatureEnabled(id))) {
      logger.warn(`[featureGate] blocked ${c.req.method} ${c.req.path} — feature '${id}' is disabled`)
      return c.json({ error: 'feature_disabled', feature: id }, 403)
    }
    await next()
  })
}

/** Per-profile authorization for a perProfile feature (remote/coding). Admins may always
 *  use it; a non-admin needs an explicit `capability.<id>` preference set to true by an
 *  admin. Default-deny for non-admins closes "a PIN-free kid profile opens a shell". */
export async function userMayUseCapability(
  user: { id: string; role: string },
  id: string,
): Promise<boolean> {
  if (user.role === 'admin') return true
  const [row] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, user.id), eq(userPreferences.key, `capability.${id}`)))
    .limit(1)
  if (!row) return false
  try { return JSON.parse(row.value) === true } catch { return false }
}
