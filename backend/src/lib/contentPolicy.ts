import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { userPreferences, contentProfiles } from '@/db/schema'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { logger } from '@/lib/logger'
import type { Candor } from '@/lib/protections'
import { IRREDUCIBLE_CORE } from '@/lib/safety/textFloor'

// ── Content categories ───────────────────────────────────────────────────────────
// One data-driven source of truth. Each category is an ordered axis whose TOP level
// is always `unrestricted` (no restriction injected — a plain permission instead).
// Companion settings are clamped to the user's profile, never higher.
//
// Two things are NEVER governed by a dial and apply on every profile, including
// "No Restrictions": sexual content involving minors, and mass-casualty
// bio/chem/nuclear/radiological weapon production. See IRREDUCIBLE_CORE.

export type DialKey =
  | 'profanity' | 'sexual' | 'violence' | 'substances'
  | 'crime' | 'hate' | 'selfHarm' | 'privacy'

export type ContentDials = Record<DialKey, string>

interface CategoryLevel {
  value: string
  label: string
  /** System-prompt fragment for this level. '' contributes nothing. */
  fragment: string
}
interface Category {
  key: DialKey
  label: string
  help: string
  levels: CategoryLevel[]   // ordered low→high; last is always `unrestricted`
}

export const CONTENT_CATEGORIES: Category[] = [
  {
    key: 'profanity', label: 'Profanity', help: 'Swearing and vulgar language',
    levels: [
      { value: 'off', label: 'Clean', fragment: 'Keep your language clean — no profanity, slurs, or vulgar terms.' },
      { value: 'mild', label: 'Mild', fragment: 'Mild language (damn, hell) is fine; avoid strong profanity.' },
      { value: 'unrestricted', label: 'Unrestricted', fragment: 'Use profanity freely and naturally, including strong language. Never self-censor with asterisks — write the actual word.' },
    ],
  },
  {
    key: 'sexual', label: 'Sexual content', help: 'Romantic and sexual content',
    levels: [
      { value: 'off', label: 'None', fragment: 'Keep content non-sexual; do not describe sexual acts.' },
      { value: 'suggestive', label: 'Suggestive', fragment: 'Mild romantic or suggestive content is allowed, but stop short of explicit description.' },
      { value: 'unrestricted', label: 'Unrestricted', fragment: 'Explicit consensual sexual content between adults is allowed; describe it directly and in detail when relevant.' },
    ],
  },
  {
    key: 'violence', label: 'Violence & gore', help: 'Violence and gore in fiction',
    levels: [
      { value: 'off', label: 'None', fragment: 'Avoid graphic violence or gore.' },
      { value: 'moderate', label: 'Moderate', fragment: 'Moderate violence is fine in context; keep gore restrained.' },
      { value: 'unrestricted', label: 'Unrestricted', fragment: 'Graphic violence and gore are allowed in full detail in fiction and description.' },
    ],
  },
  {
    key: 'substances', label: 'Drugs & alcohol', help: 'Discussion of drugs and intoxicants',
    levels: [
      { value: 'off', label: 'None', fragment: 'Do not go into detail about drug use; keep it general and high-level.' },
      { value: 'discuss', label: 'Discuss', fragment: 'You may discuss drugs and intoxicants frankly and informatively.' },
      { value: 'unrestricted', label: 'Unrestricted', fragment: 'Discuss drugs candidly and in full detail, including effects, methods, and harm reduction.' },
    ],
  },
  {
    key: 'crime', label: 'Crime & illicit how-to', help: 'Crime, fraud, hacking, weapons',
    levels: [
      { value: 'off', label: 'None', fragment: 'Do not provide guidance on crime, fraud, hacking, or weapons; keep it high-level.' },
      { value: 'discuss', label: 'Discuss', fragment: 'You may discuss crime, fraud, hacking, and weapons at a conceptual, informative level.' },
      { value: 'unrestricted', label: 'Unrestricted', fragment: 'Discuss crime, fraud, hacking, weapons, and other illicit how-to candidly and in detail.' },
    ],
  },
  {
    key: 'hate', label: 'Hate & harassment', help: 'Slurs and demeaning content',
    levels: [
      { value: 'off', label: 'None', fragment: 'Do not produce slurs or demeaning, harassing content targeting protected groups.' },
      { value: 'fiction', label: 'In fiction', fragment: 'Harsh or prejudiced language is allowed only within clearly fictional or roleplay framing.' },
      { value: 'unrestricted', label: 'Unrestricted', fragment: 'Crude, harsh, or derogatory language and slurs are allowed, including in fiction and roleplay.' },
    ],
  },
  {
    key: 'selfHarm', label: 'Self-harm', help: 'Suicide and self-harm topics',
    levels: [
      { value: 'off', label: 'Care', fragment: 'Do not provide self-harm or suicide methods; respond with care and point to help.' },
      { value: 'discuss', label: 'Discuss', fragment: 'You may discuss self-harm and related topics with care, without immediately deflecting.' },
      { value: 'unrestricted', label: 'Unrestricted', fragment: 'Discuss self-harm and related topics openly and directly.' },
    ],
  },
  {
    key: 'privacy', label: 'Privacy & people', help: 'Info about real people',
    levels: [
      { value: 'off', label: 'Strict', fragment: 'Do not help find, compile, or expose personal information about individuals.' },
      { value: 'public', label: 'Public info', fragment: "Discuss publicly available information and news about people, including public figures. Don't expose a private individual's non-public personal data." },
      { value: 'unrestricted', label: 'Unrestricted', fragment: 'Discuss and compile information about people, including public figures, without privacy hedging.' },
    ],
  },
]

