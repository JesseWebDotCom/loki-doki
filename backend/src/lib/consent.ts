// ── Consent ───────────────────────────────────────────────────────────────────
//
// Explicit, revocable user consent for the capabilities that carry real-world risk.
// Each consent GATES functionality by propagating to the existing enforcement prefs,
// so withholding a consent leaves the app in its safe default rather than needing new
// gating logic:
//   uncensored  → sets `uncensored_images` (off = censored image generation)
//   internet    → sets `connectivity.mode`  (off = offline-only; tools needing the net are blocked)
//   companions  → gates the companion feature (off = companions disabled)
//   liability   → records acceptance of the use-at-your-own-risk waiver (no enforcement)
//
// Collected at first run by the setup wizard and editable afterwards in Admin → Security.
// IMPORTANT: absence of a consent record = a legacy/pre-wizard install, which is
// GRANDFATHERED (treated as allowed) so existing behaviour is never silently disabled.

import { db } from '@/db'
import { userPreferences } from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import type { ConnectivityMode } from '@/lib/connectivity'

export const CONSENT_VERSION = 1
const CONSENT_PREF_KEY = 'consents'
const CONSENT_PRESENT_KEY = 'consent_system_present'

export interface Consents {
  uncensored: boolean
  internet: boolean
  companions: boolean
  liability: boolean
  acceptedAt: string | null
  version: number
}

export const DEFAULT_CONSENTS: Consents = {
  uncensored: false,
  internet: false,
  companions: false,
  liability: false,
  acceptedAt: null,
  version: CONSENT_VERSION,
}

// Human-facing copy for each consent — the wizard and admin panel render this so the
// risk is stated at the point of decision, and the "off" behaviour is explicit.
export const CONSENT_DEFINITIONS: Array<{
  key: 'uncensored' | 'internet' | 'companions' | 'liability'
  label: string
  risk: string
  ifDenied: string
}> = [
  {
    key: 'uncensored',
    label: 'Uncensored content',
    risk: 'Allows mature/explicit text and imagery. The only hard limits that always remain are sexual content involving minors and mass-casualty weapon instructions.',
    ifDenied: 'Image generation stays censored and content is kept tame.',
  },
  {
    key: 'internet',
    label: 'App internet connectivity',
    risk: 'Lets apps and tools reach external services (search, news, weather, lookups). Requests and queries leave this device to those services.',
    ifDenied: 'The app runs offline-only; tools that need the internet are disabled.',
  },
  {
    key: 'companions',
    label: 'AI companions',
    risk: 'Enables conversational AI companions, which generate open-ended responses and can use tools and memory.',
    ifDenied: 'Companions are disabled.',
  },
  {
    key: 'liability',
    label: 'Use at your own risk',
    risk: 'This software is provided “as is”, without warranty. You are responsible for how you use it and for the content you generate; the creators accept no liability for any outcome.',
    ifDenied: 'You must accept this to use the app’s generative features.',
  },
]

async function readConsentPref(userId: string): Promise<Partial<Consents> | null> {
  const [row] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, CONSENT_PREF_KEY)))
    .limit(1)
  if (!row) return null
  try { return JSON.parse(row.value) as Partial<Consents> } catch { return null }
}

async function writePref(userId: string, key: string, value: unknown): Promise<void> {
  await db
    .insert(userPreferences)
    .values({ id: crypto.randomUUID(), userId, key, value: JSON.stringify(value), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [userPreferences.userId, userPreferences.key],
      set: { value: JSON.stringify(value), updatedAt: new Date() },
    })
}

/** Whether THIS user has an explicit consent record (i.e. has been through the wizard). */
export async function hasConsentRecord(userId: string): Promise<boolean> {
  return (await readConsentPref(userId)) !== null
}

export async function getConsents(userId: string): Promise<Consents> {
  const stored = await readConsentPref(userId)
  return { ...DEFAULT_CONSENTS, ...(stored ?? {}) }
}

/**
 * Persist consents and propagate them to the underlying enforcement prefs. Pass
 * `accept: true` to stamp acceptedAt (used when the user actively confirms the form).
 */
export async function setConsents(
  userId: string,
  patch: Partial<Pick<Consents, 'uncensored' | 'internet' | 'companions' | 'liability'>>,
  opts?: { accept?: boolean },
): Promise<Consents> {
  const current = await getConsents(userId)
  const next: Consents = { ...current, ...patch, version: CONSENT_VERSION }
  if (opts?.accept) next.acceptedAt = new Date().toISOString()

  await writePref(userId, CONSENT_PREF_KEY, next)
  // Propagate to existing enforcement surfaces.
  await writePref(userId, 'uncensored_images', next.uncensored)
  const mode: ConnectivityMode = next.internet ? 'online' : 'offline'
  await writePref(userId, 'connectivity.mode', mode)
  // Mark the install as consent-aware so legacy grandfathering stops applying.
  await setAppSetting(CONSENT_PRESENT_KEY, true)
  return next
}

/**
 * Companion feature gate. Absence of a consent record = grandfathered ON (legacy
 * installs keep working); only an explicit `companions: false` disables it. Fails
 * open on any error so a transient DB issue never silently kills companions.
 */
export async function companionsAllowed(userId: string): Promise<boolean> {
  try {
    const stored = await readConsentPref(userId)
    if (!stored) return true
    return stored.companions !== false
  } catch {
    return true
  }
}