// The only hard limits — apply on EVERY profile, "No Restrictions" included.
// Canonical definition + the LLM-wrapper injection live in lib/safety/textFloor;
// re-exported here so existing importers (and buildContentPrompt below) are unchanged.
export { IRREDUCIBLE_CORE }

export const DIAL_KEYS = CONTENT_CATEGORIES.map((c) => c.key) as DialKey[]
export const DIAL_LEVELS: Record<DialKey, readonly string[]> = Object.fromEntries(
  CONTENT_CATEGORIES.map((c) => [c.key, c.levels.map((l) => l.value)]),
) as Record<DialKey, readonly string[]>

export const MIN_DIALS: ContentDials = Object.fromEntries(DIAL_KEYS.map((k) => [k, 'off'])) as ContentDials
export const MAX_DIALS: ContentDials = Object.fromEntries(DIAL_KEYS.map((k) => [k, 'unrestricted'])) as ContentDials

// Legacy top-level values (pre-`unrestricted` rename) → coerced on read so old
// stored dials/character configs keep working without a data migration.
const LEGACY_ALIAS: Record<string, string> = {
  full: 'unrestricted', explicit: 'unrestricted', graphic: 'unrestricted', detailed: 'unrestricted',
}

function levelIndex(dial: DialKey, level: string): number {
  const i = DIAL_LEVELS[dial].indexOf(level)
  return i < 0 ? 0 : i
}

function normalizeLevel(dial: DialKey, level: unknown): string {
  if (typeof level !== 'string') return 'off'
  if (DIAL_LEVELS[dial].includes(level)) return level
  const aliased = LEGACY_ALIAS[level]
  return aliased && DIAL_LEVELS[dial].includes(aliased) ? aliased : 'off'
}

// Coerce arbitrary stored JSON into a complete, valid ContentDials.
export function normalizeDials(
  raw: Partial<Record<DialKey, unknown>> | null | undefined,
  fallback: ContentDials = MIN_DIALS,
): ContentDials {
  const out: ContentDials = { ...fallback }
  if (raw && typeof raw === 'object') {
    for (const k of DIAL_KEYS) {
      if (raw[k] !== undefined) out[k] = normalizeLevel(k, raw[k])
    }
  }
  return out
}

function minLevel(dial: DialKey, a: string, b: string): string {
  return levelIndex(dial, a) <= levelIndex(dial, b) ? normalizeLevel(dial, a) : normalizeLevel(dial, b)
}

// Per-dial stricter-of-the-two. Folds a companion's config down under a ceiling, or
// two ceilings together. (A companion can never exceed the user's profile.)
export function effectiveCeiling(a: ContentDials, b: ContentDials): ContentDials {
  const out = {} as ContentDials
  for (const k of DIAL_KEYS) out[k] = minLevel(k, a[k], b[k])
  return out
}
export const clampDials = effectiveCeiling

// True if `item` rates ABOVE `ceiling` in any category — i.e. clamping it to the ceiling
// would lower some dial. Used by the media classifier to decide whether a video/podcast's
// topical rating exceeds what a profile permits. `level` uses the same dial vocabulary.
export function dialsExceedCeiling(item: ContentDials, ceiling: ContentDials): boolean {
  for (const k of DIAL_KEYS) {
    if (levelIndex(k, item[k]) > levelIndex(k, ceiling[k])) return true
  }
  return false
}

// The ordinal (0-based, low→high) of a dial level — exported so classifiers can map an
// LLM's 0/1/2 severity onto the category's actual level vocabulary.
export function dialLevelValue(dial: DialKey, ordinal: number): string {
  const levels = DIAL_LEVELS[dial]
  const i = Math.max(0, Math.min(levels.length - 1, Math.round(ordinal)))
  return levels[i] ?? 'off'
}

// ── Content profiles ─────────────────────────────────────────────────────────────
// A profile is a named set of per-category ceilings, assigned to users. Admins
// create/edit/delete them and pick the default for new accounts.

export interface ContentProfile {
  slug: string
  name: string
  description: string
  dials: ContentDials
  isBuiltin: boolean
  sortOrder: number
  /** Master "Kid-Safe Media" toggle: forces music/videos/podcasts to their strictest tier
   *  regardless of dials. See lib/media/policyTier.ts. */
  kidSafeMedia: boolean
}

const DEFAULT_PROFILE_KEY = 'content.default_profile'
const USER_PROFILE_PREF = 'content_profile'

// Built-in starter profiles. Seeded if missing; admins may edit them afterward.
export const BUILTIN_PROFILES: ContentProfile[] = [
  { slug: 'locked', name: 'Locked Down', description: 'Everything off. Safe for children and the default for new accounts.', isBuiltin: true, sortOrder: 0, kidSafeMedia: true, dials: { ...MIN_DIALS } },
  { slug: 'teen', name: 'Teen', description: 'Mild language and moderate violence; no sexual, drug, or illicit content.', isBuiltin: true, sortOrder: 1, kidSafeMedia: false,
    dials: normalizeDials({ profanity: 'mild', violence: 'moderate', privacy: 'public' }) },
  { slug: 'adult', name: 'Adult', description: 'Mature expression — strong language, explicit content, graphic violence — with illicit how-to kept conceptual.', isBuiltin: true, sortOrder: 2, kidSafeMedia: false,
    dials: normalizeDials({ profanity: 'unrestricted', sexual: 'unrestricted', violence: 'unrestricted', substances: 'discuss', crime: 'discuss', hate: 'fiction', selfHarm: 'discuss', privacy: 'public' }) },
  { slug: 'unrestricted', name: 'No Restrictions', description: 'Every category fully open — any and all topics. Only the absolute legal limits (minors, mass-casualty weapons) still apply.', isBuiltin: true, sortOrder: 3, kidSafeMedia: false, dials: { ...MAX_DIALS } },
]

function rowToProfile(r: typeof contentProfiles.$inferSelect): ContentProfile {
  return {
    slug: r.slug, name: r.name, description: r.description ?? '',
    dials: normalizeDials(JSON.parse(r.dials) as Partial<Record<DialKey, unknown>>),
    isBuiltin: r.isBuiltin, sortOrder: r.sortOrder, kidSafeMedia: !!r.kidSafeMedia,
  }
}

// Idempotent: seed any missing built-ins, ensure a default profile is set, and
// backfill an assignment for every existing user (admins → No Restrictions so they
// keep their access; everyone else → the default). Call once at boot.
export async function seedContentProfiles(): Promise<void> {
  const now = new Date()
  for (const p of BUILTIN_PROFILES) {
    await db.insert(contentProfiles)
      .values({ id: crypto.randomUUID(), slug: p.slug, name: p.name, description: p.description, dials: JSON.stringify(p.dials), kidSafeMedia: p.kidSafeMedia, isBuiltin: true, sortOrder: p.sortOrder, createdAt: now, updatedAt: now })
      .onConflictDoNothing()
  }
  if (await getAppSetting(DEFAULT_PROFILE_KEY) == null) {
    await setAppSetting(DEFAULT_PROFILE_KEY, 'locked')
  }
  // Backfill existing users who have no profile assigned yet.
  const { users } = await import('@/db/schema')
  const assigned = new Set(
    (await db.select({ userId: userPreferences.userId }).from(userPreferences).where(eq(userPreferences.key, USER_PROFILE_PREF))).map((r) => r.userId),
  )
  const allUsers = await db.select({ id: users.id, role: users.role }).from(users)
  for (const u of allUsers) {
    if (assigned.has(u.id)) continue
    const slug = u.role === 'admin' ? 'unrestricted' : 'locked'
    await setUserPref(u.id, USER_PROFILE_PREF, slug)
  }
  logger.info('[content] profiles seeded')
}

export async function listProfiles(): Promise<ContentProfile[]> {
  const rows = await db.select().from(contentProfiles).orderBy(asc(contentProfiles.sortOrder), asc(contentProfiles.name))
  return rows.map(rowToProfile)
}

export async function getProfile(slug: string): Promise<ContentProfile | null> {
  const [r] = await db.select().from(contentProfiles).where(eq(contentProfiles.slug, slug)).limit(1)
  return r ? rowToProfile(r) : null
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `profile-${crypto.randomUUID().slice(0, 8)}`
}

export async function createProfile(name: string, description: string, dials: Partial<Record<DialKey, unknown>>, kidSafeMedia = false): Promise<ContentProfile> {
  const now = new Date()
  let slug = slugify(name)
  if (await getProfile(slug)) slug = `${slug}-${crypto.randomUUID().slice(0, 4)}`
  const maxOrder = (await db.select().from(contentProfiles)).reduce((n, r) => Math.max(n, r.sortOrder), 0)
  await db.insert(contentProfiles).values({
    id: crypto.randomUUID(), slug, name: name.trim() || slug, description: description.trim(),
    dials: JSON.stringify(normalizeDials(dials)), kidSafeMedia, isBuiltin: false, sortOrder: maxOrder + 1, createdAt: now, updatedAt: now,
  })
  return (await getProfile(slug))!
}

export async function updateProfile(slug: string, patch: { name?: string; description?: string; dials?: Partial<Record<DialKey, unknown>>; kidSafeMedia?: boolean }): Promise<ContentProfile | null> {
  const existing = await getProfile(slug)
  if (!existing) return null
  const set: Partial<typeof contentProfiles.$inferInsert> = { updatedAt: new Date() }
  if (typeof patch.name === 'string' && patch.name.trim()) set.name = patch.name.trim()
  if (typeof patch.description === 'string') set.description = patch.description.trim()
  if (patch.dials) set.dials = JSON.stringify(normalizeDials(patch.dials))
  if (typeof patch.kidSafeMedia === 'boolean') set.kidSafeMedia = patch.kidSafeMedia
  await db.update(contentProfiles).set(set).where(eq(contentProfiles.slug, slug))
  return getProfile(slug)
}

export async function deleteProfile(slug: string): Promise<{ ok: boolean; error?: string }> {
  const p = await getProfile(slug)
  if (!p) return { ok: false, error: 'not found' }
  if (p.isBuiltin) return { ok: false, error: 'Built-in profiles cannot be deleted.' }
  if (await getDefaultProfileSlug() === slug) return { ok: false, error: 'Cannot delete the default profile.' }
  // Reassign anyone on this profile to the default.
  const def = await getDefaultProfileSlug()
  const onIt = await db.select({ userId: userPreferences.userId }).from(userPreferences)
    .where(and(eq(userPreferences.key, USER_PROFILE_PREF), eq(userPreferences.value, JSON.stringify(slug))))
  for (const r of onIt) await setUserPref(r.userId, USER_PROFILE_PREF, def)
  await db.delete(contentProfiles).where(eq(contentProfiles.slug, slug))
  return { ok: true }
}

export async function getDefaultProfileSlug(): Promise<string> {
  const v = await getAppSetting(DEFAULT_PROFILE_KEY)
  return typeof v === 'string' && v ? v : 'locked'
}
export async function setDefaultProfileSlug(slug: string): Promise<void> {
  if (!(await getProfile(slug))) throw new Error('unknown profile')
  await setAppSetting(DEFAULT_PROFILE_KEY, slug)
}

// ── Per-user assignment + resolution ─────────────────────────────────────────────
// Exported for sibling policy modules (videos/allowlist.ts) that store admin-managed
// per-user flags in the same preference store.
export async function getUserPref(userId: string, key: string): Promise<unknown | null> {
  const [row] = await db.select({ value: userPreferences.value }).from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, key))).limit(1)
  if (!row) return null
  try { return JSON.parse(row.value) } catch { return null }
}
export async function setUserPref(userId: string, key: string, value: unknown): Promise<void> {
  const now = new Date()
  await db.insert(userPreferences)
    .values({ id: crypto.randomUUID(), userId, key, value: JSON.stringify(value), updatedAt: now })
    .onConflictDoUpdate({ target: [userPreferences.userId, userPreferences.key], set: { value: JSON.stringify(value), updatedAt: now } })
}

export async function getUserProfileSlug(userId: string): Promise<string> {
  const v = await getUserPref(userId, USER_PROFILE_PREF)
  return typeof v === 'string' && v ? v : await getDefaultProfileSlug()
}
export async function setUserProfileSlug(userId: string, slug: string): Promise<void> {
  if (!(await getProfile(slug))) throw new Error('unknown profile')
  await setUserPref(userId, USER_PROFILE_PREF, slug)
}

// The user's account ceiling = the dials of their assigned profile. Pure-from-prefs
// variant for hot paths that already loaded prefs (companion overlay).
export function deriveUserProfileSlug(prefs: Record<string, unknown>): string | null {
  const v = prefs[USER_PROFILE_PREF]
  return typeof v === 'string' && v ? v : null
}

// Resolve the user's effective account ceiling (their profile's dials). Optionally
// fold in a self-lowered `content_dials` preference (user may go at or below their cap).
export async function getUserCeiling(userId: string): Promise<ContentDials> {
  const slug = await getUserProfileSlug(userId)
  const profile = (await getProfile(slug)) ?? (await getProfile(await getDefaultProfileSlug()))
  const cap = profile ? profile.dials : { ...MIN_DIALS }
  const self = await getUserPref(userId, 'content_dials')
  if (self && typeof self === 'object') {
    return effectiveCeiling(cap, normalizeDials(self as Partial<Record<DialKey, unknown>>, cap))
  }
  return cap
}

// ── Character content config (per-character JSON column) ─────────────────────────
export interface CharacterContent {
  dials: ContentDials
  candor: Candor
}
function normalizeCandor(v: unknown): Candor {
  return v === 'gentle' || v === 'blunt' ? v : 'balanced'
}
export function parseCharacterContent(raw: string | null | undefined): CharacterContent {
  let obj: Record<string, unknown> | null = null
  if (raw) { try { obj = JSON.parse(raw) as Record<string, unknown> } catch { obj = null } }
  return { dials: normalizeDials(obj as Partial<Record<DialKey, unknown>> | null, MIN_DIALS), candor: normalizeCandor(obj?.['candor']) }
}
export function serializeCharacterContent(dials: Partial<Record<DialKey, unknown>>, candor: unknown): string {
  return JSON.stringify({ ...normalizeDials(dials, MIN_DIALS), candor: normalizeCandor(candor) })
}

// ── Character eligibility (display only) ──────────────────────────────────────────
// A companion is always usable now — it's clamped to the user's ceiling rather than
// blocked. This reports which categories the user's profile limits below the
// character's authored level, for UI hints.
export interface GateResult {
  usable: boolean
  blockedBy: Array<{ dial: DialKey; required: string }>
}
export function characterGate(charDials: ContentDials, ceiling: ContentDials): GateResult {
  const blockedBy: Array<{ dial: DialKey; required: string }> = []
  for (const k of DIAL_KEYS) {
    if (levelIndex(k, charDials[k]) > levelIndex(k, ceiling[k])) blockedBy.push({ dial: k, required: charDials[k] })
  }
  return { usable: true, blockedBy }
}

// ── System-prompt assembly ────────────────────────────────────────────────────────
function fragmentFor(key: DialKey, level: string): string {
  const cat = CONTENT_CATEGORIES.find((c) => c.key === key)
  return cat?.levels.find((l) => l.value === level)?.fragment ?? ''
}

export function buildDialFragments(dials: ContentDials): string {
  return DIAL_KEYS.map((k) => fragmentFor(k, dials[k])).filter(Boolean).join(' ')
}

// The single content section: the irreducible core (always) + the per-category
// fragments for the active levels. There is no separate always-on "floor" anymore;
// what's allowed is entirely the resolved dials.
export function buildContentPrompt(dials: ContentDials): string {
  return `${IRREDUCIBLE_CORE}\n\n${buildDialFragments(dials)}`.trim()
}

// Which categories sit at the top (unrestricted) level — for the admin "100% open"
// assignment warning.
export function unrestrictedCategories(dials: ContentDials): string[] {
  return CONTENT_CATEGORIES.filter((c) => dials[c.key] === 'unrestricted').map((c) => c.label)
}
